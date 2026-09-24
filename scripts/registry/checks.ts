/**
 * The static checks of `registry validate`: one function per rule, each returning plain messages.
 * The drift check (S14) needs `setup` and lives in `commands.ts`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isRelative, packageName, runtimeScheme, scanImports } from "./imports.ts";
import { type Manifest, TARGETS } from "./manifest.ts";

/**
 * Component kinds (AGENTS.md, "Naming"): the table's kinds plus the ones the registry already uses.
 * A new kind is a naming decision, so it is added here on purpose, not accepted silently.
 */
/** The component kinds of the AGENTS.md naming table; keep the two lists equal. */
export const KINDS = [
  "channel", "router", "sessions", "storage", "workspace", "execution", "scheduler", "deployment",
  "tool", "policy", "admin", "inbound", "log",
  "conversations", "credentials", "provider", "runtime", "secrets", "server",
];

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST = /\.test\.[cm]?[jt]sx?$/;

/** Packages that are the kit itself: `requires.pikit` covers them, so `dependencies` does not. */
const KIT_PACKAGES = new Set(["@pikit/core"]);

export function checkNaming(name: string): string[] {
  if (!KEBAB.test(name)) return [`name "${name}" is not kebab-case`];
  const kind = name.split("-")[0] ?? "";
  if (!name.includes("-") || !KINDS.includes(kind)) {
    return [`name "${name}" has no known kind prefix (${KINDS.map((k) => `${k}-`).join(", ")}); a new kind goes in KINDS in scripts/registry/checks.ts and the AGENTS.md naming table`];
  }
  return [];
}

/** The hand-written fields: present, well-formed and consistent with the directory. */
export function checkManifest(manifest: Manifest, componentDir: string, dirName: string, coreVersion: string): string[] {
  const problems: string[] = [];
  const m = manifest as Partial<Manifest>;
  if (m.name !== dirName) problems.push(`component.json name "${String(m.name)}" does not match its directory "${dirName}"`);
  if (typeof m.version !== "string" || !SEMVER.test(m.version)) problems.push(`version "${String(m.version)}" is not a semver version`);
  if (typeof m.description !== "string" || m.description.trim() === "") problems.push("description is empty");
  if (m.license !== undefined && typeof m.license !== "string") problems.push("license must be a string");

  const targets = m.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    problems.push(`targets must list at least one of ${TARGETS.join(", ")}`);
  } else {
    for (const t of targets) if (!(TARGETS as readonly string[]).includes(t)) problems.push(`target "${t}" is not one of ${TARGETS.join(", ")}`);
    if (new Set(targets).size !== targets.length) problems.push("targets lists a target twice");
  }

  const pikit = m.requires?.pikit;
  if (typeof pikit !== "string" || pikit === "") problems.push("requires.pikit is missing");
  else if (!Bun.semver.satisfies(coreVersion, pikit)) {
    problems.push(`requires.pikit "${pikit}" does not accept this repository's @pikit/core ${coreVersion}`);
  }
  // SPEC §10.2: a component depends on capabilities, never on components.
  for (const key of Object.keys(m.requires ?? {})) {
    if (key !== "pikit" && key !== "capabilities") problems.push(`requires.${key} is not a manifest field (components depend on capabilities only)`);
  }

  if (typeof m.dependencies !== "object" || m.dependencies === null || Array.isArray(m.dependencies)) {
    problems.push("dependencies must be an object of package → version");
  } else {
    for (const [pkg, version] of Object.entries(m.dependencies)) {
      if (typeof version !== "string" || version === "") problems.push(`dependency "${pkg}" has no version`);
    }
  }

  if (!Array.isArray(m.files) || m.files.length === 0) problems.push("files must list at least one { source, target }");
  else {
    for (const f of m.files) {
      if (typeof f?.source !== "string" || typeof f.target !== "string") problems.push("each files entry is { source, target }");
      else if (!existsSync(join(componentDir, f.source))) problems.push(`files source "${f.source}" does not exist`);
      // SPEC §10.2: only `src` is mapped as a directory; every file outside it is listed on its own,
      // so a component owns exactly the files it lists and removing it cannot touch another one.
      else if (isDirectory(join(componentDir, f.source)) && !(f.source === "files/src" && f.target === "src")) {
        problems.push(`files maps the directory "${f.source}" onto "${f.target}"; only files/src → src is a directory, list other files one by one`);
      }
    }
  }

  for (const v of m.environment ?? []) {
    if (!ENV_NAME.test(String(v?.name)) || typeof v.secret !== "boolean" || typeof v.required !== "boolean") {
      problems.push(`environment entry ${JSON.stringify(v)} must be { name: UPPER_SNAKE, secret: boolean, required: boolean }`);
    }
  }
  for (const key of ["config", "migrations"] as const) {
    const path = m[key];
    if (path !== undefined && (typeof path !== "string" || !existsSync(join(componentDir, path)))) {
      problems.push(`${key} "${String(path)}" does not exist`);
    }
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
        }
        continue;
      }
      const scheme = specifier === "bun" ? "bun" : runtimeScheme(specifier);
      if (scheme !== undefined) {
        // Tests run under Bun's test runner in the project (they import bun:test), never in a
        // deployed bundle, so only shipped files are held to the targets (S5).
        if (TEST.test(file)) continue;
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
