# provider-faux

Fake models, **for tests only**, with no network, no key and no cost: `faux/echo` answers
`faux: <the newest user message>`, and `faux/scripted` does what the message tells it (call a tool,
show the system prompt it got), so a tool or an agent extension can be tested end to end.

- **Provides:** `model.provider`, under the key `faux` (models `faux/echo` and `faux/scripted`).
- **Requires:** nothing.
- **Targets:** `server` and `durable`.
- **Installs to:** `src/pikit/provider-faux/`.

## The models

`faux/echo` answers every turn with `faux: <the newest user message>`, at once.

`faux/scripted` reads the newest message:

| The message | What the model does |
|---|---|
| `call: <tool> <json arguments>` | calls `<tool>` with those arguments (`{}` when none are given) |
| (the tool's result) | answers `<tool>: <result text>`, or `<tool> failed: <error text>` |
| `echo-system` | answers with the system prompt it was sent: the instructions, then every section as it stands |
| `echo-system <section>` | answers with that section only (`<memory>\n…\n</memory>`), or `(no section <section>)` |
| `echo-tools` | answers with the names of the tools it was offered, sorted, comma-separated, or `(no tools)` |
| anything else | answers as `faux/echo` |

Arguments that are not a JSON object are answered (`faux/scripted: the arguments of … are not JSON`),
never called.

## What it is for

**A test of your own tool or agent extension**, through runtime-pi in a real App (a test of the
project's own, `test/<name>.test.ts`): compose `providerFaux` with runtime-pi, your components and an
agent on `faux/scripted`, send `call: remember {"fact":"Ana prefers tea"}` and assert the answer
(`remember: Remembered …`), then `echo-system memory` and assert what your extension put in the
prompt. `registry/components/provider-faux/app.test.ts` in the pikit repository is that test.

**A test of the whole project**, through a real channel, runtime and delivery, without a model
account. pikit's own end-to-end tests install it in a project made by `pikit new`, point the starter
agent at it, and assert the answer:

```sh
pikit add provider-faux --yes
# src/agents/assistant/agent.ts: model: "faux/scripted" (or "faux/echo")
pikit dev
curl -H "authorization: Bearer $PIKIT_HTTP_TOKEN" -d '{"conversationId":"t1","text":"hello"}' \
  http://127.0.0.1:3000/v1/messages      # {"requestId":"…","text":"faux: hello"}
```

Never in production: an agent on a `faux/*` model answers nobody usefully. Put the agent back on a
real model and `pikit remove provider-faux` when the test is done.

## How it works

pi-ai 1.0's faux provider (`@pikit/pi-adapter/providers/faux`), scripted in `index.ts`: each answer is
computed from the request (`fauxAnswer`, `scriptedReply`), and the next one is queued as it is taken,
so the script never runs out. The system prompt is what pi-durable's system messages say, replayed
in order (`systemPrompt`): each adds instructions, replaces or removes sections, adds or removes
tools. Its credential check always passes (pi-ai's faux has an empty API-key auth), so `runtime-pi`
starts with it and `pikit doctor` asks for no key.

## Tests

`provider-faux.test.ts`, copied with it: what setup declares, `faux/echo`'s answers, and each rule
of `faux/scripted`'s grammar, through pi-ai's models. In the pikit repository, `app.test.ts` runs it
through runtime-pi with a tool and an extension.
