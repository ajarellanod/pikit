/**
 * Run as `bun component-configure.ts <project-dir> <output-file> interactive|batch` in the project's
 * directory: the components' own steps of `pikit configure`.
 *
 * A component that needs more than a variable typed in (a token to check, an id to discover)
 * ships `src/pikit/<name>/configure.ts` exporting `configure(io)`. The CLI calls it and knows
 * nothing about what it does (SPEC §11): the component owns its setup as it owns its code. The step
 * gets its config from `pikit.config.ts`, reads and writes `.env` through `io`, asks through the
 * terminal, and returns what is still missing.
 *
 * It runs in the project's own process tree like every other project code (`run.ts`), with the
 * terminal inherited so the step can ask. Its result goes to a file, never to stdout.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ENV_FILE, readEnv, writeEnv } from "./env-file.ts";
import { readProjectManifest } from "./pikit-json.ts";
import { ask, askSecret, log } from "../ui.ts";

export type ComponentConfigureResult = { ok: true; ran: string[]; missing: string[] } | { ok: false; error: string };

/** What a component's `configure(io)` receives. Components declare the same shape; nothing is imported. */
export interface ConfigureIO {
  interactive: boolean;
  config: Readonly<Record<string, unknown>>;
  get(name: string): string | undefined;
  /** Writes to `.env` (mode 0600) now; nothing happens when `.env` already has that value. */
  set(name: string, value: string): void;
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  say(line: string): void;
}

/** The installed components that have a step of their own, in install order. */
export function componentsWithSteps(projectDir: string): string[] {
  return Object.keys(readProjectManifest(projectDir).components).filter((name) => existsSync(stepOf(projectDir, name)));
}

function stepOf(projectDir: string, name: string): string {
  return join(projectDir, "src", "pikit", name, "configure.ts");
}

async function run(projectDir: string, interactive: boolean): Promise<ComponentConfigureResult> {
  const definition = ((await import(pathToFileURL(join(projectDir, "pikit.config.ts")).href)) as { default?: { config?: Record<string, unknown> } }).default;
  const ran: string[] = [];
  const missing: string[] = [];
  for (const name of componentsWithSteps(projectDir)) {
    const step = (await import(pathToFileURL(stepOf(projectDir, name)).href)) as { configure?: (io: ConfigureIO) => Promise<string[]> };
    if (typeof step.configure !== "function") continue;
    const config = definition?.config?.[name];
    const io: ConfigureIO = {
      interactive,
      config: typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {},
      // An exported variable wins over .env, as everywhere else in `pikit configure`.
      get: (variable) => process.env[variable] || readEnv(projectDir).get(variable) || undefined,
      set(variable, value) {
        process.env[variable] = value;
        if (readEnv(projectDir).get(variable) === value) return;
        writeEnv(projectDir, new Map([[variable, value]]));
        log.ok(`${ENV_FILE} (mode 0600): set ${variable}`);
      },
      ask,
      askSecret,
      say: (line) => console.info(line),
    };
    missing.push(...(await step.configure(io)));
    ran.push(name);
  }
  return { ok: true, ran, missing };
}

if (import.meta.main) {
  const [projectDir = ".", output = "", mode = "batch"] = process.argv.slice(2);
  let result: ComponentConfigureResult;
  try {
    result = await run(projectDir, mode === "interactive");
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  writeFileSync(output, JSON.stringify(result));
  process.exit(0);
}
