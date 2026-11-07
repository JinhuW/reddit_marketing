# Node agent image (linux/amd64). Build from the repo root:
#   docker build --platform linux/amd64 -f apps/node-agent/Dockerfile -t threadline/node-agent .
# Run with the Docker socket mounted and the socket's group added, e.g. in compose:
#   volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
#   group_add: ["<gid of /var/run/docker.sock on the host>"]
# Env: GATEWAY_URL, NODE_NAME, NODE_TOKEN, CLOAKBROWSER_LICENSE_KEY, BROWSER_IMAGE, BROWSER_NETWORK, NODE_MAX_PROFILES.
# No secrets are baked into the image.

FROM --platform=linux/amd64 node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY apps/node-agent/package.json apps/node-agent/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @threadline/node-agent...
COPY packages/shared packages/shared
COPY apps/node-agent apps/node-agent
RUN pnpm --filter @threadline/node-agent build \
 && pnpm --filter @threadline/node-agent deploy --prod --legacy /out

FROM --platform=linux/amd64 node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
USER node
CMD ["node", "dist/index.mjs"]
