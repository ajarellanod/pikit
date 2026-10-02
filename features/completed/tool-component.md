# A tool of your own

**Public appeal:** —

**Status:** built. A tool is pi-durable's own `ToolRegistration`, written with `defineTool` from
`@pikit/pi-adapter/tools`, and a component provides it as `agent.tool`. pikit adds no wrapper.

**Needed by:** anyone who adds a tool to an agent.

## What it gives
A tool written in Pi's shape, in a component the user owns, that an agent names in `tools`:

```ts
// src/pikit/tool-greeting/index.ts
import { defineComponent } from "@pikit/core";
import { defineTool } from "@pikit/pi-adapter/tools";
import Type from "typebox";

export const greeting = defineTool({
  name: "greeting",
  description: "Greets someone by name.",
  parameters: Type.Object({ name: Type.String() }),
  replay: "safe", // it only computes: a call a crash interrupted runs again
  async execute(args, api, context) {
    // api.conversationId, api.env (files and shell); context.abortSignal (the call's cancellation)
    return { content: [{ type: "text", text: `Hello, ${args.name}!` }] };
  },
});

export default defineComponent({
  name: "tool-greeting",
  setup(pikit) {
    pikit.provideKeyed("agent.tool", "greeting", greeting);
  },
});

// defineAgent({ ..., tools: ["greeting"] })
```

## The references to copy
- **`tool-fetch`** (`registry/components/tool-fetch`): a tool that needs nothing from the app. `fetch.ts`
  is the tool, `index.ts` the component, `tool-fetch.test.ts` its tests from the inside out (`execute`
  directly, installed in an app, a real Harness turn with `runToolCalls`). Its README is "how this
  tool is built".
- **`tool-websearch-brave`**: a tool that needs a secret (read through `secrets` at each call, never
  in the tool), config values (`apiBase`), and a step of `pikit configure` (`configure.ts`).
- **`tool-read`, `tool-write`, `tool-edit`, `tool-bash`**: Pi's own coding tools, provided as they are
  with pikit's replay (`codingTool(name)` in the adapter); they work on `api.env`, which the runtime
  builds per call from `workspace` or `execution`.

## How it fits pikit
- **It is a component**, `tool-<name>`, that provides `agent.tool` under the tool's own name, which
  runtime-pi checks at start. An agent gets only the tools it names. `pikit doctor` lists it;
  removing it is removing its directory.
- **`replay` is the tool's decision**, one value for every call: `"safe"` runs an interrupted call
  again (it only reads or computes); `"unsafe"` (pi-durable's default) gives the model an
  `interrupted` result with the output so far. A tool with an effect is `"unsafe"`, or makes its
  effect idempotent from the call's identity. `component.json`'s `replay.tools` repeats it, so
  `pikit add` can show it.
- **What it needs comes through capabilities**: a secret through `secrets`, records through
  `storage.kv`/`storage.sql`, files through `api.env`. Never `process.env` or a binding directly: that
  would make it server-only or Cloudflare-only.
- **The tool shape has no conformance suite of its own** (`features/building-components.md`, "Contracts
  without a suite"): `runToolCalls` (`@pikit/pi-adapter/execution/testing`) runs a real Harness turn,
  which validates the parameters and records the result.

## Pi first
pi-durable's `defineTool` and `ToolRegistration` are the tool: pikit adds no shape of its own. A tool
that is not shared by name can also go straight into an agent's `tools` as an object.

## Where it is
- `packages/pi-adapter/src/tools/index.ts`: `defineTool` and its types, `codingTool`.
- `registry/components/tool-fetch`, `registry/components/tool-websearch-brave`: the references.
- `packages/pi-adapter/src/testing/execution.ts`: `callTool`, `runToolCalls`.
