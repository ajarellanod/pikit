/**
 * `pikit.json` version 2: registries recorded by what resolves on any machine. A
 * version 1 file (absolute paths, the installing machine's) is read in version 2's shape, and the next
 * write saves version 2.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REGISTRY } from "../paths.ts";
import { emptyManifest, type InstalledComponent, kitRanges, ownedDependencies, PIKIT_JSON, readProjectManifest, writeProjectManifest } from "./pikit-json.ts";
import { BUILTIN_REGISTRY, isCheckoutRegistry, isPortable, recordedLocation, registryPath } from "./registry-location.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-json-test-"));
  dirs.push(dir);
  return dir;
};

/** A directory shaped like a pikit checkout: `packages/cli` is `@pikit/cli`, `registry/` has an index. */
function checkout(): string {
  const root = temp();
  mkdirSync(join(root, "packages", "cli"), { recursive: true });
  writeFileSync(join(root, "packages", "cli", "package.json"), '{ "name": "@pikit/cli" }');
  mkdirSync(join(root, "registry"));
  writeFileSync(join(root, "registry", "registry.json"), '{ "version": 1, "components": {} }');
  return root;
}

test("a version 1 file is read as version 2: a pikit checkout's registry is builtin, one inside the project relative", () => {
  const project = temp();
  const elsewhere = checkout();
  const v1 = {
    version: 1,
    targets: ["server"],
    registries: {
      default: DEFAULT_REGISTRY,
      // The installer's checkout on the machine that made the project: gone here.
      vps: "/home/someone/.pikit/pikit/registry",
      other: join(elsewhere, "registry"),
      inside: join(project, "my-registry"),
      mine: "/opt/acme/registry",
    },
    components: { "tool-fake": { registry: "default", version: "0.0.0", files: { "src/b.ts": { hash: "sha256:b" }, "src/a.ts": { hash: "sha256:a" } }, dependencies: {}, environment: [] } },
  };
  writeFileSync(join(project, PIKIT_JSON), JSON.stringify(v1));

  const read = readProjectManifest(project);
  expect(read.version).toBe(2);
  expect(read.registries).toEqual({ default: "builtin", vps: "builtin", other: "builtin", inside: "./my-registry", mine: "/opt/acme/registry" });
  expect(read.components).toEqual(v1.components);

  // The next write saves version 2, keys in one order, files sorted.
  writeProjectManifest(project, read);
  const text = readFileSync(join(project, PIKIT_JSON), "utf8");
  expect(Object.keys(JSON.parse(text))).toEqual(["version", "targets", "registries", "components"]);
  expect(JSON.parse(text).version).toBe(2);
  expect(text.indexOf('"src/a.ts"')).toBeLessThan(text.indexOf('"src/b.ts"'));
  expect(readProjectManifest(project)).toEqual(read);
});

test("a registry directory that is not a checkout's stays a path; an unknown version is refused", () => {
  expect(isCheckoutRegistry("/opt/acme/registry")).toBe(false);
  expect(isCheckoutRegistry("./registry")).toBe(false);
  expect(isCheckoutRegistry(join(checkout(), "registry"))).toBe(true);

  const project = temp();
  writeFileSync(join(project, PIKIT_JSON), JSON.stringify({ ...emptyManifest(), version: 3 }));
  expect(() => readProjectManifest(project)).toThrow("pikit.json has version 3; this CLI reads versions 1 and 2");
});

test("a registry is recorded as builtin, relative inside the project, else as given; each resolves back", () => {
  const project = temp();
  expect(emptyManifest().registries).toEqual({ default: BUILTIN_REGISTRY });
  expect(recordedLocation(project, DEFAULT_REGISTRY)).toBe("builtin");
  expect(recordedLocation(project, join(project, "registries", "acme"))).toBe("./registries/acme");
  expect(recordedLocation(project, "/opt/acme/registry")).toBe("/opt/acme/registry");

  expect(registryPath(project, "builtin")).toBe(DEFAULT_REGISTRY);
  expect(registryPath(project, "./registries/acme")).toBe(join(project, "registries", "acme"));
  expect(registryPath(project, "/opt/acme/registry")).toBe("/opt/acme/registry");

  expect(isPortable("builtin")).toBe(true);
  expect(isPortable("./registries/acme")).toBe(true);
  expect(isPortable("/opt/acme/registry")).toBe(false);
});

test("the packages remove may take out are those add put in package.json; an older record gives every one it declared", () => {
  const record: InstalledComponent = {
    registry: "default", version: "0.0.0", files: {}, dependencies: { hono: "4.13.9", "left-pad": "1.3.0" }, devDependencies: { wrangler: "4.143.0" }, environment: [],
  };
  expect(ownedDependencies(record)).toEqual({ dependencies: ["hono", "left-pad"], devDependencies: ["wrangler"] });
  expect(ownedDependencies({ ...record, addedDependencies: ["hono"] })).toEqual({ dependencies: ["hono"], devDependencies: [] });
  expect(ownedDependencies({ ...record, addedDependencies: [], addedDevDependencies: ["wrangler"] })).toEqual({ dependencies: [], devDependencies: ["wrangler"] });
});

test("the kit ranges a component accepts: its recorded ones; with no contracts range, the contracts version it pinned", () => {
  const record: InstalledComponent = {
    registry: "default", version: "0.0.0", files: {}, dependencies: { "@pikit/contracts": "0.0.0" }, environment: [],
  };
  expect(kitRanges({ ...record, requires: { pikit: "^0.1.0", contracts: "^0.2.0" } })).toEqual({ pikit: "^0.1.0", contracts: "^0.2.0" });
  // A manifest that declares no contracts range is held to its pin, as a record from before `requires`.
  expect(kitRanges({ ...record, requires: { pikit: "^0.1.0" } })).toEqual({ pikit: "^0.1.0", contracts: "0.0.0" });
  expect(kitRanges(record)).toEqual({ contracts: "0.0.0" });
  expect(kitRanges({ ...record, dependencies: {} })).toEqual({});
});
