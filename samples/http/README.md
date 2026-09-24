# Sample: talk to an agent over HTTP

Scenario 1 of SPEC §15. Claude (through Pi) behind an HTTP API, with a bearer token, conversations
that survive restarts, and an honest `/ready`. The agent has tools: it reads, writes and edits
files and runs commands in its workspace.

This is a fixture of the repository, not a generated project. There is no CLI yet, so
`pikit.config.ts` imports the components straight from `registry/`. `pikit new --preset http` will
copy them to `src/pikit/` instead.

| Component | Does |
|---|---|
| `secrets-env` | `secrets` from the environment (`PIKIT_HTTP_TOKEN`) |
| `sessions-jsonl` | Pi's sessions as JSONL files in `.pikit/sessions/` |
| `conversations-file` | conversation → session pointers in `.pikit/conversations.json` |
| `credentials-file` | model credentials in `.pikit/credentials.json` (mode 0600) |
| `provider-anthropic` | Claude models (`anthropic/claude-sonnet-4-6`) |
| `src/extensions/agents.ts` | your agents (`src/agents/assistant/agent.ts`) |
| `execution-local` | the workspace `.pikit/workspace/`: this machine's files and shell |
| `tool-read`, `tool-write`, `tool-edit`, `tool-bash` | Pi's tools; `assistant` names all four |
| `runtime-pi` | Pi runs the agents, with Pi's `permission-gate` extension loaded |
| `router-basic` | every message goes to `assistant` |
| `channel-http` | `POST /v1/messages`, `POST /v1/conversations/:id/reset` |
| `server-bun` | HTTP on port 3000, `/health`, `/ready` |
| `deployment-docker` | the process (`main.ts`): deadlines, signals, JSON-lines logs; and Docker |

Everything the sample writes is in `samples/http/.pikit/`, which git ignores.

## Run it

From the repository root, with Bun ≥ 1.4 and `bun install` done:

```sh
# 1. The token clients must send. Generate one; keep it out of files.
export PIKIT_HTTP_TOKEN=$(openssl rand -hex 32)

# 2. Credentials for Claude: log in with a Claude Pro/Max subscription…
bun samples/http/scripts/login.ts
#    …or use an API key instead (pi-ai reads it only when nothing is stored):
# export ANTHROPIC_API_KEY=sk-ant-…

# 3. Start it. Ctrl-C (SIGINT) or SIGTERM stops it cleanly.
bun samples/http/main.ts
```

`main.ts` runs `pikit.config.ts` through `deployment-docker`'s entrypoint (SPEC §9.1). It starts
with a 30 s deadline and stops with a 10 s one, and exits non-zero when either fails. It logs one
JSON object per line; pipe it through `jq` to read it. The app refuses to start without
`PIKIT_HTTP_TOKEN`, or when Claude has no credentials, and the error line says which one is
missing.

## Run it in Docker

With Docker and its Compose plugin, from `samples/http/`:

```sh
cd samples/http
# Secrets live in .env, next to compose.yaml. Git ignores it, and it never enters the image.
printf 'PIKIT_HTTP_TOKEN=%s\nANTHROPIC_API_KEY=%s\n' "$(openssl rand -hex 32)" 'sk-ant-…' > .env
chmod 600 .env

docker compose up --detach --build --wait   # what `pikit up` will run; fails if never healthy
curl -s localhost:3000/ready
docker compose logs --no-log-prefix app     # `pikit logs`: JSON lines
docker compose down                         # `pikit down`: the state volume stays
```

This compose.yaml is `deployment-docker`'s, adapted to this monorepo: `@pikit/*` are workspace
packages here, not published ones, so the image is built from the repository's root
(`context: ../..`) with its own `Dockerfile` and `Dockerfile.dockerignore`. A project made with
`pikit new --preset http` uses the component's files unchanged. The container runs as the user
`bun`, keeps `.pikit/` on the volume `pikit-state`, and listens on `127.0.0.1:3000` only.

To log in with a Claude subscription instead of an API key, run the login inside the container, so
the tokens land on its volume. Paste the final redirect URL when it asks, because the browser cannot
reach the container's callback: `docker compose run --rm app bun samples/http/scripts/login.ts`.

Then:

```sh
curl -s localhost:3000/ready
curl -s -X POST localhost:3000/v1/messages \
  -H "authorization: Bearer $PIKIT_HTTP_TOKEN" -H 'content-type: application/json' \
  -d '{"conversationId":"c1","text":"Hello! Who are you?"}'
# {"requestId":"…","text":"…"}

curl -s -X POST localhost:3000/v1/conversations/c1/reset -H "authorization: Bearer $PIKIT_HTTP_TOKEN"
```

A message sent to `c1` while the agent is still answering changes its course: Pi takes it as a
steer, and both requests receive the same answer. All statuses are listed in
`registry/components/channel-http/README.md`.

Ask it to work with files: *"Create notes.md with a summary of …"*, *"How many lines does notes.md
have?"*. It works in `samples/http/.pikit/workspace/`.

## Before you expose it

The agent has `bash` on your machine, as your user. `execution-local` is not a sandbox:
- Commands can reach anything your user can, outside the workspace too, including this sample's
  `.pikit/credentials.json`.
- Commands do not see the server's environment variables (`PIKIT_HTTP_TOKEN`,
  `ANTHROPIC_API_KEY`), only an allowlist.
- Pi's `permission-gate` blocks `rm -rf`, `sudo` and `chmod 777`. That is a policy, not isolation:
  other commands run.
- `server-bun` listens on `0.0.0.0:3000`, so anyone who can reach the port and has the token has
  that shell. On a shared network, set `"server-bun": { hostname: "127.0.0.1" }`, or remove `bash`
  from the agent's `tools`.

## Logging in

`scripts/login.ts` runs pi-ai's own OAuth flow for Anthropic. It needs no terminal UI:
1. It prints a URL. Open it in a browser and approve.
2. The browser comes back to `localhost:53692`, and the script finishes by itself. If the browser
   is on another machine, paste the final redirect URL into the terminal instead.
3. pi-ai writes the tokens through `model.credentials` into `.pikit/credentials.json` (mode 0600).
   The running app refreshes them before they expire and writes the new ones back.

The script never prints a token. Do not copy `~/.pi/agent/auth.json` from the Pi CLI: a refresh here
would rotate the token the CLI holds, and log it out. `pikit configure` will do this once the CLI
exists.

Bun loads `.env` files from the working directory by itself. The sample does not rely on that; keep
secrets in the environment of the process that runs it.

## Tests

Run from the repository root:
- `test/scenario-1.test.ts`: the whole path over real HTTP on a free port, with Pi's scripted faux
  model (no API key). It covers the answer in the response, a message steered into a busy run with
  both POSTs answered, `401`, `/health` and `/ready` while starting, running and stopping, reset,
  and a conversation surviving a restart.
- `test/scenario-7.test.ts`: Pi's own `permission-gate` extension, unmodified, stops Pi's real
  `bash` from running `rm -rf` asked for over HTTP, while other commands run in the workspace. An
  agent that does not name `bash` cannot run commands at all.
- `test/config.test.ts`: `pikit.config.ts` composes, as `pikit doctor` will check it.
- `test/anthropic.test.ts`: a real Claude answers, and uses its tools to write a file in the
  workspace. It runs only when `.pikit/credentials.json` has an `anthropic` entry or
  `ANTHROPIC_API_KEY` is exported, and is skipped otherwise.

- `test/docker.test.ts`: the sample's Docker files keep `deployment-docker`'s promises: no `.env`,
  `.pikit` or `node_modules` in the image, a non-root user, the volume where the state is, and a stop
  that fits in the grace period.
- `test/preset.test.ts`: `registry/presets/http.yaml` lists every registry component of this sample,
  and `deployment-docker`.

The entrypoint's own tests (signals, deadlines, exit codes, logs) are in
`registry/components/deployment-docker/`.
