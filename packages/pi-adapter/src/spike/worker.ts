/**
 * Spike worker process: `bun worker.ts <sessionsRoot> <cwd> <replay>`.
 *
 * Opens a new JSONL session, starts a run whose tool never finishes, and prints one JSON line
 * per milestone. The test kills this process with SIGKILL once the tool has started, then
 * resumes the run in its own process (mirrors mini's worker/run.ts).
 */

import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { BACKGROUND_CONTEXT } from "@pikit/core";
import { SpikeConversation } from "./conversation.ts";
import { scriptedModel, tool } from "./fixtures.ts";

const [sessionsRoot, cwd, replay] = process.argv.slice(2);
if (sessionsRoot === undefined || cwd === undefined || (replay !== "safe" && replay !== "never")) {
  throw new Error("usage: worker.ts <sessionsRoot> <cwd> <safe|never>");
}

const say = (line: object): void => void process.stdout.write(`${JSON.stringify(line)}\n`);
const ctx = BACKGROUND_CONTEXT;
const repo = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd }), sessionsRoot });
const session = await repo.create({ cwd }, ctx);
const hang = tool(
  "slow",
  () => {
    say({ event: "tool_started" });
    return new Promise<string>(() => {});
  },
  replay,
);
const { conversation } = await SpikeConversation.open({ session, ...scriptedModel(), tools: [hang] }, ctx);
say({ event: "session", sessionId: conversation.sessionId });
await conversation.setState({ phase: "working" }, ctx);
const submitted = await conversation.submit("req-killed", "use-tool:slow", ctx);
if (submitted.kind !== "started") throw new Error(`expected a run, got ${submitted.kind}`);
say({ event: "submitted" });
await submitted.settled;
