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
import type { ActorInboxHandler, ActorMailbox } from "../actor.ts";
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
          send: (key, type, message, ctx = started.context()) => resolved.send(key, type, message, ctx),
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
  /** What registering `TYPE` again, then an empty type, threw in the actor's start (the last one's). */
  registration: unknown[];
  /** What the handlers do after recording a call; by default they resolve at once. */
  behave(run: (received: Received) => Promise<void>): void;
  /** Makes the handlers wait until `release()`. */
  hold(): { release(): void };
}

interface Subject extends Omit<Inbox, "component"> {
  /** Sends through the app's `actor.mailbox`; `ctx` defaults to the app's background context. */
  send(key: string, type: string, message: JsonValue, ctx?: AppContext): Promise<void>;
  context(parent?: Parameters<App["context"]>[0]): AppContext;
}

/**
 * The actor's side, scripted by each case: a component that registers handlers for `TYPE` and
 * `OTHER_TYPE` in its start, and a wakeup handler when `wakeups` is provided. Every App it is
 * installed in (every actor) records into the same lists.
 */
function createInbox(): Inbox {
  const received: Received[] = [];
  const registration: unknown[] = [];
  let finished = 0;
  let woken = 0;
  let behaviour: (received: Received) => Promise<void> = async () => {};
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
            registration.splice(0, registration.length, attempt(() => inbox.get().handle(TYPE, handler(TYPE))), attempt(() => inbox.get().handle("", handler(""))));
            own.wakeups?.handle(WAKE, async () => void woken++);
          },
        };
      },
    }),
    received,
    registration,
    get finished() {
      return finished;
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
      let running: { ctx: AppContext; stop: AbortController } | undefined;
      pikit.provide("actor.inbox", {
        handle(type, handler) {
          if (typeof type !== "string" || type === "") throw new TypeError("memory-mailbox: a message type is a non-empty string");
          if (handlers.has(type)) throw new Error(`memory-mailbox: the type "${type}" already has a handler`);
          handlers.set(type, handler);
        },
      });
      pikit.provide("actor.mailbox", {
        async send(key, type, message, ctx) {
          if (running === undefined) throw new Error("memory-mailbox: actor.mailbox used while the app is not running");
          if (typeof key !== "string" || key === "") throw new TypeError("memory-mailbox: a key is a non-empty string");
          const handler = handlers.get(type);
          if (handler === undefined) throw new Error(`memory-mailbox: no actor.inbox handler for the type "${type}"`);
          const text = JSON.stringify(message) as string | undefined;
          if (text === undefined) throw new TypeError("memory-mailbox: a message must be JSON");
          ctx.abortSignal?.throwIfAborted();
          const handled = handler(key, JSON.parse(text) as JsonValue, running.ctx);
          if (ctx.abortSignal === undefined) return handled;
          const signal = ctx.abortSignal;
          return new Promise<void>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            handled.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
          });
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
        },
      };
    },
  });
}
