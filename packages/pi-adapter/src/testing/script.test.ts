/**
 * The scripted provider's extra rules, used by component and sample tests: `bash: <command>` calls
 * the `bash` tool, and `apiKey` makes the provider need a stored credential.
 */

import { expect, test } from "bun:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { type AppEvents, defineAgent, defineApp, defineComponent, silentLogger } from "@pikit/core";
import { modelsFrom } from "../models.ts";
import { createPiRuntime } from "../runtime.ts";
import { recordingBash, scriptedProvider } from "./script.ts";

test("bash: <command> calls the bash tool, and the next turn says what it returned", async () => {
  let settled!: (result: AppEvents["agent.settled"]) => void;
  const result = new Promise<AppEvents["agent.settled"]>((resolve) => (settled = resolve));
  const observer = defineComponent({ name: "observer", setup: (pikit) => pikit.on("agent.settled", (payload) => settled(payload)) });
  const app = await defineApp({ components: [observer], logger: silentLogger }).create();
  const ran: string[] = [];
  const agent = defineAgent({ name: "coder", model: "faux/scripted", tools: [recordingBash(ran)] });
  const sessions = new MemorySessionRepo();
  const runtime = createPiRuntime({ sessions, agent: () => agent, models: modelsFrom([scriptedProvider()]), events: app.context() });
  const session = await sessions.create({}, app.context());
  await session.close(app.context());

  await runtime.dispatch(
    { requestId: "r1", conversation: { key: "test", agent: "coder", sessionId: session.metadata.id }, prompt: "bash: ls -la" },
    app.context(),
  );

  expect((await result).text).toBe("tool said: ran");
  expect(ran).toEqual(["ls -la"]);
  await runtime.close(app.context());
});

test("with apiKey, the provider is configured only by that key stored in model.credentials", async () => {
  const credentials = new InMemoryCredentialStore();
  const models = modelsFrom([scriptedProvider({ apiKey: "made-up-key" })], { credentials });

  const before = await models.checkAuth("faux");
  await credentials.modify("faux", async () => ({ type: "api_key", key: "made-up-key" }));
  const after = await models.checkAuth("faux");

  expect(before).toBeUndefined();
  expect(after).toBeDefined();
  expect(models.getModel("faux", "scripted")).toBeDefined();
});
