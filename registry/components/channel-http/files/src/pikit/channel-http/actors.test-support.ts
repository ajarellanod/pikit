/**
 * For the tests only: channel-http's two Apps as Cloudflare runs them, in one process, without
 * workerd. The objects' App (the default export) gets an `actor.inbox` of scope `"one"`, as each
 * Durable Object's App has from actors-do; the Worker's App (the Worker half) gets an
 * `actor.mailbox` whose `call` reaches the answer handlers the objects' App registered, the message and
 * the answer as JSON copies, as over an RPC. One App stands for every object: each call still names
 * its key, which the handlers check.
 *
 * The proof on real objects, with their real RPC and alarms, is pikit's workerd lane
 * (`tests/workerd/test/channel-http.workerd.ts`).
 */

import { type App, type AppContext, BACKGROUND_CONTEXT, type ComponentDefinition, defineApp, defineComponent, type Logger, silentLogger, withAbortSignal } from "@pikit/core";
import { ActorCallError, type ActorCallHandler, type ActorMailbox, answerCall, callResult, type HttpRoute, type JsonValue } from "@pikit/contracts";
import { worker } from "./worker.ts";

/** The RPC between the Worker's App and the objects' App. */
export interface Actors {
  /** Goes in the objects' App: `actor.inbox` (scope `"one"`) and `actor.mailbox` over this network. */
  object: ComponentDefinition;
  /** The Worker's `actor.mailbox`. */
  mailbox: ActorMailbox;
  /** Every call made, as `type key`. */
  calls: string[];
  /** While `false`, every call is `unreachable`, as an object a deploy reset mid-call. */
  reachable: boolean;
}

export function createActors(): Actors {
  const answers = new Map<string, ActorCallHandler>();
  /** The objects' App's handler context, cancelled when that App stops (as actors-do's inbox context). */
  let handlerCtx: AppContext | undefined;
  const refuse = (): never => {
    throw new ActorCallError("failed", "channel-http's tests use only call");
  };
  const actors: Actors = {
    calls: [],
    reachable: true,
    mailbox: {
      send: async () => refuse(),
      stream: async () => refuse(),
      async call(key, type, message, _ctx) {
        actors.calls.push(`${type} ${key}`);
        if (!actors.reachable) throw new ActorCallError("unreachable", `the object of "${key}" could not be reached`);
        const handler = answers.get(type);
        if (handler === undefined || handlerCtx === undefined) throw new ActorCallError("no_handler", `no answer handler for "${type}"`);
        return callResult(await answerCall(handler, key, JSON.parse(JSON.stringify(message)) as JsonValue, handlerCtx));
      },
    },
    object: defineComponent({
      name: "actors-test",
      setup(pikit) {
        let stopping: AbortController | undefined;
        pikit.provide("actor.inbox", {
          scope: "one",
          handle: () => refuse(),
          answerStream: () => refuse(),
          answer(type, handler) {
            if (answers.has(type)) throw new Error(`actors-test: "${type}" already has an answer handler`);
            answers.set(type, handler);
          },
        });
        pikit.provide("actor.mailbox", actors.mailbox);
        return {
          start(ctx) {
            stopping = new AbortController();
            const signal = stopping.signal;
            handlerCtx = ctx.derive(() => withAbortSignal(signal, BACKGROUND_CONTEXT));
          },
          stop() {
            stopping?.abort(new Error("actors-test: the object's App stopped"));
            handlerCtx = undefined;
            answers.clear();
          },
        };
      },
    }),
  };
  return actors;
}

/** The Worker's App: channel-http's Worker half over `actors`, with `secrets`; its routes, once started. */
export async function startWorker(actors: Actors, secrets: Record<string, string>, logger: Logger = silentLogger): Promise<{ app: App; route(key: string): HttpRoute }> {
  let routes: { get(key: string): HttpRoute | undefined } | undefined;
  const app = await defineApp({
    components: [
      defineComponent({ name: "secrets-test", setup: (pikit) => pikit.provide("secrets", { get: async (name: string) => secrets[name] }) }),
      defineComponent({ name: "mailbox-test", setup: (pikit) => pikit.provide("actor.mailbox", actors.mailbox) }),
      worker,
      defineComponent({
        name: "server-test",
        setup(pikit) {
          const handle = pikit.useKeyed("http.route");
          return { start: () => void (routes = handle) };
        },
      }),
    ],
    target: "durable",
    logger,
  }).create();
  await app.start();
  return {
    app,
    route(key) {
      const found = routes?.get(key);
      if (found === undefined) throw new Error(`the Worker's App has no route ${key}`);
      return found;
    },
  };
}
