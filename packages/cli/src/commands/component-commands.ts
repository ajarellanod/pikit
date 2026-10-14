/**
 * `pikit <name> [args...]`: a command an installed component adds (`commands` in its `component.json`,
 * recorded by `pikit add` in `pikit.json`). The CLI knows only its name, its description and its
 * file: it runs it in the project (`component-command.ts`, in a child `bun`, stdin and stdout
 * inherited), passing the arguments as they were typed, and prints its problems.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ComponentCommand, type ComponentCommandResult, componentCommands } from "../project/component-command.ts";
import { PIKIT_JSON } from "../project/pikit-json.ts";
import { runScript } from "../project/run.ts";
import { BUILT_IN_COMMANDS } from "../registry/manifest.ts";
import { log } from "../ui.ts";

/**
 * The installed component's command `name` in the project at `cwd`, or undefined: a name of the CLI's
 * own, or no project here, or no component declares it (then the CLI says what it says of any name).
 */
export function installedCommand(cwd: string, name: string | undefined): ComponentCommand | undefined {
  if (name === undefined || BUILT_IN_COMMANDS.includes(name) || !existsSync(join(cwd, PIKIT_JSON))) return undefined;
  return componentCommands(cwd).find((command) => command.name === name);
}

/** Runs `command` with `args` in the project: 1 when it reports problems (printed), else 0. */
export async function runComponentCommand(cwd: string, command: ComponentCommand, args: readonly string[]): Promise<number> {
  const result = await runScript<ComponentCommandResult>("component-command.ts", cwd, [command.name, ...args], { interactive: true });
  if (!result.ok) throw new Error(`pikit ${command.name} (${command.component}) could not run: ${result.error}`);
  for (const problem of result.problems) log.problem(problem);
  return result.problems.length > 0 ? 1 : 0;
}

/** What `pikit help` adds in a project whose components have commands: each, its description and its component. */
export function componentCommandsUsage(cwd: string): string {
  if (!existsSync(join(cwd, PIKIT_JSON))) return "";
  let commands: ComponentCommand[];
  try {
    commands = componentCommands(cwd);
  } catch {
    // Help still helps in a project whose pikit.json does not read: `pikit doctor` says why.
    return "";
  }
  if (commands.length === 0) return "";
  const width = Math.max(...commands.map((command) => command.name.length));
  const lines = commands.map(({ name, component, description }) => `  pikit ${name.padEnd(width)}   ${description} (${component})`);
  return `\n\nThis project's components add:\n${lines.join("\n")}`;
}
