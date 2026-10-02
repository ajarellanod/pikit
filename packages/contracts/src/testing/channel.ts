/**
 * Channel conformance: what every channel does with a message, whatever the
 * platform. Runner-independent, like the other suites:
 *
 *   for (const c of createChannelConformance((setup) => myChannelFixture(setup)))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite provides the rest of the path, as durable as a real one: `agent.runtime` and
 * `conversations.registry` (fakes that record what reaches them, and answer every run with
 * `CONFORMANCE_ANSWER` and its number), `agent.submissions` (the record of every run's end, with its
 * `answers` feed, which the fake runtime writes before it announces the end, as runtime-pi does),
 * `storage.kv` and `wakeups` (in memory, surviving the restarts of a case), a router to
 * `conformance-agent`, and stages that halt, deny or move a message when its text says so. The
 * fixture provides the channel and whatever it uses besides (secrets, a server, a mailbox), and
 * speaks the platform: it delivers a message as a user would send it, and reads what that user was
 * told. A channel whose answers are pushed to its platform also lets the suite fail or cut its sends
 * (`platform`).
 *
 * The rules under test:
 * - a message reaches the agent only through the whole path, and a sender whose message does not
 *   reach it is told, never left without an answer;
 * - durability comes with the contracts: an answer that ends while the channel is stopped, or whose
 *   event is lost, reaches its sender once the channel runs again, once; a send the platform failed
 *   is tried again, and its conversation's later answers wait for it; a send cut after it left goes
 *   again at most once, marked as a possible duplicate or under the same key; and one conversation's
 *   failures hold up no other. A restart is the App stopped and a new one started over the same
 *   storage, as after a deploy or a crash: nothing a channel does at stop may be needed for these
 *   (K6).
 *
 * A channel may run the path with `admitInbound` and `startAnswerDelivery` or on its own; the suite
 * checks what the sender, the platform and the agent see. These cases are what a channel a user
 * writes must pass.
 */

import type { AgentRequest, AgentResult, AgentRuntime, ConversationRef } from "../agent.ts";
import { type App, type AppContext, BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, halt, type Logger, silentLogger } from "@pikit/core";
import type { ConversationRegistry } from "../conversations.ts";
import type { AgentSubmissions, PendingConversation, RunSettlement, SubmissionStatus } from "../submissions.ts";
import { checker } from "./assert.ts";
import { createMemoryFeed, type MemoryFeed } from "./feed.ts";
import { createMemoryKeyValueStorage } from "./storage-kv.ts";
import { createMemoryWakeups } from "./wakeups.ts";
import type { ConformanceCase } from "@pikit/core/testing";

/** One message as its sender writes it. `conversation` is one of `ChannelSetup.conversations`. */
export interface ChannelMessage {
  /** Its identity on the platform: the same `id` delivered again is a redelivery of one message. */
  id: string;
  conversation: string;
  text: string;
}

/** What the fixture is built for: the conversations the suite will write in (allow their senders). */
export interface ChannelSetup {
  conversations: readonly string[];
}

/** A channel under test, built for one case. */
export interface ChannelFixture {
  /** The channel's component and what it uses besides `agent.runtime` and `conversations.registry`. */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  /**
   * Deliver `message` as the platform does, once the app started. A second call with the same `id`
   * is the platform delivering that message again. May resolve before the channel handled it.
   */
  deliver(message: ChannelMessage): Promise<void>;
  /** Everything the sender of `conversation` was told so far, in order (reply texts, HTTP bodies). */
  told(conversation: string): string[] | Promise<string[]>;
  /**
   * The platform's side of the channel's sends. Required when the channel pushes its answers (the
   * default `answers: "pushed"`); a channel that answers in its response has none.
   */
  platform?: ChannelPlatform;
  /** Release what the fixture holds. */
  dispose?(): Promise<void>;
}

/** What the suite does to the platform a channel sends to, and what it reads back. */
export interface ChannelPlatform {
  /** The next `count` sends to `conversation` fail as the platform failing for a while (a 5xx). */
  fail(conversation: string, count: number): void;
  /**
   * The next send to `conversation` reaches its user, and the platform never answers it: the channel
   * cannot know it arrived. It ends when the channel gives it up or stops.
   */
  hang(conversation: string): void;
  /** Every piece the platform took for `conversation`, in order, the one left hanging included. */
  received(conversation: string): ReceivedPiece[] | Promise<ReceivedPiece[]>;
}

/** One piece a platform took. */
export interface ReceivedPiece {
  text: string;
  /** The channel marked it as possibly sent before (a platform without keys shows the mark). */
  possibleDuplicate: boolean;
  /** The idempotency key the platform got with it, for a platform that takes one. */
  key?: string;
}

export interface ChannelConformanceOptions {
  /**
   * How the channel's answers reach their sender: `pushed` to its platform (a chat channel: the
   * default; the fixture has a `platform`), or `in-response` to the sender's request (HTTP: a
   * sender reads an answer by asking again, which a case does after a restart by delivering the same
   * message again). The cases that need a platform run only for `pushed`.
   */
  answers?: "pushed" | "in-response";
  /** How long to wait for what a delivery leads to. Default 5000 ms. */
  timeoutMs?: number;
  /** How long nothing must happen, when a case checks that nothing does. Default 300 ms. */
  quietMs?: number;
}

/** What every run's answer starts with (then its number, `(1)`): a sender who was told it got the agent's answer. */
export const CONFORMANCE_ANSWER = "conformance: the agent's answer";
/** The agent the suite's router sends every message to. */
export const CONFORMANCE_AGENT = "conformance-agent";

/** Words in a message's text that make the suite's stages act on it. */
const HALT_NORMALIZE = "[halt at normalize]";
const HALT_ROUTE = "[halt at route]";
const DENY = "[deny]";
const MOVE = "[move to another conversation]";

const GROUP = "channel";
const check = checker(GROUP);
const CONVERSATIONS = ["alpha", "beta"] as const;

export function createChannelConformance(
  factory: (setup: ChannelSetup) => ChannelFixture | Promise<ChannelFixture>,
  options: ChannelConformanceOptions = {},
): readonly ConformanceCase[] {
  const timeoutMs = options.timeoutMs ?? 5000;
  const quietMs = options.quietMs ?? 300;
  const pushed = (options.answers ?? "pushed") === "pushed";
  const channelCase = (name: string, run: (s: Subject) => Promise<void>, withRouter = true): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const fixture = await factory({ conversations: CONVERSATIONS });
      const subject = await createSubject(fixture, withRouter, timeoutMs, quietMs);
      try {
        await run(subject);
      } finally {
        await subject.stop();
        await fixture.dispose?.();
      }
    },
  });

  /** The sender was told something that is not the agent's answer, and nothing ran. */
  const refused = async (s: Subject, text: string) => {
    await s.fixture.deliver({ id: "m1", conversation: "alpha", text });
    const told = await s.eventually(async () => {
      const lines = await s.fixture.told("alpha");
      return lines.length > 0 ? lines : undefined;
    }, "the sender to be told why the message did not reach the agent");
    check(!told.some((line) => line.includes(CONFORMANCE_ANSWER)), `no agent's answer, told ${JSON.stringify(told)}`);
    check(s.dispatched.length === 0, `nothing dispatched, got ${JSON.stringify(s.dispatched)}`);
  };

  /** The answers `conversation`'s sender was told, in order. */
  const answersTo = async (s: Subject, conversation: string): Promise<string[]> => (await s.fixture.told(conversation)).filter((line) => line.includes(CONFORMANCE_ANSWER));
  /** Waits until `conversation`'s sender was told `count` answers; then, after the quiet period, that it was told no more. */
  const toldExactly = async (s: Subject, conversation: string, count: number, what: string): Promise<string[]> => {
    await s.eventually(async () => ((await answersTo(s, conversation)).length >= count ? true : undefined), what);
    await s.quiet();
    const told = await answersTo(s, conversation);
    check(told.length === count, `${count} answer(s) to ${conversation}, told ${JSON.stringify(told)}`);
    return told;
  };
  /** After a restart: a sender of a channel that answers in its response asks again (the same message); a pushed answer comes by itself. */
  const readAgain = async (s: Subject, message: ChannelMessage) => {
    if (!pushed) await s.fixture.deliver(message);
  };
  const platformOf = (s: Subject): ChannelPlatform => {
    if (s.fixture.platform === undefined) throw new Error(`${GROUP}: the fixture has no platform, but the options say the channel pushes its answers`);
    return s.fixture.platform;
  };

  const cases: ConformanceCase[] = [
    channelCase("a message reaches the routed agent in its conversation, and its sender gets the answer", async (s) => {
      await s.fixture.deliver({ id: "m1", conversation: "alpha", text: "hello" });
      const [request] = await s.eventually(() => (s.dispatched.length > 0 ? s.dispatched : undefined), "the message to be dispatched");
      check(request?.conversation.agent === CONFORMANCE_AGENT, `the routed agent "${CONFORMANCE_AGENT}", got ${JSON.stringify(request?.conversation)}`);
      check(request?.prompt.includes("hello") === true, `the message's text in the prompt, got ${JSON.stringify(request?.prompt)}`);
      await s.eventually(async () => ((await s.fixture.told("alpha")).some((l) => l.includes(CONFORMANCE_ANSWER)) ? true : undefined), "the answer to reach the sender");
    }),

    channelCase("each conversation of the platform is its own conversation", async (s) => {
      await s.fixture.deliver({ id: "m1", conversation: "alpha", text: "one" });
      await s.fixture.deliver({ id: "m2", conversation: "beta", text: "two" });
      const both = await s.eventually(() => (s.dispatched.length >= 2 ? s.dispatched : undefined), "both messages to be dispatched");
      check(both[0]?.conversation.key !== both[1]?.conversation.key, `two conversation keys, got ${JSON.stringify(both.map((r) => r.conversation.key))}`);
    }),

    channelCase("a message delivered twice runs once", async (s) => {
      await s.fixture.deliver({ id: "m1", conversation: "alpha", text: "once" });
      await s.eventually(() => (s.dispatched.length > 0 ? true : undefined), "the message to be dispatched");
      await s.fixture.deliver({ id: "m1", conversation: "alpha", text: "once" });
      await s.quiet();
      const ids = new Set(s.dispatched.map((r) => r.requestId));
      check(ids.size === 1, `one request for one message delivered twice, got ${JSON.stringify([...ids])}`);
      check(s.started === 1, `one run, got ${s.started}`);
    }),

    channelCase("a message a stage of inbound.normalize halts is not dispatched, and its sender is told", (s) => refused(s, `card 4111 ${HALT_NORMALIZE}`)),
    channelCase("a message a stage of route.resolve halts is not dispatched, and its sender is told", (s) => refused(s, `after hours ${HALT_ROUTE}`)),
    channelCase("a message the router denies is not dispatched, and its sender is told", (s) => refused(s, `not allowed ${DENY}`)),

    channelCase(
      "with no router, a message is not dispatched, its sender is told, and the misconfiguration is logged",
      async (s) => {
        await refused(s, "hello");
        check(s.errors.length > 0, "an error logged for the missing router");
      },
      false,
    ),

    channelCase("a stage that moves a message to another conversation does not get it dispatched", async (s) => {
      await s.fixture.deliver({ id: "m1", conversation: "alpha", text: `hijack ${MOVE}` });
      await s.quiet();
      check(s.dispatched.length === 0, `nothing dispatched, got ${JSON.stringify(s.dispatched)}`);
    }),

    // ---- Durability: what comes with the contracts, whatever happens to the process.

    channelCase("an answer that ends while the channel is stopped reaches its sender once the channel runs again, once", async (s) => {
      s.holdRuns();
      const message = { id: "m1", conversation: "alpha", text: "hello" };
      await s.fixture.deliver(message);
      await s.eventually(() => (s.held > 0 ? true : undefined), "the run to start");
      // A deploy: the channel stops, the run ends meanwhile, and the channel starts again.
      await s.restart(() => s.settleHeld());
      await readAgain(s, message);
      await toldExactly(s, "alpha", 1, "the answer that ended while the channel was stopped");
    }),

    channelCase("a run's end whose event was lost (the process stopped between the commit and the event) reaches its sender once after a restart", async (s) => {
      s.loseEvents();
      const message = { id: "m1", conversation: "alpha", text: "hello" };
      await s.fixture.deliver(message);
      await s.eventually(() => (s.settled > 0 ? true : undefined), "the run to end, unannounced");
      await s.restart();
      await readAgain(s, message);
      await toldExactly(s, "alpha", 1, "the answer whose event was lost");
    }),
  ];

  if (pushed) {
    cases.push(
      channelCase("a send the platform fails is tried again, and the conversation's later answers wait for it", async (s) => {
        platformOf(s).fail("alpha", 1);
        await s.fixture.deliver({ id: "m1", conversation: "alpha", text: "first" });
        await s.eventually(() => (s.settled > 0 ? true : undefined), "the first answer to end");
        await s.fixture.deliver({ id: "m2", conversation: "alpha", text: "second" });
        const told = await toldExactly(s, "alpha", 2, "both answers, the failed one tried again");
        check(told[0]?.includes(`${CONFORMANCE_ANSWER} (1)`) === true && told[1]?.includes(`${CONFORMANCE_ANSWER} (2)`) === true, `the answers in order, told ${JSON.stringify(told)}`);
      }),

      channelCase("a send cut after it left goes again at most once, as a possible duplicate or under the same key", async (s) => {
        const platform = platformOf(s);
        platform.hang("alpha");
        await s.fixture.deliver({ id: "m1", conversation: "alpha", text: "hello" });
        await s.eventually(async () => ((await platform.received("alpha")).length > 0 ? true : undefined), "the send to reach the platform");
        // The process goes while the send hangs: it never learns whether the platform took it.
        await s.restart();
        await s.quiet();
        await s.quiet();
        const received = (await platform.received("alpha")).filter((piece) => piece.text.includes(CONFORMANCE_ANSWER));
        check(received.length >= 1 && received.length <= 2, `the answer once, or twice, got ${JSON.stringify(received)}`);
        const [first, again] = received;
        if (again !== undefined) {
          const sameKey = first?.key !== undefined && first.key === again.key;
          check(again.possibleDuplicate || sameKey, `the second send marked as a possible duplicate or under the first one's key, got ${JSON.stringify(received)}`);
        }
      }),

      channelCase("a conversation whose sends keep failing holds up no other conversation", async (s) => {
        platformOf(s).fail("alpha", 1_000);
        await s.fixture.deliver({ id: "m1", conversation: "alpha", text: "stuck" });
        await s.eventually(() => (s.settled > 0 ? true : undefined), "the first answer to end");
        await s.fixture.deliver({ id: "m2", conversation: "beta", text: "free" });
        await s.eventually(async () => ((await answersTo(s, "beta")).length > 0 ? true : undefined), "the other conversation's answer");
        check((await answersTo(s, "alpha")).length === 0, "no answer in the failing conversation");
      }),
    );
  }
  return cases;
}

interface Subject {
  fixture: ChannelFixture;
  /** Every dispatch, duplicates included, in order, across restarts. */
  dispatched: AgentRequest[];
  /** Runs started (dispatches that were not duplicates). */
  readonly started: number;
  /** Runs ended (recorded in `agent.submissions`). */
  readonly settled: number;
  /** Runs started and held (`holdRuns`), not ended yet. */
  readonly held: number;
  /** Errors the apps logged. */
  errors: string[];
  /** From now on a run does not end until `settleHeld`. */
  holdRuns(): void;
  /** Ends the held runs: recorded in `agent.submissions`, and announced if an App runs. */
  settleHeld(): Promise<void>;
  /** From now on a run's end is recorded, and its events are lost. */
  loseEvents(): void;
  /** Stops the App, runs `between`, and starts a new one over the same storage. */
  restart(between?: () => Promise<void>): Promise<void>;
  /** Resolves with `probe()`'s first defined value; throws after the timeout. */
  eventually<T>(probe: () => T | undefined | Promise<T | undefined>, what: string): Promise<T>;
  /** Waits the quiet period: what a case checks after it did not happen. */
  quiet(): Promise<void>;
  stop(): Promise<void>;
}

/** What the suite's fakes keep across the restarts of a case: the runtime's records and the storage. */
interface Durable {
  dispatched: AgentRequest[];
  started: number;
  /** Runs held, waiting for `settleHeld`. */
  held: AgentResult[];
  hold: boolean;
  loseEvents: boolean;
  /** The running App's context for events, or `undefined` between Apps. */
  events: AppContext | undefined;
  /** The record of submissions: each request's status, and the feed of run ends. */
  statuses: Map<string, SubmissionStatus>;
  answers: MemoryFeed<RunSettlement>;
  conversations: Map<string, ConversationRef>;
}

async function createSubject(fixture: ChannelFixture, withRouter: boolean, timeoutMs: number, quietMs: number): Promise<Subject> {
  const errors: string[] = [];
  const logger: Logger = { ...silentLogger, error: (line) => void errors.push(line) };
  const durable: Durable = {
    dispatched: [],
    started: 0,
    held: [],
    hold: false,
    loseEvents: false,
    events: undefined,
    statuses: new Map(),
    answers: createMemoryFeed<RunSettlement>(),
    conversations: new Map(),
  };
  const kv = createMemoryKeyValueStorage();
  const definition = defineApp({
    components: [
      ...fixture.components,
      fakeConversations(durable),
      fakeRuntime(durable),
      fakeSubmissions(durable),
      defineComponent({ name: "conformance-storage-kv", setup: (pikit) => pikit.provide("storage.kv", kv) }),
      createMemoryWakeups({ durable: true, retryMs: 50 }),
      stages(),
      ...(withRouter ? [router()] : []),
    ],
    ...(fixture.config !== undefined && { config: fixture.config }),
    logger,
  });
  let app: App = await definition.create();
  await app.start();

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  return {
    fixture,
    dispatched: durable.dispatched,
    get started() {
      return durable.started;
    },
    get settled() {
      return [...durable.statuses.values()].filter((status) => status.kind === "settled").length;
    },
    get held() {
      return durable.held.length;
    },
    errors,
    holdRuns() {
      durable.hold = true;
    },
    async settleHeld() {
      durable.hold = false;
      for (const result of durable.held.splice(0)) await settle(durable, result);
    },
    loseEvents() {
      durable.loseEvents = true;
    },
    async restart(between) {
      await app.stop();
      await between?.();
      app = await definition.create();
      await app.start();
    },
    async eventually(probe, what) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = await probe();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error(`${GROUP}: timed out after ${timeoutMs} ms waiting for ${what}`);
        await sleep(20);
      }
    },
    quiet: () => sleep(quietMs),
    stop: () => app.stop(),
  };
}

/** Records the end of a run in `agent.submissions`, then announces it (unless events are lost), as runtime-pi does. */
async function settle(durable: Durable, result: AgentResult): Promise<void> {
  const key = `${result.conversation.conversationId}\u0000${result.requestId}`;
  if (durable.statuses.get(key)?.kind === "settled") return;
  const run: RunSettlement = {
    conversation: result.conversation,
    requestId: result.requestId,
    requestIds: result.requestIds,
    kind: result.kind,
    ...(result.text !== undefined && { text: result.text }),
    ...(result.error !== undefined && { error: result.error }),
  };
  durable.statuses.set(key, { kind: "settled", conversation: result.conversation, requestId: result.requestId, run });
  durable.answers.append(run);
  if (!durable.loseEvents) await durable.events?.emit(result.kind === "failed" ? "agent.failed" : "agent.settled", result);
}

/** `conversations.registry` in memory: one runtime conversation per key, across restarts. Not under test. */
function fakeConversations(durable: Durable): ComponentDefinition {
  return defineComponent({
    name: "conformance-conversations",
    setup(pikit) {
      const known = durable.conversations;
      const registry: ConversationRegistry = {
        async resolve(key, agent) {
          const conversation = known.get(key) ?? { key, agent, conversationId: `conformance-conversation-${known.size + 1}` };
          known.set(key, conversation);
          return conversation;
        },
        get: async (key) => known.get(key),
        reset: async () => undefined,
      };
      pikit.provide("conversations.registry", registry);
    },
  });
}

/**
 * `agent.submissions` as the runtime's record: what the fake runtime admitted and ended, and the
 * `answers` feed of every run's end. The suite reads only what channels read (`answers`, `pending`,
 * `get`); runs are recorded by the fake runtime itself.
 */
function fakeSubmissions(durable: Durable): ComponentDefinition {
  return defineComponent({
    name: "conformance-submissions",
    setup(pikit) {
      const record: Pick<AgentSubmissions, "answers" | "pending" | "get"> = {
        answers: durable.answers.feed,
        async pending() {
          const byConversation = new Map<string, PendingConversation>();
          for (const status of durable.statuses.values()) {
            if (status.kind !== "pending") continue;
            const entry = byConversation.get(status.conversation.conversationId) ?? { conversation: status.conversation, requestIds: [], oldestAdmittedAt: Date.now() };
            entry.requestIds.push(status.requestId);
            byConversation.set(status.conversation.conversationId, entry);
          }
          return [...byConversation.values()];
        },
        get: async (conversation, requestId) => durable.statuses.get(`${conversation.conversationId}\u0000${requestId}`),
      };
      // What a channel reads of the record; the runtime's own writes are not the channels' contract.
      pikit.provide("agent.submissions", record as AgentSubmissions);
    },
  });
}

/** `agent.runtime` that records dispatches and answers every run soon after, as a real one would later. */
function fakeRuntime(durable: Durable): ComponentDefinition {
  return defineComponent({
    name: "conformance-runtime",
    setup(pikit) {
      const runtime: AgentRuntime = {
        async dispatch(request) {
          const duplicate = durable.dispatched.some((d) => d.requestId === request.requestId && d.conversation.key === request.conversation.key);
          durable.dispatched.push(request);
          if (duplicate) return { kind: "duplicate", requestId: request.requestId };
          const number = ++durable.started;
          const key = `${request.conversation.conversationId}\u0000${request.requestId}`;
          durable.statuses.set(key, { kind: "pending", conversation: request.conversation, requestId: request.requestId });
          const result: AgentResult & { kind: "completed" } = {
            conversation: request.conversation,
            requestId: request.requestId,
            requestIds: [request.requestId],
            kind: "completed",
            text: `${CONFORMANCE_ANSWER} (${number})`,
            messages: [],
          };
          // After dispatch returns, as a run starts and ends after its admission.
          setTimeout(() => {
            void durable.events?.emit("agent.started", { conversation: request.conversation, requestId: request.requestId, resumed: false });
            if (durable.hold) durable.held.push(result);
            else void settle(durable, result);
          }, 10);
          return { kind: "started", requestId: request.requestId };
        },
        abort: async () => {},
        resume: async () => {},
      };
      pikit.provide("agent.runtime", runtime);
      let mine: AppContext | undefined;
      return {
        start(ctx) {
          mine = ctx.derive(() => BACKGROUND_CONTEXT);
          durable.events = mine;
        },
        stop() {
          if (durable.events === mine) durable.events = undefined;
        },
      };
    },
  });
}

/** Stages that act on words in a message's text: a policy, a router rule, a stage that breaks the path. */
function stages(): ComponentDefinition {
  return defineComponent({
    name: "conformance-stages",
    setup(pikit) {
      pikit.pipeline(
        "inbound.normalize",
        (message) => {
          if (message.text.includes(HALT_NORMALIZE)) return halt("the conformance policy stops it");
          if (message.text.includes(MOVE)) return { ...message, conversationId: `${message.conversationId}-elsewhere` };
          return message;
        },
        { id: "conformance-policy" },
      );
      pikit.pipeline(
        "route.resolve",
        (value) => {
          if (value.message.text.includes(HALT_ROUTE)) return halt("the conformance rule stops it");
          if (value.message.text.includes(DENY)) return { ...value, decision: { agent: CONFORMANCE_AGENT, access: "deny", reason: "the conformance rule denies it" } };
          return value;
        },
        { id: "conformance-rule", priority: 100 },
      );
    },
  });
}

/** Every message no rule decided goes to `CONFORMANCE_AGENT`. */
function router(): ComponentDefinition {
  return defineComponent({
    name: "conformance-router",
    setup(pikit) {
      pikit.pipeline("route.resolve", (value) => (value.decision !== undefined ? value : { ...value, decision: { agent: CONFORMANCE_AGENT, access: "allow" } }), {
        id: "conformance-router",
      });
    },
  });
}
