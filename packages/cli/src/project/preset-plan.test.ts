/**
 * The preset plan (`resolvePresetPlan`) in a registry that is not the kit's, every name arbitrary: what
 * the steward is granted comes from the preset and its chosen features only, each key checked against
 * what the chosen components provide; config only for the chosen; the agent layout under any feature
 * and command; and a feature the deployment cannot run is shown unavailable, with why, and refused
 * when chosen. `pikit new` refuses such a plan before it makes the directory.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { formatCompositionIssue } from "./composition.ts";
import { resolvePresetPlan } from "./preset-plan.ts";
import { openRegistry, type Registry } from "./registry-source.ts";
import { runCli } from "../testing/cli.ts";
import { compositionRegistry, type ScratchComponent, scratchDir, writePresets } from "../testing/composition-registry.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = scratchDir("pikit-preset-plan-");
  dirs.push(dir);
  return dir;
};

const HOST = "acme.review-host";
const tool = (key: string, replay = "safe") => `pikit.provideKeyed("agent.tool", ${JSON.stringify(key)}, { name: ${JSON.stringify(key)}, replay: ${JSON.stringify(replay)} });`;

const COMPONENTS: Record<string, ScratchComponent> = {
  "deployment-plain": { title: "Plain hosting", manifest: { deployment: { supports: [] } } },
  "deployment-rich": { title: "Rich hosting", manifest: { deployment: { supports: [HOST] } } },
  "tool-reader": { title: "Reader", setup: tool("read") },
  // A shell under another name than bash: installed, it is granted to no one.
  "tool-shellish": { title: "Shellish", setup: tool("shell", "unsafe") },
  "extension-know": { title: "Know", setup: 'pikit.provideKeyed("agent.extension", "know-self", {});' },
  "router-plain": { title: "Plain router" },
  "router-fancy": { title: "Fancy router" },
  // Needs a protocol of its deployment that only deployment-rich supports.
  "desk-review": { title: "Review desk: proposals reviewed on the host", manifest: { requires: { deployment: [HOST] } } },
  // An agent catalogue under another name, with another command.
  "catalog-crew": { title: "Crew: agents in folders", manifest: { commands: { crew: { file: "crew.ts", description: "Write the crew's registry" } } }, files: { "crew.ts": "export async function command() {}\n" } },
  "panel-extra": { title: "Extra panel" },
};

const PRESET = `title: Acme
components: [tool-reader, tool-shellish, extension-know, router-plain, deployment-plain]
choose:
  - kind: deployment
  - kind: router
steward:
  tools: [read]
  extensions: [know-self]
config:
  router-plain: { defaultAgent: steward }
  router-fancy: { mode: fancy }
  desk-review: { strict: true }
agents:
  folders:
    feature: catalog-crew
    command: crew
features:
  - components: [catalog-crew]
  - components: [desk-review]
    steward: { tools: [shell] }
  - components: [panel-extra]
    ui: true
`;

let shared: Registry | undefined;
async function registry(presets: Record<string, string> = {}): Promise<Registry> {
  if (shared === undefined) shared = openRegistry(await compositionRegistry(temp(), COMPONENTS, { acme: PRESET }));
  writePresets(shared.root, presets);
  return shared;
}

const plan = async (choices: string[] = [], preset = "acme") => resolvePresetPlan(await registry(), { preset, targets: ["server"], choices });
const unmet = formatCompositionIssue({ code: "deployment_requirement_unmet", component: "desk-review", requirement: HOST, via: "requires", deployment: "deployment-plain" });

test("the steward gets the preset's grants only: a tool installed and not granted is not given, whatever its name", async () => {
  const base = await plan();
  expect(base.problems).toEqual([]);
  expect(base.steward).toEqual({ tools: ["read"], extensions: ["know-self"] });
  expect(base.components).toContain("tool-shellish");
  expect(base.composition.deployment).toBe("deployment-plain");
  // Config only for the chosen: not the other router's, not a feature's that was not chosen.
  expect(base.config).toEqual({ "router-plain": { defaultAgent: "steward" } });
  expect(base.agents).toEqual({ folders: { feature: "catalog-crew", command: "crew", chosen: false } });
  expect(base.ui).toBe(false);
}, 60_000);

test("a feature the deployment cannot run is offered unavailable, with why; with another deployment it is available, and says what it grants", async () => {
  const base = await plan();
  const desk = base.features.find((f) => f.name === "desk-review");
  expect(desk).toMatchObject({ available: false, unavailable: [unmet], steward: { tools: ["shell"], extensions: [] } });
  expect(base.features.find((f) => f.name === "catalog-crew")?.available).toBe(true);

  const rich = await plan(["deployment-rich"]);
  expect(rich.problems).toEqual([]);
  expect(rich.features.find((f) => f.name === "desk-review")).toMatchObject({ available: true, unavailable: [] });
  // Never another deployment for it: the answer is kept.
  expect(rich.composition.deployment).toBe("deployment-rich");
  expect(base.components).not.toContain("deployment-rich");
}, 60_000);

test("a chosen feature that is unavailable refuses the plan; chosen where it runs, it grants its keys, in component order, and its config applies", async () => {
  const refused = await plan(["desk-review"]);
  expect(refused.problems).toEqual([`desk-review is not available with these answers: ${unmet}`]);

  const chosen = await plan(["deployment-rich", "desk-review", "router-fancy"]);
  expect(chosen.problems).toEqual([]);
  expect(chosen.steward.tools).toEqual(["read", "shell"]);
  expect(chosen.config).toEqual({ "router-fancy": { mode: "fancy" }, "desk-review": { strict: true } });
}, 60_000);

test("a grant of a key no chosen component provides is a problem, for the preset's and a feature's alike", async () => {
  await registry({
    loose: PRESET.replace("tools: [read]\n", "tools: [read, bash]\n"),
    ghost: PRESET.replace("steward: { tools: [shell] }", "steward: { tools: [shell], extensions: [ghost] }"),
  });
  const loose = await plan([], "loose");
  expect(loose.problems).toEqual(['the preset "loose" grants the steward the tool "bash", which no chosen component provides (their component.json `replay.tools`)']);
  expect(loose.steward.tools).toEqual(["read"]);

  const ghost = await plan(["deployment-rich"], "ghost");
  expect(ghost.features.find((f) => f.name === "desk-review")).toMatchObject({
    available: false,
    unavailable: ['the feature desk-review grants the steward the extension "ghost", which no chosen component provides (their component.json `extensions`)'],
  });
}, 60_000);

test("the agent layout is the preset's feature and command, under any names; a command its feature does not declare is a problem", async () => {
  const crew = await plan(["catalog-crew"]);
  expect(crew.problems).toEqual([]);
  expect(crew.agents).toEqual({ folders: { feature: "catalog-crew", command: "crew", chosen: true } });

  await registry({ undeclared: PRESET.replace("command: crew", "command: agents") });
  expect((await plan([], "undeclared")).problems).toEqual([
    'the preset "undeclared" runs `pikit agents` for agent folders (agents.folders), which catalog-crew does not declare (its component.json `commands`)',
  ]);
}, 60_000);

test("a feature that brings the dashboard, in a registry with none, is unavailable; an alias has its base's policy", async () => {
  const base = await plan();
  expect(base.features.find((f) => f.name === "panel-extra")).toMatchObject({ ui: true, available: false });
  expect(base.features.find((f) => f.name === "panel-extra")?.unavailable[0]).toContain("has no dashboard (dashboard/files/)");

  await registry({ rich: "extends: acme\nwith: [deployment-rich, desk-review]\n" });
  const alias = await plan([], "rich");
  expect(alias.problems).toEqual([]);
  expect(alias.steward.tools).toEqual(["read", "shell"]);
  expect(alias.features.map((f) => f.name)).toEqual(["catalog-crew", "panel-extra"]);
}, 60_000);

test("pikit new refuses a plan with problems before it makes the directory", async () => {
  const root = (await registry()).root;
  const parent = temp();
  const run = await runCli(["new", "acme-bot", "--registry", root, "--preset", "acme", "--with", "desk-review"], parent);
  expect(run.code).toBe(1);
  expect(run.err).toContain('the preset "acme" cannot be made with these answers:');
  expect(run.err).toContain(unmet);
  expect(existsSync(join(parent, "acme-bot"))).toBe(false);
}, 60_000);
