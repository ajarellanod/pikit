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
 * - the dashboard's answers stay in the dashboard: a run that only an operator's messages from the
 *   dashboard started (request ids `DASHBOARD_REQUEST_PREFIX`) is never sent to the conversation's
 *   chat, and one that also answers a user's message is;
 * - a message whose admission fails for a while (the runtime cannot take it) is never dropped in
 *   silence: the platform or the sender delivers it again, and it reaches the agent once the failure
 *   passes, answered once;
 * - a message to a conversation whose agent is gone for good (removed: the runtime rejects it with
 *   `AgentUnavailableError`) is handled once, never delivered again and again: answered by the agent
 *   routed now in a new conversation of its key, or, when routing names the gone agent, refused with
 *   its sender told;
 * - a command to start over (`resetCommand`) that the platform delivers again, as after a crash
 *   before the channel acknowledged it, starts over once and is answered once;
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

import type { Admission, AgentRequest, AgentResult, AgentRuntime, ConversationRef } from "../agent.ts";
import { type App, type AppContext, BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, halt, type Logger, silentLogger } from "@pikit/core";
import type { ConversationRegistry } from "../conversations.ts";
import { AgentUnavailableError } from "../inbound.ts";
import { DASHBOARD_REQUEST_PREFIX } from "../delivery.ts";
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
  /**
   * The message that starts its conversation over (`/new`), for a channel that takes one: the case of
   * a redelivered command runs only with it. A channel whose reset is no message has none (channel-http
   * resets on its own endpoint, with nothing a platform could deliver twice).
   */
  resetCommand?: string;
}

/** What every run's answer starts with (then its number, `(1)`): a sender who was told it got the agent's answer. */
export const CONFORMANCE_ANSWER = "conformance: the agent's answer";
/** The agent the suite's router sends every message to. */
export const CONFORMANCE_AGENT = "conformance-agent";
/** The agent the router sends to once a case changed it (`routeTo`). */
const OTHER_AGENT = "conformance-other-agent";

/** Words in a message's text that make the suite's stages act on it. */
const HALT_NORMALIZE = "[halt at normalize]";
const HALT_ROUTE = "[halt at route]";
const DENY = "[deny]";
const MOVE = "[move to another conversation]";

/** How many admissions in a row fail in the case of a transient failure: more than a few quick tries survive. */
const TRANSIENT_FAILURES = 3;

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
  const { resetCommand } = options;
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

    // ---- The dashboard: an operator's message joins the conversation, its answer stays in the dashboard.

    channelCase("a run only an operator's messages from the dashboard started is never sent to the conversation's sender", async (s) => {
      await s.fixture.deliver({ id: "m1", conversation: "alpha", text: "hello" });
      await toldExactly(s, "alpha", 1, "the user's answer");
      const conversation = s.dispatched[0]?.conversation;
      if (conversation === undefined) throw new Error(`${GROUP}: the user's message was not dispatched`);
      // What admin-api dispatches for an operator: a follow-up, its request id the dashboard's.
      await s.dispatch({ requestId: `${DASHBOARD_REQUEST_PREFIX}operator-1`, conversation, prompt: "[From the operator] how is it going?", whenBusy: "followUp" });
      await s.eventually(() => (s.settled >= 2 ? true : undefined), "the operator's run to end");
      await toldExactly(s, "alpha", 1, "the user's answer only");
      if (pushed) {
        const sent = (await platformOf(s).received("alpha")).filter((piece) => piece.text.includes(CONFORMANCE_ANSWER));
        check(sent.length === 1, `one answer sent to the platform, got ${JSON.stringify(sent)}`);
      }
    }),

    channelCase("a run that answers a user's message together with an operator's (queued together) is sent to the user", async (s) => {
      // The operator's follow-up was queued first: the run starts with it and takes the user's message too.
      s.joinNextRun(`${DASHBOARD_REQUEST_PREFIX}operator-1`);
      await s.fixture.deliver({ id: "m1", conversation: "alpha", text: "hello" });
      await toldExactly(s, "alpha", 1, "the run's answer, which the user is owed");
    }),

    channelCase("a message whose admission fails for a while is not dropped: it reaches the agent once the failure passes, answered once", async (s) => {
      s.failAdmissions(TRANSIENT_FAILURES);
      const message = { id: "m1", conversation: "alpha", text: "hello" };
      await s.fixture.deliver(message);
      if (!pushed) {
        // Answered in its response, the sender is told each failure and sends the message again, as a
        // client retries. A pushed channel's platform delivers it again by itself (or the channel retries).
        for (let failed = 1; failed <= TRANSIENT_FAILURES; failed++) {
          const told = await s.fixture.told("alpha");
          check(told.length === failed && !told.some((line) => line.includes(CONFORMANCE_ANSWER)), `the sender told failure ${failed}, told ${JSON.stringify(told)}`);
          await s.fixture.deliver(message);
        }
      }
      await toldExactly(s, "alpha", 1, "the answer to the message whose admission failed for a while");
      check(s.started === 1, `one run, got ${s.started}`);
    }),

    channelCase("a message to a conversation whose agent is gone is answered once by the agent routed now, in a new conversation of its key", async (s) => {
      await s.fixture.deliver({ id: "m1", conversation: "alpha", text: "hello" });
      await toldExactly(s, "alpha", 1, "the answer before the agent is removed");
      // An operator deleted the live agent; routing now names another.
      s.removeAgent(CONFORMANCE_AGENT);
      s.routeTo(OTHER_AGENT);
      await s.fixture.deliver({ id: "m2", conversation: "alpha", text: "still there?" });
      await toldExactly(s, "alpha", 2, "the answer of the agent routed now");
      const last = s.dispatched.at(-1);
      check(last?.conversation.agent === OTHER_AGENT && last.requestId.length > 0, `the message dispatched to "${OTHER_AGENT}", got ${JSON.stringify(last?.conversation)}`);
      check(s.resets === 1 && s.unavailable === 1, `the key moved once, and the gone agent asked once, got ${s.resets} reset(s), ${s.unavailable} refusal(s)`);
    }),

    channelCase("a message routed to an agent that is gone is refused once, its sender told, never delivered again", async (s) => {
      s.removeAgent(CONFORMANCE_AGENT);
      await s.fixture.deliver({ id: "m1", conversation: "alpha", text: "hello" });
      await s.eventually(async () => ((await s.fixture.told("alpha")).length > 0 ? true : undefined), "the sender to be told the message was not taken");
      await s.quiet();
      await s.quiet();
      check(!(await s.fixture.told("alpha")).some((line) => line.includes(CONFORMANCE_ANSWER)), "no agent's answer");
      check(s.unavailable === 1, `the gone agent asked once (the platform not delivering it again), got ${s.unavailable}`);
    }),

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

  if (resetCommand !== undefined) {
    cases.push(
      channelCase("a command to start over that the platform delivers again after a restart starts over once, and is answered once", async (s) => {
        await s.fixture.deliver({ id: "m1", conversation: "alpha", text: "hello" });
        await toldExactly(s, "alpha", 1, "the answer before the command");
        const command = { id: "m2", conversation: "alpha", text: resetCommand };
        await s.fixture.deliver(command);
        await s.eventually(async () => (s.resets > 0 && (await s.fixture.told("alpha")).length > 1 ? true : undefined), "the conversation to start over, and its sender to be told");
        const told = await s.fixture.told("alpha");
        // A crash before the platform learned the command was handled: it delivers it again.
        await s.restart();
        await s.fixture.deliver(command);
        await s.quiet();
        await s.quiet();
        check(s.resets === 1, `one reset for one command delivered twice, got ${s.resets}`);
        const after = await s.fixture.told("alpha");
        check(after.length === told.length, `the command answered once, told ${JSON.stringify(after)}`);
      }),
    );
  }

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
  /** Conversations started over (`conversations.registry`'s `reset`). */
  readonly resets: number;
  /** Dispatches the runtime refused because their agent is gone (`removeAgent`). */
  readonly unavailable: number;
  /** Errors the apps logged. */
  errors: string[];
  /** From now on `agent` is no agent: a dispatch to a conversation of it rejects with `AgentUnavailableError`. */
  removeAgent(agent: string): void;
  /** From now on the router sends every message to `agent`. */
  routeTo(agent: string): void;
  /** From now on a run does not end until `settleHeld`. */
  holdRuns(): void;
  /** Dispatches `request` to the suite's runtime, as another producer (admin-api, a scheduler) would. */
  dispatch(request: AgentRequest): Promise<Admission>;
  /**
   * The next run starts with `requestId` (a message queued before the next one dispatched) and takes the
   * dispatched message with it: its `requestId` is `requestId`, its `requestIds` both.
   */
  joinNextRun(requestId: string): void;
  /** Ends the held runs: recorded in `agent.submissions`, and announced if an App runs. */
  settleHeld(): Promise<void>;
  /** From now on a run's end is recorded, and its events are lost. */
  loseEvents(): void;
  /** The next `count` dispatches throw, as a runtime that cannot take messages for a while. */
  failAdmissions(count: number): void;
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
  /** Dispatches left to fail (`failAdmissions`). */
  failAdmissions: number;
  /** The keys of the conversations started over, in order. */
  resets: string[];
  /** The running App's context for events, or `undefined` between Apps. */
  events: AppContext | undefined;
  /** The record of submissions: each request's status, and the feed of run ends. */
  statuses: Map<string, SubmissionStatus>;
  answers: MemoryFeed<RunSettlement>;
  conversations: Map<string, ConversationRef>;
  /** The request the next run starts with, before the one dispatched (`joinNextRun`). */
  joinNext: string | undefined;
  /** Agents that are gone (`removeAgent`), and the dispatches refused for them. */
  gone: Set<string>;
  unavailable: number;
  /** The router's agent. */
  routed: string;
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
    failAdmissions: 0,
    resets: [],
    events: undefined,
    statuses: new Map(),
    answers: createMemoryFeed<RunSettlement>(),
    conversations: new Map(),
    joinNext: undefined,
    gone: new Set(),
    unavailable: 0,
    routed: CONFORMANCE_AGENT,
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
      ...(withRouter ? [router(durable)] : []),
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
    get resets() {
      return durable.resets.length;
    },
    get unavailable() {
      return durable.unavailable;
    },
    errors,
    removeAgent(agent) {
      durable.gone.add(agent);
    },
    routeTo(agent) {
      durable.routed = agent;
    },
    holdRuns() {
      durable.hold = true;
    },
    dispatch: (request) => dispatchFake(durable, request),
    joinNextRun(requestId) {
      durable.joinNext = requestId;
    },
    async settleHeld() {
      durable.hold = false;
      for (const result of durable.held.splice(0)) await settle(durable, result);
    },
    loseEvents() {
      durable.loseEvents = true;
    },
    failAdmissions(count) {
      durable.failAdmissions = count;
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
  // Every request the run took is settled by it.
  for (const requestId of result.requestIds) {
    durable.statuses.set(`${result.conversation.conversationId}\u0000${requestId}`, { kind: "settled", conversation: result.conversation, requestId, run });
  }
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
        async reset(key, _ctx, agent) {
          const previous = known.get(key);
          if (previous === undefined) return undefined;
          const conversation = { ...previous, ...(agent !== undefined && { agent }), conversationId: `${previous.conversationId}-reset-${durable.resets.length + 1}` };
          known.set(key, conversation);
          durable.resets.push(key);
          return { conversation, previousConversationId: previous.conversationId, newConversationId: conversation.conversationId };
        },
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
        dispatch: (request) => dispatchFake(durable, request),
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

/** Every message no rule decided goes to `CONFORMANCE_AGENT`, or the agent a case routes to (`routeTo`). */
function router(durable: Durable): ComponentDefinition {
  return defineComponent({
    name: "conformance-router",
    setup(pikit) {
      pikit.pipeline("route.resolve", (value) => (value.decision !== undefined ? value : { ...value, decision: { agent: durable.routed, access: "allow" } }), {
        id: "conformance-router",
      });
    },
  });
}

/** The suite's runtime taking `request`: recorded, and its run answers soon after (or is held). */
async function dispatchFake(durable: Durable, request: AgentRequest): Promise<Admission> {
  if (durable.failAdmissions > 0) {
    durable.failAdmissions--;
    throw new Error("conformance: the runtime cannot take messages for a while");
  }
  if (durable.gone.has(request.conversation.agent)) {
    durable.unavailable++;
    throw new AgentUnavailableError(request.conversation.agent, `conformance: no agent "${request.conversation.agent}" now`);
  }
  const duplicate = durable.dispatched.some((d) => d.requestId === request.requestId && d.conversation.key === request.conversation.key);
  durable.dispatched.push(request);
  if (duplicate) return { kind: "duplicate", requestId: request.requestId };
  const number = ++durable.started;
  const joined = durable.joinNext;
  durable.joinNext = undefined;
  const requestIds = joined === undefined ? [request.requestId] : [joined, request.requestId];
  for (const requestId of requestIds) {
    durable.statuses.set(`${request.conversation.conversationId}\u0000${requestId}`, { kind: "pending", conversation: request.conversation, requestId });
  }
  const result: AgentResult & { kind: "completed" } = {
    conversation: request.conversation,
    requestId: requestIds[0] as string,
    requestIds,
    kind: "completed",
    text: `${CONFORMANCE_ANSWER} (${number})`,
    messages: [],
  };
  // After dispatch returns, as a run starts and ends after its admission.
  setTimeout(() => {
    void durable.events?.emit("agent.started", { conversation: request.conversation, requestId: result.requestId, resumed: false });
    if (durable.hold) durable.held.push(result);
    else void settle(durable, result);
  }, 10);
  return { kind: "started", requestId: request.requestId };
}
