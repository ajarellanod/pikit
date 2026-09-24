/**
 * `pikit new` in a terminal, with no directory: the guided path (SPEC §11). The installer runs it
 * when it finishes, so pasting the install line is the only command a person types.
 *
 * It asks, in order: the agent's name (its folder), where to talk to it (the registry's presets, by
 * their `title`), then runs `new`, `configure` (each component's own step, then the model's login)
 * and `up` or `dev`: the same functions the commands run, nothing of its own. It knows nothing about
 * Telegram or any channel: the choices come from the registry, the questions from the components.
 *
 * Ctrl-C stops it at any question. Running `pikit new` again with the same name continues with the
 * project already written: configuring and starting it again is harmless, because `configure` only
 * asks for what is missing.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_REGISTRY } from "../paths.ts";
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
      const creating = spinner(`Creating ${name}: its components, then \`bun install\``);
      try {
        await newProject(project.dir, { preset, registry: registryPath, next: false, quiet: true });
      } catch (error) {
        creating.error(`Could not create ${name}`);
        throw error;
      }
      creating.stop(`Created ${name} in ${project.dir}`);
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

async function choosePreset(registryPath: string): Promise<string> {
  const presets = openRegistry(registryPath).presets();
  if (presets.length === 0) throw new CliError(`the registry ${registryPath} has no presets to choose from`);
  // A title is "Name: what it is"; the part after the colon is the option's hint.
  return await choose(
    "Where do you want to talk to your agent?",
    presets.map((preset) => {
      const [label = preset.name, ...rest] = preset.title.split(": ");
      return { value: preset.name, label, ...(rest.length > 0 && { hint: rest.join(": ") }) };
    }),
  );
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
