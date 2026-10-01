/**
 * `pikit status` prints a deployment's `DeploymentStatus` lines as they are: what they say is the
 * component's (`deployment-docker`'s and `deployment-cloudflare`'s tests hold theirs).
 */

import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { printStatus } from "./deployment.ts";

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
