/**
 * A web conversation's titles (`titles.ts`) on a server, over the runtime's doubles: its first message
 * names it, a model titles it after its first answer (in the background, once, one more try after a
 * later run if that failed), the user's rename always wins, the page hears the change, and every title
 * is given to the App's `/name` (here a double recording them), the first one while its message is
 * dispatched, before any run settles.
 */

import { afterEach, expect, test } from "bun:test";
import { type ComponentDefinition, defineComponent } from "@pikit/core";
import type { AgentCommand, ConversationRef, ModelComplete, CompletionRequest } from "@pikit/contracts";
import { sqliteStorage } from "@pikit/pi-adapter/testing";
import type { ChatConversation } from "./api.ts";
import { createChannelWeb, NAME } from "./index.ts";
import { eventually, FakeAccounts, kvOf, Runtime, router, type Served, secretsOf, serve, sse } from "./runtime.test-support.ts";
import { TITLE_SYSTEM, TITLE_TOKENS } from "./titles.ts";

const API = "/chat/api";
const apps: Served[] = [];
afterEach(async () => {
  for (const served of apps.splice(0)) await served.app.stop();
});

/** `model.complete`, answering with `answer`, recording what it was asked. */
function fakeModel(answer: (request: CompletionRequest) => string | Promise<string>) {
  const asked: CompletionRequest[] = [];
  const complete: ModelComplete = {
    complete: async (request) => {
      asked.push(request);
      return answer(request);
    },
  };
  return { asked, component: defineComponent({ name: "model-test", setup: (pikit) => pikit.provide("model.complete", complete) }) };
}

/** The App's `/name` (admin-api's, in an App with the dashboard): what it was given, in order. */
function nameCommand() {
  const named: { conversation: ConversationRef; title: string }[] = [];
  const command: AgentCommand = {
    description: "Set the conversation's title",
    run: async (conversation, args) => void named.push({ conversation, title: args }),
  };
  return { named, component: defineComponent({ name: "name-test", setup: (pikit) => pikit.provideKeyed("agent.command", "name", command) }) };
}

async function chat(components: ComponentDefinition[], config: Record<string, unknown> = {}) {
  const runtime = new Runtime();
  const accounts = new FakeAccounts();
  accounts.add("ana");
  const served = await serve(
    [secretsOf(), runtime.component(), kvOf(), sqliteStorage(), router, ...components, createChannelWeb({ accounts: accounts.wiring() })],
    { [NAME]: config },
  );
  apps.push(served);
  return { served, runtime };
}
type Chat = Awaited<ReturnType<typeof chat>>;

const as = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...FakeAccounts.session("ana"), "x-pikit-chat": "1", "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
});
const post = (body: unknown, method = "POST") => as({ method, body: JSON.stringify(body) });

async function start(c: Chat, text: string): Promise<{ id: string; requestId: string; key: string }> {
  const response = await c.served.fetch(`${API}/conversations`, post({ text }));
  expect(response.status).toBe(201);
  const started = (await response.json()) as { id: string; requestId: string };
  return { ...started, key: `web:ana:${started.id}` };
}
const titleOf = async (c: Chat, id: string) => ((await (await c.served.fetch(`${API}/conversations/${id}`, as())).json()) as ChatConversation).title;
const listed = async (c: Chat) => ((await (await c.served.fetch(`${API}/conversations`, as())).json()) as { items: ChatConversation[] }).items.map((each) => each.title);
const send = async (c: Chat, id: string, text: string, requestId: string) => {
  const response = await c.served.fetch(`${API}/conversations/${id}/messages`, post({ text, requestId }));
  expect(response.status).toBe(202);
};

test("TITLES: the first message names it, given to /name while it is dispatched; after the first answer a model titles it, in the background, once; the page hears it; /name gets it", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const model = fakeModel(async () => (await held, 'Title: "lisbon trip."'));
  const names = nameCommand();
  const c = await chat([model.component, names.component], { titleModel: "test/titles" });

  const started = await start(c, "plan a trip to Lisbon");
  // Named in the App's /name before the admission returned: before any run of it could settle.
  expect(names.named).toEqual([{ conversation: c.runtime.pointers.get(started.key) as ConversationRef, title: "Plan a trip to Lisbon" }]);
  expect(await titleOf(c, started.id)).toBe("Plan a trip to Lisbon");

  // A run that failed titles nothing.
  await c.runtime.start(started.key, [started.requestId]);
  await c.runtime.end(started.key, [started.requestId], { kind: "failed" });
  await Bun.sleep(20);
  expect(model.asked).toEqual([]);

  const client = new AbortController();
  const events = sse(await c.served.fetch(`${API}/conversations/${started.id}/events`, as({ signal: client.signal })));
  expect(await events.take(1)).toMatchObject([{ type: "snapshot" }]);
  await send(c, started.id, "and Porto?", "web:m2");
  await c.runtime.start(started.key, ["web:m2"]);
  await c.runtime.end(started.key, ["web:m2"], { text: "Sure." });
  // The run's end does not wait for the model.
  await eventually(() => (model.asked.length === 1 ? true : undefined), "the model to be asked");
  expect(model.asked).toEqual([{ model: "test/titles", system: TITLE_SYSTEM, prompt: "plan a trip to Lisbon", maxTokens: TITLE_TOKENS }]);
  expect(await titleOf(c, started.id)).toBe("Plan a trip to Lisbon");
  release();
  await eventually(async () => ((await titleOf(c, started.id)) === "Lisbon trip" ? true : undefined), "the model's title");
  expect(await listed(c)).toEqual(["Lisbon trip"]);
  // The page hears it as a change (and reads the conversation and the list again): a change with no
  // entry, the run's stored messages' first, then the title's.
  const changes: { type: string; entry?: unknown }[] = [];
  while (changes.length < 2) {
    const [event] = (await events.take(1)) as { type: string; entry?: unknown }[];
    if (event?.type === "entry_appended" && event.entry === undefined) changes.push(event);
  }
  client.abort();
  await events.reader.cancel();
  expect(names.named.map((each) => each.title)).toEqual(["Plan a trip to Lisbon", "Lisbon trip"]);
  expect(c.served.logged.find((each) => each.message.includes("a model titled"))?.fields).toEqual({ conversation: started.key, model: "test/titles" });
  // Logged without the title or the message.
  expect(JSON.stringify(c.served.logged)).not.toContain("Lisbon");

  // Later runs leave it as it is.
  await send(c, started.id, "thanks", "web:m3");
  await c.runtime.start(started.key, ["web:m3"]);
  await c.runtime.end(started.key, ["web:m3"]);
  await Bun.sleep(20);
  expect(model.asked.length).toBe(1);

  // The user's rename: theirs in both apps.
  const renamed = await c.served.fetch(`${API}/conversations/${started.id}`, post({ title: "my trip" }, "PATCH"));
  expect(await renamed.json()).toMatchObject({ title: "my trip" });
  expect(names.named.at(-1)?.title).toBe("my trip");
});

test("TITLES: a failure is tried once more after a later run, then never; a rename while the model writes wins, and no model titles a renamed conversation; the agent's model by default", async () => {
  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const model = fakeModel(async () => {
    calls++;
    if (calls === 1) throw new Error("the provider is down");
    await held;
    return "Never written";
  });
  const names = nameCommand();
  const agents = defineComponent({ name: "agents-test", setup: (pikit) => pikit.provideKeyed("agent.definition", "assistant", { name: "assistant", model: "test/agent" }) });
  const c = await chat([model.component, names.component, agents]);

  const one = await start(c, "first conversation");
  await c.runtime.start(one.key, [one.requestId]);
  await c.runtime.end(one.key, [one.requestId]);
  await eventually(() => (c.served.logged.some((each) => each.message.includes("did not title")) ? true : undefined), "the failure to be logged");
  expect(model.asked.map((each) => each.model)).toEqual(["test/agent"]);
  expect(await titleOf(c, one.id)).toBe("First conversation");

  // The second try: the model is slow, and the user renames it meanwhile.
  await send(c, one.id, "again", "web:m2");
  await c.runtime.start(one.key, ["web:m2"]);
  await c.runtime.end(one.key, ["web:m2"]);
  await eventually(() => (model.asked.length === 2 ? true : undefined), "the second try");
  expect((await c.served.fetch(`${API}/conversations/${one.id}`, post({ title: "Mine" }, "PATCH"))).status).toBe(200);
  release();
  await Bun.sleep(30);
  expect(await titleOf(c, one.id)).toBe("Mine");
  expect(names.named.map((each) => each.title)).toEqual(["First conversation", "Mine"]);

  // Renamed before its first answer: no model is asked.
  const two = await start(c, "second conversation");
  expect((await c.served.fetch(`${API}/conversations/${two.id}`, post({ title: "Named first" }, "PATCH"))).status).toBe(200);
  await c.runtime.start(two.key, [two.requestId]);
  await c.runtime.end(two.key, [two.requestId]);
  await Bun.sleep(30);
  expect(model.asked.length).toBe(2);
  expect(await titleOf(c, two.id)).toBe("Named first");
});

test("TITLES: a run that ends before its admission returns (a quick model) finds its conversation named already: /name comes first, so the dashboard asks no model of its own", async () => {
  const order: string[] = [];
  const settled = defineComponent({ name: "order-test", setup: (pikit) => pikit.on("agent.settled", () => void order.push("settled")) });
  const named = defineComponent({
    name: "name-order-test",
    setup: (pikit) =>
      pikit.provideKeyed("agent.command", "name", { description: "Set the conversation's title", run: async (_conversation, args) => void order.push(`name: ${args}`) }),
  });
  const model = fakeModel(() => "Quick title");
  const c = await chat([model.component, settled, named], { titleModel: "test/titles" });
  c.runtime.runsAtOnce = true;
  const started = await start(c, "quick one");
  await eventually(async () => ((await titleOf(c, started.id)) === "Quick title" ? true : undefined), "the model's title");
  expect(order).toEqual(["name: Quick one", "settled", "name: Quick title"]);
});

test("TITLES: without model.complete no model titles it, and without /name nothing else is told; a run only the operator's follow-ups started titles nothing", async () => {
  const c = await chat([]);
  const one = await start(c, "hello there");
  await c.runtime.start(one.key, [one.requestId]);
  await c.runtime.end(one.key, [one.requestId]);
  await Bun.sleep(20);
  expect(await titleOf(c, one.id)).toBe("Hello there");
  expect(c.served.logged.filter((each) => each.message.includes("title"))).toEqual([]);

  const model = fakeModel(() => "A title");
  const d = await chat([model.component], { titleModel: "test/titles" });
  const two = await start(d, "hi");
  // The operator's follow-up (dashboard:) alone: not an answer to the user.
  await d.runtime.start(two.key, ["dashboard:op1"]);
  await d.runtime.end(two.key, ["dashboard:op1"]);
  await Bun.sleep(20);
  expect(model.asked).toEqual([]);
  expect(await titleOf(d, two.id)).toBe("Hi");
});
