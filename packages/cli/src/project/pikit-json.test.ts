/**
 * `pikit.json`: registries recorded by what resolves on any machine, written in one stable order.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REGISTRY } from "../paths.ts";
import { emptyManifest, type InstalledComponent, ownedDependencies, PIKIT_JSON, type ProjectManifest, readProjectManifest, writeProjectManifest } from "./pikit-json.ts";
import { BUILTIN_REGISTRY, isPortable, recordedLocation, registryPath } from "./registry-location.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-json-test-"));
  dirs.push(dir);
  return dir;
};

test("a written file reads back as it was: keys in one order, files sorted; another version is refused", () => {
  const project = temp();
  const manifest: ProjectManifest = {
    ...emptyManifest(),
    components: {
      "tool-fake": {
        registry: "default", version: "0.0.0", requires: { pikit: "0.0.0" },
        files: { "src/b.ts": { hash: "sha256:b" }, "src/a.ts": { hash: "sha256:a" } }, dependencies: {}, addedDependencies: [], environment: [],
      },
    },
  };
  writeProjectManifest(project, manifest);
  const text = readFileSync(join(project, PIKIT_JSON), "utf8");
  expect(Object.keys(JSON.parse(text))).toEqual(["version", "targets", "registries", "components"]);
  expect(JSON.parse(text).version).toBe(1);
  expect(text.indexOf('"src/a.ts"')).toBeLessThan(text.indexOf('"src/b.ts"'));
  expect(readProjectManifest(project)).toEqual(manifest);

  writeFileSync(join(project, PIKIT_JSON), JSON.stringify({ ...emptyManifest(), version: 2 }));
  expect(() => readProjectManifest(project)).toThrow("pikit.json has version 2; this CLI reads version 1");
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

test("the packages remove may take out are those add put in package.json", () => {
  const record: InstalledComponent = {
    registry: "default", version: "0.0.0", requires: { pikit: "0.0.0" }, files: {}, dependencies: { hono: "4.13.9", "left-pad": "1.3.0" }, devDependencies: { wrangler: "4.143.0" },
    addedDependencies: ["hono"], environment: [],
  };
  expect(ownedDependencies(record)).toEqual({ dependencies: ["hono"], devDependencies: [] });
  expect(ownedDependencies({ ...record, addedDependencies: [], addedDevDependencies: ["wrangler"] })).toEqual({ dependencies: [], devDependencies: ["wrangler"] });
});
