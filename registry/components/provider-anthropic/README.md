# provider-anthropic

Anthropic's Claude models for your agents. An agent names one as `anthropic/<modelId>`, for example
`anthropic/claude-sonnet-4-6`.

- **Provides:** `model.provider`, under the key `anthropic`.
- **Requires:** nothing. The agent runtime reads credentials from `model.credentials` when it is
  installed.
- **Targets:** `server` and `durable`. On `durable` (Cloudflare), a subscription login needs
  `credentials-do` ("Cloudflare" below).
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

The agent runtime refuses to start when none of them exists. With `secrets` installed, it reads
these variables there first, then the environment.

The OAuth login (pi-ai 1.0) first asks how to log in: `browser` (a callback on localhost) or
`copy_code` (Anthropic's page shows a code to paste: for a login where the app runs, in Docker).
`loginInteraction` in `@pikit/pi-adapter/credentials` answers every prompt, that one included.

To log in with a Claude subscription, run pi-ai's OAuth flow and store the result in
`model.credentials`. The `http` sample has a script for it (`samples/http/scripts/login.ts`).
`pikit configure` does it too, when it sets up the model. Never reuse Pi's own `~/.pi/agent/auth.json`: a
refresh would rotate the token the Pi CLI holds.

## Cloudflare

The component is the same on both targets. An API key needs nothing of it: set `ANTHROPIC_API_KEY`
as a Worker secret (`wrangler secret put ANTHROPIC_API_KEY`, or `.env`, which `pikit up` uploads),
which `secrets-workers` reads.

A Claude Pro/Max login works on `durable` with `credentials-do` (`pikit add credentials-do`): one
Durable Object keeps the tokens, and an expiring token is refreshed once for every conversation,
under that object's lock (refresh tokens rotate: two refreshes at once would revoke one another's).
After `pikit up`, `pikit configure --login anthropic` logs in on your machine (the code login: open a
URL, paste the code the page shows) and uploads the tokens to the deployed app. pi-ai's OAuth flow,
which it loads with an import no bundler follows, is bundled by credentials-do
(`@pikit/pi-adapter/oauth-flows`). `pikit dev` (wrangler dev) has objects of its own: it takes the
API key.

**Check Anthropic's terms first:** whether a personal Claude subscription may serve a deployed bot,
other people or automated traffic is for its terms to say, and they change. An API key is
Anthropic's way for a deployed app.

Workload identity federation reads a token file, so it is a server's.

## Tests

`provider-anthropic.test.ts` is copied with the component and runs in your project. It makes no
request and reads no credential: it checks the provider, and that without `model.credentials` a key
configures it. In the pikit repository,
the workerd lane (`tests/workerd/test/provider-anthropic.workerd.ts`) composes it with runtime-pi in
a real Durable Object, where an agent answers from a fake Anthropic API with a key from `secrets`;
`tests/workerd/test/credentials-do.workerd.ts`, with a subscription login whose token is refreshed
once against a fake OAuth endpoint.

`component.json` is generated from `setup` by `pikit registry generate` and is not written by hand;
the test "what setup declares" pins it.
