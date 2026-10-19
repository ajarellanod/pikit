# provider-openai

OpenAI's models for your agents, with an API key or a ChatGPT subscription. An agent names one as
`openai/<modelId>`, for example `openai/gpt-5.5`.

- **Provides:** `model.provider`, under the key `openai`.
- **Requires:** nothing. The agent runtime reads credentials from `model.credentials` when it is
  installed.
- **Targets:** `server` and `durable`. On `durable` (Cloudflare), a ChatGPT login needs
  `credentials-do` ("Cloudflare" below).
- **Installs to:** `src/pikit/provider-openai/`.
- **npm dependencies:** `@pikit/pi-adapter` (pinned with Pi).

## What it does

The provider is pi-ai's. It is imported by subpath (`@pikit/pi-adapter/providers/openai`), so your
app carries this provider and no other. Pi handles requests (OpenAI's Responses API), retries,
prompt caching and credentials.

## Credentials

pi-ai looks for them in this order:
1. A credential stored for `openai` in `model.credentials` (for example `credentials-file`). This is
   either OAuth tokens from a "Sign in with ChatGPT" login (a ChatGPT Plus/Pro subscription), or an
   API key. pi-ai refreshes OAuth tokens before they expire and writes the new ones back.
2. Only when nothing is stored, the environment: `OPENAI_API_KEY`.

The agent runtime refuses to start when neither exists. With `secrets` installed, it reads the
variable there first, then the environment.

Signed in with ChatGPT, the subscription's usage limits apply, and the classifier models
(`openai-decisions`) are not offered: they need an API key.

To sign in with ChatGPT, run `pikit configure --login openai` (or let `pikit configure` offer it when
it sets up the model). It prints a URL to open in a browser; the browser comes back to a callback on
`127.0.0.1:1455`. Where the browser cannot reach it (a login where the app runs, in Docker), paste the
page's final URL from the address bar when asked. OpenAI names the installation by a device id: the
login keeps one in `.pikit/device-id`, and introduces itself as `pikit`. Never reuse Pi's own
`~/.pi/agent/auth.json`: a refresh would rotate the token the Pi CLI holds.

pi-ai's `openai-codex` provider ("OpenAI Codex (legacy)") is the older way to a ChatGPT
subscription; this login supersedes it.

## Cloudflare

The component is the same on both targets. With an API key, set `OPENAI_API_KEY` as a Worker secret
(`wrangler secret put OPENAI_API_KEY`, or `.env`, which `pikit up` uploads), which `secrets-workers`
reads.

Sign in with ChatGPT works on `durable` with `credentials-do` (`pikit add credentials-do`): one
Durable Object keeps the tokens, and an expiring token is refreshed once for every conversation,
under that object's lock (refresh tokens rotate: two refreshes at once would revoke one another's).
After `pikit up`, `pikit configure --login openai` signs in on your machine (the browser comes back to
`127.0.0.1:1455` there) and uploads the tokens to the deployed app. pi-ai's OAuth flow, which it
loads with an import no bundler follows, is bundled by credentials-do
(`@pikit/pi-adapter/oauth-flows`). `pikit dev` (wrangler dev) has objects of its own: it takes the
API key.

**Check OpenAI's terms first:** whether a personal ChatGPT subscription may serve a deployed bot,
other people or automated traffic is for its terms to say, and they change. An API key is OpenAI's
way for a deployed app.

## Tests

`provider-openai.test.ts` is copied with the component and runs in your project. It makes no request
and reads no credential: it checks the provider, and that without `model.credentials` a key
configures it. In the pikit repository, the workerd lane (`tests/workerd/test/provider-openai.workerd.ts`)
composes it with runtime-pi in a real Durable Object, where an agent answers from a fake Responses
API with a key from `secrets`.

`component.json` is generated from `setup` by `pikit registry generate` and is not written by hand;
the test "what setup declares" pins it.
