/**
 * The `execution` suite run against Pi's own `NodeExecutionEnv` (S12: Pi's implementation is the
 * double), with a shell and without one (its `exec` answering `shell_unavailable`, as an
 * environment with no shell must).
 */

import { test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, type ExecutionEnv, ExecutionError } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createExecutionConformance } from "./execution.ts";

function temporary() {
  const dir = mkdtempSync(join(tmpdir(), "pikit-execution-"));
  return { dir, dispose: async () => rmSync(dir, { recursive: true, force: true }) };
}

for (const c of createExecutionConformance(() => {
  const { dir, dispose } = temporary();
  return { env: new NodeExecutionEnv({ cwd: dir }), shell: true, dispose };
})) {
  test(`NodeExecutionEnv ${c.group}: ${c.name}`, () => c.run());
}

/** Pi's filesystem with no shell: what an edge environment provides as `execution` only. */
class NoShell extends NodeExecutionEnv {
  override async exec(): ReturnType<ExecutionEnv["exec"]> {
    return err(new ExecutionError("shell_unavailable", "this environment has no shell"));
  }
}

for (const c of createExecutionConformance(() => {
  const { dir, dispose } = temporary();
  return { env: new NoShell({ cwd: dir }), shell: false, dispose };
})) {
  test(`without a shell ${c.group}: ${c.name}`, () => c.run());
}
