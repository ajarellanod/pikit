/**
 * The static checks of `registry validate`: one function per rule, each returning plain messages.
 * The drift check needs `setup` and lives in `commands.ts`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { capabilityEntry, KIT_CATALOGUE, type RegistryCatalogue } from "./capabilities.ts";
import { isPiImport, isRelative, packageName, runtimeScheme, SERVER_ONLY_EXPORTS, scanImports, stripComments } from "./imports.ts";
import { commandProblems, kindOf, type Manifest, ManifestSchema, schemaProblems, uiModule, uiProblems } from "./manifest.ts";
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
 * `wrangler` with `node:child_process` while its entrypoint runs in workerd. So do its plain Node
 * scripts (`*.mjs`: `deployment-cloudflare`'s `deploy.mjs`, a build's deploy command, and the
 * `rollout.mjs` both share), and a component's step of `pikit configure`
 * (`src/pikit/<name>/configure.ts`, which admin-proposals' reads the git remote with), and the files
 * its `commands` name (`commands`, the set of their `src/pikit/<name>/<file>` paths: `pikit <command>`
 * runs them in a child of the CLI, `component-command.ts`). Like tests,
 * those files are not held to the component's targets (SPEC §4).
 */
const forMachine = (file: string, name: string, commands: ReadonlySet<string>): boolean =>
  commands.has(file) ||
  (kindOf(name) === "deployment" && (file === `src/pikit/${name}/commands.ts` || (file.startsWith(`src/pikit/${name}/`) && file.endsWith(".mjs")))) ||
  file === `src/pikit/${name}/configure.ts`;

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
      : problem.startsWith("/commands/") && problem.endsWith("is not a known field")
        ? `component.json ${problem.replace(/: is not a known field$/, "")}: a command's name is kebab-case`
        : `component.json ${problem}`,
  );
  // The rules below read the fields; on a malformed manifest they would only add noise.
  if (shape.length > 0) return shape;
  const m = manifest as Manifest;
  const problems: string[] = [];
  if (m.name !== dirName) problems.push(`component.json name "${m.name}" does not match its directory "${dirName}"`);
  problems.push(...commandProblems(m));
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
  return problems;
}

/**
 * The layout: README, the installed directory, an entry point, tests, no install scripts. `ui`: the
 * folder of its UI project (its manifest's `ui.source`), whose package.json is a Vite app's, with its
 * `build` (`checkUiProject`), never installed in the project's own packages.
 */
export function checkLayout(componentDir: string, name: string, ui?: string): string[] {
  const problems: string[] = [];
  if (!existsSync(join(componentDir, "README.md"))) problems.push("README.md is missing");
  const own = join(componentDir, "files", "src", "pikit", name);
  if (!isDirectory(own)) return [...problems, `files/src/pikit/${name}/ is missing (a component installs to src/pikit/<name>/)`];
  if (!existsSync(join(own, "index.ts"))) problems.push(`files/src/pikit/${name}/index.ts is missing`);
  if (!listFiles(own).some((f) => TEST.test(f))) problems.push(`files/src/pikit/${name}/ has no *.test.ts (tests ship with the component)`);
  for (const file of listFiles(componentDir).filter((f) => f.endsWith("package.json") && (ui === undefined || !f.startsWith(`${ui}/`)))) {
    const scripts = (JSON.parse(readFileSync(join(componentDir, file), "utf8")) as { scripts?: unknown }).scripts;
    if (scripts !== undefined) problems.push(`${file} has scripts: components have no install scripts, ever`);
  }
  return problems;
}

/**
 * A component's view (its manifest's `view`, SPEC §5): a folder of the component whose `index.tsx`
 * default-exports `defineView({ id: "<name>", … })`, the dashboard's way to find it under its name.
 * Its files are the dashboard's (React, its `@/` imports), checked by the dashboard's own build, not here.
 */
export function checkView(componentDir: string, name: string, manifest: Manifest): string[] {
  if (manifest.view === undefined) return [];
  const dir = join(componentDir, manifest.view);
  if (!isDirectory(dir)) return [`its view folder "${manifest.view}/" is missing`];
  const index = join(dir, "index.tsx");
  if (!existsSync(index)) return [`${manifest.view}/index.tsx is missing: a view default-exports defineView({ id: "${name}", … })`];
  if (!readFileSync(index, "utf8").includes(`id: "${name}"`)) return [`${manifest.view}/index.tsx must define its view under the component's name: defineView({ id: "${name}", … })`];
  return [];
}

/**
 * A component's section of the Settings dialog (its manifest's `settings`, features/settings.md): a
 * folder whose `index.tsx` default-exports `defineSettings({ id: "<name>", … })`, as a view does.
 */
export function checkSettingsSection(componentDir: string, name: string, manifest: Manifest): string[] {
  if (manifest.settings === undefined) return [];
  const dir = join(componentDir, manifest.settings);
  if (!isDirectory(dir)) return [`its settings folder "${manifest.settings}/" is missing`];
  const index = join(dir, "index.tsx");
  if (!existsSync(index)) return [`${manifest.settings}/index.tsx is missing: a section default-exports defineSettings({ id: "${name}", … })`];
  if (!readFileSync(index, "utf8").includes(`id: "${name}"`)) return [`${manifest.settings}/index.tsx must define its section under the component's name: defineSettings({ id: "${name}", … })`];
  return [];
}

/**
 * A component's UI project (its manifest's `ui`, features/completed/channel-web.md "UI projects of a component"):
 * a folder of the component, outside `files/`, with its `package.json` (a `build` script, which the
 * deployments run) and its `bun.lock` (they install from it, frozen); its target one of `src/` no other
 * UI project takes (`uiProblems`); and the module its build writes (`uiModule`: `chat-files.ts` for
 * `src/chat`) a file of the component's own directory, listed in `generated`. Its files are browser
 * code, held to its own toolchain: no check of App imports, targets or dependencies reads them.
 */
export function checkUiProject(componentDir: string, name: string, manifest: Manifest): string[] {
  const ui = manifest.ui;
  if (ui === undefined) return [];
  const problems = uiProblems(manifest);
  const dir = join(componentDir, ui.source);
  if (!isDirectory(dir)) return [...problems, `its UI project's folder "${ui.source}/" is missing`];
  const pkg = join(dir, "package.json");
  if (!existsSync(pkg)) problems.push(`${ui.source}/package.json is missing: a UI project has its own, with a "build" script`);
  else {
    let build: unknown;
    try {
      build = (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, unknown> | null }).scripts?.build;
    } catch (error) {
      return [...problems, `${ui.source}/package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`];
    }
    if (typeof build !== "string" || build.trim() === "") problems.push(`${ui.source}/package.json has no "build" script: every deploy runs it, and it writes ${uiModule(ui)}`);
  }
  if (!existsSync(join(dir, "bun.lock"))) problems.push(`${ui.source}/bun.lock is missing: the deployments install its packages from it (bun install --frozen-lockfile)`);
  const module = uiModule(ui);
  if (!existsSync(join(componentDir, "files", "src", "pikit", name, module))) {
    problems.push(`files/src/pikit/${name}/${module} is missing: the module its UI project's build writes, shipped empty`);
  } else if (!(manifest.generated ?? []).includes(module)) {
    problems.push(`generated does not list "${module}", which its UI project's build rewrites`);
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
export function checkImports(componentDir: string, name: string, targets: readonly string[], commandFiles: readonly string[] = []): ImportScan {
  const commands = new Set(commandFiles.map((file) => `src/pikit/${name}/${file}`));
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
        if (forTests(file) || forMachine(file, name, commands)) continue;
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
      if (isPiImport(specifier)) {
        problems.push(`${at} imports "${specifier}": only @pikit/pi-adapter imports Pi`);
      }
      // A kit export that reaches Node (`@pikit/pi-adapter/node`) is Node by another name.
      if (SERVER_ONLY_EXPORTS.includes(specifier) && !serverOnly && !forTests(file) && !forMachine(file, name, commands)) {
        problems.push(`${at} imports "${specifier}", but targets are ${JSON.stringify(targets)}: a server-only kit export needs targets ["server"] (SPEC §4)`);
      }
      const pkg = packageName(specifier);
      if (!KIT_PACKAGES.has(pkg)) (forTests(file) ? testPackages : packages).add(pkg);
    }
  }
  for (const pkg of packages) testPackages.delete(pkg);
  return { problems, packages, testPackages };
}

/** The self-knowledge component (SPEC §6), which describes the App to its agents. */
export const SELF_KNOWLEDGE = "extension-pikit-self";

/**
 * Only a component named `admin-*`, and the self-knowledge one, read `APP_DESCRIPTION` (SPEC K13): no
 * other one's shipped files name it, outside comments. Its tests may, as they may import anything.
 */
export function checkDescriptionReaders(componentDir: string, name: string): string[] {
  if (name.startsWith("admin-") || name === SELF_KNOWLEDGE) return [];
  const filesDir = join(componentDir, "files");
  return listFiles(filesDir)
    .filter((file) => SOURCE.test(file) && !forTests(file))
    .filter((file) => /\bAPP_DESCRIPTION\b/.test(stripComments(readFileSync(join(filesDir, file), "utf8"))))
    .map(
      (file) =>
        `files/${file} reads APP_DESCRIPTION, which only admin-* components and ${SELF_KNOWLEDGE} may (SPEC K13): ` +
        "a component never changes what it does by what else is installed; use useOptional for that",
    );
}

/** Reading the target: `pikit.target` in `setup`, `ctx.target` in a handler. */
const READS_TARGET = /\b(?:pikit|ctx)\.target\b/;

/**
 * No component's shipped files read the target (SPEC K1), outside comments: what a component needs
 * differently per target comes through a capability (`actor.inbox`'s `scope` says whose actor the App
 * is), or is a component per target. Read from the source, by the names `pikit` and `ctx`; the drift
 * check (`checkTargets`) still refuses a `setup` that declares differently, however it reads it.
 */
export function checkTargetReaders(componentDir: string): string[] {
  const filesDir = join(componentDir, "files");
  return listFiles(filesDir)
    .filter((file) => SOURCE.test(file) && !forTests(file))
    .filter((file) => READS_TARGET.test(stripComments(readFileSync(join(filesDir, file), "utf8"))))
    .map(
      (file) =>
        `files/${file} reads the target (pikit.target or ctx.target), which no component branches on (SPEC K1): ` +
        "what differs per target comes through a capability (actor.inbox's scope says whose actor the App is), or is a component per target",
    );
}

/** A table or an index a statement creates, and the name it gives (quotes aside), in SQL of any case. */
const CREATES = /\bCREATE\s+(?:UNIQUE\s+|TEMP(?:ORARY)?\s+|VIRTUAL\s+)?(TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?["[]?((?:\$\{[^}]*\}|[^\s()"'`[\];,])*)/gi;
/** A call of a method `namespace`: `storage.get().namespace(…)`, `kv.get()?.namespace(…)`. */
const NAMESPACE_CALL = /\.\s*namespace\s*\(/g;
/** A file's top-level `const NAME = "literal"` (exported or not): the names a table or namespace may be given by. */
const LITERAL_CONST = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`\\$]*)`)/gm;

/**
 * A component's own storage names (`@pikit/contracts`' storage.ts): every table and index it creates
 * is named after it, `-` as `_` (`outbound_durable_pieces`), and the `storage.kv` namespace it opens
 * is its name. Read from its shipped files, outside comments: a name in a string or template literal,
 * whose `${NAME}` parts are top-level string consts of the same file; any other name is refused, as
 * validate cannot read it.
 */
export function checkStorageNames(componentDir: string, name: string): string[] {
  const filesDir = join(componentDir, "files");
  return listFiles(filesDir)
    .filter((file) => SOURCE.test(file) && !forTests(file))
    .flatMap((file) => storageNameProblems(name, `files/${file}`, readFileSync(join(filesDir, file), "utf8")));
}

/** `checkStorageNames` on one file's `source`, reported as `at`. */
export function storageNameProblems(name: string, at: string, source: string): string[] {
  const code = stripComments(source);
  const consts = new Map<string, string>();
  for (const m of code.matchAll(LITERAL_CONST)) consts.set(m[1] ?? "", m[2] ?? m[3] ?? m[4] ?? "");
  const prefix = name.replaceAll("-", "_");
  const problems: string[] = [];

  for (const m of code.matchAll(CREATES)) {
    const kind = (m[1] ?? "").toLowerCase();
    const written = m[2] ?? "";
    let unreadable = written === "";
    const resolved = written.replace(/\$\{([^}]*)\}/g, (_, expression: string) => {
      const value = consts.get(expression.trim());
      if (value === undefined) unreadable = true;
      return value ?? "";
    });
    if (unreadable) {
      const named = written === "" ? "" : ` named "${written}"`;
      problems.push(`${at} creates a ${kind}${named} whose name validate cannot read: name it with a string literal, or a const of the same file`);
    } else if (resolved.toLowerCase() !== prefix && !resolved.toLowerCase().startsWith(`${prefix}_`)) {
      problems.push(`${at} creates the ${kind} "${resolved}": a component's tables and indexes start with its name, ${prefix}_ (storage.sql)`);
    }
  }

  for (const m of code.matchAll(NAMESPACE_CALL)) {
    const argument = callArgument(code, m.index + m[0].length).trim();
    const literal = /^(["'`])([^"'`\\$]*)\1$/.exec(argument)?.[2];
    // `this.namespace()` (execution-do's) is another method; the KV one takes the name, alone.
    if (literal === undefined && (argument === "" || argument.includes(","))) continue;
    const opened = literal ?? (/^[A-Za-z_$][\w$]*$/.test(argument) ? consts.get(argument) : undefined);
    if (opened === undefined) {
      problems.push(`${at} opens the storage.kv namespace ${argument}, which validate cannot read: write namespace("${name}"), or a const of the same file`);
    } else if (opened !== name) {
      problems.push(`${at} opens the storage.kv namespace "${opened}": a component opens the one named after it, namespace("${name}")`);
    }
  }
  return problems;
}

/** The text between `(`, just before `from`, and its matching `)`; strings may hold parentheses. */
function callArgument(code: string, from: number): string {
  let depth = 1;
  let quote = "";
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (quote !== "") {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return code.slice(from, i);
  }
  return code.slice(from);
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
