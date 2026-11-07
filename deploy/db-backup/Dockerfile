# Off-Railway Postgres backup job (Railway cron service). See deploy/db-backup/README.md.
# The pg_dump major version must be >= the server's; Railway Postgres is 18.
FROM postgres:18

RUN apt-get update \
  && apt-get install -y --no-install-recommends awscli ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY lib.sh s3.sh backup.sh verify-latest.sh /opt/db-backup/
RUN chmod 0755 /opt/db-backup/*.sh

# Run as the unprivileged postgres user; the job only needs a temp dir and the network.
USER postgres
WORKDIR /tmp
# Replace the postgres image's server entrypoint: this image never runs a database.
ENTRYPOINT []
CMD ["/opt/db-backup/backup.sh"]
