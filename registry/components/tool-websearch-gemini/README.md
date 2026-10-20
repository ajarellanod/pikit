# tool-websearch-gemini

The `websearch` tool, for the agents that name it: Gemini searches Google (the Gemini API's
`google_search` grounding) and answers in a few lines, then lists the sources it used. The API key
stays a secret: the model never sees it. It is an **alternative to `tool-websearch-brave`**: the same
tool name and parameters, so no agent changes. Install one of the two: both provide `agent.tool`
`websearch`, and an app with both does not start.

- **Provides:** `agent.tool`, under the key `websearch`.
- **Requires:** `secrets` (for example `secrets-env`), holding `GEMINI_API_KEY`.
- **Targets:** `server` and `durable`: only `fetch`, wherever a `secrets` provider is installed.
- **Installs to:** `src/pikit/tool-websearch-gemini/` (`index.ts` the component, `websearch.ts` the
  tool, `configure.ts` its step of `pikit configure`, and their tests).

```sh
pikit add secrets-env              # where GEMINI_API_KEY is read from, on a server
pikit remove tool-websearch-brave  # when it is installed: both are `websearch`
pikit add tool-websearch-gemini
```

## Config

In `pikit.config.ts`, under `"tool-websearch-gemini"`; every field has a default:

| Field | Default | What it is |
|---|---|---|
| `apiKey` | `"GEMINI_API_KEY"` | The **name** of the variable (or Worker secret) holding the Gemini API key, never the key itself: config is not secret. |
| `model` | `"gemini-3.5-flash-lite"` | The Gemini model that searches: one that can use the `google_search` tool. |
| `apiBase` | `"https://generativelanguage.googleapis.com"` | The Gemini API: a proxy or a test double replaces it. |

```ts
"tool-websearch-gemini": { apiKey: "GEMINI_API_KEY", model: "gemini-3.5-flash" },
```

`pikit configure` asks for `GEMINI_API_KEY`; with another `apiKey`, set that variable yourself (`.env`,
or `wrangler secret put` on Cloudflare).

## How this tool is built

As `tool-websearch-brave`, the reference for a tool that needs a secret:

1. **`websearch.ts` is the tool**, pi-durable's `defineTool` from `@pikit/pi-adapter/tools`. It takes
   the key as a function, `apiKey()`, asked at each call: the tool never holds the key, and never
   puts it in its description, parameters, answers, errors or memos. The key goes in the
   `x-goog-api-key` header, never in a URL; an answer or an error that echoes it has it replaced by
   `[redacted]` before the model or the transcript sees it.
2. **`index.ts` reads the key through `secrets`** (`secrets.get().get(config.apiKey)` inside
   `apiKey`): an environment variable on a server, a Worker secret on Cloudflare.
3. **Config holds values, not secrets**: the key's variable name, the model and the API's address
   (above).
4. **`component.json` declares the variable** (`GEMINI_API_KEY`, secret, optional), and
   **`configure.ts` asks for it** in `pikit configure` (where to get one, asked without echo, Enter
   skips). Without it the app starts, and each search fails saying the key is not set.
5. **Errors say what to do** and never show the key: a refused key (401, 403, or Gemini's 400 "API key
   not valid"), a quota reached (429), a missing key; with Gemini's own message (a wrong model name).
6. **Replay `"safe"`**: a search only reads, so a run resumed after a crash searches again.
7. **Its tests**: Gemini is a local stand-in on a free port (`Bun.serve`) reached through `apiBase`,
   with the grounding redirects too; the tool is tested installed (with a `secrets` double), called
   as the runtime calls it (`callTool`), and in a real Harness turn (`runToolCalls`), whose transcript
   is searched for the key.

## What it does

The model gives a `query` and, if it wants, a `count` (1 to 20, default 5): how many sources at most.
The tool asks `POST <apiBase>/v1beta/models/<model>:generateContent` with the `google_search` tool,
and gives up after 60 s. It returns Gemini's answer, then:

```
Sources:

1. bun.com
   https://bun.com/blog/bun-v1.4
```

one block per source, as `tool-websearch-brave` writes its results, so the dashboard and the web chat
show them as sources. Gemini names each source by its site, and gives its address as a redirect of
its own (`vertexaisearch.cloud.google.com/grounding-api-redirect/…`): the tool asks each redirect
where it leads (a `HEAD`, not followed, 5 s at most) and lists the real address, or the redirect when
that fails. Thoughts Gemini returns are left out; an empty answer says there are no results.

Unlike Brave, it answers rather than lists: one search costs a Gemini request, and the model reads a
summary with its sources instead of snippets. Get a key at aistudio.google.com/apikey (the free tier
works, within its rate limits).

`component.json` is generated from `setup` (`bun run registry generate`); the test "what setup
declares" pins it.
