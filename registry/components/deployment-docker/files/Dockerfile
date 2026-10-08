# The image of this pikit project (deployment-docker).
#
# Secrets are never in the image: compose.yaml passes .env to the container when it starts, and
# .dockerignore keeps .env out of the build context. State is never in the image either: .pikit/
# is a volume.

# The dashboard (SPEC §5), when the project has a UI (`pikit ui on`): built in a stage of its own,
# with its own packages. Its build writes its files into admin-api as a module
# (src/pikit/admin-api/dashboard-files.ts), which admin-api serves at /admin/: only that file reaches
# the app's image, in out/. A project without src/dashboard/ builds nothing here, and out/ stays empty.
FROM oven/bun:1.4-slim AS dashboard
WORKDIR /build
COPY src/ ./src/
RUN mkdir -p out && if [ -f src/dashboard/package.json ]; then \
      (cd src/dashboard && bun install --frozen-lockfile && bun --bun run build) && \
      if [ -f src/pikit/admin-api/dashboard-files.ts ]; then \
        mkdir -p out/src/pikit/admin-api && cp src/pikit/admin-api/dashboard-files.ts out/src/pikit/admin-api/; \
      fi; \
    fi

# What the app and the deployer share: Bun >= 1.4 (older Bun never fires an `AbortSignal.timeout()`
# whose last listener was removed, oven-sh/bun#37666, so a stop deadline would hang instead of firing)
# and git. The agent's shell runs plain git (self-improvement: it clones the proposals repository and
# pushes its branches there), committing as "pikit agent".
FROM oven/bun:1.4-slim AS base
RUN apt-get update \
 && apt-get install --yes --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system user.name "pikit agent" \
 && git config --system user.email "agent@pikit.invalid" \
 && git config --system init.defaultBranch main

# Self-improvement's deployer (compose.yaml's `deployer` service, profile `self-improvement`): git,
# Bun and Docker's CLI with Compose and buildx, and deployment-docker's own files, nothing else of the
# project. It runs as root, for the Docker socket; it runs the project's checks in containers of
# this same image without the socket, as the checks volume's owner. Never the app's image.
FROM docker:28-cli AS docker-cli
FROM base AS deployer
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
WORKDIR /deployer
COPY src/pikit/deployment-docker/ ./src/pikit/deployment-docker/
# Its volume (/checks) is the bun user's, as its checks are.
RUN mkdir -p /checks && chown bun:bun /checks
CMD ["bun", "src/pikit/deployment-docker/deployer-main.ts"]

# The app: the last stage, which `docker build` and compose's `app` build.
FROM base

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
COPY --from=dashboard /build/out/ ./

# .pikit/ holds the app's state: the database (conversations, the registry), model credentials, the agent's workspace.
# compose.yaml mounts a volume here. The directory is created owned by the unprivileged user, and a
# new volume takes that ownership, so the app can write to it without running as root.
RUN mkdir -p .pikit && chown bun:bun .pikit
USER bun

EXPOSE 3000
# Bun is the process that receives SIGTERM (compose.yaml's `init: true` forwards it), so the
# entrypoint's stop deadline applies.
CMD ["bun", "src/pikit/deployment-docker/main.ts"]
