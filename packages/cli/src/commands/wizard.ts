/**
 * `pikit new` in a terminal, with no directory: the guided path. The installer runs it
 * when it finishes, so pasting the install line is the only command a person types.
 *
 * It asks, in order: the agent's name (its folder), where it runs (its target, only when the registry
 * has presets for several), the preset to start from (only when several base presets run there), each
 * of that preset's questions (`choose`: where to talk to the agent is "which channel-* components",
 * several at once, answered by every one in the registry that runs there, by its `title`), what it can
 * do (one or several agents, then optional features). Full presets include the dashboard; then it runs
 * `new`, `configure` (each component's own step, then the model's login) and `up` or `dev`: the same
 * functions the commands run, nothing of its own. Each answer is a component `new` installs as
 * `pikit add` does, with the providers it brings. It knows nothing about Telegram, any channel or any platform: the choices
 * come from the registry, the questions from the components, and `up` is the deployment component's
 * (on Cloudflare it logs in to the account itself). It prints the `pikit new` command that makes the
 * same project without a terminal.
 *
 * What it offers after the preset's questions is the plan `new` makes with those answers
 * (`preset-plan.ts`): "one agent or several" only when the preset declares an agent layout, and every
 * feature with what it grants the steward; one the answers cannot have (self-improvement on a
 * deployment that runs no deployer) is shown, not selectable, with why. It never changes an answer
 * for one: the deployment is the person's.
 *
 * `--target`, `--preset` and `--with` answer their questions (a `--with` of a feature, or `--ui`, answers
 * "what can it do?"): the installer's `--durable` runs `pikit new --target durable --preset
 * cloudflare`, which asks the name, optional external channels and what it can do. The preset's
 * dashboard is included without selecting an external channel.
 *
 * It offers presets that make an agent you talk to, through a channel or their default dashboard,
 * when a target has any: `base-cloudflare`, storage only, is for `pikit new <dir> --preset`.
 *
 * Ctrl-C stops it at any question. Running `pikit new` again with the same name continues with the
 * project already written: configuring and starting it again is harmless, because `configure` only
 * asks for what is missing. A `pikit new` that did not finish (`UNFINISHED`: its `bun install` or
 * doctor failed, or it was stopped while writing) is not a project to continue: it offers to delete it
 * and make it again.
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_REGISTRY } from "../paths.ts";
import { NEW_PROJECT_TARGETS, readProjectManifest } from "../project/pikit-json.ts";
import { type PresetFeaturePlan, type ResolvedPresetPlan, resolvePresetPlan } from "../project/preset-plan.ts";
import { openRegistry, type Registry } from "../project/registry-source.ts";
import { dashboardFiles } from "../project/dashboard.ts";
import { kindOf, TARGETS } from "../registry/manifest.ts";
import { ask, beginGuided, Cancelled, type Choice, CliError, choose, chooseSeveral, confirm, intro, log, outro, spinner } from "../ui.ts";
import { configure } from "./configure.ts";
import { deployment, dev } from "./deployment.ts";
import { checkTarget, newProject, UNFINISHED, validProjectName } from "./new.ts";
import { deploymentOf } from "./starter.ts";

const DEFAULT_NAME = "my-agent";
const DEFAULT_TARGET = NEW_PROJECT_TARGETS[0] as string;

/** What the guided path says of each target, `pikit.json`'s `targets`. */
const TARGET_TEXT: Record<string, { label: string; hint: string }> = {
  server: {
    label: "server — a long-lived process (Docker, or a service of this machine)",
    hint: "a VPS, or your own machine while it is on",
  },
  durable: {
    label: "durable — on Cloudflare (Workers + Durable Objects), or your own machines (celld)",
    hint: "a Durable Object per chat; on Cloudflare no server to keep, the Workers Free plan is enough",
  },
};

/**
 * What it says of `pikit up`, by the project's deployment (`deployment-*`), which `up` delegates to:
 * never by the target. Another deployment gets the general words; without one, `up` is not offered.
 */
const DEPLOYMENT_TEXT: Record<string, { up: string; upHint: string; running: string }> = {
  "deployment-docker": {
    up: "In Docker, in the background (`pikit up`)",
    upHint: "it keeps running after you log out",
    running: "Your agent is running. In its folder (`cd {name}`): `pikit logs --follow` to watch it, `pikit status`, `pikit down` to stop it.",
  },
  "deployment-local": {
    up: "As a service of this machine, in the background (`pikit up`)",
    upHint: "systemd on Linux, launchd on macOS; restarted when it fails",
    running: "Your agent is running. In its folder (`cd {name}`): `pikit logs --follow` to watch it, `pikit status`, `pikit down` to stop it.",
  },
  "deployment-celld": {
    up: "On your celld fleet (`pikit up`)",
    upHint: "it deploys to the fleet's bucket; the nodes run it without this machine",
    running: "Your agent is deployed. In its folder (`cd {name}`): `pikit status`, `pikit logs` (with PIKIT_CELLD_SSH); `pikit down` stops the nodes.",
  },
  "deployment-cloudflare": {
    up: "On Cloudflare (`pikit up`)",
    upHint: "it deploys the Worker, which runs without this machine",
    running: "Your agent is deployed. In its folder (`cd {name}`): `pikit logs` to watch it, `pikit status`, `pikit down` to delete it.",
  },
};

export interface WizardOptions {
  registry?: string;
  /** Answers "where does it run?" (`--target`). */
  target?: string;
  /** Answers "which preset?" (`--preset`). */
  preset?: string;
  /** Answers the preset's questions of their kinds, and "what can it do?" for its features (`--with`). */
  with?: readonly string[];
  /** Answers "what can it do?": with the dashboard (`--ui`). */
  ui?: boolean;
}

/** The dashboard's answer to "what can it do?": not a component (`ui.ts`), so the flag's name. */
const DASHBOARD = "--ui";

export async function newWizard(parentDir: string, options: WizardOptions = {}): Promise<number> {
  const registryPath = options.registry ?? DEFAULT_REGISTRY;
  // A flag that cannot be used is refused before the first question.
  if (options.target !== undefined) checkTarget(options.target);
  if (options.preset === undefined && (options.with?.length ?? 0) > 0) throw new CliError("--with answers a preset's questions and adds its features: it needs --preset", 2);
  beginGuided();
  intro("pikit: a new agent");
  log.info("Ctrl-C stops at any question; `pikit new` continues where you left off.");
  let name = DEFAULT_NAME;
  try {
    const project = await chooseProject(parentDir);
    name = project.name;
    let target: string;
    if (project.existing) {
      log.ok(`continuing with ${name}`);
      target = readProjectManifest(project.dir).targets[0] ?? DEFAULT_TARGET;
    } else {
      const registry = openRegistry(registryPath);
      target = options.target ?? (await chooseTarget(registry, options.preset));
      const preset = options.preset ?? (await choosePreset(registry, target));
      const answers = await answerSlots(registry, preset, target, options.with ?? []);
      const agents = await chooseAgents(registry, preset, target, answers, options.ui);
      const { features, ui } = await chooseFeatures(registry, preset, target, [...answers, ...agents], options.ui);
      const choices = [...answers, ...agents, ...features];
      const creating = spinner(`Creating ${name}: its components, then \`bun install\``);
      try {
        await newProject(project.dir, { preset, with: choices, registry: registryPath, target, next: false, quiet: true, ui });
      } catch (error) {
        creating.error(`Could not create ${name}`);
        throw error;
      }
      creating.stop(`Created ${name} in ${project.dir}`);
      const registryFlag = options.registry === undefined ? "" : ` --registry ${options.registry}`;
      const targetFlag = target === DEFAULT_TARGET ? "" : ` --target ${target}`;
      log.info(`The same, in a script: pikit new ${name}${targetFlag} --preset ${preset}${choices.map((c) => ` --with ${c}`).join("")}${ui && !registry.presetUi(preset) ? " --ui" : ""}${registryFlag}`);
    }

    if (!(await confirm("Configure it now? (where you talk to it, and the model's login)", true))) return later(name, "configure");
    try {
      await configure(project.dir);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      log.problem(error.message);
      outro(`Fix that, then run \`pikit new\` again and answer "${name}": it continues from here.`);
      return 1;
    }
    return await start(project.dir, name);
  } catch (error) {
    if (error instanceof Cancelled) outro(`Stopped. Run \`pikit new\` again${name === DEFAULT_NAME ? "" : ` and answer "${name}"`} to continue.`);
    throw error;
  }
}

/** A new folder, or an existing pikit project to continue with. */
async function chooseProject(parentDir: string): Promise<{ dir: string; name: string; existing: boolean }> {
  for (;;) {
    const name = await ask(`Name of your agent (a new folder in ${parentDir})`, {
      defaultValue: DEFAULT_NAME,
      validate: (answer) => (validProjectName(answer) ? undefined : 'Use lowercase letters, digits, "-", "." or "_"'),
    });
    const dir = resolve(parentDir, name);
    if (!existsSync(dir) || readdirSync(dir).length === 0) return { dir, name, existing: false };
    // `new` marks only a directory it made: deleting it takes nothing that was there before.
    if (existsSync(join(dir, UNFINISHED))) {
      if (!(await confirm(`${name} is a \`pikit new\` that did not finish. Delete it and make it again?`, true))) continue;
      rmSync(dir, { recursive: true, force: true });
      return { dir, name, existing: false };
    }
    if (existsSync(join(dir, "pikit.json"))) {
      if (await confirm(`${name} already exists. Continue setting it up?`, true)) return { dir, name, existing: true };
      continue;
    }
    log.problem(`${dir} exists and is not a pikit project: choose another name`);
  }
}

/** Where it runs: only the targets that have presets for it (or where `--preset` runs). One is not a question. */
async function chooseTarget(registry: Registry, preset: string | undefined): Promise<string> {
  const targets = TARGETS.filter((target) => (preset === undefined ? basesFor(registry, target).length > 0 : runsOn(registry, preset, target)));
  if (targets.length === 0) throw new CliError(preset === undefined ? `the registry ${registry.root} has no presets to choose from` : `the preset "${preset}" runs on no target`);
  if (targets.length === 1) return targets[0] as string;
  return await choose(
    "Where should it run?",
    targets.map((target) => ({ value: target, label: TARGET_TEXT[target]?.label ?? target, ...(TARGET_TEXT[target] !== undefined && { hint: TARGET_TEXT[target].hint }) })),
    (targets as readonly string[]).includes(DEFAULT_TARGET) ? DEFAULT_TARGET : undefined,
  );
}

/**
 * A base preset: aliases are answers to its questions, which `answerSlots` asks. One base is not a
 * question. Only presets whose components run on the target: a server preset is not offered for
 * Cloudflare.
 */
async function choosePreset(registry: Registry, target: string): Promise<string> {
  const bases = basesFor(registry, target);
  if (bases.length === 0) throw new CliError(`the registry ${registry.root} has no presets for ${target} to choose from`);
  if (bases.length === 1) return (bases[0] as { name: string }).name;
  return await choose("Which preset do you start from?", bases.map((preset) => option(preset.name, preset.title)));
}

/** Prefer bases with a channel or a default dashboard over infrastructure-only presets. */
function basesFor(registry: Registry, target: string): { name: string; title: string }[] {
  const bases = registry.presets().filter((preset) => preset.extends === undefined && runsOn(registry, preset.name, target));
  const talking = bases.filter((preset) => registry.presetUi(preset.name) || registry.preset(preset.name).some((component) => kindOf(component) === "channel"));
  return talking.length > 0 ? talking : bases;
}

function runsOn(registry: Registry, preset: string, target: string): boolean {
  return registry.preset(preset).every((component) => registry.manifest(component).targets.includes(target));
}

/**
 * The preset's questions, each answered by a component of its kind (or several, `multiple`), but those
 * `--with` answers; returns the answers that differ from the preset's own, `--with`'s first. A
 * `multiple` question with no default allows none: the preset's dashboard is already a channel.
 */
async function answerSlots(registry: Registry, preset: string, target: string, given: readonly string[]): Promise<string[]> {
  const choices = [...given];
  const answered = new Set(given.map(kindOf));
  // Only answers the new project can install: a component for another target would fail in `new`.
  for (const slot of registry.slots(preset, [target])) {
    if (slot.options.length === 0 || (slot.options.length === 1 && slot.defaults.length === 1) || answered.has(slot.kind)) continue;
    const options = slot.options.map((o) => option(o.name, o.title));
    const picked = slot.multiple ? await chooseSeveral(slot.question, options, slot.defaults, slot.defaults.length > 0) : [await choose(slot.question, options, slot.defaults[0])];
    // In the menu's order, whatever order they were checked in: the same answers print the same command.
    const answers = slot.options.map((o) => o.name).filter((name) => picked.includes(name));
    // Any other answer replaces the preset's own, so all of them are named (`registry.preset`).
    if (answers.length !== slot.defaults.length || answers.some((a) => !slot.defaults.includes(a))) choices.push(...answers);
  }
  return choices;
}

/** The preset resolved for the answers so far (`preset-plan.ts`): the plan `new` makes with them. */
function planFor(registry: Registry, preset: string, target: string, given: readonly string[], ui: boolean | undefined): ResolvedPresetPlan {
  return resolvePresetPlan(registry, { preset, targets: [target], choices: given, ...(ui === true && { ui: true }) });
}

/**
 * Agent folders are opt-in, when the preset has a layout (`agents.folders`): one Steward needs no
 * generated catalog; several agents do. Its feature, when these answers cannot have it, is shown and
 * not selectable, with why.
 */
async function chooseAgents(registry: Registry, preset: string, target: string, given: readonly string[], ui: boolean | undefined): Promise<string[]> {
  const plan = planFor(registry, preset, target, given, ui);
  const folders = plan.agents?.folders;
  const feature = plan.features.find((f) => f.name === folders?.feature);
  if (folders === undefined || folders.chosen || feature === undefined) return [];
  const grants = grantsHint(feature);
  const count = await choose("Will you use one agent or several?", [
    { value: "one", label: "One agent", hint: "Steward; edit its agent.ts directly" },
    {
      value: "several",
      label: "Several agents",
      ...(feature.available
        ? { hint: `Steward first; each agent's prompt and skills in its folder, \`pikit ${folders.command}\` lists them${grants === undefined ? "" : `; ${grants}`}` }
        : { hint: unavailableHint(feature), disabled: true }),
    },
  ], "one");
  return count === "several" ? [feature.name] : [];
}

/**
 * Optional features, none checked: the dashboard only when not already included, and every feature
 * but agent folders (which have their own question), each with what it grants the steward. One these
 * answers cannot have is shown, not selectable, with why: the deployment is never changed for it.
 * Explicit feature flags answer it.
 */
async function chooseFeatures(registry: Registry, preset: string, target: string, given: readonly string[], ui: boolean | undefined): Promise<{ features: string[]; ui: boolean }> {
  const plan = planFor(registry, preset, target, given, ui);
  const features = plan.features;
  const defaultUi = registry.presetUi(preset);
  if (defaultUi) log.info("Dashboard included: talk to your agent at /admin/; external channels are optional.");
  const folders = plan.agents?.folders.feature;
  if (ui !== undefined || features.some((f) => f.name !== folders && given.includes(f.name))) return { features: [], ui: defaultUi || ui === true };
  const options: Choice<string>[] = [
    ...(defaultUi || dashboardFiles(registry) === undefined ? [] : [{ value: DASHBOARD, label: "Dashboard", hint: "a web UI at /admin/ to follow, steer and stop conversations" }]),
    ...features
      .filter((f) => f.name !== folders && !given.includes(f.name))
      .map((f) => {
        const shown = option(f.name, f.title);
        if (!f.available) return { value: f.name, label: shown.label, hint: unavailableHint(f), disabled: true };
        const hint = [shown.hint, grantsHint(f), f.ui && !plan.ui ? "brings the dashboard" : undefined].filter((part) => part !== undefined).join("; ");
        return { value: f.name, label: shown.label, ...(hint !== "" && { hint }) };
      }),
  ];
  if (options.every((o) => o.disabled === true)) {
    for (const o of options) log.info(`${o.label}: ${o.hint}`);
    return { features: [], ui: defaultUi };
  }
  const answer = await chooseSeveral("What can it do? (any, or none: `pikit add` adds one later)", options);
  return { features: features.map((f) => f.name).filter((name) => answer.includes(name)), ui: defaultUi || answer.includes(DASHBOARD) };
}

/** What choosing a feature grants the steward, said before it is chosen ("gives Steward: bash"). */
function grantsHint(feature: PresetFeaturePlan): string | undefined {
  const keys = [...feature.steward.tools, ...feature.steward.extensions];
  return keys.length === 0 ? undefined : `gives Steward: ${keys.join(", ")}`;
}

/** Why a feature cannot be chosen with these answers. */
function unavailableHint(feature: PresetFeaturePlan): string {
  return `not with these answers: ${feature.unavailable.join("; ")}`;
}

/** A title is "Name: what it is"; the part after the colon is the option's hint. */
function option(value: string, title: string): { value: string; label: string; hint?: string } {
  const [label = value, ...rest] = title.split(": ");
  return { value, label, ...(rest.length > 0 && { hint: rest.join(": ") }) };
}

async function start(dir: string, name: string): Promise<number> {
  const deployedBy = deploymentOf(Object.keys(readProjectManifest(dir).components));
  const text = deployedBy === undefined ? undefined : DEPLOYMENT_TEXT[deployedBy];
  const choice = await choose<"up" | "dev" | "later">(
    "Start it?",
    [
      ...(deployedBy === undefined ? [] : [{ value: "up" as const, label: text?.up ?? `With ${deployedBy} (\`pikit up\`)`, ...(text !== undefined && { hint: text.upHint }) }]),
      { value: "dev", label: "Here, in this terminal (`pikit dev`)", hint: "Ctrl-C stops it" },
      { value: "later", label: "Not now" },
    ],
    deployedBy === undefined ? "dev" : "up",
  );
  if (choice === "dev") return await dev(dir);
  if (choice === "later") return later(name, "up");
  await deployment(dir, "up");
  outro((text?.running ?? "Your agent is running. In its folder (`cd {name}`): `pikit status`, `pikit logs`.").replace("{name}", name));
  return 0;
}

function later(name: string, from: "configure" | "up"): number {
  const steps = from === "configure" ? "pikit configure && pikit up" : "pikit up";
  outro(`Later: cd ${name} && ${steps}   (or \`pikit new\` again, answering "${name}")`);
  return 0;
}
