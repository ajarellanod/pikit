/**
 * `pikit new` in a terminal, with no directory: the guided path (SPEC §11). The installer runs it
 * when it finishes, so pasting the install line is the only command a person types.
 *
 * It asks, in order: the agent's name (its folder), the preset to start from (only when the registry
 * has several base presets), each of that preset's questions (`choose`: where to talk to the agent is
 * "which channel-* component", answered by every one in the registry, by its `title`), then runs
 * `new`, `configure` (each component's own step, then the model's login) and `up` or `dev`: the same
 * functions the commands run, nothing of its own. It knows nothing about Telegram or any channel: the
 * choices come from the registry, the questions from the components. It prints the `pikit new`
 * command that makes the same project without a terminal.
 *
 * Ctrl-C stops it at any question. Running `pikit new` again with the same name continues with the
 * project already written: configuring and starting it again is harmless, because `configure` only
 * asks for what is missing.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_REGISTRY } from "../paths.ts";
import { NEW_PROJECT_TARGETS } from "../project/pikit-json.ts";
import { openRegistry } from "../project/registry-source.ts";
import { ask, beginGuided, Cancelled, CliError, choose, confirm, intro, log, outro, spinner } from "../ui.ts";
import { configure } from "./configure.ts";
import { deployment, dev } from "./deployment.ts";
import { newProject, validProjectName } from "./new.ts";

const DEFAULT_NAME = "my-agent";

export async function newWizard(parentDir: string, options: { registry?: string } = {}): Promise<number> {
  const registryPath = options.registry ?? DEFAULT_REGISTRY;
  beginGuided();
  intro("pikit: a new agent");
  log.info("Ctrl-C stops at any question; `pikit new` continues where you left off.");
  let name = DEFAULT_NAME;
  try {
    const project = await chooseProject(parentDir);
    name = project.name;
    if (project.existing) log.ok(`continuing with ${name}`);
    else {
      const preset = await choosePreset(registryPath);
      const choices = await answerSlots(registryPath, preset);
      const creating = spinner(`Creating ${name}: its components, then \`bun install\``);
      try {
        await newProject(project.dir, { preset, with: choices, registry: registryPath, next: false, quiet: true });
      } catch (error) {
        creating.error(`Could not create ${name}`);
        throw error;
      }
      creating.stop(`Created ${name} in ${project.dir}`);
      const registryFlag = options.registry === undefined ? "" : ` --registry ${options.registry}`;
      log.info(`The same, in a script: pikit new ${name} --preset ${preset}${choices.map((c) => ` --with ${c}`).join("")}${registryFlag}`);
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
    if (existsSync(join(dir, "pikit.json"))) {
      if (await confirm(`${name} already exists. Continue setting it up?`, true)) return { dir, name, existing: true };
      continue;
    }
    log.problem(`${dir} exists and is not a pikit project: choose another name`);
  }
}

/** A base preset: aliases are answers to its questions, which `answerSlots` asks. One base is not a question. */
async function choosePreset(registryPath: string): Promise<string> {
  const bases = openRegistry(registryPath).presets().filter((preset) => preset.extends === undefined);
  if (bases.length === 0) throw new CliError(`the registry ${registryPath} has no presets to choose from`);
  if (bases.length === 1) return (bases[0] as { name: string }).name;
  return await choose("Which preset do you start from?", bases.map((preset) => option(preset.name, preset.title)));
}

/** The preset's questions, each answered by a component of its kind; returns the answers that differ from its own. */
async function answerSlots(registryPath: string, preset: string): Promise<string[]> {
  const choices: string[] = [];
  // Only answers the new project can install: a component for another target would fail in `new`.
  for (const slot of openRegistry(registryPath).slots(preset, NEW_PROJECT_TARGETS)) {
    if (slot.options.length < 2) continue;
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

async function start(dir: string, name: string): Promise<number> {
  const choice = await choose<"up" | "dev" | "later">(
    "Start it?",
    [
      { value: "up", label: "In Docker, in the background (`pikit up`)", hint: "it keeps running after you log out" },
      { value: "dev", label: "Here, in this terminal (`pikit dev`)", hint: "Ctrl-C stops it" },
      { value: "later", label: "Not now" },
    ],
    "up",
  );
  if (choice === "dev") return await dev(dir);
  if (choice === "later") return later(name, "up");
  await deployment(dir, "up");
  outro(`Your agent is running. In its folder (\`cd ${name}\`): \`pikit logs --follow\` to watch it, \`pikit status\`, \`pikit down\` to stop it.`);
  return 0;
}

function later(name: string, from: "configure" | "up"): number {
  const steps = from === "configure" ? "pikit configure && pikit up" : "pikit up";
  outro(`Later: cd ${name} && ${steps}   (or \`pikit new\` again, answering "${name}")`);
  return 0;
}
