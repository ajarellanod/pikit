/**
 * Run as `bun component-doctor.ts <project-dir> <output-file>` in the project's directory: the
 * components' own checks of `pikit doctor`, which `pikit up` and `pikit dev` run first.
 *
 * A component whose config can be wrong in a way only the outside world tells (an MCP server that
 * cannot be reached, or lacks a tool config names) ships `src/pikit/<name>/doctor.ts` exporting
 * `doctor(io)`, as it ships `configure.ts` for its step of `pikit configure`: the CLI calls it and
 * knows nothing about what it checks (SPEC §11). It gets its config from `pikit.config.ts` and a
 * reader of `.env` and the environment, and resolves with its problems (empty when it is fine). It
 * may reach the network: a project without such a component starts no process for this.
 *
 * It runs in the project's own process tree like every other project code (`run.ts`). A problem must
 * never hold a secret's value; the result goes to a file, never to stdout.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readProjectManifest } from "./pikit-json.ts";

export type ComponentDoctorResult = { ok: true; problems: string[] } | { ok: false; error: string };

/** What a component's `doctor(io)` receives. Components declare the same shape; nothing is imported. */
export interface DoctorIO {
  /** The component's config in `pikit.config.ts`: the default export's, else the Worker's. */
  config: Readonly<Record<string, unknown>>;
  /** A variable of the environment or `.env` (the environment wins), or `undefined`. */
  get(name: string): string | undefined;
}

/** The installed components that have a check of their own, in install order. */
export function componentsWithChecks(projectDir: string): string[] {
  return Object.keys(readProjectManifest(projectDir).components).filter((name) => existsSync(checkOf(projectDir, name)));
}

function checkOf(projectDir: string, name: string): string {
  return join(projectDir, "src", "pikit", name, "doctor.ts");
}

type Definition = { config?: Record<string, unknown> } | undefined;

async function run(projectDir: string): Promise<string[]> {
  const module = (await import(pathToFileURL(join(projectDir, "pikit.config.ts")).href)) as { default?: Definition; worker?: Definition };
  const problems: string[] = [];
  for (const name of componentsWithChecks(projectDir)) {
    const check = (await import(pathToFileURL(checkOf(projectDir, name)).href)) as { doctor?: (io: DoctorIO) => Promise<unknown> };
    if (typeof check.doctor !== "function") {
      problems.push(`${name}: src/pikit/${name}/doctor.ts does not export doctor`);
      continue;
    }
    const config = module.default?.config?.[name] ?? module.worker?.config?.[name];
    const io: DoctorIO = {
      config: typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {},
      // `runScript` passes the project's environment: `.env` under the process's own.
      get: (variable) => process.env[variable] || undefined,
    };
    try {
      const found = await check.doctor(io);
      if (!Array.isArray(found)) throw new Error("doctor did not resolve with a list of problems");
      problems.push(...found.map((problem) => `${name}: ${String(problem)}`));
    } catch (error) {
      problems.push(`${name}: its doctor check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const [projectDir = ".", output = ""] = process.argv.slice(2);
  let result: ComponentDoctorResult;
  try {
    result = { ok: true, problems: await run(projectDir) };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  writeFileSync(output, JSON.stringify(result));
  process.exit(0);
}
