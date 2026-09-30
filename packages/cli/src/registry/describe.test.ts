import { expect, test } from "bun:test";
import { type ComponentDefinition, defineComponent } from "@pikit/core";
import Type, { type TSchema } from "typebox";
import { checkDrift } from "./commands.ts";
import { configExamples, describeComponent } from "./describe.ts";
import type { Manifest } from "./manifest.ts";

/** A component like tool-mcp: one agent.tool per tool its config names, none by default. */
function keyed(examples?: unknown[]): ComponentDefinition {
  const Config = Type.Object(
    {
      servers: Type.Record(Type.String(), Type.Object({ tools: Type.Array(Type.String({ minLength: 1 })) }), { default: {} }),
      store: Type.Boolean({ default: false }),
    },
    examples === undefined ? {} : { examples },
  );
  return defineComponent({
    name: "tool-keyed",
    config: Config as TSchema,
    setup(pikit, config: { servers: Record<string, { tools: string[] }>; store: boolean }) {
      pikit.useOptional("secrets");
      if (config.store) pikit.use("storage.kv");
      for (const [server, { tools }] of Object.entries(config.servers)) {
        for (const tool of tools) pikit.provideKeyed("agent.tool", `${server}_${tool}`, { replay: "never" } as never);
      }
      if (Object.keys(config.servers).length > 0) pikit.provide("mcp.servers" as never, {} as never);
    },
  });
}

test("without examples, a component is described by its default config alone", async () => {
  const described = await describeComponent(keyed(), "server");
  expect(described).toEqual({ provides: [], requires: [], optional: ["secrets"] });
  expect(configExamples(keyed())).toEqual([]);
});

test("examples add what setup declares with them, in order, without repeats; their tools are not written", async () => {
  const component = keyed([
    { servers: { wiki: { tools: ["ask"] } } },
    { servers: { docs: { tools: ["read", "search"] } }, store: true },
  ]);
  const described = await describeComponent(component, "server");
  expect(described).toEqual({
    provides: ["agent.tool", "mcp.servers"],
    requires: ["storage.kv"],
    optional: ["secrets"],
    exampleTools: { wiki_ask: "never", docs_read: "never", docs_search: "never" },
  });
  // Deterministic: the same examples give the same text.
  expect(JSON.stringify(await describeComponent(component, "server"))).toBe(JSON.stringify(described));
  // Examples fill in defaults as the app does.
  expect(configExamples(component)[0]).toEqual({ servers: { wiki: { tools: ["ask"] } }, store: false });
});

test("a capability optional by default but required by an example is required", async () => {
  const component = defineComponent({
    name: "tool-either",
    config: Type.Object({ strict: Type.Boolean({ default: false }) }, { examples: [{ strict: true }] }) as TSchema,
    setup(pikit, config: { strict: boolean }) {
      if (config.strict) pikit.use("secrets");
      else pikit.useOptional("secrets");
    },
  });
  expect(await describeComponent(component, "server")).toEqual({ provides: [], requires: ["secrets"], optional: [] });
});

test("an invalid example, or one setup refuses, is a problem that names it", async () => {
  expect(() => configExamples(keyed([{ servers: { wiki: { tools: [""] } } }]))).toThrow(
    "examples[0] of tool-keyed's config schema is not a valid config: /servers/wiki/tools/0:",
  );
  expect(() => configExamples(keyed({ servers: {} } as never))).toThrow("the examples of tool-keyed's config schema are not an array of configs");
  const refusing = defineComponent({
    name: "tool-refusing",
    config: Type.Object({ name: Type.String() }, { examples: [{ name: "ok" }, { name: "bad" }] }) as TSchema,
    setup(_pikit, config: { name: string }) {
      if (config.name === "bad") throw new Error("bad name");
    },
  });
  await expect(describeComponent(refusing, "server")).rejects.toThrow("with examples[1] of its config schema: bad name");
});

test("an example tool's replay is checked but not written", async () => {
  const component = defineComponent({
    name: "tool-vague",
    config: Type.Object({ tools: Type.Array(Type.String(), { default: [] }) }, { examples: [{ tools: ["poke"] }] }) as TSchema,
    setup(pikit, config: { tools: string[] }) {
      for (const tool of config.tools) pikit.provideKeyed("agent.tool", tool, {} as never);
    },
  });
  const generated = await describeComponent(component, "server");
  const manifest = { provides: ["agent.tool"], requires: { pikit: "0.0.0", capabilities: [] }, optional: { capabilities: [] }, $schema: "../../schema/component.schema.json" } as unknown as Manifest;
  expect(checkDrift(manifest, generated)).toEqual(['the agent.tool "poke" has replay "undefined"; every tool declares "safe" or "never"']);
});

test("the model.provider keys setup provides are generated, so pikit new can check a model before writing", async () => {
  const provider = defineComponent({
    name: "provider-pair",
    setup(pikit) {
      pikit.provideKeyed("model.provider" as never, "alpha", {} as never);
      pikit.provideKeyed("model.provider" as never, "beta", {} as never);
    },
  });
  const generated = await describeComponent(provider, "server");
  expect(generated).toEqual({ provides: ["model.provider"], requires: [], optional: [], modelProviders: ["alpha", "beta"] });
  const manifest = { provides: ["model.provider"], requires: { pikit: "0.0.0", capabilities: [] }, optional: { capabilities: [] }, $schema: "../../schema/component.schema.json" } as unknown as Manifest;
  expect(checkDrift(manifest, generated)).toEqual([
    'modelProviders drifted from setup: component.json has nothing, setup declares ["alpha","beta"]; run `bun run registry generate`',
  ]);
  expect(checkDrift({ ...manifest, modelProviders: ["alpha", "beta"] }, generated)).toEqual([]);
});
