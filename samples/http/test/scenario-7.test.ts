/**
 * Scenario 7, the HTTP half (SPEC §15): an existing Pi extension, unmodified, loaded with
 * `createRuntimePi({ extensions })`, fires during scenario 1. Pi's own `permission-gate` example
 * (byte for byte from Pi v0.87.1, kept in `@pikit/pi-adapter`'s tests) stops Pi's real `bash` tool
 * (`tool-bash` on `execution-local`) from running `rm -rf` asked for over HTTP: with no terminal UI
 * to ask, it blocks. Other commands run, in the workspace.
 *
 * In a project, the extension file sits in `src/extensions/` and imports
 * `@earendil-works/pi-coding-agent`, which resolves to `@pikit/pi-extension-shim` (SPEC §6.2b).
 * This fixture imports Pi's copy in the adapter instead of a second copy.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineAgent } from "@pikit/core";
import permissionGate from "../../../packages/pi-adapter/src/extensions/pi-examples/permission-gate.ts";
import { createSample, type Sample } from "./sample.ts";

const samples: Sample[] = [];
afterEach(async () => {
  for (const sample of samples.splice(0)) await sample.dispose();
});

test("Pi's permission-gate blocks rm -rf asked for over HTTP; the real bash runs other commands", async () => {
  const coder = defineAgent({ name: "coder", model: "faux/scripted", tools: ["bash"] });
  const sample = await createSample({ agents: [coder], extensions: [permissionGate] });
  samples.push(sample);
  await sample.app.start();
  const workspace = join(sample.dataDir, "workspace");
  mkdirSync(join(workspace, "keep"), { recursive: true });

  const blocked = await sample.post("/v1/messages", { conversationId: "ops", text: "bash: rm -rf keep", messageId: "m1" });
  const allowed = await sample.post("/v1/messages", { conversationId: "ops", text: "bash: echo ran > proof.txt && echo done", messageId: "m2" });

  expect(blocked.status).toBe(200);
  expect(blocked.body.text).toContain("Dangerous command blocked (no UI for confirmation)");
  expect(existsSync(join(workspace, "keep"))).toBe(true);
  expect(allowed).toEqual({ status: 200, body: { requestId: "m2", text: "tool said: done\n" } });
  expect(readFileSync(join(workspace, "proof.txt"), "utf8")).toBe("ran\n");
});

test("an agent that does not name bash cannot run commands, whatever it is asked", async () => {
  const reader = defineAgent({ name: "reader", model: "faux/scripted", tools: ["read"] });
  const sample = await createSample({ agents: [reader] });
  samples.push(sample);
  await sample.app.start();

  const asked = await sample.post("/v1/messages", { conversationId: "c1", text: "bash: echo ran > proof.txt", messageId: "m1" });

  // The model asked for bash anyway; Pi answered that the agent has no such tool.
  expect(asked).toEqual({ status: 200, body: { requestId: "m1", text: 'tool said: Tool "bash" is unavailable' } });
  expect(existsSync(join(sample.dataDir, "workspace", "proof.txt"))).toBe(false);
});
