// Public smoke check — the product-owned proof that a release works.
//
// Runs against the public URL from outside the estate. Coolify reporting a
// finished deployment and Docker reporting a running container are both
// upstream of this and neither is evidence; this is.

const base = (process.argv[2] || '').replace(/\/$/, '');
const expectedSlug = process.argv[3];
if (!base || !expectedSlug) {
  console.error('Usage: node smoke-check.mjs <base-url> <expected-slug>');
  process.exit(2);
}

const failures = [];
function check(ok, message) {
  if (ok) console.log(`  ✓ ${message}`);
  else {
    console.error(`  ✗ ${message}`);
    failures.push(message);
  }
}

console.log(`Smoke checks against ${base}`);

// Root must serve the app's own identity, not merely respond. A 200 from a
// misrouted proxy or a stale container would pass a bare status check.
try {
  const r = await fetch(`${base}/`);
  const body = await r.text();
  check(r.status === 200, `/ responds 200 (got ${r.status})`);
  check(body.includes(expectedSlug), `/ identifies itself as "${expectedSlug}"`);
  check(!body.includes('FAILED'), '/ reports no database failure');
} catch (e) {
  check(false, `/ request failed: ${e.message}`);
}

// Health is the internal view: dependencies reachable, storage writable.
try {
  const r = await fetch(`${base}/health`);
  const body = await r.json();
  check(r.status === 200, `/health responds 200 (got ${r.status})`);
  check(body.status === 'healthy', `/health reports healthy (got "${body.status}")`);
  check(body.checks?.database === 'ok', `/health database check ok (got "${body.checks?.database}")`);
  check(body.checks?.storage === 'ok', `/health storage check ok (got "${body.checks?.storage}")`);
} catch (e) {
  check(false, `/health request failed: ${e.message}`);
}

// Schema version is externally observable so a migration can be verified
// from outside rather than trusted from a deployment log.
try {
  const r = await fetch(`${base}/version`);
  const body = await r.json();
  check(r.status === 200, `/version responds 200 (got ${r.status})`);
  check(Number.isInteger(body.schema_version), `/version reports an integer schema version (got ${body.schema_version})`);
  console.log(`    schema_version = ${body.schema_version}`);
  console.log(`    code_schema_version = ${body.code_schema_version ?? '(not reported by this build)'}`);
} catch (e) {
  check(false, `/version request failed: ${e.message}`);
}

// The Node major that is actually running, against the repository's pins.
// Production is pinned by the Dockerfile's base image; engines, .nvmrc and the
// lockfile pin local development. They must agree, and only a check makes that
// true rather than hoped for. Compares the deployed artifact, not the checkout:
// a mismatch means either drift in the repository or an old image still serving.
try {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const major = (v) => String(v).replace(/[^0-9]*([0-9]+).*/, '$1');

  const pinned = {
    Dockerfile: major(readFileSync(`${dir}Dockerfile`, 'utf8').match(/^FROM node:(\S+)/m)?.[1] ?? ''),
    engines: major(JSON.parse(readFileSync(`${dir}package.json`, 'utf8')).engines?.node ?? ''),
    '.nvmrc': major(readFileSync(`${dir}.nvmrc`, 'utf8').trim()),
  };
  const agreed = [...new Set(Object.values(pinned))];
  check(agreed.length === 1, `the repository pins one Node major (${Object.entries(pinned).map(([k, v]) => `${k}=${v}`).join(', ')})`);

  const r = await fetch(`${base}/version`);
  const running = major((await r.json()).node_version ?? '');
  check(
    running !== '' && running === agreed[0],
    `the running Node major matches the pin (running ${running || 'not reported'}, pinned ${agreed.join('/')})`,
  );
} catch (e) {
  check(false, `Node pin check failed: ${e.message}`);
}

// TLS and canonical host.
check(base.startsWith('https://'), 'checked over https');

if (failures.length) {
  console.error(`\nSmoke checks FAILED (${failures.length}).`);
  process.exit(1);
}
console.log('\nAll smoke checks passed.');
