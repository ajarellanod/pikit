/**
 * `pikit new` in a terminal, with no directory: the guided path. The installer runs it
 * when it finishes, so pasting the install line is the only command a person types.
 *
 * It asks, in order: the agent's name (its folder), where it runs (its target, only when the registry
 * has presets for several), the preset to start from (only when several base presets run there), each
 * of that preset's questions (`choose`: where to talk to the agent is "which channel-* component",
 * answered by every one in the registry, by its `title`), whether it gets a dashboard (on a server;
 * `--ui` answers it), then runs `new`, `configure` (each
 * component's own step, then the model's login) and `up` or `dev`: the same functions the commands
 * run, nothing of its own. It knows nothing about Telegram, any channel or any platform: the choices
 * come from the registry, the questions from the components, and `up` is the deployment component's
 * (on Cloudflare it logs in to the account itself). It prints the `pikit new` command that makes the
 * same project without a terminal.
 *
 * `--target`, `--preset` and `--with` answer their questions: the installer's `--durable` runs
 * `pikit new --target durable --preset telegram-cloudflare`, which asks only the name.
 *
 * It offers presets that make an agent you talk to, those with a channel-* component, when a target
 * has any: `cloudflare-minimal`, storage only, is for `pikit new <dir> --preset`.
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
import { openRegistry, type Registry } from "../project/registry-source.ts";
import { kindOf, TARGETS } from "../registry/manifest.ts";
import { ask, beginGuided, Cancelled, CliError, choose, confirm, intro, log, outro, spinner } from "../ui.ts";
import { configure } from "./configure.ts";
import { deployment, dev } from "./deployment.ts";
import { checkTarget, newProject, UNFINISHED, validProjectName } from "./new.ts";

const DEFAULT_NAME = "my-agent";
const DEFAULT_TARGET = NEW_PROJECT_TARGETS[0] as string;

/** What the guided path says of each target, `pikit.json`'s `targets`. */
const TARGET_TEXT: Record<string, { label: string; hint: string; up: string; upHint: string; running: string }> = {
  server: {
    label: "server — a long-lived process (Docker on a VPS)",
    hint: "or on your own machine while it is on",
    up: "In Docker, in the background (`pikit up`)",
    upHint: "it keeps running after you log out",
    running: "Your agent is running. In its folder (`cd {name}`): `pikit logs --follow` to watch it, `pikit status`, `pikit down` to stop it.",
  },
  durable: {
    label: "durable — on Cloudflare (Workers + Durable Objects)",
    hint: "no server to keep: a Durable Object per chat; the Workers Free plan is enough",
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
  /** Answers the preset's questions of their kinds (`--with`). */
  with?: readonly string[];
  /** Answers "add a dashboard?" (`--ui`). */
  ui?: boolean;
}

export async function newWizard(parentDir: string, options: WizardOptions = {}): Promise<number> {
  const registryPath = options.registry ?? DEFAULT_REGISTRY;
  // A flag that cannot be used is refused before the first question.
  if (options.target !== undefined) checkTarget(options.target);
  if (options.preset === undefined && (options.with?.length ?? 0) > 0) throw new CliError("--with answers a preset's questions: it needs --preset", 2);
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
      const choices = await answerSlots(registry, preset, target, options.with ?? []);
      // On Cloudflare the question is not asked, so the installer's `--durable` asks only the name:
      // `--ui`, or `pikit ui on` later, gives it a dashboard (`ui.ts`).
      const ui = options.ui ?? (target === "durable" ? false : await confirm("Add a dashboard? (a web UI at /admin/ to follow, steer and stop conversations)", false));
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
      log.info(`The same, in a script: pikit new ${name}${targetFlag} --preset ${preset}${choices.map((c) => ` --with ${c}`).join("")}${ui ? " --ui" : ""}${registryFlag}`);
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
    return await start(project.dir, name, target);
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

/** The base presets that run on `target`: those with a channel (an agent you talk to) when it has any. */
function basesFor(registry: Registry, target: string): { name: string; title: string }[] {
  const bases = registry.presets().filter((preset) => preset.extends === undefined && runsOn(registry, preset.name, target));
  const talking = bases.filter((preset) => registry.preset(preset.name).some((component) => kindOf(component) === "channel"));
  return talking.length > 0 ? talking : bases;
}

function runsOn(registry: Registry, preset: string, target: string): boolean {
  return registry.preset(preset).every((component) => registry.manifest(component).targets.includes(target));
}

/**
 * The preset's questions, each answered by a component of its kind, but those `--with` answers; returns
 * the answers that differ from the preset's own, `--with`'s first.
 */
async function answerSlots(registry: Registry, preset: string, target: string, given: readonly string[]): Promise<string[]> {
  const choices = [...given];
  const answered = new Set(given.map(kindOf));
  // Only answers the new project can install: a component for another target would fail in `new`.
  for (const slot of registry.slots(preset, [target])) {
    if (slot.options.length < 2 || answered.has(slot.kind)) continue;
    const answer = await choose(slot.question, slot.options.map((o) => option(o.name, o.title)), slot.default);
    if (answer !== slot.default) choices.push(answer);
  }
  return choices;
}

/** A title is "Name: what it is"; the part after the colon is the option's hint. */
function option(value: string, title: string): { value: string; label: string; hint?: string } {
  const [label = value, ...rest] = title.split(": ");
  return { value, label, ...(rest.length > 0 && { hint: rest.join(": ") }) };
}

async function start(dir: string, name: string, target: string): Promise<number> {
  const text = TARGET_TEXT[target];
  const choice = await choose<"up" | "dev" | "later">(
    "Start it?",
    [
      { value: "up", label: text?.up ?? "In the background (`pikit up`)", ...(text !== undefined && { hint: text.upHint }) },
      { value: "dev", label: "Here, in this terminal (`pikit dev`)", hint: "Ctrl-C stops it" },
      { value: "later", label: "Not now" },
    ],
    "up",
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
