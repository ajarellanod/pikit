# A tool of your own in one call (`toolComponent`)

**Public appeal:** —

**Status:** built, in `@pikit/pi-adapter/tools`. No change to the kernel or the contracts. **A bridge:**
it is deleted when the adapter moves to Pi's durable runtime ("Migration" below).

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
- **A tool that needs a capability** (an environment, a secret) or config is a `defineComponent` of
  its own that `use`s it and provides `agentTool(tool, { replay })`, the same tool without the
  component (`tool-websearch-brave` reads its key through `secrets`); `toolComponent` declares none.
  Pi's own tools bound to an environment use `bindTool` instead, as `tool-read` does.

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

## Which to use

| You want | Use |
|---|---|
| A tool of your own for pikit that needs nothing from the app | `toolComponent` |
| A tool that needs a capability (a secret, `execution`, `workspace`, `storage.kv`) | a `defineComponent` that `use`s it and provides `agent.tool` (as `tool-read` does) |
| A Pi extension brought unchanged, or one that must also run in Pi's CLI | Pi's `defineTool` + `pi.registerTool`, inside the extension |

Pi's `defineTool` is in a pikit project only because the shim (`@earendil-works/pi-coding-agent`)
exports Pi's extension API, so extensions written for Pi load unmodified. It is not pikit's way to
write a tool: an extension's tools are always `replay: "never"`, so after a crash or an eviction the
model is told the call was interrupted, even for one that only reads. `pikit doctor` notes every
project file that calls `pi.registerTool`, and points to `toolComponent`.

## Migration: a bridge until Pi's durable runtime

Pi is moving to a durable runtime, `@earendil-works/pi-durable` (Pico; published, still changing:
its changelog lists unreleased breaking changes; Pi's coding agent is being moved onto it,
`packages/durable/docs/pico-v5-handoff.md` §16). There, extension code registers tools through one
registry (`registry.tools.add(tool)`, `packages/durable/docs/pico-v5.md` §7), and a tool is one object:

```ts
type ToolRegistration = Tool & {
  readonly replay?: "safe" | "unsafe"; // omitted: "unsafe"
  execute(args: JsonValue, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult>;
};
```

It carries its own `replay`, and its `api` knows its conversation (`api.conversationId`): the two things
`toolComponent` adds today. On recovery it reruns only when the stored intent and the current
declaration both say `safe`, as pi-agent-core does now. So, when pikit's adapter moves to it:

- **A tool is Pi's object, unchanged.** An agent takes it directly (`tools: ["read", clima]`;
  `AgentDefinition.tools` already accepts objects), or a `defineComponent` provides it as `agent.tool`
  when it is shared by name, installed from a registry, or needs a capability.
- **`toolComponent` and its `ToolDefinition` are deleted**, and `replay` takes Pi's words (`"unsafe"`
  where pikit says `"never"`), in that one change, with the other `tool-*` components.
- **If Pi ships a helper that types such an object**, it is used under Pi's own name: pikit adds none.

Decided on the way there (September 2026):
- `toolComponent` is not renamed (`createToolComponent` was considered): a name for something that
  goes away is not worth a change.
- No second word for `"never"` now: two words for one thing is the confusion this avoids, and Pi's
  vocabulary may still change before the migration.
- `defineTool` stays exported by `@pikit/pi-adapter/extensions`: that module is the shim's source, and
  removing it there would mean re-implementing it in the shim for no gain.
- No issue or pull request to Pi: its contribution gate closes new contributors' issues and PRs
  (a PR needs a maintainer's `lgtm` first), and `pi-durable` already gives tools a `replay`. What is
  left is the current `ToolDefinition` of Pi's extension API, which that migration replaces.

## Where it is
- `packages/pi-adapter/src/tools/index.ts` (`ToolDefinition`, `toolComponent`, `agentTool`).
- `packages/pi-adapter/src/tools/tools.test.ts`: component name, key, `replay`, Pi's argument order,
  `onUpdate`; Pi's `hello` object unchanged; the one typed by `defineTool` refused
  (`@ts-expect-error`).
- `packages/pi-adapter/src/run-context.test.ts`: an agent names the tool, Pi runs it, and it gets the
  run's conversation.

## Open questions
- Config for such a tool (an API URL, a limit): today it is a `defineComponent` providing
  `agentTool(...)` (as `tool-websearch-brave` does). Not added to a bridge; after the migration, a
  `defineComponent` with a config schema provides Pi's object.
- When the adapter moves to `pi-durable`: decided with the rest of that move (sessions, submissions,
  Cloudflare storage; `features/pi-durable-migration.md`), not for tools alone.
