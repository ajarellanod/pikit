import { expect, test } from "bun:test";
import { DEFAULT_REGISTRY } from "../paths.ts";
import {
  CAPABILITIES,
  type CapabilityEntry,
  type CapabilityUsage,
  capabilityEntry,
  capabilityUsage,
  checkStability,
  formatCapabilities,
} from "./capabilities.ts";
import { checkCapabilities } from "./checks.ts";
import { readManifests } from "./commands.ts";
import type { Manifest } from "./manifest.ts";

const manifest = (name: string, fields: { provides?: string[]; requires?: string[]; optional?: string[] }): Manifest => ({
  name,
  version: "0.0.0",
  description: name,
  targets: ["server"],
  requires: { pikit: "0.0.0", capabilities: fields.requires ?? [] },
  optional: { capabilities: fields.optional ?? [] },
  provides: fields.provides ?? [],
  dependencies: {},
  files: [{ source: "files/src", target: "src" }],
});

// Checked by tsc, not at run time: `agent.runtime` is a single capability, so a keyed entry is a type error.
// @ts-expect-error the catalogue's mode must match how the capability is defined
const wrongMode: (typeof CAPABILITIES)["agent.runtime"] = { mode: "keyed", definedIn: "@pikit/contracts", stability: "experimental", summary: "" };
void wrongMode;

test("validate rejects a capability the catalogue does not describe, once per name", () => {
  const m = manifest("channel-x", { provides: ["agent.conversations"], requires: ["made.up", "secrets"], optional: ["made.up"] });
  expect(checkCapabilities(m)).toEqual([
    'capability "made.up" is not in the catalogue: describe it in packages/cli/src/registry/capabilities.ts',
  ]);
  expect(checkCapabilities(manifest("tool-x", { provides: ["agent.tool"], requires: ["execution"] }))).toEqual([]);
});

test("usage lists every catalogued capability, its providers and its consumers, optional ones marked", () => {
  const usage = capabilityUsage([
    manifest("runtime-x", { provides: ["agent.runtime"], requires: ["execution"], optional: ["agent.tool"] }),
    manifest("execution-x", { provides: ["execution"] }),
    manifest("odd-x", { requires: ["made.up"] }),
  ]);
  const byName = new Map(usage.map((u) => [u.name, u]));

  expect(usage.map((u) => u.name)).toEqual([...Object.keys(CAPABILITIES), "made.up"].sort());
  expect(byName.get("execution")).toMatchObject({ providers: ["execution-x"], consumers: [{ name: "runtime-x", optional: false }] });
  expect(byName.get("agent.tool")?.consumers).toEqual([{ name: "runtime-x", optional: true }]);
  expect(byName.get("secrets")).toMatchObject({ providers: [], consumers: [] });
  expect(byName.get("made.up")?.entry).toBeUndefined();

  const text = formatCapabilities(usage);
  expect(text).toContain("execution  (single, @pikit/pi-adapter, experimental)");
  expect(text).toContain("agent.definition  (keyed, @pikit/contracts, stable)\n  One agent per name (model, prompt, tools); provided by the project, not the registry.\n  provided by: the project");
  expect(text).toContain("used by:     runtime-x (optional)");
  expect(text).toContain("agent.submissions  (single, @pikit/contracts, experimental, transitional)");
  expect(text).toContain("  transitional: a bridge over pi-durable's own submissions; deleted once the channels read pi-durable directly");
  expect(text).toContain("made.up  (not in the catalogue)");
});

test("every capability the repository's registry names is catalogued", () => {
  const unknown = capabilityUsage(readManifests(DEFAULT_REGISTRY)).filter((u) => u.entry === undefined);
  expect(unknown.map((u) => u.name)).toEqual([]);
  for (const entry of Object.values(CAPABILITIES) as CapabilityEntry[]) expect(entry.summary.length).toBeGreaterThan(0);
});

test("a stable contract needs two providers in the registry; one the project provides is promoted by decision", () => {
  const usage = (name: string, providers: string[]): CapabilityUsage => {
    const entry = capabilityEntry(name);
    if (entry === undefined) throw new Error(`${name} is not in the catalogue`);
    return { name, entry: { ...entry, stability: "stable" }, providers, consumers: [] };
  };
  expect(checkStability([usage("storage.sql", ["storage-sqlite"])])).toEqual([
    "storage.sql is stable with 1 provider(s) in the registry; a stable contract needs two",
  ]);
  expect(checkStability([usage("storage.sql", ["storage-sqlite", "storage-postgres"])])).toEqual([]);
  expect(checkStability([usage("agent.definition", [])])).toEqual([]);
});

test("the repository's registry backs every stable contract", () => {
  expect(checkStability(capabilityUsage(readManifests(DEFAULT_REGISTRY)))).toEqual([]);
});
