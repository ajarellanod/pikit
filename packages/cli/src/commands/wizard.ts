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
import { ask, Cancelled, CliError, confirmYes, log } from "../ui.ts";
import { configure } from "./configure.ts";
import { deployment, dev } from "./deployment.ts";
import { newProject, validProjectName } from "./new.ts";

const DEFAULT_NAME = "my-agent";

export async function newWizard(parentDir: string, options: { registry?: string } = {}): Promise<number> {
  const registryPath = options.registry ?? DEFAULT_REGISTRY;
  log.info("\nLet's set up your agent. Ctrl-C stops at any question; `pikit new` continues where you left off.\n");
  let name = DEFAULT_NAME;
  try {
    const project = await chooseProject(parentDir);
    name = project.name;
    if (project.existing) log.ok(`continuing with ${name}`);
    else {
      const preset = await choosePreset(registryPath);
      await newProject(project.dir, { preset, registry: registryPath, next: false, quiet: true });
    }

    if (!(await confirmYes("\nConfigure it now (where you talk to it, and the model's login)?"))) return later(name, "configure");
    try {
      await configure(project.dir);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      log.problem(error.message);
      log.info(`\nFix that, then run \`pikit new\` again and answer "${name}": it continues from here.`);
      return 1;
    }
    return await start(project.dir, name);
  } catch (error) {
    if (error instanceof Cancelled) log.info(`\n\nStopped. Run \`pikit new\` again${name === DEFAULT_NAME ? "" : ` and answer "${name}"`} to continue.`);
    throw error;
  }
}

/** A new folder, or an existing pikit project to continue with. */
async function chooseProject(parentDir: string): Promise<{ dir: string; name: string; existing: boolean }> {
  for (;;) {
    const name = (await ask(`Name of your agent (a new folder in ${parentDir}) [${DEFAULT_NAME}]: `)) || DEFAULT_NAME;
    if (!validProjectName(name)) {
      log.problem(`"${name}": use lowercase letters, digits, "-", "." or "_"`);
      continue;
    }
    const dir = resolve(parentDir, name);
    if (!existsSync(dir) || readdirSync(dir).length === 0) return { dir, name, existing: false };
    if (existsSync(join(dir, "pikit.json"))) {
      if (await confirmYes(`${name} already exists. Continue setting it up?`)) return { dir, name, existing: true };
      continue;
    }
    log.problem(`${dir} exists and is not a pikit project: choose another name`);
  }
}

async function choosePreset(registryPath: string): Promise<string> {
  const presets = openRegistry(registryPath).presets();
  if (presets.length === 0) throw new CliError(`the registry ${registryPath} has no presets to choose from`);
  log.info("\nWhere do you want to talk to your agent?");
  presets.forEach((preset, i) => log.info(`  ${i + 1}) ${preset.title}`));
  for (;;) {
    const choice = Number(await ask("Choice: "));
    const preset = Number.isInteger(choice) ? presets[choice - 1] : undefined;
    if (preset !== undefined) return preset.name;
  }
}

async function start(dir: string, name: string): Promise<number> {
  const choice = await ask(
    [
      "\nStart it:",
      "  1) in Docker, in the background (`pikit up`): it keeps running after you log out",
      "  2) here, in this terminal (`pikit dev`): Ctrl-C stops it",
      "  s) not now",
      "Choice [1]: ",
    ].join("\n"),
  );
  if (choice === "2") return await dev(dir);
  if (choice !== "" && choice !== "1") return later(name, "up");
  await deployment(dir, "up");
  log.info(`\nYour agent is running. In its folder (\`cd ${name}\`): \`pikit logs --follow\` to watch it, \`pikit status\`, \`pikit down\` to stop it.`);
  return 0;
}

function later(name: string, from: "configure" | "up"): number {
  const steps = from === "configure" ? "pikit configure && pikit up" : "pikit up";
  log.info(`\nLater: cd ${name} && ${steps}   (or \`pikit new\` again, answering "${name}")`);
  return 0;
}
