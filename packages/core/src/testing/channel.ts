/**
 * Channel conformance (SPEC §5, §14): what every channel does with a message, whatever the
 * platform. Runner-independent, like the other suites:
 *
 *   for (const c of createChannelConformance((setup) => myChannelFixture(setup)))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite provides the rest of the inbound path: `agent.runtime` and `conversations.registry`
 * (fakes that record what reaches them, and answer every run with `ANSWER`), a router to
 * `conformance-agent`, and stages that halt, deny or move a message when its text says so. The
 * fixture provides the channel and whatever it uses besides (secrets, a server), and speaks the
 * platform: it delivers a message as a user would send it, and reads what that user was told.
 *
 * The rule under test: a message reaches the agent only through the whole path, and a sender whose
 * message does not reach it is told, never left without an answer. A channel may run the path with
 * `admitInbound` or on its own; the suite checks what the sender and the agent see.
 */

import type { AgentRequest, AgentResult, AgentRuntime, ConversationRef } from "../agent.ts";
import { type AppContext, type ComponentDefinition, defineApp, defineComponent } from "../app.ts";
import { BACKGROUND_CONTEXT } from "../context.ts";
import type { ConversationRegistry } from "../contracts/conversations.ts";
import { type Logger, silentLogger } from "../contracts/logger.ts";
import { halt } from "../pipeline.ts";
import { checker } from "./assert.ts";
import type { ConformanceCase } from "./lifecycle.ts";

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
  /** Release what the fixture holds. */
  dispose?(): Promise<void>;
}

export interface ChannelConformanceOptions {
  /** How long to wait for what a delivery leads to. Default 5000 ms. */
  timeoutMs?: number;
  /** How long nothing must happen, when a case checks that nothing does. Default 300 ms. */
  quietMs?: number;
}

/** The text every run answers with: a sender who was told it got the agent's answer. */
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

  return [
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
  ];
}

interface Subject {
  fixture: ChannelFixture;
  /** Every dispatch, duplicates included, in order. */
  dispatched: AgentRequest[];
  /** Runs started (dispatches that were not duplicates). */
  readonly started: number;
  /** Errors the app logged. */
  errors: string[];
  /** Resolves with `probe()`'s first defined value; throws after the timeout. */
  eventually<T>(probe: () => T | undefined | Promise<T | undefined>, what: string): Promise<T>;
  /** Waits the quiet period: what a case checks after it did not happen. */
  quiet(): Promise<void>;
  stop(): Promise<void>;
}

async function createSubject(fixture: ChannelFixture, withRouter: boolean, timeoutMs: number, quietMs: number): Promise<Subject> {
  const dispatched: AgentRequest[] = [];
  let started = 0;
  const errors: string[] = [];
  const logger: Logger = { ...silentLogger, error: (line) => void errors.push(line) };

  const app = await (
    defineApp({
      components: [...fixture.components, fakeConversations(), fakeRuntime(dispatched, () => started++), stages(), ...(withRouter ? [router()] : [])],
      ...(fixture.config !== undefined && { config: fixture.config }),
      logger,
    })
  ).create();
  await app.start();

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  return {
    fixture,
    dispatched,
    get started() {
      return started;
    },
    errors,
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

/** `conversations.registry` in memory: one session per key. Not under test. */
function fakeConversations(): ComponentDefinition {
  return defineComponent({
    name: "conformance-conversations",
    setup(pikit) {
      const known = new Map<string, ConversationRef>();
      const registry: ConversationRegistry = {
        async resolve(key, agent) {
          const conversation = known.get(key) ?? { key, agent, sessionId: `conformance-session-${known.size + 1}` };
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

/** `agent.runtime` that records dispatches and answers every run at once, as a real one would later. */
function fakeRuntime(dispatched: AgentRequest[], onStarted: () => void): ComponentDefinition {
  return defineComponent({
    name: "conformance-runtime",
    setup(pikit) {
      let events: AppContext | undefined;
      const runtime: AgentRuntime = {
        async dispatch(request) {
          const duplicate = dispatched.some((d) => d.requestId === request.requestId && d.conversation.key === request.conversation.key);
          dispatched.push(request);
          if (duplicate) return { kind: "duplicate", requestId: request.requestId };
          onStarted();
          const result: AgentResult & { kind: "completed" } = {
            conversation: request.conversation,
            requestId: request.requestId,
            requestIds: [request.requestId],
            kind: "completed",
            text: CONFORMANCE_ANSWER,
            messages: [],
          };
          // After dispatch returns, as a run ends after its admission.
          setTimeout(() => {
            void events?.emit("agent.started", { conversation: request.conversation, requestId: request.requestId, resumed: false });
            void events?.emit("agent.settled", result);
          }, 10);
          return { kind: "started", requestId: request.requestId };
        },
        abort: async () => {},
        resume: async () => {},
      };
      pikit.provide("agent.runtime", runtime);
      return {
        start(ctx) {
          events = ctx.derive(() => BACKGROUND_CONTEXT);
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
