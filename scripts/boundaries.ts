/**
 * The packages' import boundaries (AGENTS.md, "The rules" 1 and 5), checked on every source file
 * under `packages/*`, as `registry validate` checks components (S1, S5). `scripts/boundaries.test.ts`
 * runs it on the repository, so `bun test` fails the moment a package crosses one:
 *
 * - **Declared**: a package imports only itself and its `dependencies` (tests also their
 *   `devDependencies`), and runtime modules by scheme (`node:fs`, never `fs`). A type-only import
 *   counts: the package must be installed to typecheck it.
 * - **Pi only through the adapter**: no package but `@pikit/pi-adapter` imports `@earendil-works/*`.
 * - **Neutral exports**: every file an export reaches through relative imports runs on every target:
 *   no `node:*`, `bun:*` or `cloudflare:*`, and not Pi's Node subpath. Every export is neutral unless
 *   `SERVER_ONLY` names it, so a new export is held to the rule until someone decides otherwise.
 * - **Inside the package**: source files do not import relative paths outside their package; a
 *   package reaches another only through its exports. Tests may (they read registry fixtures).
 *
 * Specifiers with `${` are the CLI's templates for generated code, not imports, and are skipped.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isRelative, packageName, runtimeScheme, scanImports } from "../packages/cli/src/registry/imports.ts";

/** Exports that may use Node, by package directory. Every other export is neutral. */
export const SERVER_ONLY: Readonly<Record<string, readonly string[]>> = {
  // The JSONL store and the local execution environment; the test fixtures that spawn Pi workers.
  "pi-adapter": ["./node", "./testing"],
};

/** A specifier some files may import beyond their dependencies, and why. */
export const ALLOWED: readonly { dir: string; files: string; specifier: string; why: string }[] = [
  {
    dir: "pi-adapter",
    files: "src/extensions/pi-examples/",
    specifier: "@earendil-works/pi-coding-agent",
    why: "Pi's example extensions, unmodified: a project aliases that name to @pikit/pi-extension-shim (SPEC §6.2b)",
  },
];

/** Pi's own Node subpath: fine behind `./node`, never in a neutral export. */
const PI_NODE = "@earendil-works/pi-agent-core/node";
const SOURCE = /\.[cm]?tsx?$/;
const TEST = /\.test\.[cm]?tsx?$/;

interface PackageJson {
  name: string;
  exports?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Every boundary problem under `packagesDir`, one line each (`packages/<dir>/<file>: …`); empty when none. */
export function checkBoundaries(packagesDir: string): string[] {
  const problems: string[] = [];
  const at = (file: string) => relative(join(packagesDir, ".."), file).split(sep).join("/");
  for (const dir of readdirSync(packagesDir).sort()) {
    const root = resolve(packagesDir, dir);
    const manifestPath = join(root, "package.json");
    if (!existsSync(manifestPath)) continue;
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageJson;
    const dependencies = new Set(Object.keys(pkg.dependencies ?? {}));
    const devDependencies = new Set(Object.keys(pkg.devDependencies ?? {}));

    for (const file of sourceFiles(join(root, "src"))) {
      const test = TEST.test(file);
      const own = relative(root, file).split(sep).join("/");
      for (const specifier of imports(file)) {
        if (isRelative(specifier)) {
          if (!test && !resolve(dirname(file), specifier).startsWith(root + sep)) {
            problems.push(`${at(file)} imports "${specifier}", outside ${pkg.name}: reach another package through its exports`);
          }
          continue;
        }
        if (specifier === "bun" || runtimeScheme(specifier) !== undefined) continue; // runtime modules: see neutral exports
        if (isBuiltin(specifier)) {
          problems.push(`${at(file)} imports the Node builtin "${specifier}" without its scheme: write "node:${specifier}"`);
          continue;
        }
        const name = packageName(specifier);
        if (name.startsWith("@earendil-works/") && pkg.name !== "@pikit/pi-adapter" && !allowed(dir, own, specifier)) {
          problems.push(`${at(file)} imports "${specifier}": only @pikit/pi-adapter imports Pi (rule 1)`);
          continue;
        }
        const declared = name === pkg.name || dependencies.has(name) || (test && devDependencies.has(name));
        if (!declared && !allowed(dir, own, specifier)) {
          problems.push(`${at(file)} imports "${specifier}", which is not a dependency of ${pkg.name}`);
        }
      }
    }

    const serverOnly = SERVER_ONLY[dir] ?? [];
    for (const [exported, target] of Object.entries(pkg.exports ?? {})) {
      if (serverOnly.includes(exported)) continue;
      const entry = `${pkg.name}${exported === "." ? "" : exported.slice(1)}`;
      for (const { file, specifier } of platformImports(resolve(root, target))) {
        problems.push(`${at(file)} imports "${specifier}", but ${entry} reaches it and must run on every target (rule 5)`);
      }
    }
  }
  return problems;
}

/** The runtime-specific imports of every file reachable from `entry` through relative imports. */
function platformImports(entry: string): { file: string; specifier: string }[] {
  const found: { file: string; specifier: string }[] = [];
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    for (const specifier of imports(file)) {
      if (isRelative(specifier)) visit(resolveModule(dirname(file), specifier));
      else if (specifier === "bun" || runtimeScheme(specifier) !== undefined || isBuiltin(specifier) || specifier === PI_NODE) {
        found.push({ file, specifier });
      }
    }
  };
  visit(entry);
  return found;
}

/** `./x.ts`, `./x` or `./dir` as the file it names. */
function resolveModule(from: string, specifier: string): string {
  const path = resolve(from, specifier);
  if (existsSync(path) && statSync(path).isFile()) return path;
  for (const candidate of [`${path}.ts`, join(path, "index.ts")]) if (existsSync(candidate)) return candidate;
  return path;
}

function imports(file: string): string[] {
  return scanImports(readFileSync(file, "utf8")).filter((specifier) => !specifier.includes("${"));
}

function allowed(dir: string, file: string, specifier: string): boolean {
  return ALLOWED.some((a) => a.dir === dir && file.startsWith(a.files) && a.specifier === specifier);
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => SOURCE.test(f) && !f.split(sep).includes("node_modules"))
    .map((f) => join(dir, f))
    .sort();
}
