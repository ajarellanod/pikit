# The image of this pikit project (deployment-docker).
#
# Secrets are never in the image: compose.yaml passes .env to the container when it starts, and
# .dockerignore keeps .env out of the build context. State is never in the image either: .pikit/
# is a volume.

# The dashboard (SPEC §5), when the project has a UI (`pikit ui on`): built in a stage of its own,
# with its own packages, so the app's image gets only its static files (src/dashboard/dist), which
# admin-api serves at /admin/. A project without src/dashboard/ builds nothing here.
FROM oven/bun:1.4-slim AS dashboard
WORKDIR /build
COPY src/ ./src/
RUN if [ -f src/dashboard/package.json ]; then \
      cd src/dashboard && bun install --frozen-lockfile && bun --bun run build; \
    else mkdir -p src/dashboard/dist; fi

# Bun >= 1.4: older Bun never fires an `AbortSignal.timeout()` whose last listener was removed
# (oven-sh/bun#37666), so a stop deadline would hang instead of firing.
FROM oven/bun:1.4-slim

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so that changing the source does not reinstall them. `--frozen-lockfile`
# installs exactly what bun.lock says; `--production` leaves out devDependencies (tests, types).
COPY package.json bun.lock ./
# @pikit/* are not on npm yet: `pikit new` vendors them as tarballs in vendor/, and package.json
# depends on them with `file:vendor/…`. They must be here before the install.
COPY vendor/ ./vendor/
RUN bun install --frozen-lockfile --production

COPY . .
COPY --from=dashboard /build/src/dashboard/dist ./src/dashboard/dist

# .pikit/ holds the app's state: the database (conversations, the registry), model credentials, the agent's workspace.
# compose.yaml mounts a volume here. The directory is created owned by the unprivileged user, and a
# new volume takes that ownership, so the app can write to it without running as root.
RUN mkdir -p .pikit && chown bun:bun .pikit
USER bun

EXPOSE 3000
# Bun is the process that receives SIGTERM (compose.yaml's `init: true` forwards it), so the
# entrypoint's stop deadline applies.
CMD ["bun", "src/pikit/deployment-docker/main.ts"]
