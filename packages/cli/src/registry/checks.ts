/**
 * The static checks of `registry validate`: one function per rule, each returning plain messages.
 * The drift check needs `setup` and lives in `commands.ts`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { capabilityEntry, KIT_CATALOGUE, type RegistryCatalogue } from "./capabilities.ts";
import { isRelative, packageName, runtimeScheme, SERVER_ONLY_EXPORTS, scanImports, stripComments } from "./imports.ts";
import { type Manifest, ManifestSchema, schemaProblems } from "./manifest.ts";
import { isInside, isProtected } from "../project/registry-source.ts";
import { confinedPath } from "../project/paths.ts";

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST = /\.test\.[cm]?[jt]sx?$/;
/** Test support (fakes, fixtures, doubles): held like tests, and never imported by a shipped file. */
const TEST_SUPPORT = /\.test-support\.[cm]?[jt]sx?$/;
const forTests = (file: string): boolean => TEST.test(file) || TEST_SUPPORT.test(file);
/**
 * A deployment component's commands (`src/pikit/deployment-*\/commands.ts`) run on the machine that
 * deploys, loaded by the CLI under Bun, never in the app: `deployment-cloudflare`'s spawn
 * `wrangler` with `node:child_process` while its entrypoint runs in workerd. Like tests, that one file
 * is not held to the component's targets (SPEC §4).
 */
const forMachine = (file: string, name: string): boolean => name.startsWith("deployment-") && file === `src/pikit/${name}/commands.ts`;

/** Packages that are the kit itself: `requires.pikit` covers them, so `dependencies` does not. */
const KIT_PACKAGES = new Set(["@pikit/core"]);

/** The name is kebab-case and starts with a kind of `catalogue`: the kit's, or one a component of the registry declares. */
export function checkNaming(name: string, catalogue: RegistryCatalogue = KIT_CATALOGUE): string[] {
  if (!KEBAB.test(name)) return [`name "${name}" is not kebab-case`];
  const kind = name.split("-")[0] ?? "";
  if (!name.includes("-") || !catalogue.kinds.includes(kind)) {
    return [
      `name "${name}" has no known kind prefix (${catalogue.kinds.map((k) => `${k}-`).join(", ")}); ` +
        `a new kind is declared by a component of the registry: "declares": { "kinds": ["${kind}"] } in its component.json`,
    ];
  }
  return [];
}

/** The kit packages a component states a range for, by their `requires` field: the core, and those that version apart from it (SPEC K8). */
export const KIT_RANGES = [
  ["pikit", "@pikit/core"],
  ["contracts", "@pikit/contracts"],
  ["adapter", "@pikit/pi-adapter"],
] as const;
export type KitPackage = (typeof KIT_RANGES)[number][1];

/** A range that says something: not blank, not a wildcard that accepts any version. */
function meaningful(range: string | undefined): range is string {
  return range !== undefined && !/^\s*[*xX]?\s*$/.test(range);
}

/**
 * The kit ranges of `manifest` against `versions`, the same for `registry validate` and `pikit add`:
 * `missing`, a range it must state and does not (its `dependencies` list @pikit/contracts or
 * @pikit/pi-adapter without a meaningful `requires.contracts` or `requires.adapter`), which nothing
 * may skip; `refused`, a stated range the version is outside of. A kit package only its tests import
 * (`devDependencies`) needs no range: the component runs without it, and its tests run on the
 * project's kit.
 */
export function kitRangeProblems(
  manifest: Manifest,
  versions: Record<KitPackage, string>,
): { missing: string[]; refused: { field: string; pkg: KitPackage; range: string; version: string }[] } {
  const missing: string[] = [];
  const refused: { field: string; pkg: KitPackage; range: string; version: string }[] = [];
  const requires = manifest.requires as Record<string, unknown>;
  for (const [field, pkg] of KIT_RANGES) {
    const range = typeof requires[field] === "string" ? (requires[field] as string) : undefined;
    if (field !== "pikit" && pkg in manifest.dependencies && !meaningful(range)) {
      const what = range === undefined ? "does not say" : `("${range}") does not say`;
      missing.push(`dependencies lists ${pkg}, but requires.${field} ${what} which versions it works with (a semver range, as requires.pikit)`);
    } else if (range !== undefined && !Bun.semver.satisfies(versions[pkg], range)) {
      refused.push({ field, pkg, range, version: versions[pkg] });
    }
  }
  return { missing, refused };
}

/**
 * The manifest's shape (`ManifestSchema`), then what a schema cannot say: that it matches its
 * directory, accepts this repository's core, contracts and adapter (a component that depends on the
 * contracts or the adapter says which versions it accepts: they version apart from the core, SPEC K8,
 * `kitRangeProblems`), and names files that exist.
 */
export function checkManifest(
  manifest: unknown,
  componentDir: string,
  dirName: string,
  coreVersion: string,
  contractsVersion: string,
  adapterVersion: string,
): string[] {
  const shape = schemaProblems(ManifestSchema, manifest).map((problem) =>
    // The one extra field worth explaining: a dependency on another component.
    problem.startsWith("/requires/") && problem.endsWith("is not a known field")
      ? `component.json ${problem}: components depend on capabilities only, never on components`
      : `component.json ${problem}`,
  );
  // The rules below read the fields; on a malformed manifest they would only add noise.
  if (shape.length > 0) return shape;
  const m = manifest as Manifest;
  const problems: string[] = [];
  if (m.name !== dirName) problems.push(`component.json name "${m.name}" does not match its directory "${dirName}"`);
  const kit = kitRangeProblems(m, { "@pikit/core": coreVersion, "@pikit/contracts": contractsVersion, "@pikit/pi-adapter": adapterVersion });
  problems.push(...kit.missing);
  for (const { field, pkg, range, version } of kit.refused) problems.push(`requires.${field} "${range}" does not accept this repository's ${pkg} ${version}`);
  for (const f of m.files) {
    // What `pikit add` refuses to install (registry-source.ts), refused here first.
    if (!isInside(f.target)) problems.push(`files target "${f.target}" leaves the project`);
    else if (isProtected(f.target)) problems.push(`files target "${f.target}" is one of the project's own files; no component writes it`);
    try {
      const source = confinedPath(componentDir, f.source);
      if (!existsSync(source)) problems.push(`files source "${f.source}" does not exist`);
      // Only src may map a directory; other files must be explicitly owned.
      else if (isDirectory(source) && !(f.source === "files/src" && f.target === "src")) {
        problems.push(`files maps the directory "${f.source}" onto "${f.target}"; only files/src → src is a directory, list other files one by one`);
      }
    } catch (error) {
      problems.push(`files source "${f.source}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const key of ["config", "migrations"] as const) {
    const path = m[key];
    if (path === undefined) continue;
    try {
      if (!existsSync(confinedPath(componentDir, path))) problems.push(`${key} "${path}" does not exist`);
    } catch (error) {
      problems.push(`${key} "${path}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}

/** The layout: README, the installed directory, an entry point, tests, no install scripts. */
export function checkLayout(componentDir: string, name: string): string[] {
  const problems: string[] = [];
  if (!existsSync(join(componentDir, "README.md"))) problems.push("README.md is missing");
  const own = join(componentDir, "files", "src", "pikit", name);
  if (!isDirectory(own)) return [...problems, `files/src/pikit/${name}/ is missing (a component installs to src/pikit/<name>/)`];
  if (!existsSync(join(own, "index.ts"))) problems.push(`files/src/pikit/${name}/index.ts is missing`);
  if (!listFiles(own).some((f) => TEST.test(f))) problems.push(`files/src/pikit/${name}/ has no *.test.ts (tests ship with the component)`);
  for (const file of listFiles(componentDir).filter((f) => f.endsWith("package.json"))) {
    const scripts = (JSON.parse(readFileSync(join(componentDir, file), "utf8")) as { scripts?: unknown }).scripts;
    if (scripts !== undefined) problems.push(`${file} has scripts: components have no install scripts, ever`);
  }
  return problems;
}

export interface ImportScan {
  problems: string[];
  /** npm packages the shipped files import (tests aside), excluding the kit itself: its `dependencies`. */
  packages: Set<string>;
  /** npm packages only its tests and test support import: its `dependencies` or `devDependencies`. */
  testPackages: Set<string>;
}

/**
 * The imports of every source file under `files/` (only the adapter imports Pi; no sibling
 * component's files, P4; the targets' runtimes, SPEC §4), and the packages they need.
 */
export function checkImports(componentDir: string, name: string, targets: readonly string[]): ImportScan {
  const problems: string[] = [];
  const packages = new Set<string>();
  const testPackages = new Set<string>();
  const filesDir = join(componentDir, "files");
  const serverOnly = targets.length === 1 && targets[0] === "server";
  const durableOnly = targets.length === 1 && targets[0] === "durable";

  for (const file of listFiles(filesDir).filter((f) => SOURCE.test(f))) {
    const at = `files/${file}`;
    for (const specifier of scanImports(readFileSync(join(filesDir, file), "utf8"))) {
      if (isRelative(specifier)) {
        const target = relative(filesDir, resolve(dirname(join(filesDir, file)), specifier)).split(sep).join("/");
        const sibling = /^src\/pikit\/([^/]+)/.exec(target)?.[1];
        if (target.startsWith("..")) {
          problems.push(`${at} imports "${specifier}", outside the component's files`);
        } else if (sibling !== undefined && sibling !== name) {
          problems.push(`${at} imports "${specifier}", a file of the component "${sibling}": depend on its capability instead (SPEC P4)`);
        } else if (TEST_SUPPORT.test(target) && !forTests(file)) {
          problems.push(`${at} imports "${specifier}", which is test support: only tests may import it`);
        }
        continue;
      }
      const scheme = specifier === "bun" ? "bun" : runtimeScheme(specifier);
      if (scheme !== undefined) {
        // Tests run under Bun's test runner in the project (they import bun:test), never in a
        // deployed bundle, so only shipped files are held to the targets (SPEC §4).
        if (forTests(file) || forMachine(file, name)) continue;
        if ((scheme === "node" || scheme === "bun") && !serverOnly) {
          problems.push(`${at} imports "${specifier}", but targets are ${JSON.stringify(targets)}: node:* and bun:* need targets ["server"] (SPEC §4)`);
        }
        // Only Cloudflare provides the durable target today, so its runtime modules are durable's.
        if (scheme === "cloudflare" && !durableOnly) {
          problems.push(`${at} imports "${specifier}", but targets are ${JSON.stringify(targets)}: cloudflare:* needs targets ["durable"] (SPEC §4)`);
        }
        continue;
      }
      if (isBuiltin(specifier)) {
        problems.push(`${at} imports the Node builtin "${specifier}" without its scheme: write "node:${specifier}"`);
        continue;
      }
      if (specifier.startsWith("@earendil-works/")) {
        problems.push(`${at} imports "${specifier}": only @pikit/pi-adapter imports Pi`);
      }
      // A kit export that reaches Node (`@pikit/pi-adapter/node`) is Node by another name.
      if (SERVER_ONLY_EXPORTS.includes(specifier) && !serverOnly && !forTests(file) && !forMachine(file, name)) {
        problems.push(`${at} imports "${specifier}", but targets are ${JSON.stringify(targets)}: a server-only kit export needs targets ["server"] (SPEC §4)`);
      }
      const pkg = packageName(specifier);
      if (!KIT_PACKAGES.has(pkg)) (forTests(file) ? testPackages : packages).add(pkg);
    }
  }
  for (const pkg of packages) testPackages.delete(pkg);
  return { problems, packages, testPackages };
}

/**
 * Only a component named `admin-*` reads `APP_DESCRIPTION` (SPEC K13): no other one's shipped files
 * name it, outside comments. Its tests may, as they may import anything.
 */
export function checkDescriptionReaders(componentDir: string, name: string): string[] {
  if (name.startsWith("admin-")) return [];
  const filesDir = join(componentDir, "files");
  return listFiles(filesDir)
    .filter((file) => SOURCE.test(file) && !forTests(file))
    .filter((file) => /\bAPP_DESCRIPTION\b/.test(stripComments(readFileSync(join(filesDir, file), "utf8"))))
    .map(
      (file) =>
        `files/${file} reads APP_DESCRIPTION, which only admin-* components may (SPEC K13): ` +
        "a component never changes what it does by what else is installed; use useOptional for that",
    );
}

/** What works on the environment the runtime builds for each tool call: `api.env`, or Pi's coding tools. */
const WORKS_ON_ENV = /\bapi\.env\b|\bcreate(?:Read|Write|Edit|Bash)Tool\b/;

/**
 * A component whose shipped files work on a tool call's environment (`api.env`, or Pi's coding tools
 * from `@pikit/pi-adapter/tools`) declares `execution` or `execution.shell` (`use`, or `useOptional`):
 * its requirement is then in its manifest, where `pikit add` and `doctor` see it. Read from the source,
 * outside comments: a tool that names its argument otherwise is not seen.
 */
export function checkEnvironmentUsers(componentDir: string, manifest: Manifest): string[] {
  const declared = [...(manifest.requires?.capabilities ?? []), ...(manifest.optional?.capabilities ?? [])];
  if (declared.includes("execution") || declared.includes("execution.shell")) return [];
  const filesDir = join(componentDir, "files");
  return listFiles(filesDir)
    .filter((file) => SOURCE.test(file) && !forTests(file))
    .filter((file) => WORKS_ON_ENV.test(stripComments(readFileSync(join(filesDir, file), "utf8"))))
    .map(
      (file) =>
        `files/${file} works on a tool call's environment (api.env, or Pi's coding tools), but setup uses neither execution nor execution.shell: ` +
        'add pikit.use("execution") (pikit.use("execution.shell") for a shell) to setup',
    );
}

/**
 * Every capability the component provides or uses is in `catalogue`: the kit's (`capabilities.ts`), or
 * one a component of the registry declares.
 */
export function checkCapabilities(manifest: Manifest, catalogue: RegistryCatalogue = KIT_CATALOGUE): string[] {
  const named = [...(manifest.provides ?? []), ...(manifest.requires?.capabilities ?? []), ...(manifest.optional?.capabilities ?? [])];
  return [...new Set(named)]
    .filter((name) => capabilityEntry(name, catalogue) === undefined)
    .map(
      (name) =>
        `capability "${name}" is not in the catalogue: the component that defines its contract declares it in its component.json ` +
        `("declares": { "capabilities": { "${name}": { "mode", "stability", "summary" } } }); \`pikit registry capabilities\` lists the known ones`,
    );
}

/**
 * `dependencies` lists exactly the npm packages its shipped files import, and `devDependencies` every
 * package only its tests import (`scan.testPackages`): a test's import never makes a runtime
 * dependency, nor a range in `requires`.
 */
export function checkDependencies(manifest: Manifest, scan: Pick<ImportScan, "packages" | "testPackages">): string[] {
  const problems: string[] = [];
  const declared = manifest.dependencies;
  const dev = manifest.devDependencies ?? {};
  for (const pkg of [...scan.packages].sort()) {
    if (!(pkg in declared)) problems.push(`files import "${pkg}", which dependencies does not list`);
  }
  for (const pkg of [...scan.testPackages].sort()) {
    if (!(pkg in dev)) problems.push(`only its tests import "${pkg}": list it in devDependencies${pkg in declared ? ", not dependencies" : ""}`);
  }
  for (const pkg of Object.keys(declared).sort()) {
    if (!scan.packages.has(pkg) && !scan.testPackages.has(pkg)) problems.push(`dependencies lists "${pkg}", which no file imports`);
  }
  return problems;
}

/**
 * `devDependencies` are what only its tests import, and the tools it runs (deployment-cloudflare's
 * `wrangler`): never a package its shipped files import (a dependency, `checkDependencies`), so none is
 * in both; and never `@pikit/core`, which comes with `requires.pikit`.
 */
export function checkDevDependencies(manifest: Manifest): string[] {
  const problems: string[] = [];
  for (const pkg of Object.keys(manifest.devDependencies ?? {}).sort()) {
    if (pkg in manifest.dependencies) problems.push(`"${pkg}" is in both dependencies and devDependencies: a package its shipped files import is a dependency`);
    if (pkg.startsWith("@pikit/") && !KIT_RANGES.some(([field, kit]) => field !== "pikit" && kit === pkg)) {
      problems.push(`devDependencies lists the kit package "${pkg}": the core comes with requires.pikit`);
    }
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
