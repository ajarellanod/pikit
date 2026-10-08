/**
 * Run as `bun component-configure.ts <project-dir> <output-file> interactive|batch` in the project's
 * directory: the components' own steps of `pikit configure`.
 *
 * A component that needs more than a variable typed in (a token to check, an id to discover)
 * ships `src/pikit/<name>/configure.ts` exporting `configure(io)`. The CLI calls it and knows
 * nothing about what it does: the component owns its setup as it owns its code. The step
 * gets its config from `pikit.config.ts` (and may set a key of it: `setConfig`), reads and writes
 * `.env` through `io`, asks through the terminal, and returns what is still missing.
 *
 * It runs in the project's own process tree like every other project code (`run.ts`), with the
 * terminal inherited so the step can ask. Its result goes to a file, never to stdout.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONFIG_FILE, setConfigValue, WORKER_CONFIG } from "./config-file.ts";
import { ENV_FILE, readEnv, writeEnv } from "./env-file.ts";
import { readProjectManifest } from "./pikit-json.ts";
import { ask, askSecret, Cancelled, choose, confirm, log } from "../ui.ts";

export type ComponentConfigureResult = { ok: true; ran: string[]; missing: string[] } | { ok: false; error: string; cancelled?: true };

/** What a component's `configure(io)` receives. Components declare the same shape; nothing is imported. */
export interface ConfigureIO {
  interactive: boolean;
  config: Readonly<Record<string, unknown>>;
  get(name: string): string | undefined;
  /** Writes to `.env` (mode 0600) now; nothing happens when `.env` already has that value. */
  set(name: string, value: string): void;
  /**
   * Sets `key` of this component's entry in `pikit.config.ts` to `value` (written as JSON), and in
   * `workerConfig` too when the component goes in both Apps on Cloudflare. A step written for an older
   * CLI may not use it.
   */
  setConfig(key: string, value: string | number | boolean): void;
  ask(question: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  /** One of `choices`, with the arrow keys. A step written for an older CLI may not use it. */
  choose(message: string, choices: { value: string; label: string; hint?: string }[]): Promise<string>;
  /** Yes or no; Enter gives `initialValue`. */
  confirm(message: string, initialValue: boolean): Promise<boolean>;
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
  const { components } = readProjectManifest(projectDir);
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
      setConfig(key, value) {
        const path = join(projectDir, CONFIG_FILE);
        let text = setConfigValue(readFileSync(path, "utf8"), name, key, JSON.stringify(value));
        // A component in both Apps (`apps.worker: "default"`) has its entry in each config.
        if (components[name]?.apps?.worker === "default") text = setConfigValue(text, name, key, JSON.stringify(value), WORKER_CONFIG);
        writeFileSync(path, text);
        log.ok(`${CONFIG_FILE}: set ${name}.${key}`);
      },
      ask: (question) => ask(question),
      askSecret,
      choose: (message, choices) => choose(message, choices),
      confirm,
      say: (line) => log.info(line),
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
    result = { ok: false, error: error instanceof Error ? error.message : String(error), ...(error instanceof Cancelled && { cancelled: true as const }) };
  }
  writeFileSync(output, JSON.stringify(result));
  process.exit(0);
}
