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
        registry: "default", version: "0.0.1", requires: { pikit: "0.0.1" },
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

test("what a component needs of the deployment, and what a deployment supports, are recorded and read back stably", () => {
  const project = temp();
  const record = { registry: "default", version: "0.0.1", files: {}, dependencies: {}, addedDependencies: [], environment: [] };
  const manifest: ProjectManifest = {
    ...emptyManifest(),
    components: {
      "proposals-acme": { ...record, requires: { pikit: "0.0.1", deployment: ["proposals.deployer", "acme.review-host"] }, compose: "src/pikit/proposals-acme/compose.yaml" },
      "deployment-acme": { ...record, requires: { pikit: "0.0.1" }, deployment: { supports: ["services.compose", "proposals.deployer"] } },
      "deployment-bare": { ...record, requires: { pikit: "0.0.1" }, deployment: { supports: [] } },
    },
  };
  writeProjectManifest(project, manifest);
  const text = readFileSync(join(project, PIKIT_JSON), "utf8");
  const read = readProjectManifest(project);
  expect(read).toEqual(manifest);
  expect(read.components["proposals-acme"]?.requires.deployment).toEqual(["proposals.deployer", "acme.review-host"]);
  expect(read.components["deployment-bare"]?.deployment).toEqual({ supports: [] });
  // Written again, the same text.
  writeProjectManifest(project, read);
  expect(readFileSync(join(project, PIKIT_JSON), "utf8")).toBe(text);

  writeFileSync(join(project, PIKIT_JSON), JSON.stringify({ ...manifest, components: { "deployment-acme": { ...record, requires: { pikit: "0.0.1" }, deployment: { supports: ["a.b"], extra: 1 } } } }));
  expect(() => readProjectManifest(project)).toThrow("/components/deployment-acme/deployment/extra: is not a known field");
});

test("a pikit.json that does not have the schema's shape is refused, naming the file and the path of each bad field", () => {
  const project = temp();
  const component = { registry: "default", version: 1, requires: { pikit: "0.0.1" }, files: {}, dependencies: {}, addedDependencies: [], environment: [], note: "mine" };
  writeFileSync(join(project, PIKIT_JSON), JSON.stringify({ ...emptyManifest(), components: { "tool-fake": component } }));
  expect(() => readProjectManifest(project)).toThrow(
    "pikit.json does not have the shape this CLI reads:\n  /components/tool-fake/note: is not a known field\n  /components/tool-fake/version: must be string",
  );

  writeFileSync(join(project, PIKIT_JSON), JSON.stringify({ version: 1, targets: ["server"], registries: {} }));
  expect(() => readProjectManifest(project)).toThrow("pikit.json does not have the shape this CLI reads:\n  /: must have required properties components");

  writeFileSync(join(project, PIKIT_JSON), "{ \"version\": 1,");
  expect(() => readProjectManifest(project)).toThrow("pikit.json is not valid JSON: ");
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
    registry: "default", version: "0.0.1", requires: { pikit: "0.0.1" }, files: {}, dependencies: { hono: "4.13.9", "left-pad": "1.3.0" }, devDependencies: { wrangler: "4.143.0" },
    addedDependencies: ["hono"], environment: [],
  };
  expect(ownedDependencies(record)).toEqual({ dependencies: ["hono"], devDependencies: [] });
  expect(ownedDependencies({ ...record, addedDependencies: [], addedDevDependencies: ["wrangler"] })).toEqual({ dependencies: [], devDependencies: ["wrangler"] });
});
