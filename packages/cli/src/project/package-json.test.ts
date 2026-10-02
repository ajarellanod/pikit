/**
 * What `pikit add` and `pikit remove` do to the project's `package.json`: a component's `dependencies`
 * go in its dependencies, its `devDependencies` (a tool it runs, like deployment-cloudflare's
 * `wrangler`) in its devDependencies, and `remove` takes out only what nothing else still needs.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unneededDependencies } from "../commands/remove.ts";
import { addDependencies, type PackageJson, removeDependencies } from "./package-json.ts";
import { emptyManifest, type InstalledComponent } from "./pikit-json.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pikit-package-json-"));
  dirs.push(dir);
  return dir;
};

const starter = (): PackageJson => ({
  name: "p",
  dependencies: { "@pikit/core": "file:vendor/pikit-core.tgz" },
  devDependencies: { "@types/bun": "1.4.2", typescript: "7.0.2" },
});

test("dev dependencies are added to devDependencies, sorted, and dependencies are left alone", () => {
  const pkg = starter();
  expect(addDependencies(temp(), pkg, { wrangler: "4.143.0", "@cloudflare/x": "1.0.0" }, "devDependencies")).toEqual({
    added: ["wrangler", "@cloudflare/x"],
    conflicts: [],
  });
  expect(pkg.devDependencies).toEqual({ "@cloudflare/x": "1.0.0", "@types/bun": "1.4.2", typescript: "7.0.2", wrangler: "4.143.0" });
  expect(Object.keys(pkg.devDependencies ?? {})).toEqual(["@cloudflare/x", "@types/bun", "typescript", "wrangler"]);
  expect(pkg.dependencies).toEqual(starter().dependencies);
});

test("a dev dependency the project has keeps the project's version, and a different one is a conflict", () => {
  const pkg = starter();
  expect(addDependencies(temp(), pkg, { typescript: "7.0.2" }, "devDependencies")).toEqual({ added: [], conflicts: [] });
  expect(addDependencies(temp(), pkg, { typescript: "6.0.0" }, "devDependencies")).toEqual({
    added: [],
    conflicts: ["typescript: the project has 7.0.2, the component asks for 6.0.0"],
  });
  expect(pkg).toEqual(starter());
});

test("a dev dependency the project has as a dependency is there already: it is installed either way", () => {
  const pkg: PackageJson = { name: "p", dependencies: { hono: "4.13.9" } };
  expect(addDependencies(temp(), pkg, { hono: "4.13.9" }, "devDependencies")).toEqual({ added: [], conflicts: [] });
  // Nothing added: no empty devDependencies appears.
  expect(pkg).toEqual({ name: "p", dependencies: { hono: "4.13.9" } });
});

test("a project without devDependencies gets them when a component declares one", () => {
  const pkg: PackageJson = { name: "p", dependencies: {} };
  addDependencies(temp(), pkg, { wrangler: "4.143.0" }, "devDependencies");
  expect(pkg.devDependencies).toEqual({ wrangler: "4.143.0" });
});

test("dependencies are added as before", () => {
  const pkg = starter();
  expect(addDependencies(temp(), pkg, { hono: "4.13.9" })).toEqual({ added: ["hono"], conflicts: [] });
  expect(pkg.dependencies).toEqual({ "@pikit/core": "file:vendor/pikit-core.tgz", hono: "4.13.9" });
  expect(pkg.devDependencies).toEqual(starter().devDependencies);
});

test("removing dev dependencies takes them out of devDependencies only, and says which were there", () => {
  const pkg: PackageJson = { ...starter(), dependencies: { ...starter().dependencies, wrangler: "4.143.0" }, devDependencies: { ...starter().devDependencies, wrangler: "4.143.0" } };
  expect(removeDependencies(pkg, ["wrangler", "absent"], "devDependencies")).toEqual(["wrangler"]);
  expect(pkg.devDependencies).toEqual(starter().devDependencies);
  expect(pkg.dependencies?.wrangler).toBe("4.143.0");
  // A project without devDependencies is left without them.
  const bare: PackageJson = { name: "p", dependencies: {} };
  expect(removeDependencies(bare, ["wrangler"], "devDependencies")).toEqual([]);
  expect(bare).toEqual({ name: "p", dependencies: {} });
});

const installed = (dependencies: Record<string, string>, devDependencies?: Record<string, string>): InstalledComponent => ({
  registry: "default",
  version: "0.0.0",
  files: {},
  dependencies,
  ...(devDependencies !== undefined && { devDependencies }),
  environment: [],
});

test("remove takes out a dev dependency no remaining component declares, as either, and no project file imports", () => {
  const dir = temp();
  const project = emptyManifest(undefined, undefined, ["durable"]);
  // What remains once deployment-cloudflare is gone.
  project.components["storage-do"] = installed({ "@pikit/contracts": "0.0.0" });
  expect(unneededDependencies(dir, project, ["wrangler"])).toEqual(["wrangler"]);

  // Another deployment that declares it too keeps it; so does one that has it as a dependency.
  project.components["deployment-other"] = installed({}, { wrangler: "4.143.0" });
  expect(unneededDependencies(dir, project, ["wrangler"])).toEqual([]);
  project.components["deployment-other"] = installed({ wrangler: "4.143.0" });
  expect(unneededDependencies(dir, project, ["wrangler"])).toEqual([]);
  // And a dependency that a remaining component declares as a dev dependency stays too.
  project.components["deployment-other"] = installed({}, { hono: "4.13.9" });
  expect(unneededDependencies(dir, project, ["hono"])).toEqual([]);

  // A project file that imports it keeps it.
  delete project.components["deployment-other"];
  mkdirSync(join(dir, "scripts"));
  // Built in two pieces: this test's own imports are checked (scripts/boundaries.ts), and it has no wrangler.
  writeFileSync(join(dir, "scripts", "deploy.ts"), `import { unstable_dev } from ${JSON.stringify("wrangler")};\n`);
  expect(unneededDependencies(dir, project, ["wrangler"])).toEqual([]);
});
