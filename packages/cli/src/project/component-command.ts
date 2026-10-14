/**
 * Run as `bun component-command.ts <project-dir> <output-file> <name> [args...]` in the project's
 * directory: `pikit <name> [args...]`, a command an installed component adds to the CLI.
 *
 * A component declares it in its `component.json`, `"commands": { "<name>": { "file": "<own file>",
 * "description": "<one line>" } }`, a file of its own exporting `command(io)`, as it declares a hook
 * (`component-doctor.ts`). `pikit add` records it in `pikit.json` by project path; the CLI runs it and
 * knows nothing about what it does. It gets the arguments after its name as they were typed, its
 * config from `pikit.config.ts` when it asks (importing that file imports every component, and a
 * command that repairs the project must run without it), a reader of `.env` and the environment, and
 * a way to say a line; it resolves with its problems (empty, or nothing, when it is done). A file that
 * does not export `command`, or a command that throws, is a problem too.
 *
 * It runs on the machine that runs the CLI, in the project's own process tree like every other
 * project code (`run.ts`), stdin and stdout inherited: it may ask, print, and write the project's
 * files. Its result goes to a file, never to stdout.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readProjectManifest } from "./pikit-json.ts";

export type ComponentCommandResult = { ok: true; problems: string[] } | { ok: false; error: string };

/** What a component's `command(io)` receives. Components declare the same shape; nothing is imported. */
export interface CommandIO {
  /** The arguments after `pikit <name>`, as typed: the CLI parses none of them. */
  args: readonly string[];
  /** The component's config in `pikit.config.ts` (the default export's, else the Worker's), imported when asked. */
  config(): Promise<Readonly<Record<string, unknown>>>;
  /** A variable of the environment or `.env` (the environment wins), or `undefined`. */
  get(name: string): string | undefined;
  /** A line for the person running it. */
  say(line: string): void;
}

/** An installed component's command, as `pikit.json` records it: its project-relative file. */
export interface ComponentCommand {
  name: string;
  component: string;
  file: string;
  description: string;
}

/** The installed components' commands (`commands` in `pikit.json`), in install order. */
export function componentCommands(projectDir: string): ComponentCommand[] {
  return Object.entries(readProjectManifest(projectDir).components).flatMap(([component, installed]) =>
    Object.entries(installed.commands ?? {}).map(([name, { file, description }]) => ({ name, component, file, description })),
  );
}

type Definition = { config?: Record<string, unknown> } | undefined;

async function run(projectDir: string, name: string, args: readonly string[]): Promise<string[]> {
  const found = componentCommands(projectDir).find((command) => command.name === name);
  if (found === undefined) throw new Error(`no installed component declares the command "${name}"`);
  const { component, file } = found;
  let config: Promise<Readonly<Record<string, unknown>>> | undefined;
  const io: CommandIO = {
    args,
    config: () =>
      (config ??= import(pathToFileURL(join(projectDir, "pikit.config.ts")).href).then((module: { default?: Definition; worker?: Definition }) => {
        const own = module.default?.config?.[component] ?? module.worker?.config?.[component];
        return typeof own === "object" && own !== null ? (own as Record<string, unknown>) : {};
      })),
    // `runScript` passes the project's environment: `.env` under the process's own.
    get: (variable) => process.env[variable] || undefined,
    say: (line) => console.log(line),
  };
  try {
    const module = (await import(pathToFileURL(join(projectDir, file)).href)) as { command?: (io: CommandIO) => Promise<unknown> };
    if (typeof module.command !== "function") return [`${component}: ${file} does not export command`];
    const problems = await module.command(io);
    if (problems === undefined) return [];
    if (!Array.isArray(problems)) throw new Error("command did not resolve with a list of problems");
    return problems.map((problem: unknown) => String(problem));
  } catch (error) {
    return [`${component}: pikit ${name} failed: ${error instanceof Error ? error.message : String(error)}`];
  }
}

if (import.meta.main) {
  const [projectDir = ".", output = "", name = "", ...args] = process.argv.slice(2);
  let result: ComponentCommandResult;
  try {
    result = { ok: true, problems: await run(projectDir, name, args) };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  writeFileSync(output, JSON.stringify(result));
  process.exit(0);
}
