# tool-fetch

The `fetch` tool, for the agents that name it: one HTTP(S) request to a web page or an API, with the
answer as text the model can read.

- **Provides:** `agent.tool`, under the key `fetch`.
- **Requires:** nothing.
- **Targets:** `server` and `durable`: it uses only `fetch`, streams and `HTMLRewriter`, which
  Workers and Bun both have.
- **Installs to:** `src/pikit/tool-fetch/`.
- **npm dependencies:** `@pikit/pi-adapter` (pinned with Pi), `typebox`.

## What it does

An agent gets this tool only when it names it:

```ts
defineAgent({ name: "research", model: "openrouter/z-ai/glm-5.3-flash", tools: ["fetch"] })
```

The model gives a `url` and, when it needs them, a `method`, `headers`, a `body`, and `raw`. It gets
back the status line (`HTTP 200 OK · text/html · <final URL>`) and the content:

- **HTML** as readable text: the title, the text by blocks (no head, scripts or styles), then its
  links, absolute, with their text. `raw: true` returns the HTML as it is.
- **JSON** pretty-printed; **other text** (plain, CSV, XML, JavaScript…) as it is.
- **Binary content** (images, PDFs, archives) is refused: the body is not downloaded, and the model
  is told what it was. Without a content type, a body with NUL bytes counts as binary.
- **HEAD** returns the status and the response headers.
- An error status (404, 500) is an answer like any other; a URL that is not `http:` or `https:`, a
  method it does not allow, a body on a GET, a network failure or the timeout are errors.

Its limits, the same on both targets:
- **Methods:** GET by default; HEAD, POST, PUT, PATCH and DELETE allowed. The tool's description asks
  the model to tell the user what it will send, and wait for their confirmation, before any method
  other than GET or HEAD. That is an instruction to the model, not an enforcement: an approvals
  component would be the enforcement.
- **20 s** for the whole call (the answer and the body); the run's cancellation stops it too.
- **2 MB** read from the body at most; the rest is never downloaded, and the model is told.
- **50,000 characters** given back to the model at most, with how many more there were.
- Redirects are followed.

## What it does not carry

**No credentials.** It adds no cookie, token or key of its own: it reaches what anyone on the
network could, plus the headers the model writes itself. A tool for an API that needs your key is a
component of its own that reads the key through `secrets` (as `tool-websearch-brave` does), so the
model never sees it.

It does not filter addresses: on a server, it reaches whatever the server reaches, private addresses
included (`localhost`, your LAN, a cloud's metadata endpoint). On Cloudflare, a Worker runs outside
your network, so it reaches what the internet reaches. If your server can reach something the agent must not, do not
install this tool there, or put the server behind a firewall that refuses it.

## Replay: `unsafe`

pikit resumes a run after a crash. A tool that is `"safe"` is called again; one that is
`"unsafe"` is reported to the model as interrupted, and the model decides what to do.

`fetch` is `"unsafe"` because a POST, PUT, PATCH or DELETE may have reached the server and had its
effect before the crash: sending it again could order twice, post twice or delete something that was
recreated since. A replay is decided per tool, not per call, so a GET is reported as interrupted
too; the model can simply fetch it again, which costs one call.

## Tests

`tool-fetch.test.ts` is copied with the component and runs in your project. The web is a local
server on a free port (`Bun.serve`): no test reaches the network. It covers what setup declares, the
replay, HTML (text, entities, links, hidden elements, tables), `raw`, JSON, plain text, error
statuses, binary content (by type and by bytes), redirects, POST and HEAD, the absence of
credentials, what it refuses, the 2 MB limit, the output limit, the timeout and cancellation.

`component.json` is generated from `setup` by the CLI and is not written by hand. Until the CLI
exists, the test "what setup declares" pins it.
