/**
 * A worker that dies mid-run: `bun interrupted-worker.ts <root> <sessionId> <requestId> <safe|never> [jsonl|sql]`.
 *
 * It dispatches `hold` to the conversation over the sessions in `<root>` (Pi's JSONL files, or the
 * SQL store's database there: see `stores.ts`), prints `held` once the tool runs, and waits for the
 * SIGKILL the parent sends. What it leaves is what a crashed process leaves: the request committed,
 * the tool call's intent recorded, the run open.
 */

import { defineApp, silentLogger } from "@pikit/core";
import { modelsFrom } from "../models.ts";
import { createPiRuntime } from "../runtime.ts";
import { holdTool, scriptedAgent, scriptedProvider } from "./script.ts";
import { sessionsAt } from "./stores.ts";

const [root, sessionId, requestId, replay, kind = "jsonl"] = process.argv.slice(2);
if (root === undefined || sessionId === undefined || requestId === undefined || (replay !== "safe" && replay !== "never") || (kind !== "jsonl" && kind !== "sql")) {
  throw new Error("usage: interrupted-worker.ts <root> <sessionId> <requestId> <safe|never> [jsonl|sql]");
}
const sessions = sessionsAt(root, kind);
await sessions.ready;

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
  sessions: sessions.store,
  agent: (name) => (name === agent.name ? agent : undefined),
  models: modelsFrom([scriptedProvider()]),
  events: ctx,
});
const conversation = { key: `test:pi:${sessionId}`, agent: agent.name, sessionId };
await runtime.dispatch({ requestId, conversation, prompt: "hold" }, ctx);
