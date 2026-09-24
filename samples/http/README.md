# Sample: talk to an agent over HTTP

Scenario 1 of SPEC §15. Claude (through Pi) behind an HTTP API, with a bearer token, conversations
that survive restarts, and an honest `/ready`.

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
| `runtime-pi` | Pi runs the agents |
| `router-basic` | every message goes to `assistant` |
| `channel-http` | `POST /v1/messages`, `POST /v1/conversations/:id/reset` |
| `server-bun` | HTTP on port 3000, `/health`, `/ready` |

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

The app refuses to start without `PIKIT_HTTP_TOKEN`, or when Claude has no credentials. The error
says which one is missing.

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
- `test/scenario-7.test.ts`: Pi's own `permission-gate` extension, unmodified, blocks `rm -rf`
  asked for over HTTP.
- `test/config.test.ts`: `pikit.config.ts` composes, as `pikit doctor` will check it.
- `test/anthropic.test.ts`: a real Claude answers. It runs only when `.pikit/credentials.json` has
  an `anthropic` entry or `ANTHROPIC_API_KEY` is exported, and is skipped otherwise.

`main.ts` stands in for `pikit up` and for the entrypoint a `deployment-*` component will own
(SPEC §9.1). It starts with a deadline, stops on SIGTERM or SIGINT with a deadline, and exits
non-zero when either fails.
