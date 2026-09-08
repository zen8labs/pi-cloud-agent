# A clean source checkout is the complete build input.
# microSandbox's controller SDK requires glibc >= 2.39. Runtime archives
# remain Bookworm-based for compatibility with older project environments.
FROM node:22-trixie-slim AS source
WORKDIR /repo
ENV CI=true
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ packages/
COPY apps/controller/ apps/controller/
RUN pnpm install --frozen-lockfile --filter @pi-cloud-agent/controller... --filter @pi-cloud-agent/runtime...
RUN pnpm --filter @pi-cloud-agent/runtime build

FROM --platform=linux/amd64 node:22-bookworm-slim AS runtime-amd64
WORKDIR /opt/pi-cloud-agent
COPY --from=source /repo/packages/runtime/dist/ ./
RUN npm install --omit=dev --no-audit --no-fund \
    && node patch-pi-ai-exports.mjs && rm patch-pi-ai-exports.mjs \
    && mkdir bin && cp /usr/local/bin/node bin/node \
    && tar -czf /runtime-linux-amd64.tar.gz .

FROM --platform=linux/arm64 node:22-bookworm-slim AS runtime-arm64
WORKDIR /opt/pi-cloud-agent
COPY --from=source /repo/packages/runtime/dist/ ./
RUN npm install --omit=dev --no-audit --no-fund \
    && node patch-pi-ai-exports.mjs && rm patch-pi-ai-exports.mjs \
    && mkdir bin && cp /usr/local/bin/node bin/node \
    && tar -czf /runtime-linux-arm64.tar.gz .

FROM source AS controller
ENV NODE_ENV=production
COPY --from=runtime-amd64 /runtime-linux-amd64.tar.gz packages/runtime/dist/
COPY --from=runtime-arm64 /runtime-linux-arm64.tar.gz packages/runtime/dist/
WORKDIR /repo/apps/controller
EXPOSE 8080
CMD ["pnpm", "start"]
