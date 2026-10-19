/**
 * channel-http: talk to an agent over HTTP (samples/http's scenario-1.test.ts).
 *
 *   POST /v1/messages                              { conversationId, text, messageId? }
 *   GET  /v1/conversations/:id/messages/:messageId  the outcome of a message, later
 *   POST /v1/conversations/:id/reset
 *
 * All need `Authorization: Bearer <PIKIT_HTTP_TOKEN>`, read from `secrets` at start.
 *
 * A message goes through the inbound path (@pikit/contracts' inbound.ts):
 * 1. `http.authenticate`: this channel's stage checks the bearer token. The pipeline is this
 *    component's own (declared in `routes.ts`): how a sender proves who it is depends on the platform,
 *    so it is not a shared contract. A project extension adds a stage to it, as to any pipeline.
 * 2. The body becomes an `InboundMessage`, and `admitInbound` takes it the way every channel does:
 *    `inbound.normalize`, `route.resolve` (a router picks the agent), the conversation
 *    `http:<conversationId>`, and `agent.runtime.dispatch`: Pi takes the message. An idle
 *    conversation starts a run. A busy one queues it as a follow-up: the next run answers it, with
 *    every other message that waited. A message a stage stops gets `422` (a policy in `inbound.normalize`) or `403`
 *    (`route.resolve`, or the router's deny); no router installed is `500 no_route`.
 *
 * The POST then waits for the answer, up to `replyTimeoutMs`:
 * - `200 { requestId, text }`: the run answered it. The answer's parts (a question a tool asked) are
 *   in `text`, as their fallbacks: this channel draws none (`foldParts`).
 * - `202 { requestId }`: no answer in time, or the server is stopping. The answer still lands in
 *   the conversation's session; nothing is lost.
 * - `502 { requestId, error }`: the run failed. `409 { error: "aborted" }`: it was stopped.
 *   `502 { requestId, error: "abandoned" }`: the runtime gave up on it (its agent or session is gone,
 *   or it waited too long): it was never answered and never will be; send it again.
 * - A `messageId` already in the conversation does not run again. With `agent.submissions` installed
 *   (runtime-pi provides it), the POST answers with its outcome, as above (`202` while it is still
 *   running). Without it, `409 { requestId, error: "duplicate" }`: its answer went to the POST that
 *   sent it first.
 *
 * `GET /v1/conversations/:id/messages/:messageId`, with `agent.submissions` installed: what became of
 * a message, as its POST would have answered (`200` / `202` / `502` / `409 aborted`), or `404` when
 * the conversation's current session has no such message (never sent, or sent before a reset).
 * Without it: `501`, since nothing keeps the outcome of a message outside its session.
 *
 * Delivery `[decision]`: the answer is returned in the HTTP response, not queued in `outbound.queue`
 * (`outbound-durable`) and sent by a `ChannelTransport`, as a chat channel's is. The channel
 * listens to `agent.settled` / `agent.failed` itself and answers every POST waiting for one of the
 * run's `requestIds`. The map of waiting POSTs is a cache: the answer is in the session anyway, and
 * in `agent.submissions` when installed.
 * Guarantee: a message accepted by `dispatch` (any answer but 4xx/5xx before it) is in the session
 * and will be answered there, at least once.
 *
 * Who a conversation is with, for the dashboard (its stage of `conversation.describe`): its client's
 * conversation id, all the channel knows of it.
 *
 * Targets: `server` and `durable`. It never reads the target: in `start`, `actor.inbox`'s `scope` says
 * where it runs.
 * - **On a server** (`"all"`, or no `actor.inbox`): this export is everything. Its routes hand each
 *   request to the backend in process (`createLocalBackend`, `backend.ts`).
 * - **On Cloudflare** (`"one"`, each conversation's Durable Object): the Worker's half (`worker.ts`)
 *   serves the routes and calls the conversation's object (`actor.mailbox.call`); here `actor.inbox`
 *   answers those calls with the same local backend: the message is admitted in the object, and the
 *   call waits for its answer there, inside the RPC's event (`answerCalls`). The routes are registered
 *   here too, where no server serves them, and call their conversation's object as the Worker's do.
 */

import { defineComponent } from "@pikit/core";
import { type AgentResult, type ConversationParty, describeStage } from "@pikit/contracts";
import Type from "typebox";
import { type Digest, readToken } from "./auth.ts";
import { answerCalls, createLocalBackend, createRemoteBackend, type HttpBackend } from "./backend.ts";
import { CONVERSATION_ID } from "./body.ts";
import { Replies } from "./replies.ts";
import { CHANNEL, provideRoutes } from "./routes.ts";

export { CALL } from "./backend.ts";
export { CHANNEL, conversationKey } from "./routes.ts";
export { worker, WORKER_NAME } from "./worker.ts";

const Config = Type.Object({
  /** How long a POST waits for the agent's answer before `202`. */
  replyTimeoutMs: Type.Integer({ minimum: 1, default: 120_000 }),
});

/**
 * Who a conversation of this channel is with (`conversation.describe`): the client's own conversation
 * id, which is all the channel knows (its sender is the token's bearer). `undefined` for another key.
 */
export function describeKey(key: string): ConversationParty | undefined {
  const conversationId = key.startsWith(`${CHANNEL}:`) ? key.slice(CHANNEL.length + 1) : "";
  if (!new RegExp(CONVERSATION_ID).test(conversationId)) return undefined;
  return { name: conversationId, detail: "HTTP API", ids: [{ label: "Conversation id", value: conversationId }] };
}

export default defineComponent({
  name: "channel-http",
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    const conversations = pikit.use("conversations.registry");
    const runtime = pikit.use("agent.runtime");
    // Optional: with it, a message's outcome can be read later (GET), and a repeated POST answers it.
    const submissions = pikit.useOptional("agent.submissions");
    // Where it runs (`scope`); in one key's actor, the routes reach their conversation through the mailbox.
    const inbox = pikit.useOptional("actor.inbox");
    const mailbox = pikit.useOptional("actor.mailbox");
    const replies = new Replies();
    const local = createLocalBackend({
      conversations: () => conversations.get(),
      runtime: () => runtime.get(),
      submissions: () => submissions.get(),
      replies,
      replyTimeoutMs: config.replyTimeoutMs,
    });
    /** The token's digest, from start to stop. No token, no requests. */
    let token: Digest | undefined;
    /** Where this App's routes send requests: in process, or the conversation's actor. */
    let backend: HttpBackend = local;

    // Answers come from the runtime's events, for runs whoever started them.
    const deliver = (result: AgentResult): void => replies.answer(result);
    pikit.on("agent.settled", deliver);
    pikit.on("agent.failed", deliver);

    provideRoutes(pikit, { token: () => token, backend: () => backend });

    // Who its conversations are with, for the dashboard: the client's conversation id.
    pikit.pipeline("conversation.describe", describeStage({ describe: async (key) => describeKey(key) }), { id: "channel-http" });

    return {
      async start() {
        const read = await readToken((name) => secrets.get().get(name));
        const actors = inbox.get();
        if (actors !== undefined && actors.scope === "one") {
          // One key's actor (a Durable Object): it answers the Worker's calls for its conversation, and
          // its own routes, which no server serves, call their conversation's actor as the Worker's do.
          const box = mailbox.get();
          if (box === undefined) throw new Error("channel-http: in an App that is one conversation's actor, its routes reach their conversations through actor.mailbox, which is not installed");
          answerCalls(actors, local);
          backend = createRemoteBackend(() => box);
        } else backend = local;
        token = read;
      },
      stop() {
        token = undefined;
        backend = local;
      },
    };
  },
});
