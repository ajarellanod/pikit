/**
 * Scenario 7, the HTTP half (SPEC §15): an existing Pi extension, unmodified, loaded with
 * `createRuntimePi({ extensions })`, fires during scenario 1. Pi's own `permission-gate` example
 * (byte for byte from Pi v0.87.1, kept in `@pikit/pi-adapter`'s tests) blocks `rm -rf` asked for
 * over HTTP: with no terminal UI to ask, it blocks.
 *
 * In a project, the extension file sits in `src/extensions/` and imports
 * `@earendil-works/pi-coding-agent`, which resolves to `@pikit/pi-extension-shim` (SPEC §6.2b).
 * This fixture imports Pi's copy in the adapter instead of a second copy.
 */

import { afterEach, expect, test } from "bun:test";
import { defineAgent } from "@pikit/core";
import { recordingBash } from "@pikit/pi-adapter/testing";
import permissionGate from "../../../packages/pi-adapter/src/extensions/pi-examples/permission-gate.ts";
import { createSample, type Sample } from "./sample.ts";

const samples: Sample[] = [];
afterEach(async () => {
  for (const sample of samples.splice(0)) await sample.dispose();
});

test("Pi's permission-gate extension blocks rm -rf asked for over HTTP, and lets ls run", async () => {
  // A stand-in for Pi's bash tool: it records what it is asked to run and runs nothing.
  const ran: string[] = [];
  const coder = defineAgent({ name: "coder", model: "faux/scripted", tools: [recordingBash(ran)] });
  const sample = await createSample({ agents: [coder], extensions: [permissionGate] });
  samples.push(sample);
  await sample.app.start();

  const blocked = await sample.post("/v1/messages", { conversationId: "ops", text: "bash: rm -rf /", messageId: "m1" });
  const allowed = await sample.post("/v1/messages", { conversationId: "ops", text: "bash: ls", messageId: "m2" });

  expect(blocked.status).toBe(200);
  expect(blocked.body.text).toContain("Dangerous command blocked (no UI for confirmation)");
  expect(allowed).toEqual({ status: 200, body: { requestId: "m2", text: "tool said: ran" } });
  expect(ran).toEqual(["ls"]);
});
