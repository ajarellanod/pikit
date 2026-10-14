// Owner: skeleton. The Worker's half on Cloudflare, and the ingress wiring both halves share.
/**
 * channel-google-chat's Worker half, on Cloudflare (SPEC §4.1, C1): the endpoint of each Chat app
 * (`POST /google-chat`, `POST /google-chat/<name>`), served by the Worker's App. It verifies Google's
 * token, reads the event, builds its conversation's key (reading the `conversations` setting, which
 * settings-store's Worker half answers here too), and hands it to that conversation's object through
 * `actor.mailbox`: `send(key, "google-chat.event", event)` for a message, an add or a removal,
 * acknowledged `{}` once it resolves; `call(key, "google-chat.click", event)` for a click, whose answer
 * is the response. The object (the default export, index.ts) admits, answers and draws.
 *
 * It requires `secrets` and `actor.mailbox`, and uses `settings`. It has no `storage.kv`: whether a
 * space has threads is kept in memory, per isolate. Its config (`workerConfig`) is `WorkerConfig`, the
 * same values as the default export's (apiBase, jwksUrl, instances, conversations): keep them equal.
 *
 * `component.json`'s `apps.worker` names this export (`worker`): `pikit add` puts it in
 * `export const worker` of pikit.config.ts, as `channel-google-chat-worker`. On a server it is not
 * installed: the default export serves the routes itself and hands events over in process.
 *
 * What both halves share is here too: `connect` (an instance's secrets, API client, token verifier and
 * threading) and `routeOf` (its route over a sink), and `mailboxSink`.
 */

import { type AppContext, type Clock, defineComponent } from "@pikit/core";
import type { ActorMailbox, JsonValue, KeyValueStore } from "@pikit/contracts";
import { createChatApi } from "./api.ts";
import { createAccessTokens } from "./auth.ts";
import type { AddOnResponse } from "./event.ts";
import { type Credentials, createConversationSettings, type Instance, instancesOf, readCredentials, WorkerConfig } from "./instance.ts";
import { createSpaceThreading, eventKey } from "./key.ts";
import { createRoute } from "./route.ts";
import { createIdTokenVerifier, createJwks } from "./token.ts";
import { type ChatApi, CLICK_TYPE, EVENT_TYPE, type EventSink, type IdTokenVerifier, type Jwks, type ModeOf, type SpaceThreading } from "./types.ts";

export const WORKER_NAME = "channel-google-chat-worker";

/** An endpoint's handler. */
export type Route = (request: Request, ctx: AppContext) => Promise<Response>;

/** One instance, connected: its secrets read, and what calls Google and checks its tokens. Nothing is fetched yet. */
export interface Connection {
  instance: Instance;
  credentials: Credentials;
  api: ChatApi;
  verifier: IdTokenVerifier;
  threading: SpaceThreading;
}

export interface ConnectOptions {
  read: (name: string) => Promise<string | undefined>;
  /** `Config.apiBase`. */
  apiBase: string;
  /** Google's keys, one set for every instance. */
  jwks: Jwks;
  clock: Clock;
  /** Where the threading state is kept: the component's `storage.kv` namespace, or none (in memory). */
  cache: KeyValueStore | undefined;
}

/** `instance` connected: its secrets read and parsed (a missing or unusable one throws, P5), its clients built. Makes no request. */
export async function connect(instance: Instance, options: ConnectOptions): Promise<Connection> {
  const credentials = await readCredentials(instance, options.read);
  const tokens = createAccessTokens(credentials.serviceAccount, { clock: options.clock });
  const api = createChatApi({ apiBase: options.apiBase, tokens });
  const verifier = createIdTokenVerifier({ jwks: options.jwks, audience: credentials.audience, email: credentials.tokenEmail, clock: options.clock });
  return { instance, credentials, api, verifier, threading: createSpaceThreading(api, options.cache) };
}

/** `connection`'s endpoint, handing what it verified and keyed to `sink`, keys made with `mode`. */
export function routeOf(connection: Connection, options: { sink: EventSink; mode: ModeOf }): Route {
  const { instance, credentials, verifier, threading } = connection;
  return createRoute({ instance, credentials, verifier, sink: options.sink, keyOf: (event, ctx) => eventKey(event, { instance, threading, mode: options.mode }, ctx) });
}

/** The sink of an App whose conversations are other actors: each event to its conversation's object. */
export function mailboxSink(mailbox: ActorMailbox): EventSink {
  return {
    event: (key, event, ctx) => mailbox.send(key, EVENT_TYPE, event as unknown as JsonValue, ctx),
    click: async (key, event, ctx) => (await mailbox.call(key, CLICK_TYPE, event as unknown as JsonValue, ctx)) as unknown as AddOnResponse,
  };
}

/** Serves `route`, or `503` while the component is not running. */
export function serve(route: Route | undefined, request: Request, ctx: AppContext): Promise<Response> {
  if (route === undefined) return Promise.resolve(new Response("not running", { status: 503 }));
  return route(request, ctx);
}

export const worker = defineComponent({
  name: WORKER_NAME,
  config: WorkerConfig,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    const mailbox = pikit.use("actor.mailbox");
    const settings = pikit.useOptional("settings");
    const instances = instancesOf(config.instances);
    const conversations = createConversationSettings(settings, instances, config.conversations);
    let routes: Map<string, Route> | undefined;

    for (const instance of instances) {
      pikit.provideKeyed("http.route", `POST ${instance.path}`, (request, ctx) => serve(routes?.get(instance.instance), request, ctx));
    }

    return {
      async start(ctx) {
        const jwks = createJwks({ url: config.jwksUrl, clock: ctx.clock });
        const sink = mailboxSink(mailbox.get());
        const ready = new Map<string, Route>();
        for (const instance of instances) {
          const connection = await connect(instance, { read: (name) => secrets.get().get(name), apiBase: config.apiBase, jwks, clock: ctx.clock, cache: undefined });
          ready.set(instance.instance, routeOf(connection, { sink, mode: conversations.modeOf(instance.instance) }));
        }
        conversations.declare();
        routes = ready;
      },
      stop() {
        routes = undefined;
        conversations.undeclare();
      },
    };
  },
});
