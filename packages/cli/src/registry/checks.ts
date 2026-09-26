/**
 * The static checks of `registry validate`: one function per rule, each returning plain messages.
 * The drift check (S14) needs `setup` and lives in `commands.ts`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { capabilityEntry } from "./capabilities.ts";
import { isRelative, packageName, runtimeScheme, scanImports } from "./imports.ts";
import { type Manifest, ManifestSchema, schemaProblems } from "./manifest.ts";

/**
 * Component kinds (AGENTS.md, "Naming"): the table's kinds plus the ones the registry already uses.
 * A new kind is a naming decision, so it is added here on purpose, not accepted silently.
 */
/** The component kinds of the AGENTS.md naming table; keep the two lists equal. */
export const KINDS = [
  "channel", "router", "sessions", "storage", "workspace", "execution", "scheduler", "deployment",
  "tool", "policy", "admin", "inbound", "outbound", "log",
  "conversations", "credentials", "provider", "runtime", "secrets", "server",
];

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST = /\.test\.[cm]?[jt]sx?$/;
/** Test support (fakes, fixtures, doubles): held like tests, and never imported by a shipped file. */
const TEST_SUPPORT = /\.test-support\.[cm]?[jt]sx?$/;
const forTests = (file: string): boolean => TEST.test(file) || TEST_SUPPORT.test(file);

/** Packages that are the kit itself: `requires.pikit` covers them, so `dependencies` does not. */
const KIT_PACKAGES = new Set(["@pikit/core"]);

export function checkNaming(name: string): string[] {
  if (!KEBAB.test(name)) return [`name "${name}" is not kebab-case`];
  const kind = name.split("-")[0] ?? "";
  if (!name.includes("-") || !KINDS.includes(kind)) {
    return [`name "${name}" has no known kind prefix (${KINDS.map((k) => `${k}-`).join(", ")}); a new kind goes in KINDS in packages/cli/src/registry/checks.ts and the AGENTS.md naming table`];
  }
  return [];
}

/**
 * The manifest's shape (`ManifestSchema`), then what a schema cannot say: that it matches its
 * directory, accepts this repository's core, and names files that exist.
 */
export function checkManifest(manifest: unknown, componentDir: string, dirName: string, coreVersion: string): string[] {
  const shape = schemaProblems(ManifestSchema, manifest).map((problem) =>
    // The one extra field worth explaining: a dependency on another component (SPEC §10.2).
    problem.startsWith("/requires/") && problem.endsWith("is not a known field")
      ? `component.json ${problem}: components depend on capabilities only, never on components`
      : `component.json ${problem}`,
  );
  // The rules below read the fields; on a malformed manifest they would only add noise.
  if (shape.length > 0) return shape;
  const m = manifest as Manifest;
  const problems: string[] = [];
  if (m.name !== dirName) problems.push(`component.json name "${m.name}" does not match its directory "${dirName}"`);
  if (!Bun.semver.satisfies(coreVersion, m.requires.pikit)) {
    problems.push(`requires.pikit "${m.requires.pikit}" does not accept this repository's @pikit/core ${coreVersion}`);
  }
  for (const f of m.files) {
    if (!existsSync(join(componentDir, f.source))) problems.push(`files source "${f.source}" does not exist`);
    // SPEC §10.2: only `src` is mapped as a directory; every file outside it is listed on its own,
    // so a component owns exactly the files it lists and removing it cannot touch another one.
    else if (isDirectory(join(componentDir, f.source)) && !(f.source === "files/src" && f.target === "src")) {
      problems.push(`files maps the directory "${f.source}" onto "${f.target}"; only files/src → src is a directory, list other files one by one`);
    }
  }
  for (const key of ["config", "migrations"] as const) {
    const path = m[key];
    if (path !== undefined && !existsSync(join(componentDir, path))) problems.push(`${key} "${path}" does not exist`);
  }
  return problems;
}

/** SPEC §10.1 and S13: README, the installed directory, an entry point, tests, no install scripts. */
export function checkLayout(componentDir: string, name: string): string[] {
  const problems: string[] = [];
  if (!existsSync(join(componentDir, "README.md"))) problems.push("README.md is missing");
  const own = join(componentDir, "files", "src", "pikit", name);
  if (!isDirectory(own)) return [...problems, `files/src/pikit/${name}/ is missing (a component installs to src/pikit/<name>/)`];
  if (!existsSync(join(own, "index.ts"))) problems.push(`files/src/pikit/${name}/index.ts is missing`);
  if (!listFiles(own).some((f) => TEST.test(f))) problems.push(`files/src/pikit/${name}/ has no *.test.ts (tests ship with the component, S13)`);
  for (const file of listFiles(componentDir).filter((f) => f.endsWith("package.json"))) {
    const scripts = (JSON.parse(readFileSync(join(componentDir, file), "utf8")) as { scripts?: unknown }).scripts;
    if (scripts !== undefined) problems.push(`${file} has scripts: components have no install scripts, ever (S13)`);
  }
  return problems;
}

export interface ImportScan {
  problems: string[];
  /** npm packages the files import, excluding the kit itself. */
  packages: Set<string>;
}

/** S1, S4, S5 over every source file under `files/`, and the packages they need. */
export function checkImports(componentDir: string, name: string, targets: readonly string[]): ImportScan {
  const problems: string[] = [];
  const packages = new Set<string>();
  const filesDir = join(componentDir, "files");
  const serverOnly = targets.length === 1 && targets[0] === "server";
  const cloudflareOnly = targets.length === 1 && targets[0] === "cloudflare";

  for (const file of listFiles(filesDir).filter((f) => SOURCE.test(f))) {
    const at = `files/${file}`;
    for (const specifier of scanImports(readFileSync(join(filesDir, file), "utf8"))) {
      if (isRelative(specifier)) {
        const target = relative(filesDir, resolve(dirname(join(filesDir, file)), specifier)).split(sep).join("/");
        const sibling = /^src\/pikit\/([^/]+)/.exec(target)?.[1];
        if (target.startsWith("..")) {
          problems.push(`${at} imports "${specifier}", outside the component's files`);
        } else if (sibling !== undefined && sibling !== name) {
          problems.push(`${at} imports "${specifier}", a file of the component "${sibling}": depend on its capability instead (S4)`);
        } else if (TEST_SUPPORT.test(target) && !forTests(file)) {
          problems.push(`${at} imports "${specifier}", which is test support: only tests may import it`);
        }
        continue;
      }
      const scheme = specifier === "bun" ? "bun" : runtimeScheme(specifier);
      if (scheme !== undefined) {
        // Tests run under Bun's test runner in the project (they import bun:test), never in a
        // deployed bundle, so only shipped files are held to the targets (S5).
        if (forTests(file)) continue;
        if ((scheme === "node" || scheme === "bun") && !serverOnly) {
          problems.push(`${at} imports "${specifier}", but targets are ${JSON.stringify(targets)}: node:* and bun:* need targets ["server"] (S5)`);
        }
        if (scheme === "cloudflare" && !cloudflareOnly) {
          problems.push(`${at} imports "${specifier}", but targets are ${JSON.stringify(targets)}: cloudflare:* needs targets ["cloudflare"] (S5)`);
        }
        continue;
      }
      if (isBuiltin(specifier)) {
        problems.push(`${at} imports the Node builtin "${specifier}" without its scheme: write "node:${specifier}"`);
        continue;
      }
      if (specifier.startsWith("@earendil-works/")) {
        problems.push(`${at} imports "${specifier}": only @pikit/pi-adapter imports Pi (S1)`);
      }
      const pkg = packageName(specifier);
      if (!KIT_PACKAGES.has(pkg)) packages.add(pkg);
    }
  }
  return { problems, packages };
}

/** Every capability the component provides or uses has an entry in the catalogue (`capabilities.ts`). */
export function checkCapabilities(manifest: Manifest): string[] {
  const named = [...(manifest.provides ?? []), ...(manifest.requires?.capabilities ?? []), ...(manifest.optional?.capabilities ?? [])];
  return [...new Set(named)]
    .filter((name) => capabilityEntry(name) === undefined)
    .map((name) => `capability "${name}" is not in the catalogue: describe it in packages/cli/src/registry/capabilities.ts`);
}

/** `dependencies` lists exactly the npm packages the files import. */
export function checkDependencies(declared: Record<string, string>, imported: Set<string>): string[] {
  const problems: string[] = [];
  for (const pkg of [...imported].sort()) {
    if (!(pkg in declared)) problems.push(`files import "${pkg}", which dependencies does not list`);
  }
  for (const pkg of Object.keys(declared).sort()) {
    if (!imported.has(pkg)) problems.push(`dependencies lists "${pkg}", which no file imports`);
  }
  return problems;
}

/** Relative paths of every file below `dir` (forward slashes), `node_modules` excluded. */
export function listFiles(dir: string): string[] {
  if (!isDirectory(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => f.split(sep).join("/"))
    .filter((f) => !f.split("/").includes("node_modules") && statSync(join(dir, f)).isFile())
    .sort();
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}
