/**
 * A worker that dies mid-run: `bun interrupted-worker.ts <root> <sessionId> <requestId> <safe|never>`.
 *
 * It dispatches `hold` to the conversation over the JSONL sessions in `<root>`, prints `held` once
 * the tool runs, and waits for the SIGKILL the parent sends. What it leaves is what a crashed
 * process leaves: the request committed, the tool call's intent recorded, the run open.
 */

import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { defineApp, silentLogger } from "@pikit/core";
import { modelsFrom } from "../models.ts";
import { createPiRuntime } from "../runtime.ts";
import { holdTool, scriptedAgent, scriptedProvider } from "./script.ts";

const [root, sessionId, requestId, replay] = process.argv.slice(2);
if (root === undefined || sessionId === undefined || requestId === undefined || (replay !== "safe" && replay !== "never")) {
  throw new Error("usage: interrupted-worker.ts <root> <sessionId> <requestId> <safe|never>");
}

// Keeps the process alive until it is killed: the tool below never settles.
setInterval(() => {}, 60_000);

const hold = holdTool(() => {
  process.stdout.write("held\n");
  return new Promise<string>(() => {});
}, replay);
const agent = scriptedAgent(hold);
const app = await defineApp({ components: [], logger: silentLogger }).create();
const ctx = app.context();
const runtime = createPiRuntime({
  sessions: new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root }),
  agent: (name) => (name === agent.name ? agent : undefined),
  models: modelsFrom([scriptedProvider()]),
  events: ctx,
});
const conversation = { key: `test:pi:${sessionId}`, agent: agent.name, sessionId };
await runtime.dispatch({ requestId, conversation, prompt: "hold" }, ctx);
