/**
 * agents-folders with agents-live, in a real App: runtime-pi runs the agents on SQLite, the model is
 * the scripted faux provider (`call: <tool> <json>` calls a tool), and `settings` is a double that
 * validates what is stored, as settings-store does. The agents of folders are the code's
 * (`agent.definition`), the operator's are data (`agent.directory`); the catalog of `src/skills/` is
 * what both name skills from.
 *
 * A repository test, not copied with the component: a component's files never import another's (SPEC
 * P4), so this one lives beside `files/`.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AppEvents, type ComponentDefinition, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { type AgentRuntime, type ConversationRef, type Settings, SettingsError, type SettingsValue } from "@pikit/contracts";
import { type ModelRequest, scriptedProvider, sqliteStorage } from "@pikit/pi-adapter/testing";
import Value from "typebox/value";
import agentsLive from "../agents-live/files/src/pikit/agents-live/index.ts";
import runtimePi from "../runtime-pi/files/src/pikit/runtime-pi/index.ts";
import { generated } from "./files/src/pikit/agents-folders/generate.ts";
import { GENERATED } from "./files/src/pikit/agents-folders/index.ts";

const projects: string[] = [];
afterAll(() => {
  for (const dir of projects) rmSync(dir, { recursive: true, force: true });
});
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const skillText = (name: string, body: string) => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n${body}\n`;
const agentText = (name: string, extra = "") => `import { defineAgent } from "@pikit/contracts";\nexport default defineAgent({ name: "${name}", model: "faux/scripted"${extra} });\n`;

/**
 * A project next to this test (its agent.ts files resolve `@pikit/contracts` from the repository), its
 * folders turned into src/extensions/agents.ts as `pikit agents` writes it; the generated component.
 */
async function project(files: Record<string, string>): Promise<{ dir: string; agents: ComponentDefinition }> {
  const dir = mkdtempSync(join(import.meta.dir, ".project-"));
  projects.push(dir);
  const all: Record<string, string> = {
    "pikit.json": JSON.stringify({ version: 1, targets: ["server"], components: {} }),
    "pikit.config.ts": 'import agents from "./src/extensions/agents.ts";\nexport default { components: [agents] };\n',
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const { text, problems } = generated(dir);
  expect(problems).toEqual([]);
  mkdirSync(dirname(join(dir, GENERATED)), { recursive: true });
  writeFileSync(join(dir, GENERATED), text);
  return { dir, agents: (await import(join(dir, GENERATED))).default as ComponentDefinition };
}

/** `settings` in memory: a stored key is kept while the declared schema accepts it, as settings-store does. */
function memorySettings(stored = new Map<string, SettingsValue>()) {
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
  };
  /** An operator's change, refused as settings-store's routes refuse what the schema does not accept. */
  const set = async (component: string, value: SettingsValue) => {
    const found = declared.get(component);
    if (found === undefined) throw new SettingsError("unknown_component", component);
    if (!Value.Check(found.schema as never, { ...found.defaults, ...value })) throw new Error(`settings-test: the schema refuses ${component}'s value`);
    stored.set(component, structuredClone(value));
  };
  return { stored, set, component: defineComponent({ name: "settings-test", setup: (pikit) => pikit.provide("settings", provider) }) };
}

/** What each model request was shown: its instructions and its skills section, and what the skill tool returned. */
type Entry = { role: string; sections?: { instructions?: string; skills?: string | null }; content?: unknown };
type Seen = { instructions: string; skills: string; tool: string };

/** An App of the generated agents, agents-live and runtime-pi; `ask` sends one message and waits for its run. */
async function start(agents: ComponentDefinition, settings: ReturnType<typeof memorySettings>) {
  const seen: Seen[] = [];
  const onRequest = (request: ModelRequest) => {
    const last: Seen = { instructions: "", skills: "", tool: "" };
    for (const message of request.messages as unknown as Entry[]) {
      if (message.role === "system" && message.sections?.instructions !== undefined) last.instructions = message.sections.instructions;
      if (message.role === "system" && message.sections?.skills !== undefined) last.skills = message.sections.skills ?? "";
      if (message.role === "toolResult") last.tool = JSON.stringify(message.content);
    }
    seen.push(last);
  };
  const results: (AppEvents["agent.settled"] | AppEvents["agent.failed"])[] = [];
  let runtime: AgentRuntime | undefined;
  let create: (() => Promise<string>) | undefined;
  const channel = defineComponent({
    name: "channel-test",
    setup(pikit) {
      const handle = pikit.use("agent.runtime");
      const conversations = pikit.use("agent.conversations");
      pikit.on("agent.settled", (result) => void results.push(result));
      pikit.on("agent.failed", (result) => void results.push(result));
      return {
        start(ctx) {
          runtime = handle.get();
          create = () => conversations.get().create(ctx);
        },
      };
    },
  });
  const provider = defineComponent({ name: "provider-test", setup: (pikit) => pikit.provideKeyed("model.provider", "faux", scriptedProvider({ onRequest })) });
  const app = await defineApp({ components: [sqliteStorage(), agents, provider, settings.component, agentsLive, runtimePi, channel], logger: silentLogger }).create();
  await app.start();
  cleanup.push(() => app.stop());
  const ask = async (agent: string, prompt: string, channelName?: string) => {
    const conversation: ConversationRef = {
      key: `test:${agent}:${results.length}`,
      agent,
      conversationId: await (create as () => Promise<string>)(),
      ...(channelName !== undefined && { channel: channelName }),
    };
    const before = results.length;
    await (runtime as AgentRuntime).dispatch({ requestId: `r${before}`, conversation, prompt }, app.context());
    const deadline = Date.now() + 10_000;
    while (results.length === before) {
      if (Date.now() > deadline) throw new Error(`no answer to ${agent}`);
      await Bun.sleep(10);
    }
    return results.at(-1);
  };
  return { seen, ask };
}

/** A system prompt as the model is shown it: pi-durable's instructions section. */
const shown = (prompt: string) => `<instructions>\n${prompt}\n</instructions>`;

const FOLDERS = {
  "src/agents/assistant/agent.ts": agentText("assistant", ', skills: ["review"]'),
  "src/agents/assistant/SYSTEM.md": "You are the project's assistant.",
  "src/agents/assistant/channels/telegram.md": "Answer briefly: this is Telegram.",
  "src/agents/assistant/skills/notes/SKILL.md": skillText("notes", "Write it down."),
  "src/skills/review/SKILL.md": skillText("review", "Read the diff twice."),
  "src/skills/faq/SKILL.md": skillText("faq", "Read the FAQ first."),
};

test("a live agent takes skills from the folders' catalog, loads one in a run, and knows no other; the folder's agent keeps its own", async () => {
  const { agents } = await project(FOLDERS);
  const settings = memorySettings();
  const { seen, ask } = await start(agents, settings);

  // The operator gives a live agent a skill of src/skills/; an agent's own skill (notes) is not the catalog's.
  await settings.set("agents-live", { support: { model: "faux/scripted", systemPrompt: "Help customers.", skills: ["faq"] } });
  await expect(settings.set("agents-live", { support: { model: "faux/scripted", skills: ["notes"] } })).rejects.toThrow("the schema refuses");

  expect(await ask("support", 'call: skill {"name":"faq"}')).toMatchObject({ kind: "completed" });
  const [listed, loaded] = seen.slice(-2) as [Seen, Seen];
  expect(listed.instructions).toBe(shown("Help customers."));
  expect(listed.skills).toContain("<name>faq</name>");
  expect(listed.skills).not.toContain("<name>review</name>");
  expect(loaded.tool).toContain("Read the FAQ first.");

  // The folder's agent: SYSTEM.md, its channel's text, the catalog skill it names and its own; not faq.
  await ask("assistant", "hello", "telegram");
  const assistant = seen.at(-1) as Seen;
  expect(assistant.instructions).toBe(shown("You are the project's assistant.\n\nAnswer briefly: this is Telegram."));
  expect(assistant.skills).toContain("<name>review</name>");
  expect(assistant.skills).toContain("<name>notes</name>");
  expect(assistant.skills).not.toContain("<name>faq</name>");
}, 30_000);

test("names: a live agent never takes a folder's name, and a folder added later under a live agent's name wins", async () => {
  // Before: support is the operator's.
  const before = await project({ "src/agents/assistant/agent.ts": agentText("assistant"), "src/skills/faq/SKILL.md": skillText("faq", "Read the FAQ first.") });
  const stored = new Map<string, SettingsValue>();
  const settings = memorySettings(stored);
  const first = await start(before.agents, settings);
  await expect(settings.set("agents-live", { assistant: { model: "faux/scripted" } })).rejects.toThrow("the schema refuses");
  await settings.set("agents-live", { support: { model: "faux/scripted", systemPrompt: "The operator's support." } });
  await first.ask("support", "hello");
  expect((first.seen.at(-1) as Seen).instructions).toBe(shown("The operator's support."));
  for (const step of cleanup.splice(0).reverse()) await step();

  // A deploy adds src/agents/support/: the folder's agent answers; the stored live one is left out.
  const after = await project({
    "src/agents/assistant/agent.ts": agentText("assistant"),
    "src/agents/support/agent.ts": agentText("support"),
    "src/agents/support/SYSTEM.md": "The folder's support.",
  });
  const second = await start(after.agents, memorySettings(stored));
  await second.ask("support", "hello");
  expect((second.seen.at(-1) as Seen).instructions).toBe(shown("The folder's support."));
}, 30_000);
