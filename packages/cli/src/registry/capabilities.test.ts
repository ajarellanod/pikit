import { expect, test } from "bun:test";
import { DEFAULT_REGISTRY } from "../paths.ts";
import { CAPABILITIES, type CapabilityEntry, capabilityUsage, formatCapabilities } from "./capabilities.ts";
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
const wrongMode: (typeof CAPABILITIES)["agent.runtime"] = { mode: "keyed", definedIn: "@pikit/core", summary: "" };
void wrongMode;

test("validate rejects a capability the catalogue does not describe, once per name", () => {
  const m = manifest("channel-x", { provides: ["sessions.store"], requires: ["made.up", "secrets"], optional: ["made.up"] });
  expect(checkCapabilities(m)).toEqual([
    'capability "made.up" is not in the catalogue: describe it in packages/cli/src/registry/capabilities.ts',
  ]);
  expect(checkCapabilities(manifest("tool-x", { provides: ["agent.tool"], requires: ["execution"] }))).toEqual([]);
});

test("usage lists every catalogued capability, its providers and its consumers, optional ones marked", () => {
  const usage = capabilityUsage([
    manifest("runtime-x", { provides: ["agent.runtime"], requires: ["sessions.store"], optional: ["agent.tool"] }),
    manifest("sessions-x", { provides: ["sessions.store"] }),
    manifest("odd-x", { requires: ["made.up"] }),
  ]);
  const byName = new Map(usage.map((u) => [u.name, u]));

  expect(usage.map((u) => u.name)).toEqual([...Object.keys(CAPABILITIES), "made.up"].sort());
  expect(byName.get("sessions.store")).toMatchObject({ providers: ["sessions-x"], consumers: [{ name: "runtime-x", optional: false }] });
  expect(byName.get("agent.tool")?.consumers).toEqual([{ name: "runtime-x", optional: true }]);
  expect(byName.get("secrets")).toMatchObject({ providers: [], consumers: [] });
  expect(byName.get("made.up")?.entry).toBeUndefined();

  const text = formatCapabilities(usage);
  expect(text).toContain("sessions.store  (single, @pikit/pi-adapter)");
  expect(text).toContain("used by:     runtime-x (optional)");
  expect(text).toContain("made.up  (not in the catalogue)");
});

test("every capability the repository's registry names is catalogued", () => {
  const unknown = capabilityUsage(readManifests(DEFAULT_REGISTRY)).filter((u) => u.entry === undefined);
  expect(unknown.map((u) => u.name)).toEqual([]);
  for (const entry of Object.values(CAPABILITIES) as CapabilityEntry[]) expect(entry.summary.length).toBeGreaterThan(0);
});
