/**
 * The project-root files this component installs: `Dockerfile`, `compose.yaml`, `.dockerignore`.
 * They sit three directories above this test, both in the registry (`files/` mirrors the project)
 * and in your project, so these checks keep holding after you edit them.
 *
 * The checks read the text: pikit parses no YAML here, and a line-level check is enough for the
 * invariants that matter (no secret in the image, a stop that fits in Docker's grace period).
 */

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { START_DEADLINE_MS, STOP_DEADLINE_MS } from "./entrypoint.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const read = (name: string): string => readFileSync(join(ROOT, name), "utf8");
/** The file's lines without comments and blank lines. */
const lines = (name: string): string[] =>
  read(name)
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "").trimEnd())
    .filter((line) => line.trim() !== "");

/** A Compose duration (`20s`, `1m30s`, `500ms`) in milliseconds. */
function duration(text: string): number {
  const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+)(ms|s|m|h)/g)) total += Number(amount) * (units[unit ?? ""] ?? Number.NaN);
  return total;
}

/** The value of `key:` in compose.yaml (the first one). */
function composeValue(key: string): string {
  const line = lines("compose.yaml").find((l) => l.trimStart().startsWith(`${key}:`));
  if (line === undefined) throw new Error(`compose.yaml has no ${key}`);
  return line.slice(line.indexOf(":") + 1).trim();
}

test("Dockerfile: Bun >= 1.4, a production install from the lockfile, and the entrypoint", () => {
  const dockerfile = lines("Dockerfile");
  const from = dockerfile.find((line) => line.startsWith("FROM "));
  const [, major, minor] = from?.match(/oven\/bun:(\d+)\.(\d+)/) ?? [];
  expect(Number(major) * 100 + Number(minor)).toBeGreaterThanOrEqual(104);

  expect(dockerfile).toContain("RUN bun install --frozen-lockfile --production");
  expect(dockerfile.at(-1)).toBe('CMD ["bun", "src/pikit/deployment-docker/main.ts"]');
  expect(existsSync(join(ROOT, "src", "pikit", "deployment-docker", "main.ts"))).toBe(true);
});

test("Dockerfile: the app runs as a user that is not root, and owns .pikit/", () => {
  const dockerfile = lines("Dockerfile");
  const users = dockerfile.filter((line) => line.startsWith("USER "));
  expect(users.length).toBeGreaterThan(0);
  expect(users.at(-1)).not.toMatch(/^USER (root|0)(:|$)/);
  expect(dockerfile.some((line) => /chown\s+\S+\s+\.pikit/.test(line))).toBe(true);
});

test("Dockerfile: no secret is baked in", () => {
  const dockerfile = lines("Dockerfile");
  expect(dockerfile.filter((line) => /^(ENV|ARG)\s.*(TOKEN|KEY|SECRET|PASSWORD)/i.test(line))).toEqual([]);
  expect(dockerfile.filter((line) => /^(COPY|ADD)\s.*\.env\b/.test(line))).toEqual([]);
});

test(".dockerignore keeps secrets, state and node_modules out of the build", () => {
  const ignored = lines(".dockerignore");
  expect(ignored).toContain(".env");
  expect(ignored).toContain(".pikit");
  expect(ignored).toContain("node_modules");
});

test("compose.yaml: a stop grace period longer than the entrypoint's stop deadline", () => {
  const grace = duration(composeValue("stop_grace_period"));
  expect(grace).toBeGreaterThan(STOP_DEADLINE_MS);
  // Room for the process to exit after its last stop hook gave up.
  expect(grace - STOP_DEADLINE_MS).toBeGreaterThanOrEqual(5_000);
});

test("compose.yaml: a healthcheck on GET /health, patient enough for the start deadline", () => {
  expect(lines("compose.yaml").join("\n")).toMatch(/healthcheck:\n\s+test: \[.*http:\/\/127\.0\.0\.1:3000\/health/);
  expect(duration(composeValue("start_period"))).toBeGreaterThanOrEqual(START_DEADLINE_MS);
});

test("compose.yaml: restarts, secrets from .env at run time, .pikit/ on a volume, the port", () => {
  const compose = lines("compose.yaml");
  expect(composeValue("restart")).toBe("unless-stopped");
  expect(composeValue("init")).toBe("true");
  expect(compose.join("\n")).toMatch(/env_file:\n\s+- \.env$/m);
  expect(compose.some((line) => /^\s+- [\w-]+:\/app\/\.pikit$/.test(line))).toBe(true);
  expect(compose.some((line) => /^\s+- "127\.0\.0\.1:3000:3000"$/.test(line))).toBe(true);
  expect(compose.filter((line) => /(TOKEN|API_KEY|SECRET)\s*[:=]/.test(line))).toEqual([]);
});
