/**
 * Scenario 8, many agents (SPEC §15, ROADMAP M1.5): one pikit runs several agents side by side, each
 * with its own tools, Pi extensions and directory, each reached from the conversations its rules give
 * it, all by adding components:
 * - `router-rules` sends `ops-room` to `ops` and `support-room` to `support`; any other conversation
 *   goes to `router-basic`'s default agent, `assistant`;
 * - `ops` and `support` both have Pi's real `bash`, but only `ops` names Pi's `permission-gate`
 *   extension (provided under `agent.extension`), and `assistant` has no tools;
 * - `workspace-local` gives each agent its own directory.
 * Removing `router-rules` routes everything to `assistant` again, with nothing else changed (S3).
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { defineAgent, defineComponent } from "@pikit/core";
import permissionGate from "../../../packages/pi-adapter/src/extensions/pi-examples/permission-gate.ts";
import routerRules from "../../../registry/components/router-rules/files/src/pikit/router-rules/index.ts";
import workspaceLocal from "../../../registry/components/workspace-local/files/src/pikit/workspace-local/index.ts";
import { createSample, type Sample } from "./sample.ts";

const samples: Sample[] = [];
afterEach(async () => {
  for (const sample of samples.splice(0)) await sample.dispose();
});

const assistant = defineAgent({ name: "assistant", model: "faux/scripted", systemPrompt: "You help anyone." });
const ops = defineAgent({ name: "ops", model: "faux/scripted", systemPrompt: "You run the servers.", tools: ["bash"], extensions: ["permission-gate"] });
const support = defineAgent({ name: "support", model: "faux/scripted", systemPrompt: "You help customers.", tools: ["bash"] });

/** A project component that installs Pi's permission-gate for the agents that name it. */
const extensions = defineComponent({
  name: "project-extensions",
  setup: (pikit) => pikit.provideKeyed("agent.extension", "permission-gate", permissionGate),
});

const RULES = [
  { conversation: "ops-room", agent: "ops" },
  { conversation: "support-room", agent: "support" },
];

test("each conversation reaches its agent, with that agent's tools, extensions and directory", async () => {
  const sample = await createSample({
    agents: [assistant, ops, support],
    extra: [extensions, workspaceLocal, routerRules],
    config: { "router-rules": { rules: RULES } },
    workspaces: true,
  });
  samples.push(sample);
  await sample.app.start();
  // Real path: `pwd` resolves symlinks (macOS's /var is /private/var).
  const workspaces = realpathSync(join(sample.dataDir, "workspaces"));
  const say = (conversationId: string, text: string, messageId: string) => sample.post("/v1/messages", { conversationId, text, messageId });

  // ops has bash and Pi's permission-gate: a dangerous command is blocked.
  const blocked = await say("ops-room", "bash: rm -rf anything", "o1");
  expect(blocked.body.text).toContain("Dangerous command blocked (no UI for confirmation)");

  // support has bash but not the gate: the same kind of command runs, in support's directory.
  const unguarded = await say("support-room", "bash: mkdir keep && rm -rf keep && echo gone", "s1");
  expect(unguarded.body.text).toBe("tool said: gone\n");

  // Each agent's commands run in its own directory.
  const opsWrote = await say("ops-room", "bash: echo ops > who.txt && pwd", "o2");
  expect(opsWrote.body.text).toBe(`tool said: ${join(workspaces, "ops")}\n`);
  expect(readFileSync(join(workspaces, "ops", "who.txt"), "utf8")).toBe("ops\n");
  const supportLooked = await say("support-room", "bash: pwd && ls", "s2");
  expect(supportLooked.body.text).toBe(`tool said: ${join(workspaces, "support")}\n`);
  expect(existsSync(join(workspaces, "support", "who.txt"))).toBe(false);

  // No rule for this conversation: router-basic's default agent, which has no tools at all.
  const other = await say("lobby", "bash: echo hi", "l1");
  expect(other.body.text).toBe('tool said: Tool "bash" is unavailable');
});

test("without router-rules, every conversation goes to the default agent (S3)", async () => {
  const sample = await createSample({ agents: [assistant, ops, support], extra: [extensions, workspaceLocal], workspaces: true });
  samples.push(sample);
  await sample.app.start();

  const asked = await sample.post("/v1/messages", { conversationId: "ops-room", text: "bash: echo hi", messageId: "o1" });

  expect(asked.body.text).toBe('tool said: Tool "bash" is unavailable');
});
