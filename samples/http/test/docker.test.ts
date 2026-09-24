/**
 * The sample's Docker files, adapted to the monorepo, keep deployment-docker's promises: secrets and
 * state out of the image, the state volume where `pikit.config.ts` keeps its state, and a stop that
 * fits in the grace period. The component's own `files.test.ts` checks its unadapted files.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { STOP_DEADLINE_MS } from "../../../registry/components/deployment-docker/files/src/pikit/deployment-docker/entrypoint.ts";
import { config } from "../pikit.config.ts";

const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("the image leaves out .env, .pikit and node_modules, and runs as a user that is not root", () => {
  const ignored = read("Dockerfile.dockerignore").split("\n");
  expect(ignored).toContain("**/.env");
  expect(ignored).toContain("**/.pikit");
  expect(ignored).toContain("**/node_modules");
  expect(read("Dockerfile")).toMatch(/^USER bun$/m);
  expect(read("Dockerfile")).toMatch(/^CMD \["bun", "samples\/http\/main\.ts"\]$/m);
});

test("the volume is mounted where pikit.config.ts keeps the sample's state", () => {
  const sessions = config["sessions-jsonl"].root;
  const state = sessions.slice(0, sessions.lastIndexOf("/"));
  expect(state.endsWith("/samples/http/.pikit")).toBe(true);
  expect(read("compose.yaml")).toMatch(/^\s+- pikit-state:\/app\/samples\/http\/\.pikit$/m);
});

test("secrets come from .env at run time, and the stop fits in the grace period", () => {
  const compose = read("compose.yaml");
  expect(compose).toMatch(/env_file:\n\s+- \.env$/m);
  const grace = Number(compose.match(/stop_grace_period: (\d+)s/)?.[1]) * 1_000;
  expect(grace).toBeGreaterThan(STOP_DEADLINE_MS);
});
