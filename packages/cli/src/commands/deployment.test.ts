/**
 * `pikit status` prints a deployment's `DeploymentStatus` lines as they are, and still prints the two
 * shapes `deployment-docker` and `deployment-cloudflare` returned before it, which copies already in
 * projects return (P6).
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

test("Docker's containers and probes, and Cloudflare's deployments and probe, as before", () => {
  printStatus({ containers: [{ name: "app-1", state: "running", health: "healthy", status: "Up 3 minutes" }], health: 200, ready: 503 });
  expect(output()).toBe("app-1: running (healthy) · Up 3 minutes\nGET /health: 200\nGET /ready:  503");
  printed.mockClear();

  printStatus({ deployments: [{ id: "d1", created: "2025-01-01", versions: [{ id: "v1", percentage: 100 }] }], url: "https://a.example", health: 200, version: "v1" });
  expect(output()).toBe("2025-01-01  v1 (100%)\nGET /health at https://a.example: 200 from version v1");
});

test("any other result is printed as JSON, not read as Docker's", () => {
  printStatus({ state: "up" });
  expect(output()).toBe(JSON.stringify({ state: "up" }, null, 2));
  expect(output()).not.toContain("no containers");
});
