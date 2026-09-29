/**
 * Run as `bun component-doctor.ts <project-dir> <output-file>` in the project's directory: the
 * components' own checks of `pikit doctor`, which `pikit up` and `pikit dev` run first.
 *
 * A component whose config can be wrong in a way only the outside world tells (an MCP server that
 * cannot be reached, or lacks a tool config names) declares a check in its `component.json`,
 * `"hooks": { "doctor": "doctor.ts" }`, a file of its own exporting `doctor(io)`, as it declares
 * `afterDeploy` (SPEC §3.2). `pikit add` records it in `pikit.json` by project path; the CLI calls it
 * and knows nothing about what it checks. It gets its config from `pikit.config.ts` and a reader of
 * `.env` and the environment, and resolves with its problems (empty when it is fine). It may reach
 * the network, and writes nothing: a project without such a component starts no process for this.
 *
 * It runs in the project's own process tree like every other project code (`run.ts`). A problem must
 * never hold a secret's value; the result goes to a file, never to stdout.
 */

import { writeFileSync } from "node:fs";
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

/** An installed component's check, as `pikit.json` records it: its project-relative file. */
export interface DoctorHook {
  component: string;
  file: string;
}

/** The installed components' checks (`hooks.doctor` in `pikit.json`), in install order. */
export function doctorHooks(projectDir: string): DoctorHook[] {
  return Object.entries(readProjectManifest(projectDir).components).flatMap(([component, installed]) => {
    const file = installed.hooks?.doctor;
    return typeof file === "string" ? [{ component, file }] : [];
  });
}

type Definition = { config?: Record<string, unknown> } | undefined;

async function run(projectDir: string): Promise<string[]> {
  const module = (await import(pathToFileURL(join(projectDir, "pikit.config.ts")).href)) as { default?: Definition; worker?: Definition };
  const problems: string[] = [];
  for (const { component: name, file } of doctorHooks(projectDir)) {
    const config = module.default?.config?.[name] ?? module.worker?.config?.[name];
    const io: DoctorIO = {
      config: typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {},
      // `runScript` passes the project's environment: `.env` under the process's own.
      get: (variable) => process.env[variable] || undefined,
    };
    try {
      const check = (await import(pathToFileURL(join(projectDir, file)).href)) as { doctor?: (io: DoctorIO) => Promise<unknown> };
      if (typeof check.doctor !== "function") {
        problems.push(`${name}: ${file} does not export doctor`);
        continue;
      }
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
