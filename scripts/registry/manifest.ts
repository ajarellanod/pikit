/**
 * `component.json` (SPEC §10.2) and `registry.json` (SPEC §10.4): their shape, their stable key
 * order, and which fields are generated.
 *
 * Generated from `setup` (S14), rewritten by `generate`, checked by `validate`:
 * `provides`, `requires.capabilities`, `optional.capabilities` and `replay.tools`.
 * Everything else is written by hand and `generate` never changes it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TARGETS = ["server", "cloudflare"] as const;

export interface EnvironmentVariable {
  name: string;
  secret: boolean;
  required: boolean;
  description?: string;
}

export interface Manifest {
  name: string;
  version: string;
  description: string;
  license?: string;
  targets: string[];
  requires: { pikit: string; capabilities: string[] };
  optional: { capabilities: string[] };
  provides: string[];
  /** Only for components that provide `agent.tool`: each tool's replay (S10, SPEC §8.4). */
  replay?: { tools: Record<string, string> };
  dependencies: Record<string, string>;
  files: { source: string; target: string }[];
  environment?: EnvironmentVariable[];
  migrations?: string;
  [extra: string]: unknown;
}

/** What `setup` declares, in the manifest's terms. */
export interface Generated {
  provides: string[];
  requires: string[];
  optional: string[];
  /** Tool name → its replay; absent when the component provides no tool. */
  tools?: Record<string, string>;
}

/** Top-level key order. Unknown keys keep their place after these, in their own order. */
const KEY_ORDER = [
  "name",
  "version",
  "description",
  "license",
  "targets",
  "requires",
  "optional",
  "provides",
  "replay",
  "dependencies",
  "files",
  "environment",
  "config",
  "migrations",
];

export function manifestPath(componentDir: string): string {
  return join(componentDir, "component.json");
}

export function readManifest(componentDir: string): Manifest | undefined {
  const path = manifestPath(componentDir);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** The manifest with its generated fields replaced; hand-written fields untouched. */
export function withGenerated(manifest: Manifest, generated: Generated): Manifest {
  const next: Manifest = {
    ...manifest,
    requires: { ...manifest.requires, capabilities: generated.requires },
    optional: { ...manifest.optional, capabilities: generated.optional },
    provides: generated.provides,
  };
  if (generated.tools === undefined) delete next.replay;
  else next.replay = { ...manifest.replay, tools: generated.tools };
  return next;
}

/** Stable text: known keys in `KEY_ORDER`, `requires.pikit` before `requires.capabilities`. */
export function formatManifest(manifest: Manifest): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) if (key in manifest) ordered[key] = manifest[key];
  for (const [key, value] of Object.entries(manifest)) if (!(key in ordered)) ordered[key] = value;
  const { pikit, capabilities, ...otherRequires } = manifest.requires;
  ordered.requires = { pikit, capabilities, ...otherRequires };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function writeManifest(componentDir: string, manifest: Manifest): void {
  writeFileSync(manifestPath(componentDir), formatManifest(manifest));
}

export interface RegistryIndex {
  /** Schema version of `registry.json` (SPEC §12a). */
  version: 1;
  components: Record<string, { version: string; description: string; targets: string[]; path: string }>;
}

/** `registry.json`, rebuilt from the manifests. Sorted by name, so its diff shows only changes. */
export function buildIndex(manifests: Manifest[]): RegistryIndex {
  const components: RegistryIndex["components"] = {};
  for (const m of [...manifests].sort((a, b) => a.name.localeCompare(b.name))) {
    components[m.name] = {
      version: m.version,
      description: m.description,
      targets: m.targets,
      path: `components/${m.name}`,
    };
  }
  return { version: 1, components };
}

export function formatIndex(index: RegistryIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}
