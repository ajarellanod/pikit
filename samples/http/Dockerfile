# The sample's image. It is deployment-docker's Dockerfile adapted to this monorepo; a project uses
# that one unchanged. Two things differ, both because @pikit/* are workspace packages here, not
# published ones:
# - The build context is the repository's root (compose.yaml: `context: ../..`), so the image gets
#   packages/ and registry/. Dockerfile.dockerignore, next to this file, applies to that context.
# - `bun install` keeps devDependencies: the monorepo's root lists @pikit/core, hono and typebox
#   there, where a project lists them as dependencies.
# Everything else holds as in a project: Bun >= 1.4, a non-root user, .pikit/ on a volume, no secret
# in the image.

FROM oven/bun:1.4-slim

WORKDIR /app
ENV NODE_ENV=production

# The workspace's manifests first, so that changing the source does not reinstall dependencies.
# bunfig.toml preloads scripts/require-bun.ts, which refuses a Bun older than 1.4.
COPY package.json bun.lock bunfig.toml ./
COPY scripts/require-bun.ts scripts/
COPY packages/core/package.json packages/core/
COPY packages/pi-adapter/package.json packages/pi-adapter/
COPY packages/pi-extension-shim/package.json packages/pi-extension-shim/
RUN bun install --frozen-lockfile

COPY packages packages
COPY registry registry
COPY samples/http samples/http

# The sample keeps its state next to pikit.config.ts: samples/http/.pikit/, the volume.
RUN mkdir -p samples/http/.pikit && chown bun:bun samples/http/.pikit
USER bun

EXPOSE 3000
CMD ["bun", "samples/http/main.ts"]
