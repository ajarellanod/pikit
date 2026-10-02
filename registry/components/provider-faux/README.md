# provider-faux

A fake model, **for tests only**: an agent that names `faux/echo` gets `faux: <the newest user
message>` for every turn, at once, with no network, no key and no cost.

- **Provides:** `model.provider`, under the key `faux` (model `faux/echo`).
- **Requires:** nothing.
- **Targets:** `server` and `durable`.
- **Installs to:** `src/pikit/provider-faux/`.

## What it is for

A test of the whole project that sends a real message through a real channel, runtime and delivery
and checks the answer, without a model account. pikit's own end-to-end tests install it in a project
made by `pikit new`, point the starter agent at it, and assert the answer:

```sh
pikit add provider-faux
# src/agents/assistant/agent.ts: model: "faux/echo"
pikit dev
curl -H "authorization: Bearer $PIKIT_HTTP_TOKEN" -d '{"conversationId":"t1","text":"hello"}' \
  http://127.0.0.1:3000/v1/messages      # {"requestId":"…","text":"faux: hello"}
```

Never in production: an agent on `faux/echo` answers nobody usefully. Put the agent back on a real
model and `pikit remove provider-faux` when the test is done.

## How it works

pi-ai 1.0's faux provider (`@pikit/pi-adapter/providers/faux`), scripted in `index.ts`: each answer is
computed from the request (`fauxAnswer`), and the next one is queued as it is taken, so the script
never runs out. Its credential check always passes (pi-ai's faux has an empty API-key auth), so
`runtime-pi` starts with it and `pikit doctor` asks for no key. A test that needs other answers (a
tool call, a failure) scripts its own with `fauxProvider` and `setResponses`, as `index.ts` does.
