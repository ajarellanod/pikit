# A tool of your own in one call (`toolComponent`)

**Public appeal:** —

**Status:** built, in `@pikit/pi-adapter/tools`. No change to the kernel or the contracts.

**Needed by:** anyone who adds a tool to an agent. Before, the choices were a Pi extension's tool
(always `replay: "never"`, hidden inside the extension, the agent names the extension) or a full
`defineComponent` providing `agent.tool` in the harness's six-argument shape.

## What it gives
A tool written in the shape of Pi's `defineTool` becomes a component that provides `agent.tool`, and
an agent names it in `tools`:

```ts
import { toolComponent } from "@pikit/pi-adapter/tools";
import { Type } from "typebox";

export default toolComponent(
  {
    name: "greeting",
    label: "Greeting",
    description: "Greets someone",
    parameters: Type.Object({ name: Type.String() }),
    async execute(toolCallId, params, signal, onUpdate, context) {
      return { content: [{ type: "text", text: `Hello, ${params.name}!` }], details: undefined };
    },
  },
  { replay: "safe" },
);

// defineAgent({ ..., tools: ["greeting"] })
```

## How it fits pikit
- **It is a component**, `tool-<name>` (`_` becomes `-`: `web_search` is `tool-web-search`), that
  provides `agent.tool` under the tool's name. `pikit doctor` lists it; removing it is removing the
  file. No new verb, no registration by import (no magic).
- **`replay` is required** (SPEC §8.4): `"safe"` runs it again after a crash (it only reads);
  `"never"` tells the model it was interrupted (it changes something: derive an idempotency key from
  the run's conversation and `toolCallId`).
- **The fifth `execute` argument is the run's context**: its conversation
  (`context.value(CONVERSATION)`) and its cancellation. `signal` is the same cancellation, in Pi's
  place.
- **A tool that needs a capability** (an environment, a secret) is a `defineComponent` of its own that
  `use`s it, as `tool-read` does with `bindTool`; `toolComponent` declares none.

## Pi first
Pi already has `defineTool` (`@earendil-works/pi-coding-agent`, re-exported by
`@pikit/pi-adapter/extensions`), and an extension's `pi.registerTool` works in pikit today. So
`toolComponent` takes Pi's shape (same fields, same `execute` order) instead of a new one, and has
another name so the two are never confused. It adds only what pikit owns: the component, the
`agent.tool` key, and `replay`.

The one difference is deliberate. Pi's fifth argument is its `ExtensionContext`, which only an
extension's host has. Pi's `defineTool` always types it, so:
- a Pi tool's **object** moves in as it is, written inside `toolComponent`;
- an object **typed by Pi's `defineTool`** does not compile with `toolComponent`: the compiler says
  so, not a conversation;
- a tool that really uses the `ExtensionContext` stays an extension's tool.

## Where it is
- `packages/pi-adapter/src/tools/index.ts` (`ToolDefinition`, `toolComponent`).
- `packages/pi-adapter/src/tools/tools.test.ts`: component name, key, `replay`, Pi's argument order,
  `onUpdate`; Pi's `hello` object unchanged; the one typed by `defineTool` refused
  (`@ts-expect-error`).
- `packages/pi-adapter/src/run-context.test.ts`: an agent names the tool, Pi runs it, and it gets the
  run's conversation.

## Open questions
- Config for such a tool (an API URL, a limit): today it is a `defineComponent`. An optional
  `config` schema could come if users ask for it.
- Whether `pikit add` should scaffold one (`pikit new tool <name>`).
