# extension-house-rules

House rules for the agents that name them: the rules you write in config become a system prompt
section, and the tools you list are refused before they run, whatever the model asks. It is also
**the reference agent extension**: copy it to add behaviour to your agents (the skill
`.agents/skills/pikit-extension/SKILL.md` walks through it).

- **Provides:** `agent.extension`, under the key `house-rules`.
- **Requires:** nothing.
- **Targets:** `server` and `durable`: it imports nothing platform-specific.
- **Installs to:** `src/pikit/extension-house-rules/` (`index.ts`, `extension-house-rules.test.ts`).

## Use it

```sh
pikit add extension-house-rules
```

Write the rules in `pikit.config.ts`, under the component's name:

```ts
export const config = {
  "extension-house-rules": {
    rules: ["Answer in English.", "Never share a customer's email address."],
    deniedTools: ["bash", "write"],
  },
};
```

and name the extension in the agents that follow them (`src/agents/<agent>/agent.ts`):

```ts
defineAgent({ name: "support", model: "…", tools: ["read", "bash"], extensions: ["house-rules"] })
```

Every model request of `support` then carries:

```
<house-rules>
- Answer in English.
- Never share a customer's email address.
- Do not call these tools, they are refused here: bash, write.
</house-rules>
```

and a call to `bash` gets the error result `The tool "bash" is not allowed here (house rules).`
without running. An agent that does not name `house-rules` has neither, even with the component
installed. Installed with the default config (no rules, no tools), it adds nothing.

## How this extension is built

1. **The extension** is pi-durable's `defineExtension`, imported from
   `@pikit/pi-adapter/extensions` (a component never imports `@earendil-works/*`):

   ```ts
   import { defineExtension, hook, section, ToolTask } from "@pikit/pi-adapter/extensions";

   defineExtension({
     name: "house-rules",                                  // what agents name; also its key
     sections: [section("house-rules", () => text)],       // <house-rules>…</house-rules>; undefined omits it
     hooks: [hook(ToolTask, { beforeTool: (call) => (denied(call.name) ? { block: "why" } : undefined) })],
   });
   ```

2. **The section is the same text on every request.** It is computed from config once, in
   `createHouseRules`. pi-durable sends a section again only when its text changes, so a stable
   section keeps the provider's prompt cache warm; a section that changes on every request (the time,
   a search over the latest message) defeats it.
3. **The hook decides from the call alone.** `beforeTool` runs before the call's intent is recorded,
   and again if the call is retried after a crash, so it has no effect of its own: it returns
   `{ block: reason }` (the model reads the reason as the call's error result) or `undefined`. A hook
   that throws blocks the call too.
4. **The component provides it under its name**:
   `pikit.provideKeyed("agent.extension", "house-rules", createHouseRules(config))`. runtime-pi
   refuses to start when an agent names an extension nobody provides, or when the key and the
   extension's name differ; names starting with `pikit.` are the runtime's own.
5. **Config holds values**, checked by its TypeBox schema when the App is defined: an empty rule or a
   tool name a model could not call is refused, naming the component.

## Tests

- `extension-house-rules.test.ts` (copied into your project): what `setup` declares, the section's
  text, the hook's decision, and config that is refused.
- `app.test.ts` (beside `files/`, in the registry only, because a component's files never import
  another's): the extension in a real App, with runtime-pi on a SQLite file and the scripted faux
  model (`scriptedProvider` from `@pikit/pi-adapter/testing`, model `faux/scripted`): the section is
  in every request of an agent that names it and sent once, a denied `bash` never runs and the model
  reads why, and an agent that does not name it is untouched. In your project, the same test is the
  project's own and imports `src/pikit/runtime-pi/index.ts`, shaped like
  `src/pikit/runtime-pi/extensions.test.ts`.
