/**
 * A registry the CLI installs from (SPEC §10.4). M1 reads a local directory: the registry of the
 * pikit checkout by default, or `--registry <path>`. Git URLs come later; the path and the commit
 * it was at are what `pikit.json` records.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { parse } from "yaml";
import { type Manifest, readManifest, type RegistryIndex } from "../registry/manifest.ts";

export interface Registry {
  /** Absolute path of the registry's root (where `registry.json` is). */
  root: string;
  /** The Git commit of the registry's repository, `-dirty` when its files have uncommitted changes. */
  commit: string | undefined;
  names(): string[];
  /** The component's manifest; throws when the registry has no such component. */
  manifest(name: string): Manifest;
  /** The component's package directory. */
  dir(name: string): string;
  /** The preset's component names, in order. */
  preset(name: string): string[];
  /** Every file a component installs: project-relative target → absolute source. */
  files(name: string): Map<string, string>;
}

export function openRegistry(path: string): Registry {
  const root = resolve(path);
  const indexPath = join(root, "registry.json");
  if (!existsSync(indexPath)) throw new Error(`${root} is not a registry: it has no registry.json`);
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as RegistryIndex;
  const commit = gitCommit(root);

  const dir = (name: string): string => {
    const entry = index.components[name];
    if (entry === undefined) {
      throw new Error(`the registry ${root} has no component "${name}" (it has: ${Object.keys(index.components).join(", ")})`);
    }
    return join(root, entry.path);
  };

  return {
    root,
    commit,
    names: () => Object.keys(index.components),
    dir,
    manifest(name) {
      const manifest = readManifest(dir(name));
      if (manifest === undefined) throw new Error(`the registry's component "${name}" has no component.json`);
      return manifest;
    },
    preset(name) {
      const file = join(root, "presets", `${name}.yaml`);
      if (!existsSync(file)) throw new Error(`the registry ${root} has no preset "${name}" (presets/${name}.yaml)`);
      // YAML 1.2 (SPEC §12): a preset is a list of names and nothing else (SPEC §11).
      const preset = parse(readFileSync(file, "utf8")) as { components?: unknown };
      const components = preset?.components;
      if (!Array.isArray(components) || !components.every((c) => typeof c === "string")) {
        throw new Error(`presets/${name}.yaml must be \`components:\` followed by a list of component names`);
      }
      return components as string[];
    },
    files(name) {
      const componentDir = dir(name);
      const files = new Map<string, string>();
      for (const { source, target } of this.manifest(name).files) {
        const from = join(componentDir, source);
        if (!isInside(target)) throw new Error(`${name}: the file target "${target}" leaves the project`);
        if (statSync(from).isDirectory()) {
          // SPEC §10.2: `files/src` → `src` is the only directory mapping.
          if (source !== "files/src" || target !== "src") throw new Error(`${name}: only files/src → src may map a directory`);
          for (const file of listFiles(from)) files.set(`src/${file}`, join(from, file));
        } else {
          files.set(normalize(target).split("\\").join("/"), from);
        }
      }
      return files;
    },
  };
}

/** A relative path that stays inside the project: no `..`, not absolute. */
export function isInside(target: string): boolean {
  if (target === "" || isAbsolute(target)) return false;
  return !normalize(target).split(/[\\/]/).includes("..");
}

function listFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => f.split("\\").join("/"))
    .filter((f) => !f.split("/").includes("node_modules") && statSync(join(dir, f)).isFile())
    .sort();
}

function gitCommit(root: string): string | undefined {
  const head = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  if (head.exitCode !== 0) return undefined;
  const status = Bun.spawnSync(["git", "-C", root, "status", "--porcelain", "--", "."], { stdout: "pipe", stderr: "ignore" });
  const dirty = status.stdout.toString().trim() !== "";
  return `${head.stdout.toString().trim()}${dirty ? "-dirty" : ""}`;
}
