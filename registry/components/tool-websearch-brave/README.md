# tool-websearch-brave

The `websearch` tool, for the agents that name it: it searches the web with the Brave Search API and
returns the most relevant results. The API key stays a secret: the model never sees it.

- **Provides:** `agent.tool`, under the key `websearch`.
- **Requires:** `secrets` (for example `secrets-env`), holding `BRAVE_API_KEY`.
- **Targets:** `server` and `cloudflare`: it uses only `fetch`, wherever a `secrets` provider is
  installed.
- **Installs to:** `src/pikit/tool-websearch-brave/`.
- **npm dependencies:** `@pikit/pi-adapter` (pinned with Pi), `typebox`.

```sh
pikit add secrets-env            # where BRAVE_API_KEY is read from, on a server
pikit add tool-websearch-brave
```

## What it does

An agent gets this tool only when it names it:

```ts
defineAgent({ name: "research", model: "openrouter/z-ai/glm-5.3-flash", tools: ["websearch", "fetch"] })
```

The model gives a `query` and, if it wants, a `count` (1 to 20, default 5). It gets back one entry
per result: its title, its address, how old the page is when Brave knows, and a snippet, as plain
text (Brave's `<strong>` highlighting removed). A search with no results says so.

It asks `GET <apiBase>/res/v1/web/search?q=…&count=…` with the key in the `X-Subscription-Token`
header, and gives up after 20 s. Its tool is named `websearch`, not after Brave, so another search
component could provide the same name and your agents would not change.

## The key

Get one at api-dashboard.search.brave.com (the free plan works; it has a monthly quota and a rate
limit). Set it as the secret `BRAVE_API_KEY` of whatever provides `secrets`: an environment variable
with `secrets-env`, a Worker secret with `secrets-cloudflare` (`pikit up` uploads `.env`'s).

`pikit configure` asks for it (`configure.ts`, this component's step): in a terminal it says where to
get one and asks without echo, and Enter skips; a key already in `.env` or exported is kept. It is
optional, so `pikit configure` and `pikit doctor` never fail without it.

- It is read through `secrets` at every call, and sent only to Brave. It is not in the tool's
  description, its parameters, its answers or its errors, so it never reaches the model or a
  transcript.
- Without it, the app still starts (an agent that does not search needs no key); each search fails
  with `websearch: BRAVE_API_KEY is not set…`, which the model can pass on to you.
- A key Brave refuses (401, 403) or a quota reached (429) fails with Brave's status and what it means.

## Config

```ts
config: { "tool-websearch-brave": { apiBase: "https://api.search.brave.com" } }
```

`apiBase` is Brave's API by default. Change it only for a proxy in front of Brave, or a test double.

## Replay: `safe`

A search only reads, so a run resumed after a crash simply searches again.

## Tests

`tool-websearch-brave.test.ts` is copied with the component and runs in your project. Brave is a
local stand-in on a free port (`Bun.serve`), reached through `apiBase`: no test reaches the network
or needs a real key. It covers what setup declares, the replay, the request (path, query, count,
token), the results as plain text, no results, a missing key, a refused key and a quota, and that the
key never reaches what the model sees. `configure.test.ts` covers the configure step with a scripted
terminal: a key asked and saved, Enter skipping, a key kept, and nothing asked without a terminal.

`component.json` is generated from `setup` by the CLI and is not written by hand. Until the CLI
exists, the test "what setup declares" pins it.
