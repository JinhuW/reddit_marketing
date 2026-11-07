# db-backup: nightly off-Railway Postgres dump

A Railway cron service that copies the Threadline database out of Railway every night, so a Railway account
or region problem cannot take the only backup with it (ADR-0001, "Observability, secrets, backups"). It runs
alongside Railway's own PITR and volume backups; it does not replace them.

Every night at **02:30 UTC** the job:

1. runs `pg_dump --format=custom` against Postgres over Railway's private network;
2. runs `pg_restore --list` on the local file and refuses to upload an archive with no entries;
3. uploads it to `s3://$S3_BUCKET/$S3_PREFIX/daily/threadline-YYYYMMDDTHHMMSSZ.dump` and checks the stored size;
4. on Sundays (`BACKUP_WEEKLY_DOW=7`) uploads the same file to `…/weekly/`;
5. only then prunes: keeps the **7 newest daily** and the **4 newest weekly** dumps. Objects whose names are not
   `threadline-<stamp>.dump` are never deleted.

Any failure exits non-zero, so the run shows as failed in Railway and nothing is pruned. The scripts never print
`DATABASE_URL` or the bucket keys.

| File | Purpose |
|---|---|
| `Dockerfile` | `postgres:18` (pg_dump 18, must be ≥ the server) + Debian `awscli`; runs as `postgres` |
| `railway.json` | Dockerfile build, `cronSchedule: "30 2 * * *"`, `restartPolicyType: NEVER` |
| `backup.sh` | the nightly job (default command) |
| `verify-latest.sh` | downloads a dump and runs `pg_restore --list`; optional full restore into a scratch DB |
| `lib.sh`, `s3.sh` | naming/retention helpers and S3 client setup |
| `test/lib.test.sh` | unit tests for naming and retention (no Docker) |
| `test/e2e.sh` | Docker test: local Postgres → S3 mock, 10 nightly runs, retention, verify, restore, no secrets in logs |

## Variables

Set on the Railway service (all secrets as Railway variables; nothing in the image).

| Variable | Required | Example / default |
|---|---|---|
| `DATABASE_URL` | yes | `${{Postgres.DATABASE_URL}}` (the private `postgres.railway.internal` URL, not the public proxy) |
| `S3_BUCKET` | yes | `threadline-backups` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | yes | bucket credentials (for OCI: a Customer Secret Key) |
| `S3_ENDPOINT` | for non-AWS | OCI: `https://<namespace>.compat.objectstorage.<region>.oraclecloud.com` |
| `S3_REGION` | for non-AWS | OCI: the bucket's region, e.g. `us-ashburn-1`; default `us-east-1` |
| `S3_PREFIX` | no | `threadline/postgres` |
| `S3_ADDRESSING_STYLE` | no | `path` when `S3_ENDPOINT` is set (OCI needs it), else `auto` |
| `BACKUP_KEEP_DAILY` / `BACKUP_KEEP_WEEKLY` | no | `7` / `4` |
| `BACKUP_WEEKLY_DOW` | no | `7` (ISO weekday, Sunday) |
| `BACKUP_TIMESTAMP` | no | override the dump name stamp, e.g. `20261108T023000Z` (tests and manual reruns) |

Use credentials that can only read/write/delete objects in this bucket. On OCI, create a dedicated IAM user in a
group whose policy allows `manage objects` in the backup bucket's compartment, and give it a Customer Secret Key.

## Set up on Railway (owner gate G4)

Nothing here is applied automatically; each step changes the live project and needs approval.

1. Create the bucket (OCI Object Storage, 20 GB free tier, or any S3). Keep it private. Optionally add a
   lifecycle rule deleting objects under `threadline/postgres/` after 40 days as a safety net behind the
   script's own pruning.
2. In the `threadline` project, add a service from the GitHub repo named `db-backup`:
   - Settings → Source → **Root Directory**: `/deploy/db-backup`
   - Settings → **Config-as-code file**: `/deploy/db-backup/railway.json` (the config path does not follow the
     root directory). This sets the Dockerfile build, the 02:30 UTC cron and no restarts.
   - No public domain, no TCP proxy, no volume.
3. Set the variables above. `DATABASE_URL` must reference the Postgres service's private URL.
4. Trigger one run from the service's cron panel (or wait for 02:30 UTC). Do not use `railway run` for this: it
   runs the script on your machine, which cannot reach the private database URL. Then check the bucket:

```bash
# from any machine with Docker and the same bucket credentials in the environment
docker build -t threadline/db-backup deploy/db-backup
docker run --rm -e S3_BUCKET -e S3_ENDPOINT -e S3_REGION -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  threadline/db-backup /opt/db-backup/verify-latest.sh
# → db-backup verify: pg_restore --list ok: s3://…/daily/threadline-….dump, <bytes>, <n> TOC entries, …
```

5. Turn on Railway's failed-deployment notifications for the service so a failed night is seen.

## Restore

```bash
# newest daily dump into a scratch database (must be Postgres 18 with pgvector available, i.e. the same major
# version as production; a pg_dump 18 archive sets parameters older servers reject)
docker run --rm -e S3_BUCKET -e S3_ENDPOINT -e S3_REGION -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  -e VERIFY_RESTORE_URL='postgresql://…/scratch' threadline/db-backup /opt/db-backup/verify-latest.sh

# a specific dump: pass its key, or `weekly` for the newest weekly one
… /opt/db-backup/verify-latest.sh threadline/postgres/weekly/threadline-20261108T023000Z.dump
```

`verify-latest.sh` restores with `--no-owner --no-acl --exit-on-error` into an existing, empty database. For a
real recovery, restore into a fresh Railway Postgres, point `DATABASE_URL` of `web`, `worker` and `node-gateway`
at it, and run `prisma migrate deploy` (it should report nothing to apply). Railway PITR is the first choice for
recent mistakes; this dump is for when Railway itself is the problem.

## Tests

```bash
deploy/db-backup/test/lib.test.sh                     # retention and naming, no Docker
E2E_DATABASE_URL=postgresql://threadline:threadline@host.docker.internal:5432/threadline \
  deploy/db-backup/test/e2e.sh                        # needs Docker and a seeded local database
```

The e2e test uses `adobe/s3mock` as the bucket and a throwaway `pgvector/pgvector:pg18` as the restore target;
it never touches a real bucket or Railway.
