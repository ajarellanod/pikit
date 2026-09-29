/**
 * `actor.mailbox` conformance (SPEC §4.1, C2): what every mailbox must do, wherever its actors run.
 * Runner-independent, like the lifecycle suite:
 *
 *   for (const c of createMailboxConformance((inbox) => ({ components: [inbox, myMailbox] })))
 *     test(`${c.group}: ${c.name}`, () => c.run());
 *
 * The suite brings the actor's side: a component providing `actor.inbox` handlers it scripts
 * (`inbox`). The fixture installs it where its actors run: in its own list, for a mailbox that
 * delivers in the same App. The suite sends through the capability, as a channel would.
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
import type { ActorMailbox } from "../actor.ts";
import type { JsonValue } from "../storage.ts";
import { checker, expecter } from "./assert.ts";

/** A mailbox built for one case. */
export interface MailboxFixture {
  /** The component providing `actor.mailbox`, what it uses, and `inbox` wherever the actors run. */
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

interface Received {
  type: string;
  key: string;
  message: JsonValue;
  ctx: AppContext;
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

export function createMailboxConformance(factory: (inbox: ComponentDefinition) => MailboxFixture | Promise<MailboxFixture>): readonly ConformanceCase[] {
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

  return [
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
  ];
}

interface Inbox {
  component: ComponentDefinition;
  /** Every handler call, in the order they began. */
  received: Received[];
  /** How many handler calls resolved. */
  readonly finished: number;
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

/** The actor's side, scripted by each case: handlers for `TYPE` and `OTHER_TYPE`. */
function createInbox(): Inbox {
  const received: Received[] = [];
  let finished = 0;
  let behaviour: (received: Received) => Promise<void> = async () => {};
  const handler = (type: string) => async (key: string, message: JsonValue, ctx: AppContext) => {
    const call = { type, key, message, ctx };
    received.push(call);
    await behaviour(call);
    finished++;
  };
  return {
    component: defineComponent({
      name: "mailbox-conformance-inbox",
      setup(pikit) {
        pikit.provideKeyed("actor.inbox", TYPE, handler(TYPE));
        pikit.provideKeyed("actor.inbox", OTHER_TYPE, handler(OTHER_TYPE));
      },
    }),
    received,
    get finished() {
      return finished;
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
 * `actor.mailbox` in memory, for tests: every key's actor is this App, as on a server. `send` calls
 * this App's `actor.inbox` handler for the type with a JSON copy of the message and a context of the
 * handler's own (cancelled when the App stops), and resolves when the handler does.
 */
export function createMemoryMailbox(): ComponentDefinition {
  return defineComponent({
    name: "memory-mailbox",
    setup(pikit) {
      const inbox = pikit.useKeyed("actor.inbox");
      let running: { ctx: AppContext; stop: AbortController } | undefined;
      pikit.provide("actor.mailbox", {
        async send(key, type, message, ctx) {
          if (running === undefined) throw new Error("memory-mailbox: actor.mailbox used while the app is not running");
          if (typeof key !== "string" || key === "") throw new TypeError("memory-mailbox: a key is a non-empty string");
          const handler = inbox.get(type);
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
          const handlers = ctx.derive((inner) => ({ abortSignal: stop.signal, value: (key) => inner.value(key), toString: () => `${inner}.Inbox` }));
          running = { ctx: handlers, stop };
        },
        stop() {
          running?.stop.abort(new Error("memory-mailbox: the app is stopping"));
          running = undefined;
        },
      };
    },
  });
}
