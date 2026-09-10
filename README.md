# fixture-dynamic

A disposable stateful fixture for the NIIN.1 estate, used in Slice 3 to prove
that a dynamic workload can fail, restart, migrate, deploy and restore without
touching anything else on the host.

**This is not a product.** It exists to be broken. The `fixture-` prefix means
it is always safe to destroy.

Two independent instances run from this code — `fixture-dynamic-a` and
`fixture-dynamic-b` — with separate projects, networks, databases, credentials
and volumes. They are deliberately identical so that an isolation failure is
unambiguous: if one can reach the other's database, that is isolation breaking,
not a difference between the two services.

## Endpoints

| Path | Purpose |
| --- | --- |
| `/` | Public page: reads a row from its own database and a marker file from its own volume |
| `/health` | Internal check: database reachable, `/data` is a mounted volume and writable. `503` when any fails |
| `/version` | Current schema version, so a migration is verifiable from outside |

## Environment

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | Postgres connection string for this instance's own database |
| `FIXTURE_SLUG` | `fixture-dynamic-a` or `fixture-dynamic-b` — appears in output and identifies the instance |
| `FIXTURE_DATA_DIR` | Writable volume mount point (default `/data`) |
| `FIXTURE_FAIL_HEALTH` | `1` makes `/health` return 503 while the process stays up |
| `FIXTURE_CRASH_ON_BOOT` | `1` exits 1 at startup, producing a crash loop |
| `FIXTURE_REQUIRE_VOLUME` | `0` skips the mount check — only for running outside Linux; never set in the estate |

The last two exist so the failed-health and crash-loop exercises need no code
change — the fault is configuration, and reverting it is a single edit.

## Why health and the smoke check are separate

`/health` is the internal view: it asks whether this process can reach the
things it needs. The smoke check is the external view, run from outside the
estate against the public URL.

They fail in different situations, and the gap between them is the point. A
container can be running while the application is broken; a deployment tool
can report success while nothing is reachable. Neither Docker's status nor
Coolify's deployment result is evidence that a release works.

```bash
npm run smoke -- https://dyn-a.niin.one fixture-dynamic-a
```
