/**
 * Run as `bun component-doctor.ts <project-dir> <output-file>` in the project's directory: the
 * components' own checks of `pikit doctor`, which `pikit up` and `pikit dev` run first.
 *
 * A component whose config can be wrong in a way only the outside world tells (an MCP server that
 * cannot be reached, or lacks a tool config names) declares a check in its `component.json`,
 * `"hooks": { "doctor": "doctor.ts" }`, a file of its own exporting `doctor(io)`, as it declares
 * `afterDeploy` (SPEC §3.2). `pikit add` records it in `pikit.json` by project path; the CLI calls it
 * and knows nothing about what it checks. It gets its config from `pikit.config.ts` and a reader of
 * `.env` and the environment, and resolves with its problems (empty when it is fine), or with
 * `{ problems, notes }` when it also has information to give (a note stops nothing). It may reach the
 * network, and writes nothing: a project without such a component starts no process for this.
 *
 * `pikit up` passes `--unless-before-deploy`: a component that also has a `beforeDeploy` hook is not
 * checked here, because `up` runs that hook right before the build and it checks the same (so each
 * MCP server, say, is reached once per deploy, not twice).
 *
 * It runs in the project's own process tree like every other project code (`run.ts`). A problem must
 * never hold a secret's value; the result goes to a file, never to stdout.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readProjectManifest } from "./pikit-json.ts";

export type ComponentDoctorResult = { ok: true; problems: string[]; notes: string[] } | { ok: false; error: string };

/** The flag `pikit up` passes: skip the checks of components that have a `beforeDeploy` hook. */
export const UNLESS_BEFORE_DEPLOY = "--unless-before-deploy";

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

/**
 * The installed components' checks (`hooks.doctor` in `pikit.json`), in install order; with
 * `unlessBeforeDeploy`, not those of components that also have a `beforeDeploy` hook.
 */
export function doctorHooks(projectDir: string, options: { unlessBeforeDeploy?: boolean } = {}): DoctorHook[] {
  return Object.entries(readProjectManifest(projectDir).components).flatMap(([component, installed]) => {
    const file = installed.hooks?.doctor;
    if (options.unlessBeforeDeploy === true && installed.hooks?.beforeDeploy !== undefined) return [];
    return typeof file === "string" ? [{ component, file }] : [];
  });
}

type Definition = { config?: Record<string, unknown> } | undefined;

async function run(projectDir: string, unlessBeforeDeploy: boolean): Promise<{ problems: string[]; notes: string[] }> {
  const module = (await import(pathToFileURL(join(projectDir, "pikit.config.ts")).href)) as { default?: Definition; worker?: Definition };
  const problems: string[] = [];
  const notes: string[] = [];
  for (const { component: name, file } of doctorHooks(projectDir, { unlessBeforeDeploy })) {
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
      const report = (Array.isArray(found) ? { problems: found } : found) as { problems?: unknown; notes?: unknown } | null;
      const listed = { problems: report?.problems, notes: report?.notes ?? [] };
      if (!Array.isArray(listed.problems) || !Array.isArray(listed.notes)) {
        throw new Error("doctor did not resolve with a list of problems, nor with { problems, notes }");
      }
      problems.push(...listed.problems.map((problem: unknown) => `${name}: ${String(problem)}`));
      notes.push(...listed.notes.map((note: unknown) => `${name}: ${String(note)}`));
    } catch (error) {
      problems.push(`${name}: its doctor check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { problems, notes };
}

if (import.meta.main) {
  const [projectDir = ".", output = "", ...flags] = process.argv.slice(2);
  let result: ComponentDoctorResult;
  try {
    result = { ok: true, ...(await run(projectDir, flags.includes(UNLESS_BEFORE_DEPLOY))) };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  writeFileSync(output, JSON.stringify(result));
  process.exit(0);
}
