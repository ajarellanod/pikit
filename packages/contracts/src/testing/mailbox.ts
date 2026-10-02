/**
 * `actor.mailbox` and `actor.inbox` conformance (SPEC §4.1, C2): what every mailbox must do, wherever
 * its actors run. Runner-independent, like the lifecycle suite:
 *
 *   for (const c of createMailboxConformance((inbox) => ({ components: [inbox, myMailbox] })))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite brings the actor's side: a component (`inbox`) that uses `actor.inbox` and registers the
 * handlers it scripts in its `start`. The fixture installs it where its actors run: in its own list,
 * for a mailbox that delivers in the same App. The suite sends through the capability, as a channel
 * would.
 *
 * That component is an actor as real ones are: it also uses `actor.mailbox` (a handler sends to
 * another actor) and, when installed, `wakeups` (it registers a wakeup handler and asks for it from a
 * message's handler). So every fixture proves that one component can handle and send, and one with
 * `wakeups: true` that an actor waking itself composes with its mailbox: none is a dependency cycle.
 *
 * It also answers calls (`answer`, reached by `call`): the answer is JSON and a copy, a refusal
 * reaches the caller as an `ActorCallError` with its code, and calls and messages are apart.
 *
 * `createMemoryMailbox` is the in-memory double: it passes this suite, and it stands in for a
 * mailbox in the tests of a channel or an actor.
 */

import {
  type App,
  type AppContext,
  BACKGROUND_CONTEXT,
  type ComponentDefinition,
  defineApp,
  defineComponent,
  silentLogger,
  withAbortSignal,
  withCancel,
} from "@pikit/core";
import type { ConformanceCase } from "@pikit/core/testing";
import { type ActorCallHandler, ActorCallError, type ActorInboxHandler, type ActorMailbox, answerCall, callResult } from "../actor.ts";
import type { JsonValue } from "../json.ts";
import type { Wakeups } from "../wakeups.ts";
import { checker, expecter } from "./assert.ts";

/** A mailbox built for one case. */
export interface MailboxFixture {
  /**
   * The component providing `actor.mailbox`, what it uses, and `inbox` wherever the actors run, with
   * the providers of `actor.inbox` and `actor.mailbox` there (and of `wakeups`, if the options say so).
   */
  components: ComponentDefinition[];
  config?: Record<string, unknown>;
  dispose?(): Promise<void>;
}

const GROUP = "actor.mailbox";
const expect = expecter(GROUP);
const check = checker(GROUP);

/** The message types the suite's inbox handles. */
const TYPE = "conformance";
const OTHER_TYPE = "conformance.other";
/** A type only answered (calls), never handled (messages). */
const ASK_TYPE = "conformance.ask";
/** The wakeup handler the suite's actors register when `wakeups` is provided. */
const WAKE = "mailbox-conformance.wake";

interface Received {
  type: string;
  key: string;
  message: JsonValue;
  ctx: AppContext;
  /** The actor App's own mailbox and wakeups (when provided): what its handlers may use. */
  mailbox: ActorMailbox;
  wakeups: Wakeups | undefined;
}

/** One call an answer handler got. */
interface Asked {
  type: string;
  key: string;
  message: JsonValue;
  ctx: AppContext;
  mailbox: ActorMailbox;
}

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error ?? new Error("rejected with nothing"),
  );

/** Waits (a few event-loop turns at a time, up to `ms`) until `condition` holds. */
async function eventually(condition: () => boolean, what: string, ms = 2_000): Promise<void> {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited >= ms) throw new Error(`${GROUP}: expected ${what} within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Whether `promise` has settled by now, after letting pending work run. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  return settled;
}

export interface MailboxConformanceOptions {
  /** Where the actors run, the App also provides `wakeups`: the case of an actor that wakes itself runs. */
  wakeups?: boolean;
}

export function createMailboxConformance(
  factory: (inbox: ComponentDefinition) => MailboxFixture | Promise<MailboxFixture>,
  options: MailboxConformanceOptions = {},
): readonly ConformanceCase[] {
  const mailboxCase = (name: string, run: (s: Subject) => Promise<void>): ConformanceCase => ({
    group: GROUP,
    name,
    run: async () => {
      const inbox = createInbox();
      const fixture = await factory(inbox.component);
      let app: App | undefined;
      try {
        let mailbox: ActorMailbox | undefined;
        const sender = defineComponent({
          name: "mailbox-conformance-sender",
          setup(pikit) {
            const handle = pikit.use("actor.mailbox");
            return { start: () => void (mailbox = handle.get()) };
          },
        });
        app = await defineApp({ components: [...fixture.components, sender], ...(fixture.config !== undefined && { config: fixture.config }), logger: silentLogger }).create();
        await app.start();
        if (mailbox === undefined) throw new Error(`${GROUP}: actor.mailbox was not resolved`);
        const started = app;
        const resolved = mailbox;
        await run({
          received: inbox.received,
          get finished() {
            return inbox.finished;
          },
          get woken() {
            return inbox.woken;
          },
          registration: inbox.registration,
          behave: inbox.behave,
          hold: inbox.hold,
          asked: inbox.asked,
          get answered() {
            return inbox.answered;
          },
          answerWith: inbox.answerWith,
          send: (key, type, message, ctx = started.context()) => resolved.send(key, type, message, ctx),
          call: (key, type, message, ctx = started.context()) => resolved.call(key, type, message, ctx),
          context: (parent) => started.context(parent),
        });
      } finally {
        await app?.stop().catch(() => {});
        await fixture.dispose?.();
      }
    },
  });

  const cases: ConformanceCase[] = [
    mailboxCase("send resolves once the handler for its type resolved, and the handler gets the key and the message", async (s) => {
      const gate = s.hold();
      const sent = s.send("actor-1", TYPE, { text: "hello" });
      await eventually(() => s.received.length === 1, "the handler to be called");
      expect(s.received.map(({ type, key, message }) => ({ type, key, message })), [{ type: TYPE, key: "actor-1", message: { text: "hello" } }], "what the handler got");
      check(!(await hasSettled(sent)), "send to wait while the handler has not resolved");
      gate.release();
      await sent;
    }),

    mailboxCase("each type reaches its own handler", async (s) => {
      await s.send("actor-1", OTHER_TYPE, 1);
      await s.send("actor-1", TYPE, 2);
      expect(
        s.received.map(({ type, message }) => [type, message]),
        [
          [OTHER_TYPE, 1],
          [TYPE, 2],
        ],
        "the types and messages handled",
      );
    }),

    mailboxCase("every kind of JSON value arrives as it was sent, as a copy", async (s) => {
      const values: JsonValue[] = [
        "ñandú ✓ \"quoted\" \\ \n tab\t",
        9_007_199_254_740_991,
        -1.5,
        true,
        false,
        null,
        [1, "two", null, [3], { four: 4 }],
        { nested: { deep: [true, { x: "y" }] }, empty: {} },
      ];
      for (const value of values) await s.send("actor-1", TYPE, value);
      expect(
        s.received.map((r) => r.message),
        values,
        "the messages handled",
      );

      // The handler changes what it got; the sender changes what it sent: neither sees the other's change.
      s.behave(async (r) => void (r.message as number[]).push(99));
      const sent = [1, 2];
      await s.send("actor-1", TYPE, sent);
      sent.push(3);
      expect(sent, [1, 2, 3], "the sender's message after the handler changed its copy");
      expect(s.received.at(-1)?.message, [1, 2, 99], "the handler's copy after the sender changed its message");
    }),

    mailboxCase("a handler that rejects makes send reject, and sending again delivers again", async (s) => {
      s.behave(async () => {
        throw new Error("the actor could not keep it");
      });
      check((await rejection(s.send("actor-1", TYPE, { id: "m1" }))) !== undefined, "send to reject when the handler rejects");
      s.behave(async () => {});
      await s.send("actor-1", TYPE, { id: "m1" });
      expect(s.received.length, 2, "how many times the handler got the message");
    }),

    mailboxCase("with no handler for its type, send rejects with an error naming the type, and nothing is delivered", async (s) => {
      const error = await rejection(s.send("actor-1", "conformance.nobody-handles-this", { id: "m1" }));
      check(error instanceof Error && error.message.includes("conformance.nobody-handles-this"), `an error naming the type, got ${String(error)}`);
      expect(s.received.length, 0, "handlers called");
    }),

    mailboxCase("an empty key, or a message that is not JSON, is refused and nothing is delivered", async (s) => {
      check((await rejection(s.send("", TYPE, 1))) !== undefined, "send with an empty key to reject");
      check((await rejection(s.send("actor-1", TYPE, undefined as unknown as JsonValue))) !== undefined, "send with undefined to reject");
      check((await rejection(s.send("actor-1", TYPE, (() => 1) as unknown as JsonValue))) !== undefined, "send with a function to reject");
      expect(s.received.length, 0, "handlers called");
    }),

    mailboxCase("the handler has its own context: the sender's cancellation rejects send, and the handler goes on", async (s) => {
      const gate = s.hold();
      const caller = withCancel(BACKGROUND_CONTEXT);
      const sent = s.send("actor-1", TYPE, { id: "m1" }, s.context(caller.context));
      await eventually(() => s.received.length === 1, "the handler to be called");
      caller.cancel(new Error("the platform's request went away"));
      check((await rejection(sent)) !== undefined, "send to reject once its context is cancelled");
      const handler = s.received[0] as Received;
      check(handler.ctx.abortSignal?.aborted !== true, "the handler's context not to be cancelled by the sender's");
      gate.release();
      await eventually(() => s.finished === 1, "the handler to finish after the sender stopped waiting");
    }),

    mailboxCase("a send whose context is already cancelled rejects", async (s) => {
      const cancelled = withAbortSignal(AbortSignal.abort(new Error("already gone")), BACKGROUND_CONTEXT);
      check((await rejection(s.send("actor-1", TYPE, 1, s.context(cancelled)))) !== undefined, "send to reject");
    }),

    mailboxCase("concurrent sends to many keys each reach the handler, with their own key", async (s) => {
      const keys = Array.from({ length: 20 }, (_, i) => `actor-${i}`);
      await Promise.all(keys.map((key) => s.send(key, TYPE, key)));
      expect(
        s.received.map((r) => [r.key, r.message]).sort(),
        keys.map((key) => [key, key]).sort(),
        "each key and its message",
      );
    }),

    mailboxCase("a type has one handler: registering it again throws, naming it, and an empty type throws", async (s) => {
      // The actor's start tried both after registering its handlers; an actor starts by the first send.
      await s.send("actor-1", TYPE, 1);
      const [again, empty] = s.registration;
      check(again instanceof Error && again.message.includes(TYPE), `an error naming "${TYPE}", got ${String(again)}`);
      check(empty !== undefined, "handle with an empty type to throw");
      expect(s.received.length, 1, "handlers called: the first registration stands");
    }),

    mailboxCase("one component both handles and sends: a handler sends to another actor through the mailbox", async (s) => {
      s.behave(async (r) => {
        if (r.type === TYPE) await r.mailbox.send("actor-2", OTHER_TYPE, { forwarded: r.message }, r.ctx);
      });
      await s.send("actor-1", TYPE, "hello");
      expect(
        s.received.map(({ type, key, message }) => [type, key, message]),
        [
          [TYPE, "actor-1", "hello"],
          [OTHER_TYPE, "actor-2", { forwarded: "hello" }],
        ],
        "the message and the one its handler sent",
      );
    }),
  ];

  /** What a call rejected with, as an `ActorCallError`; fails the case when it resolved or rejected with another error. */
  const callError = async (call: Promise<JsonValue>, what: string): Promise<ActorCallError> => {
    const error = await rejection(call);
    check(error instanceof ActorCallError, `${what} to reject with an ActorCallError, got ${error === undefined ? "an answer" : String(error)}`);
    return error as ActorCallError;
  };

  cases.push(
    mailboxCase("call resolves with the answer handler's answer, and the handler gets the key and the message", async (s) => {
      const answer = await s.call("actor-1", ASK_TYPE, { question: "how many?" });
      expect(answer, { key: "actor-1", type: ASK_TYPE, message: { question: "how many?" } }, "the answer");
      expect(s.asked.map(({ type, key, message }) => ({ type, key, message })), [{ type: ASK_TYPE, key: "actor-1", message: { question: "how many?" } }], "what the handler got");
      expect(s.received.length, 0, "message handlers called by a call");
    }),

    mailboxCase("every kind of JSON value is answered as it was, and both the message and the answer are copies", async (s) => {
      const values: JsonValue[] = ["ñandú ✓ \"quoted\" \\ \n", 9_007_199_254_740_991, -1.5, true, false, null, [1, "two", null, [3]], { nested: { deep: [true, { x: "y" }] }, empty: {} }];
      s.answerWith(async (a) => a.message);
      for (const value of values) expect(await s.call("actor-1", ASK_TYPE, value), value, `the answer to ${JSON.stringify(value)}`);

      // The handler keeps what it answered and changes the message it got; the caller changes its message and the answer.
      const kept: number[] = [7];
      s.answerWith(async (a) => {
        (a.message as number[]).push(99);
        return kept;
      });
      const sent = [1, 2];
      const answer = (await s.call("actor-1", ASK_TYPE, sent)) as number[];
      sent.push(3);
      answer.push(8);
      expect([sent, kept], [[1, 2, 3], [7]], "the caller's message and the handler's answer after the other side changed its copy");
    }),

    mailboxCase("calls and messages are apart: a call reaches only an answer handler, and a send only a message handler", async (s) => {
      const noAnswer = await callError(s.call("actor-1", TYPE, 1), "a call to a type handled only as messages");
      expect(noAnswer.code, "no_handler", "its code");
      check((await rejection(s.send("actor-1", ASK_TYPE, 1))) !== undefined, "a send to a type only answered to reject");
      expect([s.received.length, s.asked.length], [0, 0], "handlers called");
    }),

    mailboxCase("with no answer handler for its type, call rejects with no_handler, naming the type", async (s) => {
      const error = await callError(s.call("actor-1", "conformance.nobody-answers-this", 1), "a call nobody answers");
      expect(error.code, "no_handler", "its code");
      check(error.message.includes("conformance.nobody-answers-this"), `an error naming the type, got ${error.message}`);
    }),

    mailboxCase("a handler's ActorCallError reaches the caller with its code and message; any other error is failed, with its message", async (s) => {
      s.answerWith(async () => {
        throw new ActorCallError("not_found", "no such approval");
      });
      const refused = await callError(s.call("actor-1", ASK_TYPE, { id: "a1" }), "a call the handler refuses");
      expect([refused.code, refused.message], ["not_found", "no such approval"], "the refusal");

      s.answerWith(async () => {
        throw new Error("the actor's storage is down");
      });
      const failed = await callError(s.call("actor-1", ASK_TYPE, 1), "a call whose handler throws");
      expect(failed.code, "failed", "its code");
      check(failed.message.includes("the actor's storage is down"), `the handler's message, got ${failed.message}`);

      s.answerWith(async () => undefined as unknown as JsonValue);
      expect((await callError(s.call("actor-1", ASK_TYPE, 1), "a call answered with undefined")).code, "failed", "an answer that is not JSON");
    }),

    mailboxCase("an empty key, or a message that is not JSON, is refused as invalid and nothing is called", async (s) => {
      expect((await callError(s.call("", ASK_TYPE, 1), "a call with an empty key")).code, "invalid", "an empty key");
      expect((await callError(s.call("actor-1", ASK_TYPE, undefined as unknown as JsonValue), "a call with undefined")).code, "invalid", "undefined");
      expect((await callError(s.call("actor-1", ASK_TYPE, (() => 1) as unknown as JsonValue), "a call with a function")).code, "invalid", "a function");
      expect(s.asked.length, 0, "answer handlers called");
    }),

    mailboxCase("a call's context bounds it: cancelled, it rejects as cancelled, and the handler goes on with its own context", async (s) => {
      let release = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      s.answerWith(async () => {
        await released;
        return "late";
      });
      const caller = withCancel(BACKGROUND_CONTEXT);
      const asked = s.call("actor-1", ASK_TYPE, 1, s.context(caller.context));
      await eventually(() => s.asked.length === 1, "the answer handler to be called");
      caller.cancel(new Error("the dashboard's request timed out"));
      expect((await callError(asked, "a cancelled call")).code, "cancelled", "its code");
      check((s.asked[0] as Asked).ctx.abortSignal?.aborted !== true, "the handler's context not to be cancelled by the caller's");
      release();
      await eventually(() => s.answered === 1, "the handler to finish after the caller stopped waiting");

      const gone = withAbortSignal(AbortSignal.timeout(1), BACKGROUND_CONTEXT);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect((await callError(s.call("actor-1", ASK_TYPE, 1, s.context(gone)), "a call past its deadline")).code, "cancelled", "a deadline already passed");
    }),

    mailboxCase("concurrent calls to many keys are each answered by their own actor", async (s) => {
      const keys = Array.from({ length: 20 }, (_, i) => `actor-${i}`);
      const answers = await Promise.all(keys.map((key) => s.call(key, ASK_TYPE, key)));
      expect(
        answers,
        keys.map((key) => ({ key, type: ASK_TYPE, message: key })),
        "each answer",
      );
    }),

    mailboxCase("an answer handler may call another actor, and registering one twice throws, naming its type", async (s) => {
      s.answerWith(async (a) => (a.key === "actor-1" ? { relayed: await a.mailbox.call("actor-2", ASK_TYPE, a.message, a.ctx) } : { from: a.key }));
      expect(await s.call("actor-1", ASK_TYPE, "hi"), { relayed: { from: "actor-2" } }, "the relayed answer");
      const [, , again] = s.registration;
      check(again instanceof Error && again.message.includes(ASK_TYPE), `an error naming "${ASK_TYPE}", got ${String(again)}`);
    }),
  );

  if (options.wakeups) {
    cases.push(
      mailboxCase("an actor that handles messages also registers a wakeup handler, and asks for it from a message's handler", async (s) => {
        s.behave(async (r) => {
          if (r.wakeups === undefined) throw new Error(`${GROUP}: wakeups is not provided where the actor runs`);
          await r.wakeups.at(WAKE, r.ctx.clock.now(), r.ctx);
        });
        await s.send("actor-1", TYPE, { wake: true });
        await eventually(() => s.woken > 0, "the actor's wakeup handler to run");
      }),
    );
  }
  return cases;
}

interface Inbox {
  component: ComponentDefinition;
  /** Every handler call, in the order they began. */
  received: Received[];
  /** How many handler calls resolved. */
  readonly finished: number;
  /** How many times the actors' wakeup handler ran. */
  readonly woken: number;
  /** What registering `TYPE` again, an empty type, then `ASK_TYPE`'s answer again threw in the actor's start (the last one's). */
  registration: unknown[];
  /** What the handlers do after recording a call; by default they resolve at once. */
  behave(run: (received: Received) => Promise<void>): void;
  /** Makes the handlers wait until `release()`. */
  hold(): { release(): void };
  /** Every call the answer handler got, in the order they began. */
  asked: Asked[];
  /** How many calls the answer handler resolved. */
  readonly answered: number;
  /** What the answer handler answers; by default `{ key, type, message }`. */
  answerWith(run: (asked: Asked) => Promise<JsonValue>): void;
}

interface Subject extends Omit<Inbox, "component"> {
  /** Sends through the app's `actor.mailbox`; `ctx` defaults to the app's background context. */
  send(key: string, type: string, message: JsonValue, ctx?: AppContext): Promise<void>;
  /** Calls through the app's `actor.mailbox`; `ctx` defaults to the app's background context. */
  call(key: string, type: string, message: JsonValue, ctx?: AppContext): Promise<JsonValue>;
  context(parent?: Parameters<App["context"]>[0]): AppContext;
}

/**
 * The actor's side, scripted by each case: a component that registers handlers for `TYPE` and
 * `OTHER_TYPE` in its start, and a wakeup handler when `wakeups` is provided. Every App it is
 * installed in (every actor) records into the same lists.
 */
function createInbox(): Inbox {
  const received: Received[] = [];
  const asked: Asked[] = [];
  const registration: unknown[] = [];
  let finished = 0;
  let answered = 0;
  let woken = 0;
  let behaviour: (received: Received) => Promise<void> = async () => {};
  let answering: (asked: Asked) => Promise<JsonValue> = async ({ key, type, message }) => ({ key, type, message });
  const attempt = (register: () => void): unknown => {
    try {
      register();
      return undefined;
    } catch (thrown) {
      return thrown ?? new Error("threw nothing");
    }
  };
  return {
    component: defineComponent({
      name: "mailbox-conformance-inbox",
      setup(pikit) {
        const inbox = pikit.use("actor.inbox");
        const mailbox = pikit.use("actor.mailbox");
        const wakeups = pikit.useOptional("wakeups");
        return {
          start() {
            const own = { mailbox: mailbox.get(), wakeups: wakeups.get() };
            const handler =
              (type: string): ActorInboxHandler =>
              async (key, message, ctx) => {
                const call = { type, key, message, ctx, ...own };
                received.push(call);
                await behaviour(call);
                finished++;
              };
            inbox.get().handle(TYPE, handler(TYPE));
            inbox.get().handle(OTHER_TYPE, handler(OTHER_TYPE));
            const answer: ActorCallHandler = async (key, message, ctx) => {
              const call = { type: ASK_TYPE, key, message, ctx, mailbox: own.mailbox };
              asked.push(call);
              const value = await answering(call);
              answered++;
              return value;
            };
            inbox.get().answer(ASK_TYPE, answer);
            registration.splice(
              0,
              registration.length,
              attempt(() => inbox.get().handle(TYPE, handler(TYPE))),
              attempt(() => inbox.get().handle("", handler(""))),
              attempt(() => inbox.get().answer(ASK_TYPE, answer)),
            );
            own.wakeups?.handle(WAKE, async () => void woken++);
          },
        };
      },
    }),
    received,
    asked,
    registration,
    get finished() {
      return finished;
    },
    get answered() {
      return answered;
    },
    answerWith(run) {
      answering = run;
    },
    get woken() {
      return woken;
    },
    behave(run) {
      behaviour = run;
    },
    hold() {
      let release = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      behaviour = () => released;
      return { release };
    },
  };
}

/**
 * `actor.mailbox` and `actor.inbox` in memory, for tests: every key's actor is this App, as on a
 * server. `send` calls the handler registered for the type with a JSON copy of the message and a
 * context of the handler's own (cancelled when the App stops), and resolves when the handler does.
 * Handlers are dropped when the App stops.
 */
export function createMemoryMailbox(): ComponentDefinition {
  return defineComponent({
    name: "memory-mailbox",
    setup(pikit) {
      const handlers = new Map<string, ActorInboxHandler>();
      const answerers = new Map<string, ActorCallHandler>();
      let running: { ctx: AppContext; stop: AbortController } | undefined;
      pikit.provide("actor.inbox", {
        handle(type, handler) {
          if (typeof type !== "string" || type === "") throw new TypeError("memory-mailbox: a message type is a non-empty string");
          if (handlers.has(type)) throw new Error(`memory-mailbox: the type "${type}" already has a handler`);
          handlers.set(type, handler);
        },
        answer(type, handler) {
          if (typeof type !== "string" || type === "") throw new TypeError("memory-mailbox: a call type is a non-empty string");
          if (answerers.has(type)) throw new Error(`memory-mailbox: the call type "${type}" already has a handler`);
          answerers.set(type, handler);
        },
      });
      /** `work`, or a rejection with `signal`'s reason once it is cancelled. */
      const bounded = <T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
        if (signal === undefined) return work;
        return new Promise<T>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        });
      };
      pikit.provide("actor.mailbox", {
        async send(key, type, message, ctx) {
          if (running === undefined) throw new Error("memory-mailbox: actor.mailbox used while the app is not running");
          if (typeof key !== "string" || key === "") throw new TypeError("memory-mailbox: a key is a non-empty string");
          const handler = handlers.get(type);
          if (handler === undefined) throw new Error(`memory-mailbox: no actor.inbox handler for the type "${type}"`);
          const text = JSON.stringify(message) as string | undefined;
          if (text === undefined) throw new TypeError("memory-mailbox: a message must be JSON");
          ctx.abortSignal?.throwIfAborted();
          return bounded(handler(key, JSON.parse(text) as JsonValue, running.ctx), ctx.abortSignal);
        },
        async call(key, type, message, ctx) {
          if (running === undefined) throw new ActorCallError("unreachable", "memory-mailbox: actor.mailbox used while the app is not running");
          if (typeof key !== "string" || key === "") throw new ActorCallError("invalid", "memory-mailbox: a key is a non-empty string");
          const handler = answerers.get(type);
          if (handler === undefined) throw new ActorCallError("no_handler", `memory-mailbox: no actor.inbox answer handler for the call type "${type}"`);
          const text = JSON.stringify(message) as string | undefined;
          if (text === undefined) throw new ActorCallError("invalid", "memory-mailbox: a message must be JSON");
          if (ctx.abortSignal?.aborted) throw new ActorCallError("cancelled", "memory-mailbox: the call was cancelled", { cause: ctx.abortSignal.reason });
          const outcome = await bounded(answerCall(handler, key, JSON.parse(text) as JsonValue, running.ctx), ctx.abortSignal).catch((reason: unknown) => {
            throw new ActorCallError("cancelled", "memory-mailbox: the call was cancelled before it was answered", { cause: reason });
          });
          return callResult(outcome);
        },
      });
      return {
        start(ctx) {
          const stop = new AbortController();
          // The start context's values, cancelled only when the app stops.
          const context = ctx.derive((inner) => ({ abortSignal: stop.signal, value: (key) => inner.value(key), toString: () => `${inner}.Inbox` }));
          running = { ctx: context, stop };
        },
        stop() {
          running?.stop.abort(new Error("memory-mailbox: the app is stopping"));
          running = undefined;
          handlers.clear();
          answerers.clear();
        },
      };
    },
  });
}
