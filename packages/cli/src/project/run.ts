/**
 * Running the project's own code from the CLI: always in a child `bun` process, in the project's
 * directory, with the project's environment. The CLI never imports a project's components into
 * its own process, except the deployment component's commands, which are plain functions.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnv } from "./env-file.ts";
import type { ProbeResult } from "./probe.ts";

/**
 * The environment the project runs with: `.env`, then the process's own variables over it (a
 * variable exported in the shell wins, as with Compose and Bun). Values are passed on, never printed.
 */
export function projectEnv(projectDir: string): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(readEnv(projectDir));
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  return env;
}

/** Runs a script of this package with Bun in the project's directory; its JSON result is read from a file. */
export async function runScript<T>(script: string, projectDir: string, args: string[], options: { interactive?: boolean } = {}): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pikit-cli-"));
  const output = join(dir, "result.json");
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, script), projectDir, output, ...args], {
      cwd: projectDir,
      env: projectEnv(projectDir),
      stdin: options.interactive ? "inherit" : "ignore",
      stdout: options.interactive ? "inherit" : "pipe",
      stderr: "inherit",
    });
    const code = await child.exited;
    let text: string;
    try {
      text = readFileSync(output, "utf8");
    } catch {
      throw new Error(`${script} exited with code ${code} and no result`);
    }
    return JSON.parse(text) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The app `pikit.config.ts` composes, created and described without starting (SPEC §4.6). */
export function probe(projectDir: string): Promise<ProbeResult> {
  return runScript<ProbeResult>("probe.ts", projectDir, []);
}
