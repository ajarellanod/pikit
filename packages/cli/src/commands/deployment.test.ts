/**
 * `pikit status` prints a deployment's `DeploymentStatus` lines as they are: what they say is the
 * component's (`deployment-docker`'s and `deployment-cloudflare`'s tests hold theirs). And which
 * component is the deployment: exactly one of kind `deployment`, the planner's rule (`deploymentsOf`).
 */

import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentExec, deploymentUrl } from "../project/deployment-module.ts";
import { emptyManifest, writeProjectManifest } from "../project/pikit-json.ts";
import { deploymentComponent, printStatus } from "./deployment.ts";

const printed = spyOn(console, "log").mockImplementation(() => {});
afterEach(() => printed.mockClear());
// Test files share one process: the files after this one keep their console.
afterAll(() => printed.mockRestore());
const output = () => printed.mock.calls.map((call) => String(call[0])).join("\n");

test("a DeploymentStatus is printed line by line, nothing added", () => {
  printStatus({ lines: ["pikit-agent.service: active (running)", "GET /health: 200"], containers: [] });
  expect(output()).toBe("pikit-agent.service: active (running)\nGET /health: 200");
});

test("any other result is printed as JSON, not guessed at: a status without lines is not read as Docker's", () => {
  const docker = { containers: [{ name: "app-1", state: "running", health: "healthy", status: "Up 3 minutes" }], health: 200, ready: 503 };
  printStatus(docker);
  expect(output()).toBe(JSON.stringify(docker, null, 2));
});

test("the deployment is the one component of kind deployment: none or several is said, and exec/url are then absent", async () => {
  const dirs: string[] = [];
  const project = (names: string[], targets = ["server"]) => {
    const dir = mkdtempSync(join(tmpdir(), "pikit-deployment-test-"));
    dirs.push(dir);
    const manifest = emptyManifest(undefined, undefined, targets);
    for (const name of names) manifest.components[name] = { registry: "default", version: "0.0.1", requires: { pikit: "0.0.1" }, addedDependencies: [], files: {}, dependencies: {}, environment: [] };
    writeProjectManifest(dir, manifest);
    return dir;
  };
  try {
    expect(deploymentComponent(project(["tool-x", "deployment-mine"]))).toBe("deployment-mine");
    expect(() => deploymentComponent(project(["tool-x"]))).toThrow("no deployment-* component is installed; add one, e.g. `pikit add deployment-docker`");
    expect(() => deploymentComponent(project([], ["durable"]))).toThrow("e.g. `pikit add deployment-cloudflare`");
    const several = project(["deployment-zeta", "deployment-alpha"]);
    expect(() => deploymentComponent(several)).toThrow("several deployment components are installed (deployment-alpha, deployment-zeta); remove all but one");
    expect(await deploymentExec(several)).toBeUndefined();
    expect(await deploymentUrl(several)).toBeUndefined();
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});
