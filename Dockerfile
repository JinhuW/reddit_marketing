# syntax=docker/dockerfile:1.7
# One image for apps/web, apps/worker (SERVICE_ROLE=core) and node-gateway (SERVICE_ROLE=gateway).
# ADR-0001 "Build and release": Railway builds this file instead of Railpack, so production runs the same
# Node 22 image as `docker compose`.
#
#   docker compose      picks a named target: web | worker | gateway
#   Railway             builds the LAST stage (`railway`; Railway has no build-target setting) and each service's
#                       config file sets the start command, pre-deploy step and healthcheck:
#                         web           config file /apps/web/railway.json             healthcheck /login
#                         worker        config file /apps/worker/railway.json          (no HTTP port)
#                         node-gateway  config file /apps/worker/railway.gateway.json  healthcheck /healthz
#                       Root directory stays `/` for all three (they need packages/*).
#
# apps/node-agent and apps/browser-profile have their own Dockerfiles; .github/workflows/images.yml builds them.
# Nothing here receives CLOAKBROWSER_LICENSE_KEY: Railway services never hold it (plan §3.5).

FROM node:22-bookworm-slim AS base
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

# Workspace manifests and the Prisma schema only, collected generically so new packages (node-agent, node-testkit)
# need no edit here and `pnpm install` stays cached until a manifest, the lockfile or the schema changes.
FROM base AS manifests
COPY . /src
RUN mkdir -p /out/packages/db/prisma && cd /src \
  && find . -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /out \; \
  && cp pnpm-lock.yaml pnpm-workspace.yaml .npmrc /out \
  && cp packages/db/prisma/schema.prisma /out/packages/db/prisma/

FROM base AS deps
COPY --from=manifests /out ./
# Only what web and worker need: the node agent's dockerode/playwright-core stay out of the Railway image.
RUN pnpm install --frozen-lockfile --filter "@threadline/web..." --filter "@threadline/worker..."

FROM deps AS build
COPY . .
# Railway sets this build arg; next.config.ts turns it into the build id the update banner compares.
ARG RAILWAY_GIT_COMMIT_SHA
# `next build` downloads Inter from Google Fonts (next/font). That download sometimes fails in CI with
# "An error occurred in `next/font`", which made a commit's CI red and Railway skip its deploy: retry twice.
RUN pnpm --filter @threadline/db generate && \
    (pnpm --filter @threadline/web build || \
     (echo "web build failed; retrying in 10 s" >&2 && sleep 10 && pnpm --filter @threadline/web build) || \
     (echo "web build failed again; last retry in 30 s" >&2 && sleep 30 && pnpm --filter @threadline/web build))

FROM build AS runtime
ENV NODE_ENV=production
# Start commands exec the real binary (not `pnpm run`) so SIGTERM reaches the process and the worker's
# graceful shutdown runs on redeploy.

FROM runtime AS web
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["sh", "-c", "pnpm --filter @threadline/db migrate:deploy && cd apps/web && exec node_modules/.bin/tsx server.ts"]

FROM runtime AS worker
ENV SERVICE_ROLE=core
CMD ["sh", "-c", "cd apps/worker && exec node_modules/.bin/tsx src/index.ts"]

FROM runtime AS gateway
ENV SERVICE_ROLE=gateway PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["sh", "-c", "cd apps/worker && exec node_modules/.bin/tsx src/index.ts"]

# Railway's default (last) stage. It has no role of its own: without a config file it refuses to start rather
# than guess which service it is.
FROM runtime AS railway
CMD ["sh", "-c", "echo 'threadline: no start command. Set the service config file to apps/web/railway.json, apps/worker/railway.json or apps/worker/railway.gateway.json' >&2; exit 64"]
