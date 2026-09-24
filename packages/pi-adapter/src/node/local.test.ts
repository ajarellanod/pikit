/**
 * `createLocalExecution` is Pi's `NodeExecutionEnv` whose commands start from the variables given,
 * not from this process's environment. It passes the `execution` suite with a shell.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { createExecutionConformance } from "../testing/index.ts";
import { createLocalExecution } from "./index.ts";

function temporary() {
  const dir = mkdtempSync(join(tmpdir(), "pikit-local-"));
  return { dir, dispose: async () => rmSync(dir, { recursive: true, force: true }) };
}

for (const c of createExecutionConformance(() => {
  const { dir, dispose } = temporary();
  return { env: createLocalExecution({ cwd: dir, env: { PATH: process.env.PATH ?? "" } }), shell: true, dispose };
})) {
  test(`local ${c.group}: ${c.name}`, () => c.run());
}

test("a command sees the variables given, not this process's environment", async () => {
  const { dir, dispose } = temporary();
  // Stands in for a secret of the server, such as PIKIT_HTTP_TOKEN.
  process.env.PIKIT_LOCAL_TEST_SECRET = "server-secret";
  const env = createLocalExecution({ cwd: dir, env: { PIKIT_GIVEN: "given" } });
  try {
    await env.exec('printf "%s|%s|%s" "${PIKIT_GIVEN:-}" "${PIKIT_LOCAL_TEST_SECRET:-absent}" "${EXTRA:-}" > seen.txt', { env: { EXTRA: "extra" } }, BACKGROUND_CONTEXT);
    await env.exec('printf "%s" "${PIKIT_GIVEN:-absent}" > only.txt', { inheritEnv: false }, BACKGROUND_CONTEXT);
  } finally {
    delete process.env.PIKIT_LOCAL_TEST_SECRET;
  }

  expect(readFileSync(join(dir, "seen.txt"), "utf8")).toBe("given|absent|extra");
  expect(readFileSync(join(dir, "only.txt"), "utf8")).toBe("absent");
  await dispose();
});
