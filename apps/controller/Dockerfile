# The controller image. The sandbox image is packages/runtime/Dockerfile.sandbox.
#
# There is no build step: the workspace ships TypeScript and tsx runs it. That is
# one fewer artifact to keep in sync between what was typechecked and what runs.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    CI=true
WORKDIR /repo

RUN corepack enable

# Manifests first, so a source-only change reuses the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/controller/package.json apps/controller/
COPY packages/protocol/package.json packages/protocol/
COPY packages/profiles/package.json packages/profiles/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/vcs/package.json packages/vcs/
COPY packages/tsconfig/package.json packages/tsconfig/

RUN pnpm install --frozen-lockfile --filter @pi-cloud-agent/controller...

COPY packages/ packages/
COPY apps/controller/ apps/controller/

WORKDIR /repo/apps/controller
EXPOSE 8080
CMD ["pnpm", "start"]
