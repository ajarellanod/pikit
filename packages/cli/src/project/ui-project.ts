/**
 * UI projects (features/completed/channel-web.md §3): a Vite app with its own `package.json`, `bun.lock` and
 * toolchain in a folder of `src/`. The dashboard is one (`src/dashboard/`, `dashboard.ts`); a component
 * may ship another, its manifest's `ui` (channel-web's `src/chat/`).
 *
 * - **What one is**: a folder of `src/` with a `package.json`, `src/pikit/` aside (`uiProjects`). The
 *   deployments find them by the same rule (deployment-docker's Dockerfile, deployment-cloudflare's
 *   wrangler `build.command`), and build each with `bun run build` before they bundle.
 * - **What its build writes**: the module its component serves, `src/pikit/<component>/<folder>-files.ts`
 *   (`uiModule`): admin-api's `dashboard-files.ts`, channel-web's `chat-files.ts`.
 * - **A component's**: `pikit add` copies it (`uiProjectFiles`) as the component's files, with hashes and
 *   bases, so `pikit upgrade` merges it (P6) and `pikit remove` deletes it; its lockfile is `generated`
 *   (its `bun install` rewrites it). The project's `tsc` and `bun test` skip it: `pikit add` lists it in
 *   `tsconfig.json`'s `exclude` and `bunfig.toml`'s `pathIgnorePatterns`, `pikit remove` takes it out
 *   (`syncUiExclusions`), as the starter lists `src/dashboard`.
 * - **`pikit dev`** builds one again when its files change (`watchUiProjects`), and each once at start on
 *   a server (wrangler's build command does it on Cloudflare), so a fresh project serves its pages.
 */

import { existsSync, type FSWatcher, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError, log } from "../ui.ts";
import { BUILT, listSource } from "./dashboard.ts";
import { confinedPath } from "./paths.ts";
import type { Registry } from "./registry-source.ts";
import type { Undo } from "./undo.ts";

/** The project's own TypeScript and test configuration, where `pikit add` lists a component's UI project. */
export const TSCONFIG = "tsconfig.json";
export const BUNFIG = "bunfig.toml";

/** What a component installs as its UI project: project-relative target → absolute source; empty without `ui`. */
export function uiProjectFiles(registry: Registry, component: string): Map<string, string> {
  const ui = registry.manifest(component).ui;
  if (ui === undefined) return new Map();
  const root = confinedPath(registry.dir(component), ui.source);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new CliError(`${component}: its UI project's folder "${ui.source}" is missing`);
  return new Map(listSource(root).map((file) => [`${ui.target}/${file}`, confinedPath(root, file)]));
}

/** What a UI project's toolchain rewrites (its `bun install`): never the user's edits. */
export function uiGenerated(target: string): string[] {
  return [`${target}/bun.lock`];
}

/** Whether `relative` (`src/chat`) is a UI project: a folder of `src/`, not `src/pikit`, with a `package.json`. */
export function isUiProject(projectDir: string, relative: string): boolean {
  if (!/^src\/[^/]+$/.test(relative) || relative === "src/pikit") return false;
  const dir = confinedPath(projectDir, relative);
  return existsSync(dir) && statSync(dir).isDirectory() && existsSync(confinedPath(projectDir, `${relative}/package.json`));
}

/** The project's UI projects (`src/dashboard`, `src/chat`), sorted. */
export function uiProjects(projectDir: string): string[] {
  const src = confinedPath(projectDir, "src");
  if (!existsSync(src)) return [];
  return readdirSync(src, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `src/${entry.name}`)
    .filter((dir) => isUiProject(projectDir, dir))
    .sort();
}

/**
 * `tsconfig.json`'s text with `add` in its `exclude` and `remove` out of it; the same text when nothing
 * changes, undefined when it is not JSON (comments) and cannot be edited.
 */
export function withTsconfigExcluded(text: string, add: readonly string[], remove: readonly string[]): string | undefined {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (config.exclude !== undefined && !(Array.isArray(config.exclude) && config.exclude.every((entry) => typeof entry === "string"))) return undefined;
  // Without `exclude`, tsc leaves out node_modules on its own; with one, only what it lists.
  const before = (config.exclude as string[] | undefined) ?? ["node_modules"];
  const after = [...before.filter((entry) => !remove.includes(entry)), ...add.filter((entry) => !before.includes(entry))];
  if (after.length === before.length && after.every((entry, i) => entry === before[i])) return text;
  return `${JSON.stringify({ ...config, exclude: after }, null, 2)}\n`;
}

const IGNORE_LINE = /^(pathIgnorePatterns\s*=\s*)(\[[^\]\n]*\])[ \t]*$/m;

/**
 * `bunfig.toml`'s text with `<dir>/**` of each of `add` in `[test]`'s `pathIgnorePatterns`, and those of
 * `remove` out of it; the same text when nothing changes, undefined when its `pathIgnorePatterns` is not
 * one line of plain strings (as the starter writes it) and cannot be edited.
 */
export function withBunfigIgnored(text: string, add: readonly string[], remove: readonly string[]): string | undefined {
  const adding = add.map((dir) => `${dir}/**`);
  const removing = remove.map((dir) => `${dir}/**`);
  const line = IGNORE_LINE.exec(text);
  if (line === null) {
    if (/^\s*pathIgnorePatterns\s*=/m.test(text)) return undefined;
    if (adding.length === 0) return text;
    const entry = `pathIgnorePatterns = ${JSON.stringify(adding).replaceAll(",", ", ")}`;
    if (/^\[test\][ \t]*$/m.test(text)) return text.replace(/^\[test\][ \t]*$/m, `[test]\n${entry}`);
    return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}\n[test]\n${entry}\n`;
  }
  let patterns: unknown;
  try {
    patterns = JSON.parse(line[2] as string);
  } catch {
    return undefined;
  }
  if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === "string")) return undefined;
  const before = patterns as string[];
  const after = [...before.filter((p) => !removing.includes(p)), ...adding.filter((p) => !before.includes(p))];
  if (after.length === before.length && after.every((p, i) => p === before[i])) return text;
  return text.replace(IGNORE_LINE, `$1${JSON.stringify(after).replaceAll('","', '", "')}`);
}

/**
 * Lists the UI projects `add` gives the project in `tsconfig.json`'s `exclude` and `bunfig.toml`'s
 * `pathIgnorePatterns`, and takes those of `remove` out, each file kept in `undo` first. A file the
 * project does not have is left so; one that cannot be edited is said, with what to add by hand.
 */
export function syncUiExclusions(projectDir: string, add: readonly string[], remove: readonly string[], undo: Undo): void {
  if (add.length + remove.length === 0) return;
  for (const [file, edit, what] of [
    [TSCONFIG, withTsconfigExcluded, (dirs: readonly string[]) => `"exclude": ${dirs.map((dir) => `"${dir}"`).join(", ")}`],
    [BUNFIG, withBunfigIgnored, (dirs: readonly string[]) => `pathIgnorePatterns: ${dirs.map((dir) => `"${dir}/**"`).join(", ")}`],
  ] as const) {
    const path = confinedPath(projectDir, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const next = edit(text, add, remove);
    if (next === undefined) {
      const change = [...(add.length > 0 ? [`add ${what(add)}`] : []), ...(remove.length > 0 ? [`take out ${what(remove)}`] : [])].join("; ");
      log.warn(`${file} could not be edited (not in the shape pikit writes): ${change}, so that tsc and bun test skip the UI project`);
      continue;
    }
    if (next === text) continue;
    undo.keep(file);
    writeFileSync(path, next);
  }
}

/**
 * After its files are deleted (`pikit remove`), what is left of a UI project at `target`: what its
 * toolchain made (`node_modules/`, `dist/`) goes, then the folder when nothing else is in it. Returns
 * the files left, the user's own.
 */
export function removeUiLeftovers(projectDir: string, target: string): string[] {
  const dir = confinedPath(projectDir, target);
  if (!existsSync(dir)) return [];
  for (const built of BUILT) rmSync(confinedPath(projectDir, `${target}/${built}`), { recursive: true, force: true });
  const left = listSource(dir, false);
  if (left.length === 0) rmSync(dir, { recursive: true, force: true });
  return left.map((file) => `${target}/${file}`);
}

/** Builds the UI project at `dir` (`bun run build` there), its output on this terminal; whether it succeeded. */
export async function buildUiProject(projectDir: string, dir: string): Promise<boolean> {
  log.step(`${dir}: bun run build`);
  const child = Bun.spawn([process.execPath, "run", "build"], { cwd: confinedPath(projectDir, dir), stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const ok = (await child.exited) === 0;
  if (!ok) log.warn(`${dir}: its build failed (were its packages installed? \`bun install\` in ${dir}/): the app serves its last build`);
  return ok;
}

/**
 * `pikit dev`: builds each UI project again when one of its files changes, never for what its build
 * makes (`node_modules/`, `dist/`), one build at a time per project. Its build writes its component's
 * module, which the running app imports, so the app reloads with it. Not the whole of `src/`: a watcher
 * there would also watch every UI project's `node_modules/`. With `atStart`, it also builds each once
 * at start: a project fresh from `pikit add` (its module empty) serves its page without an edit first.
 */
export function watchUiProjects(
  projectDir: string,
  build: (projectDir: string, dir: string) => Promise<unknown> = buildUiProject,
  options: { atStart?: boolean } = {},
): { close(): void } {
  const watchers: FSWatcher[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  for (const dir of uiProjects(projectDir)) {
    const root = confinedPath(projectDir, dir);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let again = false;
    const run = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          await build(projectDir, dir);
        } while (again);
      } finally {
        running = false;
      }
    };
    const changed = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(timer);
      }
      timer = setTimeout(() => void run(), 200);
      timers.add(timer);
    };
    // Its own files: those at its top, and every folder but what its toolchain makes, each in full.
    watchers.push(watch(root, (_event, file) => (file === null || !BUILT.has(String(file)) ? changed() : undefined)));
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !BUILT.has(entry.name)) watchers.push(watch(join(root, entry.name), { recursive: true }, changed));
    }
    if (options.atStart === true) void run();
  }
  return {
    close() {
      for (const watcher of watchers) watcher.close();
      for (const timer of timers) clearTimeout(timer);
    },
  };
}
