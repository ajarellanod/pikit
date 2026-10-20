/**
 * A registry's dashboard descriptor (`dashboard/dashboard.json`): which components its dashboard
 * needs is the registry's to say, under any names. A fake registry whose dashboard needs `acme-*`
 * components, none of which the CLI knows.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uiComponentsFor } from "../commands/ui.ts";
import { DEFAULT_REGISTRY } from "../paths.ts";
import type { Manifest } from "../registry/manifest.ts";
import { DASHBOARD_MANIFEST, dashboardManifest, dashboardManifestProblems } from "./dashboard-manifest.ts";
import { openRegistry, type Registry } from "./registry-source.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const NOTHING = { provides: [], requires: [], optional: [] };
const DESCRIPTOR = { components: ["acme-auth", "acme-admin", "acme-settings"], defaultFor: { "acme-auth": "admin.auth", "acme-settings": "settings" } };
const MANIFESTS: Partial<Manifest>[] = [
  { name: "acme-auth", provides: ["admin.auth"], apps: { worker: "default" } },
  { name: "acme-admin", provides: ["http.route"], apps: { worker: "worker" }, halves: { default: { ...NOTHING, provides: ["http.route"] }, worker: { ...NOTHING, provides: ["http.route"] } } },
  { name: "acme-settings", provides: ["settings"], apps: { worker: "default" } },
  // Other providers of what the defaults stand for: in both Apps, and in the Worker's only.
  { name: "other-auth", provides: ["admin.auth"], apps: { worker: "default" } },
  { name: "edge-auth", provides: ["admin.auth"], apps: { worker: "worker" }, halves: { default: NOTHING, worker: { ...NOTHING, provides: ["admin.auth"] } } },
];

/**
 * A registry of `manifests`, with a dashboard (`dashboard/files/`) unless `files` is false, and
 * `descriptor` as its `dashboard/dashboard.json` (a string as is; none when undefined).
 */
function fake(descriptor: unknown, manifests: Partial<Manifest>[] = MANIFESTS, files = true): Registry {
  const root = mkdtempSync(join(tmpdir(), "pikit-dashboard-manifest-"));
  dirs.push(root);
  if (files) {
    mkdirSync(join(root, "dashboard", "files"), { recursive: true });
    writeFileSync(join(root, "dashboard", "files", "README.md"), "# a dashboard\n");
  }
  if (descriptor !== undefined) {
    mkdirSync(join(root, "dashboard"), { recursive: true });
    writeFileSync(join(root, DASHBOARD_MANIFEST), typeof descriptor === "string" ? descriptor : JSON.stringify(descriptor));
  }
  const full = manifests.map(
    (m) => ({ version: "0.0.1", description: m.name, targets: ["server", "durable"], requires: { pikit: "0.0.1", capabilities: [] }, optional: { capabilities: [] }, provides: [], dependencies: {}, files: [], ...m }) as Manifest,
  );
  return {
    root,
    names: () => full.map((m) => m.name),
    manifest: (name: string) => {
      const manifest = full.find((m) => m.name === name);
      if (manifest === undefined) throw new Error(`no component "${name}"`);
      return manifest;
    },
  } as unknown as Registry;
}

test("the dashboard's components are its registry's: uiComponentsFor picks them, in the descriptor's order", () => {
  const registry = fake(DESCRIPTOR);
  expect(dashboardManifest(registry)).toEqual(DESCRIPTOR);
  expect(dashboardManifestProblems(registry)).toEqual([]);
  expect(uiComponentsFor(registry, [], ["server"])).toEqual(["acme-auth", "acme-admin", "acme-settings"]);
  expect(uiComponentsFor(registry, [], ["durable"])).toEqual(["acme-auth", "acme-admin", "acme-settings"]);
  // One the composition has already is not missing.
  expect(uiComponentsFor(registry, ["acme-settings"], ["server"])).toEqual(["acme-auth", "acme-admin"]);
});

test("another provider of a default's capability in every App takes the default's place; in some Apps only, refused", () => {
  const registry = fake(DESCRIPTOR);
  expect(uiComponentsFor(registry, ["other-auth"], ["server"])).toEqual(["acme-admin", "acme-settings"]);
  expect(uiComponentsFor(registry, ["other-auth"], ["durable"])).toEqual(["acme-admin", "acme-settings"]);
  expect(() => uiComponentsFor(registry, ["edge-auth"], ["durable"])).toThrow(
    "the dashboard needs admin.auth in every App, and it is provided in the Worker's App (export const worker) but not in the default App: acme-auth would provide it in each",
  );
  // On a server only the default App counts: the Worker's half alone does not provide it there.
  expect(uiComponentsFor(registry, ["edge-auth"], ["server"])).toEqual(["acme-auth", "acme-admin", "acme-settings"]);
});

test("a registry without a dashboard has no descriptor, and nothing to report; uiComponentsFor refuses it", () => {
  const registry = fake(undefined, MANIFESTS, false);
  expect(dashboardManifest(registry)).toBeUndefined();
  expect(dashboardManifestProblems(registry)).toEqual([]);
  expect(() => uiComponentsFor(registry, [], ["server"])).toThrow("has no dashboard (dashboard/files/)");
});

test("a dashboard without its descriptor, or with one of another shape, is refused naming the file", () => {
  const missing = fake(undefined);
  expect(() => dashboardManifest(missing)).toThrow(`${DASHBOARD_MANIFEST} is missing`);
  expect(dashboardManifestProblems(missing)).toEqual([expect.stringContaining(`${DASHBOARD_MANIFEST} is missing`)]);

  expect(() => dashboardManifest(fake("{ not json"))).toThrow(`${DASHBOARD_MANIFEST}: not valid JSON`);
  for (const invalid of [
    { components: [], defaultFor: {} },
    { components: ["acme-auth", "acme-auth"], defaultFor: {} },
    { components: ["Acme Auth"], defaultFor: {} },
    { components: ["acme-auth"] },
    { components: ["acme-auth"], defaultFor: {}, extra: true },
    { components: ["acme-auth"], defaultFor: { "acme-auth": 1 } },
  ]) {
    const registry = fake(invalid);
    expect(() => dashboardManifest(registry)).toThrow(DASHBOARD_MANIFEST);
    const problems = dashboardManifestProblems(registry);
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) expect(problem).toStartWith(DASHBOARD_MANIFEST);
  }
});

test("registry validate's problems: a component the registry lacks, a default not among the components, a default that does not provide its capability in every App", () => {
  expect(dashboardManifestProblems(fake({ ...DESCRIPTOR, components: [...DESCRIPTOR.components, "acme-gone"] }))).toEqual([
    `${DASHBOARD_MANIFEST}: "acme-gone" is not a component of the registry`,
  ]);
  expect(dashboardManifestProblems(fake({ components: ["acme-admin"], defaultFor: { "acme-auth": "admin.auth" } }))).toEqual([
    `${DASHBOARD_MANIFEST}: "defaultFor" names "acme-auth", which is not one of its "components"`,
  ]);
  // acme-admin provides no settings; edge-auth provides admin.auth in the Worker's App only.
  expect(dashboardManifestProblems(fake({ components: ["acme-admin", "edge-auth"], defaultFor: { "acme-admin": "settings", "edge-auth": "admin.auth" } }))).toEqual([
    `${DASHBOARD_MANIFEST}: "acme-admin" stands for settings, which it does not provide in the default App on server`,
    `${DASHBOARD_MANIFEST}: "acme-admin" stands for settings, which it does not provide in the default App and the Worker's App (export const worker) on durable`,
    `${DASHBOARD_MANIFEST}: "edge-auth" stands for admin.auth, which it does not provide in the default App on server`,
    `${DASHBOARD_MANIFEST}: "edge-auth" stands for admin.auth, which it does not provide in the default App on durable`,
  ]);
  // A default that goes in the default App alone does not provide it in the Worker's.
  const single = MANIFESTS.map((m) => (m.name === "acme-auth" ? { name: "acme-auth", provides: ["admin.auth"] } : m));
  expect(dashboardManifestProblems(fake(DESCRIPTOR, single))).toEqual([
    `${DASHBOARD_MANIFEST}: "acme-auth" stands for admin.auth, which it does not provide in the Worker's App (export const worker) on durable`,
  ]);
  // The dashboard goes on every target: so must what it needs.
  const serverOnly = MANIFESTS.map((m) => (m.name === "acme-admin" ? { ...m, targets: ["server"] } : m));
  expect(dashboardManifestProblems(fake(DESCRIPTOR, serverOnly))).toEqual([`${DASHBOARD_MANIFEST}: "acme-admin" does not run on durable, and the dashboard does`]);
});

test("the kit's registry: its descriptor names admin-auth-token, admin-api and settings-store, and validates", () => {
  const kit = openRegistry(DEFAULT_REGISTRY);
  expect(dashboardManifest(kit)).toEqual({ components: ["admin-auth-token", "admin-api", "settings-store"], defaultFor: { "admin-auth-token": "admin.auth", "settings-store": "settings" } });
  expect(dashboardManifestProblems(kit)).toEqual([]);
});
