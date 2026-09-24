/**
 * A worker that dies mid-run with a prepared agent: `bun prepared-worker.ts <root> <sessionId>
 * <requestId> <keep|advance>`.
 *
 * It dispatches `hold` to `preparedAgent`'s conversation over the JSONL sessions in `<root>`. Its
 * `hold` tool (replay `safe`) first moves the state to phase `done` when asked to `advance`, then
 * prints `held` and waits for the SIGKILL the parent sends.
 */

import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { AGENT_STATE, defineApp, silentLogger } from "@pikit/core";
import { modelsFrom } from "../models.ts";
import { createPiRuntime } from "../runtime.ts";
import { holdTool, preparedAgent, scriptedProvider } from "./script.ts";

const [root, sessionId, requestId, mode] = process.argv.slice(2);
if (root === undefined || sessionId === undefined || requestId === undefined || (mode !== "keep" && mode !== "advance")) {
  throw new Error("usage: prepared-worker.ts <root> <sessionId> <requestId> <keep|advance>");
}

// Keeps the process alive until it is killed: the tool below never settles.
setInterval(() => {}, 60_000);

const hold = holdTool(async (context) => {
  if (mode === "advance") await context.value(AGENT_STATE)?.update({ phase: "done" }, context);
  process.stdout.write("held\n");
  return new Promise<string>(() => {});
}, "safe");
const agent = preparedAgent(hold);
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
