/**
 * `pikit doctor` (SPEC §4.6, §11): everything up to and including setup, never a start.
 *
 * It creates the app `pikit.config.ts` composes, in a child process, and prints the component
 * graph, the capability providers, the pipelines and the config. Then it checks:
 * - the app composes: every required capability has a provider, selections are valid, the config
 *   matches the merged schema (the core's own `create()` decides, SPEC §4.6);
 * - every variable a component marks required is set in the environment or in `.env` (names
 *   only, never a value);
 * - the Pi import rule (S1): only `@pikit/pi-adapter` imports Pi. Components never import
 *   `@earendil-works/*`; project code only imports `@earendil-works/pi-coding-agent`, the name Pi
 *   extensions use, which resolves to `@pikit/pi-extension-shim` (SPEC §6.2b).
 * Installed files that differ from what was installed are listed as information: they are yours.
 *
 * `problems` fail the command. `unconfigured` fail it too, but `pikit new` expects them: a new
 * project is configured next, by `pikit configure`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { packageName, scanImports } from "../registry/imports.ts";
import { projectEnv, probe } from "../project/run.ts";
import type { ProbeResult } from "../project/probe.ts";
import { missingFiles, modifiedFiles, readProjectManifest } from "../project/pikit-json.ts";
import { EXTENSION_ALIAS } from "../project/vendor.ts";
import { log } from "../ui.ts";

export interface DoctorReport {
  problems: string[];
  /** Required variables that are not set. */
  unconfigured: string[];
  /** Information: modified files, installed components that are not listed. */
  notes: string[];
  probe: ProbeResult;
}

export async function doctor(projectDir: string, options: { quiet?: boolean } = {}): Promise<DoctorReport> {
  const project = readProjectManifest(projectDir);
  const problems: string[] = [];
  const unconfigured: string[] = [];
  const notes: string[] = [];

  if (!existsSync(join(projectDir, "node_modules"))) problems.push("dependencies are not installed: run `bun install`");

  const result = await probe(projectDir);
  if (!result.ok) problems.push(`pikit.config.ts does not compose: ${result.error}`);
  else {
    if (options.quiet !== true) printGraph(result);
    for (const name of Object.keys(project.components)) {
      const listable = existsSync(join(projectDir, "src", "pikit", name, "index.ts")) && !name.startsWith("deployment-");
      if (listable && !result.listed.includes(name)) notes.push(`${name} is installed but not listed in pikit.config.ts`);
    }
    notes.push(...unusedProviders(result.description.components));
  }

  const env = projectEnv(projectDir);
  for (const [name, component] of Object.entries(project.components)) {
    for (const variable of component.environment) {
      if (variable.required && (env[variable.name] ?? "") === "") {
        unconfigured.push(`${variable.name} is not set (${name} requires it): run \`pikit configure\``);
      }
    }
    for (const file of modifiedFiles(projectDir, component)) notes.push(`modified: ${file} (${name})`);
    for (const file of missingFiles(projectDir, component)) notes.push(`deleted: ${file} (${name})`);
  }

  problems.push(...checkPiImports(projectDir));

  if (options.quiet !== true) {
    for (const note of notes) log.info(`  ${note}`);
    for (const missing of unconfigured) log.warn(missing);
    for (const problem of problems) log.problem(problem);
    if (problems.length === 0 && unconfigured.length === 0) log.ok("pikit doctor: green");
  }
  return { problems, unconfigured, notes, probe: result };
}

/** Components that provide capabilities no other component uses: installed, and doing nothing. */
function unusedProviders(components: Extract<ProbeResult, { ok: true }>["description"]["components"]): string[] {
  const used = new Set(components.flatMap((c) => [...c.requires, ...c.optional]));
  return components
    .filter((c) => c.provides.length > 0 && c.provides.every((capability) => !used.has(capability)))
    .map((c) => `${c.name} provides ${c.provides.join(", ")}, which no component uses: \`pikit remove ${c.name}\` if you do not need it`);
}

function printGraph(result: Extract<ProbeResult, { ok: true }>): void {
  const { components, capabilities, pipelines, config } = result.description;
  const width = Math.max(...components.map((c) => c.name.length), 10);
  log.info("Components, in start order:");
  for (const c of components) {
    const parts = [
      c.provides.length > 0 ? `provides ${c.provides.join(", ")}` : "",
      c.requires.length > 0 ? `requires ${c.requires.join(", ")}` : "",
      c.optional.length > 0 ? `uses if present ${c.optional.join(", ")}` : "",
    ].filter((p) => p !== "");
    log.info(`  ${c.name.padEnd(width)}  ${parts.join(" · ")}`);
  }
  log.info("Capabilities:");
  for (const [name, capability] of Object.entries(capabilities).sort(([a], [b]) => a.localeCompare(b))) {
    const provider = capability.keys
      ? Object.entries(capability.keys).map(([key, owner]) => `${key} → ${owner}`).join(", ") || "(no keys)"
      : (capability.selected ?? capability.providers.join(", "));
    log.info(`  ${name}: ${provider}`);
  }
  log.info("Pipelines:");
  for (const [name, stages] of Object.entries(pipelines)) {
    log.info(`  ${name}: ${stages.map((s) => `${s.id} (${s.priority})`).join(" → ")}`);
  }
  log.info(`Config:\n${JSON.stringify(config, null, 2).replace(/^/gm, "  ")}`);
}

/** S1 in the project: `@earendil-works/*` is imported only by the adapter, and by Pi extensions under their alias. */
export function checkPiImports(projectDir: string): string[] {
  const problems: string[] = [];
  for (const file of projectSources(projectDir)) {
    const inComponent = file.startsWith("src/pikit/");
    for (const specifier of scanImports(readFileSync(join(projectDir, file), "utf8"))) {
      if (!specifier.startsWith("@earendil-works/")) continue;
      if (!inComponent && packageName(specifier) === EXTENSION_ALIAS) continue;
      problems.push(`${file} imports "${specifier}": only @pikit/pi-adapter imports Pi (S1)${inComponent ? "" : `; a Pi extension imports ${EXTENSION_ALIAS}`}`);
    }
  }
  return problems;
}

const SKIPPED = new Set(["node_modules", "vendor", ".pikit", ".git", "dist"]);

/** The project's own source files, relative, without dependencies or state. */
export function projectSources(projectDir: string, dir = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(projectDir, dir))) {
    if (SKIPPED.has(entry)) continue;
    const relative = dir === "" ? entry : `${dir}/${entry}`;
    const stats = statSync(join(projectDir, relative));
    if (stats.isDirectory()) files.push(...projectSources(projectDir, relative));
    else if (/\.[cm]?[jt]sx?$/.test(entry)) files.push(relative);
  }
  return files;
}
