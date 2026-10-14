/**
 * agents-folders' tests. They are copied with the component and keep running in your project.
 *
 * Each test writes a small project next to this file (so its agent.ts resolves `@pikit/contracts` as
 * yours does), runs the generator on it, and imports what it wrote into a real App.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineApp, defineComponent, type ComponentDefinition, silentLogger } from "@pikit/core";
import type { AgentDefinition, AgentSkill, ConversationRef } from "@pikit/contracts";
import { doctor } from "./doctor.ts";
import { command, generated, stale } from "./generate.ts";
import { channelOfFile, GENERATED, literal, render } from "./index.ts";

const projects: string[] = [];
afterAll(() => {
  for (const dir of projects) rmSync(dir, { recursive: true, force: true });
});

const CONFIG = 'import agents from "./src/extensions/agents.ts";\nexport default { components: [agents] };\n';
const skillText = (name: string, body = "Do it well.") => `---\nname: ${name}\ndescription: The ${name} skill.\n---\n${body}\n`;
const agentText = (name: string, extra = "") => `import { defineAgent } from "@pikit/contracts";\nexport default defineAgent({ name: "${name}", model: "faux/scripted"${extra} });\n`;

/** A project of `files` (by path) next to this test, targeting `targets`. */
function project(files: Record<string, string>, targets: string[] = ["server"]): string {
  const dir = mkdtempSync(join(import.meta.dir, ".project-"));
  projects.push(dir);
  const all: Record<string, string> = { "pikit.json": JSON.stringify({ version: 1, targets, components: {} }), "pikit.config.ts": CONFIG, ...files };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** Runs `pikit agents` in `dir` as the CLI would: its problems, and what it said. */
async function run(dir: string, args: string[] = []): Promise<{ problems: string[]; said: string[] }> {
  const said: string[] = [];
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const problems = await command({ args, config: async () => ({}), get: () => undefined, say: (line) => void said.push(line) });
    return { problems, said };
  } finally {
    process.chdir(cwd);
  }
}

/** The agents and skills the generated file provides, read from a real App. */
async function provided(dir: string): Promise<{ agents: Map<string, AgentDefinition>; skills: Map<string, AgentSkill> }> {
  const component = (await import(join(dir, GENERATED))).default as ComponentDefinition;
  const agents = new Map<string, AgentDefinition>();
  const skills = new Map<string, AgentSkill>();
  const reader = defineComponent({
    name: "reader",
    setup(pikit) {
      const definitions = pikit.useKeyed("agent.definition");
      const catalog = pikit.useKeyed("agent.skill");
      return {
        start() {
          for (const name of definitions.keys()) agents.set(name, definitions.get(name) as AgentDefinition);
          for (const name of catalog.keys()) skills.set(name, catalog.get(name) as AgentSkill);
        },
      };
    },
  });
  const app = await defineApp({ components: [component, reader], logger: silentLogger }).create();
  await app.start();
  await app.stop();
  return { agents, skills };
}

const conversation = (channel?: string): ConversationRef => ({ key: "k", agent: "support", conversationId: "c", ...(channel !== undefined && { channel }) });

test("a folder is its agent: SYSTEM.md its prompt, its own skills after the ones it names, the catalog as agent.skill", async () => {
  const dir = project({
    "src/agents/support/agent.ts": agentText("support", ', skills: ["review"]'),
    "src/agents/support/SYSTEM.md": "Help customers.\n",
    "src/agents/support/skills/notes/SKILL.md": skillText("notes"),
    "src/agents/ops/agent.ts": agentText("ops", ', systemPrompt: "Watch the servers."'),
    "src/skills/review/SKILL.md": skillText("review", "Read the diff `twice` and ${carefully}."),
  });

  expect(await run(dir)).toEqual({ problems: [], said: [`wrote ${GENERATED} (2 agents, 1 skill in the catalog): commit it with the folders`] });
  const { agents, skills } = await provided(dir);

  expect([...agents.keys()].sort()).toEqual(["ops", "support"]);
  expect(agents.get("support")?.systemPrompt).toBe("Help customers.");
  expect(agents.get("support")?.skills?.map((each) => (typeof each === "string" ? each : each.name))).toEqual(["review", "notes"]);
  expect(agents.get("ops")?.systemPrompt).toBe("Watch the servers.");
  // The text is written as it is, backticks and template braces included.
  expect(skills.get("review")?.instructions).toBe("Read the diff `twice` and ${carefully}.");
});

test("a channel's text is appended to the prompt in that channel's conversations only, after the agent's own prepare", async () => {
  const dir = project({
    "src/agents/support/agent.ts": agentText("support", ", prepare: (_state, ctx) => (ctx.conversation.channel === 'http' ? { systemPrompt: 'From prepare.' } : {})"),
    "src/agents/support/SYSTEM.md": "Help customers.",
    "src/agents/support/channels/telegram.md": "Answer briefly: this is Telegram.",
    "src/agents/support/channels/telegram.ops.md": "These are the operators.",
    "src/agents/support/channels/http.md": "Over HTTP.",
  });
  expect((await run(dir)).problems).toEqual([]);
  const support = (await provided(dir)).agents.get("support") as AgentDefinition;
  const prompt = (channel?: string) => support.prepare?.({}, { conversation: conversation(channel) }).systemPrompt;

  expect(prompt("telegram")).toBe("Help customers.\n\nAnswer briefly: this is Telegram.");
  expect(prompt("telegram:ops")).toBe("Help customers.\n\nThese are the operators.");
  expect(prompt("http")).toBe("From prepare.\n\nOver HTTP.");
  expect(prompt("dashboard")).toBeUndefined();
  expect(prompt()).toBeUndefined();
});

test("one source per field: a systemPrompt beside SYSTEM.md, or an agent.ts naming another agent, stops the App", async () => {
  const twice = project({ "src/agents/support/agent.ts": agentText("support", ', systemPrompt: "Here."'), "src/agents/support/SYSTEM.md": "And here." });
  expect((await run(twice)).problems).toEqual([]);
  await expect(import(join(twice, GENERATED))).rejects.toThrow('agent "support": its system prompt is in agent.ts and in SYSTEM.md; keep one');

  const other = project({ "src/agents/support/agent.ts": agentText("sales") });
  expect((await run(other)).problems).toEqual([]);
  await expect(import(join(other, GENERATED))).rejects.toThrow('src/agents/support/agent.ts defines the agent "sales"');
});

test("every problem of the folders is said at once, and nothing is written", async () => {
  const dir = project({
    "src/agents/support/SYSTEM.md": "No agent.ts here.",
    "src/agents/Sales/agent.ts": agentText("Sales"),
    "src/agents/ok/agent.ts": agentText("ok"),
    "src/agents/ok/channels/Telegram.md": "Wrong name.",
    "src/agents/ok/skills/empty/notes.txt": "No SKILL.md.",
    "src/skills/review/SKILL.md": skillText("other"),
    "src/skills/Bad/SKILL.md": skillText("bad"),
  });

  expect((await run(dir)).problems).toEqual([
    "src/agents/Sales/: an agent's folder is its name, kebab-case (support, sales-eu)",
    "src/agents/ok/channels/Telegram.md: a channel's file is <channel>.md, lowercase, telegram:ops written telegram.ops.md",
    "src/agents/ok/skills/empty/ has no SKILL.md",
    'src/agents/support/ has no agent.ts (export default defineAgent({ name: "support", … }))',
    "src/skills/Bad/: a skill's folder is its name: lowercase letters, digits and single hyphens",
    'src/skills/review/SKILL.md: skill "other": its folder is "review"; a skill\'s name is its folder\'s',
  ]);
  expect(() => readFileSync(join(dir, GENERATED))).toThrow();
});

test("a project whose pikit.config.ts does not list the generated file is told so", async () => {
  const dir = project({ "src/agents/support/agent.ts": agentText("support"), "pikit.config.ts": "export default {};\n" });
  expect((await run(dir)).problems).toEqual([`pikit.config.ts does not list ./${GENERATED}: import it and add it to the components, as the starter does`]);
});

test("on a server a skill with files of its own gets its location; on Cloudflare, and a skill of its text only, none", async () => {
  const files = {
    "src/agents/support/agent.ts": agentText("support", ', skills: ["review", "plain"]'),
    "src/skills/review/SKILL.md": skillText("review"),
    "src/skills/review/scripts/lint.sh": "echo lint\n",
    "src/skills/plain/SKILL.md": skillText("plain"),
  };
  const server = project(files, ["server"]);
  expect((await run(server)).problems).toEqual([]);
  const { skills } = await provided(server);
  expect(skills.get("review")?.location).toBe(join(server, "src", "skills", "review") + "/");
  expect(skills.get("plain")?.location).toBeUndefined();

  const durable = project(files, ["durable"]);
  expect((await run(durable)).problems).toEqual([]);
  expect(readFileSync(join(durable, GENERATED), "utf8")).not.toContain("location");
  expect(readFileSync(join(durable, GENERATED), "utf8")).not.toContain("node:url");
});

test("doctor passes while the file is what the folders say, and fails naming the command once a folder changed", async () => {
  const dir = project({ "src/agents/support/agent.ts": agentText("support"), "src/agents/support/SYSTEM.md": "Help." });
  const io = { config: {}, get: () => undefined };
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    expect(await doctor(io)).toEqual([`${GENERATED} is not what src/agents/ and src/skills/ say: run \`pikit agents\` (then commit both)`]);
    expect((await run(dir)).problems).toEqual([]);
    expect(await doctor(io)).toEqual([]);
    writeFileSync(join(dir, "src/agents/support/SYSTEM.md"), "Help, kindly.");
    expect(stale(dir)).toEqual([`${GENERATED} is not what src/agents/ and src/skills/ say: run \`pikit agents\` (then commit both)`]);
  } finally {
    process.chdir(cwd);
  }
});

test("the command writes only when the text changes, says so, and takes no arguments", async () => {
  const dir = project({ "src/agents/support/agent.ts": agentText("support") });
  await run(dir);

  expect(await run(dir)).toEqual({ problems: [], said: [`${GENERATED} is up to date (1 agent, 0 skills in the catalog)`] });
  expect((await run(dir, ["--check"])).problems).toEqual(['`pikit agents` takes no arguments (it was given "--check")']);
});

test("the same folders give the same text; channels' files and template literals are read as written", () => {
  const dir = project({ "src/agents/b/agent.ts": agentText("b"), "src/agents/a/agent.ts": agentText("a") });
  expect(generated(dir).text).toBe(generated(dir).text);
  expect(generated(dir).text.indexOf('"../agents/a/agent.ts"')).toBeLessThan(generated(dir).text.indexOf('"../agents/b/agent.ts"'));
  expect(render({ agents: [], skills: [] })).not.toContain("defineSkill");

  expect([channelOfFile("telegram.md"), channelOfFile("telegram.ops.md"), channelOfFile("Telegram.md"), channelOfFile("notes.txt"), channelOfFile(".md")]).toEqual([
    "telegram",
    "telegram:ops",
    undefined,
    undefined,
    undefined,
  ]);
  expect(literal("a `b` ${c} \\d")).toBe("`a \\`b\\` \\${c} \\\\d`");
});
