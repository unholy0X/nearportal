# Build from the repository root (the build context holds apps/server, apps/site and services/relayer):
#   docker build -f apps/server/Dockerfile -t nearportal:demo .
# (compose.yaml uses the same context and Dockerfile.)
FROM node:24-bookworm-slim AS build
WORKDIR /workspace
COPY apps/server/package*.json ./apps/server/
COPY services/relayer/package*.json ./services/relayer/
RUN cd apps/server && npm ci && cd ../../services/relayer && npm ci
COPY apps/server ./apps/server
COPY services/relayer/src ./services/relayer/src
# The Aurora landing and workspace pages, served by the same process on the public origin.
COPY apps/site ./apps/site
RUN cd apps/site && node build.mjs \
 && node -e "const a=require('fs').readFileSync('/workspace/apps/site/workspace-model.mjs','utf8'),b=require('fs').readFileSync('/workspace/apps/server/src/workspace/workspace-model.mjs','utf8');if(a!==b){console.error('apps/server/src/workspace is out of sync with apps/site: run npm run sync:workspace in apps/site');process.exit(1)}"
WORKDIR /workspace/apps/server
RUN npm run typecheck && npm run build && npm prune --omit=dev
WORKDIR /workspace/services/relayer
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/var/lib/nearportal SITE_DIR=/workspace/landing
WORKDIR /workspace/apps/server
COPY --from=build --chown=node:node /workspace/apps/server/package*.json ./
COPY --from=build --chown=node:node /workspace/apps/server/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/server/dist ./dist
COPY --from=build --chown=node:node /workspace/apps/server/server ./server
# server/portal/home.ts and read-model.ts import the shared status model at runtime.
COPY --from=build --chown=node:node /workspace/apps/server/src/workspace ./src/workspace
COPY --from=build --chown=node:node /workspace/apps/server/scripts/backup.ts /workspace/apps/server/scripts/restore-check.ts /workspace/apps/server/scripts/backup-drill.ts ./scripts/
COPY --from=build --chown=node:node /workspace/apps/server/scripts/repair-gas-encryption.ts ./scripts/
COPY --from=build --chown=node:node /workspace/apps/site/dist /workspace/landing
# The server imports the relayer as source (../../../services/relayer/src from server/).
COPY --from=build --chown=node:node /workspace/services/relayer/package.json /workspace/services/relayer/package.json
COPY --from=build --chown=node:node /workspace/services/relayer/node_modules /workspace/services/relayer/node_modules
COPY --from=build --chown=node:node /workspace/services/relayer/src /workspace/services/relayer/src
RUN mkdir -p /var/lib/nearportal && chown node:node /var/lib/nearportal
USER node
EXPOSE 8787
# Readiness fails only when this instance cannot serve (database or stalled worker), not when an
# external provider is degraded: restarting would not fix a provider outage.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:8787/api/portal/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "--import", "tsx", "server/tasks.ts"]
