/**
 * `pikit doctor`: everything up to and including setup, never a start.
 *
 * It creates the app `pikit.config.ts` composes, in a child process, and prints the component
 * graph, the capability providers, the pipelines and the config; on Cloudflare, of each App (C1).
 * Then it checks:
 * - no `pikit add`, `remove` or `upgrade` was left unfinished (`operation.ts`): its marker is a problem
 *   until the person has checked the project and deleted it; doctor never deletes it;
 * - `bun.lock` matches `package.json`'s dependencies (`lockfile.ts`), read offline: no `bun install`;
 * - the app composes: every required capability has a provider, selections are valid, the config
 *   matches the merged schema (the core's own `create()` decides);
 * - every tool and model provider an agent names statically is an installed key, when a
 *   component (the runtime) uses it: the runtime would refuse to start otherwise (`references.ts`);
 * - the app answers someone: a channel has a router (a `route.resolve` stage), and `http.route`s a
 *   server, but in the Worker's App, whose host serves them (`serving.ts`);
 * - every variable a component marks required is set in the environment or in `.env` (names
 *   only, never a value);
 * - the Pi import rule: only `@pikit/pi-adapter` imports Pi. Neither components nor project
 *   code import `@earendil-works/*`;
 * - each installed component's own check, the file its `hooks.doctor` names (`component-doctor.ts`),
 *   once the app composes: `tool-mcp` reaches each MCP server it names. Only such a check may reach the
 *   network; a project without one runs none.
 * Installed files that differ from what was installed are listed as information: they are yours. So
 * is a kit in `vendor/` that is not this CLI's (`staleKit`): behind it, `pikit upgrade` refreshes it;
 * from a checkout this CLI's does not include, updating pikit does.
 *
 * `problems` fail the command. `unconfigured` fail it too, but `pikit new` expects them: a new
 * project is configured next, by `pikit configure`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { packageName, scanImports } from "../registry/imports.ts";
import { type ComponentDoctorResult, doctorHooks, UNLESS_BEFORE_DEPLOY } from "../project/component-doctor.ts";
import { projectEnv, probe, runScript } from "../project/run.ts";
import type { AppDescription, ProbeResult } from "../project/probe.ts";
import { brokenReferences } from "../project/references.ts";
import { servingGaps } from "../project/serving.ts";
import { checkLockfile } from "../project/lockfile.ts";
import { incompleteOperation, incompleteOperationMessage } from "../project/operation.ts";
import { missingFiles, modifiedFiles, readProjectManifest } from "../project/pikit-json.ts";
import { log } from "../ui.ts";
import { confinedPath } from "../project/paths.ts";
import { DASHBOARD_DIR } from "../project/dashboard.ts";
import { kitCommit, kitOrder, staleKit } from "../project/vendor.ts";

export interface DoctorReport {
  problems: string[];
  /** Required variables that are not set. */
  unconfigured: string[];
  /** Information: modified files, installed components that are not listed. */
  notes: string[];
  probe: ProbeResult;
}

export interface DoctorOptions {
  quiet?: boolean;
  /**
   * Whether the components' own checks run (default: yes). `add`, `remove` and `new` check what
   * they changed, the composition: an MCP server down elsewhere is not theirs to report.
   * `"unless-before-deploy"` (`pikit up`): not those of components with a `beforeDeploy` hook, which
   * `up` runs right before the build and which checks the same.
   */
  componentChecks?: boolean | "unless-before-deploy";
}

export async function doctor(projectDir: string, options: DoctorOptions = {}): Promise<DoctorReport> {
  const project = readProjectManifest(projectDir);
  const problems: string[] = [];
  const unconfigured: string[] = [];
  const notes: string[] = [];

  const operation = incompleteOperation(projectDir);
  if (operation !== undefined) problems.push(incompleteOperationMessage(operation));
  if (!existsSync(join(projectDir, "node_modules"))) problems.push("dependencies are not installed: run `bun install`");
  const lockfile = checkLockfile(projectDir);
  problems.push(...lockfile.problems);
  notes.push(...lockfile.notes);
  const kit = kitNote(projectDir, project.kit?.commit);
  if (kit !== undefined) notes.push(kit);

  const result = await probe(projectDir);
  if (!result.ok) problems.push(`pikit.config.ts does not compose: ${result.error}`);
  else {
    if (options.quiet !== true) {
      printGraph(result.description);
      if (result.worker !== undefined) {
        log.info("The Worker's App (export const worker):");
        printGraph(result.worker, "  ");
      }
    }
    for (const name of Object.keys(project.components)) {
      const listable = existsSync(join(projectDir, "src", "pikit", name, "index.ts")) && !name.startsWith("deployment-");
      if (listable && !result.listed.includes(name)) notes.push(`${name} is installed but not listed in pikit.config.ts`);
    }
    notes.push(...unusedProviders(result.description.components));
    problems.push(...brokenReferences(result));
    problems.push(...servingGaps(result).map((gap) => gap.message));
    if (options.componentChecks !== false) {
      const checked = await componentChecks(projectDir, options.componentChecks === "unless-before-deploy");
      problems.push(...checked.problems);
      notes.push(...checked.notes);
    }
  }

  const env = projectEnv(projectDir);
  for (const [name, component] of Object.entries(project.components)) {
    for (const variable of component.environment) {
      if (variable.required && (env[variable.name] ?? "") === "") {
        unconfigured.push(`${variable.name} is not set (${name} requires it): run \`pikit configure\``);
      }
    }
    try {
      for (const file of modifiedFiles(projectDir, component)) notes.push(`modified: ${file} (${name})`);
      for (const file of missingFiles(projectDir, component)) notes.push(`deleted: ${file} (${name})`);
    } catch (error) {
      problems.push(`${name}'s installed files cannot be checked: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  try {
    const sources = projectSources(projectDir);
    problems.push(...checkPiImports(projectDir, sources));
  } catch (error) {
    problems.push(`the project's source files cannot be checked: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (options.quiet !== true) {
    for (const note of notes) log.info(`  ${note}`);
    for (const missing of unconfigured) log.warn(missing);
    for (const problem of problems) log.problem(problem);
    if (problems.length === 0 && unconfigured.length === 0) log.ok("pikit doctor: green");
  }
  return { problems, unconfigured, notes, probe: result };
}

/** What to say of a kit in `vendor/` that is not this CLI's; nothing when it is, or when there is none. */
function kitNote(projectDir: string, commit: string | undefined): string | undefined {
  if (!existsSync(join(projectDir, "package.json"))) return undefined;
  const { stale } = staleKit(projectDir);
  if (stale.length === 0) return undefined;
  const cli = kitCommit() ?? "not in Git";
  if (kitOrder(commit).verdict === "downgrade") {
    return `the project's kit (vendor/) comes from pikit ${commit}, which this CLI's checkout (${cli}) does not include: update pikit before \`pikit add\` or \`pikit upgrade\``;
  }
  return `the project's kit (vendor/) is ${commit === undefined ? "another" : `pikit ${commit}`}, not this CLI's (${cli}): \`pikit upgrade\` refreshes it (${stale.join(", ")})`;
}

/** What the installed components' own checks find; nothing, and no process, without a check to run. */
async function componentChecks(projectDir: string, unlessBeforeDeploy: boolean): Promise<{ problems: string[]; notes: string[] }> {
  if (doctorHooks(projectDir, { unlessBeforeDeploy }).length === 0) return { problems: [], notes: [] };
  const result = await runScript<ComponentDoctorResult>("component-doctor.ts", projectDir, unlessBeforeDeploy ? [UNLESS_BEFORE_DEPLOY] : []);
  return result.ok ? result : { problems: [`the components' own checks could not run: ${result.error}`], notes: [] };
}

/** Components that provide capabilities no other component uses: installed, and doing nothing. */
function unusedProviders(components: Extract<ProbeResult, { ok: true }>["description"]["components"]): string[] {
  const used = new Set(components.flatMap((c) => [...c.requires, ...c.optional]));
  return components
    .filter((c) => c.provides.length > 0 && c.provides.every((capability) => !used.has(capability)))
    .map((c) => `${c.name} provides ${c.provides.join(", ")}, which no component uses: \`pikit remove ${c.name}\` if you do not need it`);
}

function printGraph(description: AppDescription, indent = ""): void {
  const { components, capabilities, pipelines, config } = description;
  const width = Math.max(...components.map((c) => c.name.length), 10);
  log.info(`${indent}Components, in start order:`);
  for (const c of components) {
    const parts = [
      c.provides.length > 0 ? `provides ${c.provides.join(", ")}` : "",
      c.requires.length > 0 ? `requires ${c.requires.join(", ")}` : "",
      c.optional.length > 0 ? `uses if present ${c.optional.join(", ")}` : "",
    ].filter((p) => p !== "");
    log.info(`${indent}  ${c.name.padEnd(width)}  ${parts.join(" · ")}`);
  }
  log.info(`${indent}Capabilities:`);
  for (const [name, capability] of Object.entries(capabilities).sort(([a], [b]) => a.localeCompare(b))) {
    const provider = capability.keys
      ? Object.entries(capability.keys).map(([key, owner]) => `${key} → ${owner}`).join(", ") || "(no keys)"
      : (capability.selected ?? capability.providers.join(", "));
    log.info(`${indent}  ${name}: ${provider}`);
  }
  log.info(`${indent}Pipelines:`);
  for (const [name, stages] of Object.entries(pipelines)) {
    log.info(`${indent}  ${name}: ${stages.map((s) => `${s.id} (${s.priority})`).join(" → ")}`);
  }
  log.info(`${indent}Config:\n${JSON.stringify(config, null, 2).replace(/^/gm, `${indent}  `)}`);
}

/** The Pi import rule in the project: `@earendil-works/*` is imported only by the adapter. */
export function checkPiImports(projectDir: string, sources: readonly string[] = projectSources(projectDir)): string[] {
  const problems: string[] = [];
  for (const file of sources) {
    for (const specifier of scanImports(readFileSync(join(projectDir, file), "utf8"))) {
      if (!specifier.startsWith("@earendil-works/")) continue;
      problems.push(`${file} imports "${specifier}": only @pikit/pi-adapter imports Pi`);
    }
  }
  return problems;
}

const SKIPPED = new Set(["node_modules", "vendor", ".pikit", ".git", "dist"]);

/**
 * The project's own source files, relative, without dependencies or state. Not the dashboard's
 * (`src/dashboard/`): a project of its own, whose packages are its own `package.json`'s.
 */
export function projectSources(projectDir: string, dir = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir === "" ? projectDir : confinedPath(projectDir, dir))) {
    if (SKIPPED.has(entry)) continue;
    const relative = dir === "" ? entry : `${dir}/${entry}`;
    if (relative === DASHBOARD_DIR) continue;
    const stats = statSync(confinedPath(projectDir, relative));
    if (stats.isDirectory()) files.push(...projectSources(projectDir, relative));
    else if (stats.isFile() && /\.[cm]?[jt]sx?$/.test(entry)) files.push(relative);
  }
  return files;
}
