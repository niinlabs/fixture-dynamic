// Disposable dynamic fixture for NIIN.1 Slice 3.
//
// Exists to be broken deliberately: crash loops, failed health, schema
// migration and cross-tenant credential tests. Nothing here is a product.
//
// The distinction this fixture is built to demonstrate: a running container
// is not a working application. /health checks the dependencies the app
// actually needs; the process staying alive proves neither.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const SLUG = process.env.FIXTURE_SLUG || 'unknown';
const DATA_DIR = process.env.FIXTURE_DATA_DIR || '/data';
const PORT = process.env.PORT || 3000;
const FAIL_HEALTH = process.env.FIXTURE_FAIL_HEALTH === '1';
const CRASH_ON_BOOT = process.env.FIXTURE_CRASH_ON_BOOT === '1';
const REQUIRE_VOLUME = process.env.FIXTURE_REQUIRE_VOLUME !== '0';

if (CRASH_ON_BOOT) {
  console.error(`[${SLUG}] FIXTURE_CRASH_ON_BOOT set — exiting 1 to produce a crash loop`);
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  max: 4,
});

// Migrations are an ordered list applied at boot. Adding an entry and
// redeploying is how the schema-migration exercise is performed; the
// version is externally observable at /version so a migration can be
// verified from outside rather than trusted from the deployment log.
const MIGRATIONS = [
  {
    version: 1,
    sql: `CREATE TABLE IF NOT EXISTS fixture_note (
            id serial PRIMARY KEY,
            slug text NOT NULL,
            note text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
          );`,
  },
];

async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
                      version int PRIMARY KEY,
                      applied_at timestamptz NOT NULL DEFAULT now()
                    );`);
  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  const done = new Set(rows.map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    console.log(`[${SLUG}] applying migration ${m.version}`);
    await pool.query('BEGIN');
    try {
      await pool.query(m.sql);
      await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }
  }
  await pool.query(
    `INSERT INTO fixture_note (slug, note)
     SELECT $1, 'seeded at first boot'
     WHERE NOT EXISTS (SELECT 1 FROM fixture_note)`,
    [SLUG]
  );
}

// A writable directory is not persistent storage. Without a volume, DATA_DIR
// is an ordinary directory in the container's writable layer: every write
// succeeds, and every write is discarded when the container is replaced. A
// write-and-read-back probe cannot tell the two apart, so the check first
// asks the kernel whether the path is actually a mount.
function isMountPoint(dir) {
  const target = path.resolve(dir);
  return fs
    .readFileSync('/proc/self/mountinfo', 'utf8')
    .split('\n')
    .some((line) => {
      const fields = line.split(' ');
      return fields[4] && fields[4].replace(/\\040/g, ' ') === target;
    });
}

// Writable storage is part of what makes this fixture stateful. After
// confirming a mount, the check writes and reads back rather than only
// checking the path exists — a mounted-but-read-only volume is a real
// failure mode and looks fine to anything that only stats the directory.
function storageCheck() {
  if (REQUIRE_VOLUME) {
    let mounted;
    try {
      mounted = isMountPoint(DATA_DIR);
    } catch {
      throw new Error('cannot verify mount (no /proc/self/mountinfo); set FIXTURE_REQUIRE_VOLUME=0 outside Linux');
    }
    if (!mounted) {
      throw new Error(`${DATA_DIR} is not a mounted volume — writes will not survive container replacement`);
    }
  }
  const probe = path.join(DATA_DIR, '.health-probe');
  const stamp = String(Date.now());
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(probe, stamp);
  if (fs.readFileSync(probe, 'utf8') !== stamp) throw new Error('readback mismatch');
}

const app = express();

app.get('/health', async (_req, res) => {
  const checks = {};
  let ok = true;
  try {
    const r = await pool.query('SELECT 1 AS ok');
    checks.database = r.rows[0].ok === 1 ? 'ok' : 'unexpected result';
  } catch (e) {
    checks.database = `failed: ${e.message}`;
    ok = false;
  }
  try {
    storageCheck();
    checks.storage = 'ok';
  } catch (e) {
    checks.storage = `failed: ${e.message}`;
    ok = false;
  }
  if (FAIL_HEALTH) {
    checks.forced = 'FIXTURE_FAIL_HEALTH is set';
    ok = false;
  }
  res.status(ok ? 200 : 503).json({ slug: SLUG, status: ok ? 'healthy' : 'unhealthy', checks });
});

app.get('/version', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT max(version) AS v FROM schema_migrations');
    res.json({ slug: SLUG, schema_version: rows[0].v });
  } catch (e) {
    res.status(503).json({ slug: SLUG, error: e.message });
  }
});

app.get('/', async (_req, res) => {
  let note = null;
  let dbError = null;
  try {
    const { rows } = await pool.query(
      'SELECT note, created_at FROM fixture_note ORDER BY id LIMIT 1'
    );
    note = rows[0] || null;
  } catch (e) {
    dbError = e.message;
  }
  let stored = null;
  try {
    stored = fs.readFileSync(path.join(DATA_DIR, 'marker.txt'), 'utf8').trim();
  } catch {
    stored = '(no marker file yet)';
  }
  res
    .status(dbError ? 503 : 200)
    .type('html')
    .send(`<!doctype html><meta charset="utf-8"><title>${SLUG}</title>
<h1>NIIN.1 dynamic fixture</h1>
<p>slug: <strong>${SLUG}</strong></p>
<p>database: ${dbError ? `<strong>FAILED</strong> — ${dbError}` : `ok — note "${note?.note}"`}</p>
<p>storage marker: ${stored}</p>`);
});

(async () => {
  try {
    await migrate();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const marker = path.join(DATA_DIR, 'marker.txt');
    if (!fs.existsSync(marker)) fs.writeFileSync(marker, `${SLUG} first boot ${new Date().toISOString()}`);
  } catch (e) {
    // Deliberately non-fatal: the container starts, and /health reports the
    // fault. That is the state the slice needs to be able to observe.
    console.error(`[${SLUG}] startup task failed: ${e.message}`);
  }
  app.listen(PORT, () => console.log(`[${SLUG}] listening on ${PORT}`));
})();
