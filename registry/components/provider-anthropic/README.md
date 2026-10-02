# provider-anthropic

Anthropic's Claude models for your agents. An agent names one as `anthropic/<modelId>`, for example
`anthropic/claude-sonnet-4-6`.

- **Provides:** `model.provider`, under the key `anthropic`.
- **Requires:** nothing. The agent runtime reads credentials from `model.credentials` when it is
  installed.
- **Target:** `server`. On Cloudflare an API key would work, but an OAuth refresh loads its flow
  with a dynamic import, which Workers do not allow.
- **Installs to:** `src/pikit/provider-anthropic/`.
- **npm dependencies:** `@pikit/pi-adapter` (pinned with Pi).

## What it does

The provider is pi-ai's. It is imported by subpath (`@pikit/pi-adapter/providers/anthropic`), so
your app carries this provider and no other. Pi handles requests, retries, prompt caching and
credentials.

## Credentials

pi-ai looks for them in this order:
1. A credential stored for `anthropic` in `model.credentials` (for example `credentials-file`).
   This is either OAuth tokens from a Claude Pro/Max login, or an API key. pi-ai refreshes OAuth
   tokens before they expire and writes the new ones back.
2. Only when nothing is stored, the environment: `ANTHROPIC_API_KEY` (also `ANTHROPIC_OAUTH_TOKEN`
   or `ANTHROPIC_AUTH_TOKEN`), then (pi-ai 1.0) workload identity federation, when
   `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID` and `ANTHROPIC_IDENTITY_TOKEN_FILE` are
   all set.

The agent runtime refuses to start when none of them exists.

The OAuth login (pi-ai 1.0) first asks how to log in: `browser` (a callback on localhost) or
`copy_code` (Anthropic's page shows a code to paste: for a login where the app runs, in Docker).
`loginInteraction` in `@pikit/pi-adapter/credentials` answers every prompt, that one included.

To log in with a Claude subscription, run pi-ai's OAuth flow and store the result in
`model.credentials`. The `http` sample has a script for it (`samples/http/scripts/login.ts`).
`pikit configure` will do it once the CLI exists. Never reuse Pi's own `~/.pi/agent/auth.json`: a
refresh would rotate the token the Pi CLI holds.

## Tests

`provider-anthropic.test.ts` is copied with the component and runs in your project. It makes no
request and reads no credential.

`component.json` is generated from `setup` by the CLI and is not written by hand. Until the CLI
exists, the test "what setup declares" pins it.
