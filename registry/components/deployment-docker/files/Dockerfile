# The image of this pikit project (deployment-docker, SPEC §9.1).
#
# Secrets are never in the image: compose.yaml passes .env to the container when it starts, and
# .dockerignore keeps .env out of the build context. State is never in the image either: .pikit/
# is a volume.

# Bun >= 1.4: older Bun never fires some stop deadlines (see pikit's AGENTS.md).
FROM oven/bun:1.4-slim

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so that changing the source does not reinstall them. `--frozen-lockfile`
# installs exactly what bun.lock says; `--production` leaves out devDependencies (tests, types).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

# .pikit/ holds the app's state: sessions, conversations, model credentials, the agent's workspace.
# compose.yaml mounts a volume here. The directory is created owned by the unprivileged user, and a
# new volume takes that ownership, so the app can write to it without running as root.
RUN mkdir -p .pikit && chown bun:bun .pikit
USER bun

EXPOSE 3000
# Bun is the process that receives SIGTERM (compose.yaml's `init: true` forwards it), so the
# entrypoint's stop deadline applies.
CMD ["bun", "src/pikit/deployment-docker/main.ts"]
