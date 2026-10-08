/**
 * agents-live's tests. They are copied with the component and keep running in your project.
 *
 * `settings` is a double here (a map, validating each stored key against the declared schema, as
 * settings-store does): settings-store passes the contract's suite on its own.
 */

import { expect, test } from "bun:test";
import { defineApp, defineComponent, silentLogger } from "@pikit/core";
import { type AgentDirectory, type AgentTool, defineAgent, type DirectoryAgent, type Settings, SettingsError, type SettingsValue } from "@pikit/contracts";
import { createAgentDirectoryConformance } from "@pikit/contracts/testing";
import { createLifecycleConformance } from "@pikit/core/testing";
import { scriptedProvider } from "@pikit/pi-adapter/testing";
import { defineTool } from "@pikit/pi-adapter/tools";
import Type from "typebox";
import Value from "typebox/value";
import agentsLive from "./index.ts";

/** `settings` in memory: each stored key kept while the schema accepts it, as settings-store does. */
function memorySettings() {
  const stored = new Map<string, SettingsValue>();
  const declared = new Map<string, { schema: object; defaults: SettingsValue }>();
  const provider: Settings = {
    declare: (component, schema, defaults) => void declared.set(component, { schema, defaults }),
    async get<T extends SettingsValue>(component: string) {
      const found = declared.get(component);
      if (found === undefined) throw new SettingsError("unknown_component", component);
      let value: Record<string, unknown> = { ...found.defaults };
      for (const [key, each] of Object.entries(stored.get(component) ?? {})) {
        const candidate = { ...value, [key]: each };
        if (Value.Check(found.schema as never, candidate)) value = candidate;
      }
      return structuredClone(value) as T;
    },
    async set(component, value) {
      const found = declared.get(component);
      if (found === undefined) throw new SettingsError("unknown_component", component);
      if (!Value.Check(found.schema as never, { ...found.defaults, ...value })) throw new SettingsError("invalid_value", component);
      stored.set(component, structuredClone(value));
      return value;
    },
    sections: async () => [],
  };
  return { provider, stored, schema: () => declared.get("agents-live")?.schema, component: defineComponent({ name: "settings-test", setup: (pikit) => pikit.provide("settings", provider) }) };
}

const lookup = defineTool({ name: "lookup", description: "Looks up", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "found" }] }) }) as unknown as AgentTool;

/** The App's other parts: a code agent, a model provider (`faux/scripted`), a tool. */
const project = defineComponent({
  name: "project-test",
  setup(pikit) {
    pikit.provideKeyed("agent.definition", "assistant", defineAgent({ name: "assistant", model: "faux/scripted" }));
    pikit.provideKeyed("model.provider", "faux", scriptedProvider());
    pikit.provideKeyed("agent.tool", "lookup", lookup);
  },
});

/** An App of agents-live over a settings double, started. */
async function started(settings = memorySettings()) {
  let directory: AgentDirectory | undefined;
  const reader = defineComponent({
    name: "reader-test",
    setup(pikit) {
      const handle = pikit.use("agent.directory");
      return { start: () => void (directory = handle.get()) };
    },
  });
  const app = await defineApp({ components: [project, settings.component, agentsLive, reader], logger: silentLogger }).create();
  await app.start();
  const ctx = app.context();
  const put = async (agents: readonly DirectoryAgent[]) => {
    const value = Object.fromEntries(agents.map(({ name, ...fields }) => [name, fields]));
    await settings.provider.set("agents-live", value, { id: "ops" }, ctx);
  };
  return { app, ctx, settings, put, directory: directory as AgentDirectory };
}

for (const c of createAgentDirectoryConformance(async () => {
  const { app, ctx, put, directory } = await started();
  return { directory, ctx, put, model: "faux/scripted", tool: "lookup", definedAgent: "assistant", dispose: () => app.stop() };
})) {
  test(`agents-live ${c.group}: ${c.name}`, () => c.run());
}

for (const c of createLifecycleConformance(() => ({ component: agentsLive, providers: [project, memorySettings().component] }))) {
  test(`agents-live ${c.group}: ${c.name}`, () => c.run());
}

test("what setup declares: component.json's provides / requires / optional come from it", async () => {
  const app = await defineApp({ components: [project, memorySettings().component, agentsLive], logger: silentLogger }).create();
  expect(app.describe().components.find((component) => component.name === "agents-live")).toMatchObject({
    provides: ["agent.directory"],
    requires: ["settings"],
    optional: ["agent.definition", "model.provider", "agent.tool", "agent.extension"],
  });
});

test("its settings accept only this App's models, tools and extensions, and no code agent's name", async () => {
  const { app, settings } = await started();
  const schema = settings.schema() as never;
  try {
    expect(Value.Check(schema, {})).toBe(true);
    expect(Value.Check(schema, { support: { model: "faux/scripted", tools: ["lookup"], description: "Customers", systemPrompt: "Be kind." } })).toBe(true);
    expect(Value.Check(schema, { support: { model: "nobody/nothing" } })).toBe(false);
    expect(Value.Check(schema, { support: { model: "faux/scripted", tools: ["bash"] } })).toBe(false);
    expect(Value.Check(schema, { support: { model: "faux/scripted", extensions: ["plan"] } })).toBe(false);
    expect(Value.Check(schema, { support: { model: "faux/scripted", tools: ["lookup", "lookup"] } })).toBe(false);
    expect(Value.Check(schema, { support: {} })).toBe(false);
    expect(Value.Check(schema, { assistant: { model: "faux/scripted" } })).toBe(false);
    expect(Value.Check(schema, { Support: { model: "faux/scripted" } })).toBe(false);
  } finally {
    await app.stop();
  }
});

test("a stored agent a deploy made invalid (its model gone) is no agent; the others stay", async () => {
  const settings = memorySettings();
  const { app, put, directory, ctx } = await started(settings);
  await put([{ name: "support", model: "faux/scripted" }, { name: "billing", model: "faux/scripted" }]);
  settings.stored.set("agents-live", { support: { model: "faux/scripted" }, billing: { model: "gone/model" } });
  expect(await directory.list(ctx)).toEqual([{ name: "support", model: "faux/scripted" }]);
  expect(await directory.get("billing", ctx)).toBeUndefined();
  await app.stop();
});

test("it is no directory while the App is not running", async () => {
  const { app, directory, ctx } = await started();
  await app.stop();
  await expect(directory.list(ctx)).rejects.toThrow("agents-live: agent.directory used while the app is not running");
});
