/**
 * Skills in the durable runtime (`agent.ts`): an agent with skills gets the runtime's extension of
 * them, a system prompt section listing each one and the `skill` tool that loads one; `prepare` may
 * change them; an agent without skills gets neither.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { type AgentDefinition, type AgentSkill, defineAgent, defineSkill, SKILL_TOOL } from "@pikit/contracts";
import { skillsText, skillText } from "./agent.ts";
import { databaseFile, type ModelRequest, openWorker, scriptedProvider } from "./test-support.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const review = defineSkill("---\nname: code-review\ndescription: Reviews a diff for bugs & risks.\n---\n# Review\n\nRun `scripts/lint.sh`.\n", {
  location: "/app/skills/code-review",
});
const deploy = defineSkill("---\nname: deploy\ndescription: Deploys a service.\n---\nSay which environment first.\n");

/** A worker running `agent`, with `catalog` the installed skills (`agent.skill`), by name. */
async function worker(agent: AgentDefinition, catalog: Record<string, AgentSkill> = {}) {
  const file = databaseFile();
  cleanup.push(file.dispose);
  const requests: ModelRequest[] = [];
  const w = await openWorker(file.path, {
    agents: [agent],
    providers: [scriptedProvider({ onRequest: (request) => void requests.push(structuredClone(request)) })],
    runtime: { skill: (name) => catalog[name] },
  });
  cleanup.push(w.close);
  return { ...w, requests };
}

/** The skills section each request showed (the latest shown before it), and the tools it offered. */
function seen(request: ModelRequest | undefined): { skills?: string; tools: string[] } {
  let skills: string | undefined;
  const tools = new Set<string>();
  for (const message of request?.messages ?? []) {
    if (message.role !== "system") continue;
    if (message.sections?.skills !== undefined) skills = message.sections.skills ?? undefined;
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return { ...(skills !== undefined && { skills }), tools: [...tools].sort() };
}

describe("skills", () => {
  test("an agent's skills are listed in its system prompt, and the skill tool loads one by name", async () => {
    const w = await worker(defineAgent({ name: "scripted", model: "faux/scripted", skills: [review, deploy] }));
    const conversation = await w.conversation();

    await w.dispatch("r1", `call: ${SKILL_TOOL} {"name":"code-review"}`, conversation);
    expect((await w.result("r1")).kind).toBe("completed");

    expect(seen(w.requests[0])).toEqual({ skills: skillsText([review, deploy]), tools: [SKILL_TOOL] });
    expect(skillsText([review, deploy])).toContain("<description>Reviews a diff for bugs &amp; risks.</description>");
    expect(skillsText([review, deploy])).toContain("<location>/app/skills/code-review</location>");
    const result = w.requests[1]?.messages.find((message) => message.role === "toolResult");
    expect(JSON.stringify(result)).toContain(JSON.stringify(skillText(review)).slice(1, -1));
    expect(skillText(review)).toStartWith("Its files are in /app/skills/code-review");
  });

  test("an unknown skill is an error result naming the skills there are", async () => {
    const w = await worker(defineAgent({ name: "scripted", model: "faux/scripted", skills: [deploy] }));
    await w.dispatch("r1", `call: ${SKILL_TOOL} {"name":"nope"}`, await w.conversation());
    await w.result("r1");

    const result = w.requests[1]?.messages.find((message) => message.role === "toolResult");
    expect(JSON.stringify(result)).toContain('there is no skill \\"nope\\"; the skills are: deploy');
  });

  test("a skill named from the catalog (agent.skill) is the agent's; one installed and not named is not offered", async () => {
    const w = await worker(defineAgent({ name: "scripted", model: "faux/scripted", skills: ["deploy"] }), { "code-review": review, deploy });
    const conversation = await w.conversation();

    await w.dispatch("r1", `call: ${SKILL_TOOL} {"name":"code-review"}`, conversation);
    await w.result("r1");

    expect(seen(w.requests[0])).toEqual({ skills: skillsText([deploy]), tools: [SKILL_TOOL] });
    const result = w.requests[1]?.messages.find((message) => message.role === "toolResult");
    expect(JSON.stringify(result)).toContain('there is no skill \\"code-review\\"; the skills are: deploy');
  });

  test("names and an agent's own skills together, and prepare may name catalog skills too", async () => {
    const agent = defineAgent<{ phase: string }>({
      name: "scripted",
      model: "faux/scripted",
      skills: ["deploy", review],
      state: { phase: "review" },
      prepare: (state) => (state.phase === "ship" ? { skills: ["deploy"] } : {}),
    });
    const w = await worker(agent as AgentDefinition, { deploy });
    const conversation = await w.conversation();
    await w.dispatch("r1", "hello", conversation);
    await w.result("r1");
    await w.runtime.state(conversation).update({ phase: "ship" }, w.ctx);
    await w.dispatch("r2", "hello", conversation);
    await w.result("r2");

    expect(w.requests.map((request) => seen(request).skills)).toEqual([skillsText([deploy, review]), skillsText([deploy])]);
  });

  test("an agent naming a skill nothing installed cannot run, saying which", async () => {
    const w = await worker(defineAgent({ name: "scripted", model: "faux/scripted", skills: ["nope"] }), { deploy });

    await expect(w.dispatch("r1", "hello", await w.conversation())).rejects.toThrow('agent "scripted" names the skill "nope", which no agent.skill provides');
  });

  test("an agent without skills has no section and no skill tool", async () => {
    const w = await worker(defineAgent({ name: "scripted", model: "faux/scripted" }));
    await w.dispatch("r1", "hello", await w.conversation());
    await w.result("r1");

    expect(seen(w.requests[0])).toEqual({ tools: [] });
  });

  test("prepare changes the skills with the state", async () => {
    const agent = defineAgent<{ phase: string }>({
      name: "scripted",
      model: "faux/scripted",
      skills: [review],
      state: { phase: "review" },
      prepare: (state) => (state.phase === "ship" ? { skills: [deploy] } : {}),
    });
    const w = await worker(agent as AgentDefinition);
    const conversation = await w.conversation();
    await w.dispatch("r1", "hello", conversation);
    await w.result("r1");
    await w.runtime.state(conversation).update({ phase: "ship" }, w.ctx);
    await w.dispatch("r2", "hello", conversation);
    await w.result("r2");

    expect(w.requests.map((request) => seen(request).skills)).toEqual([skillsText([review]), skillsText([deploy])]);
  });

  test("skills prepare gives that are not valid (one twice) fall back to the static agent, logged", async () => {
    const agent = defineAgent<{ broken: boolean }>({
      name: "scripted",
      model: "faux/scripted",
      skills: [review],
      state: { broken: true },
      prepare: () => ({ skills: [deploy, deploy] }),
    });
    const w = await worker(agent as AgentDefinition);
    await w.dispatch("r1", "hello", await w.conversation());
    await w.result("r1");

    expect(seen(w.requests[0]).skills).toBe(skillsText([review]));
  });
});
