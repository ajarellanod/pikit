/**
 * The static checks of `registry validate`: one function per rule, each returning plain messages.
 * The drift check needs `setup` and lives in `commands.ts`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { capabilityEntry } from "./capabilities.ts";
import { isRelative, packageName, runtimeScheme, SERVER_ONLY_EXPORTS, scanImports } from "./imports.ts";
import { type Manifest, ManifestSchema, schemaProblems } from "./manifest.ts";
import { isInside, isProtected } from "../project/registry-source.ts";
import { confinedPath } from "../project/paths.ts";

/**
 * Component kinds: the prefix of every component's name. A new kind is a naming decision, so it is
 * added here on purpose, not accepted silently.
 */
export const KINDS = [
  "channel", "router", "sessions", "storage", "workspace", "execution", "scheduler", "deployment",
  "tool", "policy", "admin", "inbound", "outbound", "log",
  "conversations", "credentials", "provider", "runtime", "secrets", "server", "submissions",
  // SPEC C2 and C3: `mailbox-local`, `wakeups-timers`.
  "mailbox", "wakeups",
  // SPEC C2 to C5: a target's platform providers (`platform-cloudflare`).
  "platform",
];

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

export function checkNaming(name: string): string[] {
  if (!KEBAB.test(name)) return [`name "${name}" is not kebab-case`];
  const kind = name.split("-")[0] ?? "";
  if (!name.includes("-") || !KINDS.includes(kind)) {
    return [`name "${name}" has no known kind prefix (${KINDS.map((k) => `${k}-`).join(", ")}); a new kind goes in KINDS in packages/cli/src/registry/checks.ts`];
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
 * `missing`, a range it must state and does not (it depends on @pikit/contracts or @pikit/pi-adapter,
 * in `dependencies` or `devDependencies`, without a meaningful `requires.contracts` or
 * `requires.adapter`), which nothing may skip; `refused`, a stated range the version is outside of.
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
    const listedIn = (["dependencies", "devDependencies"] as const).find((deps) => pkg in (manifest[deps] ?? {}));
    if (field !== "pikit" && listedIn !== undefined && !meaningful(range)) {
      const what = range === undefined ? "does not say" : `("${range}") does not say`;
      missing.push(`${listedIn} lists ${pkg}, but requires.${field} ${what} which versions it works with (a semver range, as requires.pikit)`);
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
  /** npm packages the files import, excluding the kit itself. */
  packages: Set<string>;
}

/**
 * The imports of every source file under `files/` (only the adapter imports Pi; no sibling
 * component's files, P4; the targets' runtimes, SPEC §4), and the packages they need.
 */
export function checkImports(componentDir: string, name: string, targets: readonly string[]): ImportScan {
  const problems: string[] = [];
  const packages = new Set<string>();
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

/**
 * `devDependencies` are the tools a component needs besides what its files import: a package its files
 * import is a dependency (`checkDependencies`), so none is in both; and the kit is never one, it comes
 * with `requires.pikit` and `dependencies`.
 */
export function checkDevDependencies(manifest: Manifest): string[] {
  const problems: string[] = [];
  for (const pkg of Object.keys(manifest.devDependencies ?? {}).sort()) {
    if (pkg in manifest.dependencies) problems.push(`"${pkg}" is in both dependencies and devDependencies: a package its files import is a dependency`);
    if (pkg.startsWith("@pikit/")) problems.push(`devDependencies lists the kit package "${pkg}": the kit comes with requires.pikit and dependencies`);
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
