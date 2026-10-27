/**
 * tool-notify: the agent tool `notify({ to, text })`, for the agents that name it. It sends a
 * Markdown text to a chat the operator named in its config (features/completed/tool-notify.md), and
 * never reads that chat nor gets a reply: send-only.
 *
 * - **A name, never an address.** `to` is one of the configured destinations' names; each is a channel
 *   instance and a conversation key, written out. The model cannot write a chat, a key or a channel.
 * - **Who may send: `from`.** A destination with `from` takes a message only when the calling
 *   conversation's agent and every agent above it in its delegation are in `from` (`callersOf`,
 *   tool-delegate's twin `callers.ts`); a chain that cannot be trusted reaches none (fail closed).
 * - **Enqueued by the destination's actor.** The tool calls `tool-notify.enqueue` on the actor that owns
 *   the destination's key (`actor.mailbox`); this component's `actor.inbox` handler there applies the
 *   destination's rate limit and stores the message in that App's `outbound.queue`: one outbox lane
 *   per chat. On a server every key's actor is the App; on Cloudflare it is the destination's object.
 * - **The idempotency key is the call's**, `answerKey(conversation, "tool-notify:" + callId)`, so
 *   replay is `safe`: a call made again stores nothing twice and is counted once.
 * - **A rate limit per destination** (`maxPerHour`), counted in `storage.kv` by idempotency key; over
 *   it the call is refused (`rate_limited`) with when the next one fits.
 * - **The destination's conversation is never touched**: no admission, no run, no transcript.
 * - **Attribution**: each message starts with the sending agent's name (`**trader:**`), unless the
 *   destination says `attribution: false`. The origin (the chat that led to it) is only logged.
 *
 * Targets: `server` and `durable`: it imports nothing platform-specific.
 */

import { type AppContext, BACKGROUND_CONTEXT, type Context, defineComponent } from "@pikit/core";
import { ActorCallError, type ActorMailbox, answerKey, CONVERSATION, isJsonObject, type JsonValue, originOf } from "@pikit/contracts";
import { defineTool, type ToolRegistration } from "@pikit/pi-adapter/tools";
import Type, { type Static } from "typebox";
import { callersOf } from "./callers.ts";

/** The name agents give it, and its key under `agent.tool`. */
export const NOTIFY_TOOL = "notify";
/** The call its two halves speak: the caller's tool to the destination's actor. */
export const ENQUEUE = "tool-notify.enqueue";
/** The request-id prefix of its idempotency keys: `<conversation id>:tool-notify:<call id>`. */
export const KEY_PREFIX = "tool-notify:";
/** The longest text the model may send, in characters. */
export const TEXT_MAX = 4_000;
const HOUR = 60 * 60 * 1_000;

/** An agent's name: `start` checks it is an `agent.definition`. */
const AgentName = Type.String({ minLength: 1 });
const PerHour = Type.Integer({ minimum: 1, maximum: 1_000 });

const Destination = Type.Object({
  /** The channel instance whose transport sends it (`telegram`, `telegram:ops`, `googlechat`). */
  channel: Type.String({ minLength: 1 }),
  /** The chat, as that channel keys it (`telegram:ops:-100123`, `googlechat:spaces/AAAA`). */
  conversation: Type.String({ minLength: 1 }),
  /** What it is for: what the model reads to pick one. */
  description: Type.String({ minLength: 1 }),
  /** Only these agents may send here, and only when every agent above them in the delegation is one of them. */
  from: Type.Optional(Type.Array(AgentName, { minItems: 1 })),
  /** This destination's limit, instead of the component's. */
  maxPerHour: Type.Optional(PerHour),
  /** `false`: the message is only what the model wrote, without the sending agent's name first. */
  attribution: Type.Optional(Type.Boolean()),
});

const Config = Type.Object(
  {
    /** The chats agents may send to, by name (at least one: `start` checks). */
    destinations: Type.Record(Type.String({ pattern: "^[a-z][a-z0-9]*(-[a-z0-9]+)*$" }), Destination),
    /** Messages per destination per hour, unless the destination says otherwise. */
    maxPerHour: Type.Integer({ minimum: 1, maximum: 1_000, default: 30 }),
  },
  {
    examples: [
      {
        destinations: {
          ops: { channel: "telegram:ops", conversation: "telegram:ops:-100123", description: "The operations group: deploys, pull requests, incidents.", from: ["developer"] },
        },
      },
    ],
  },
);

export type NotifyConfig = Static<typeof Config>;
type DestinationConfig = Static<typeof Destination>;

/** The destination named `name`, or `undefined` (never a property of `Object.prototype`). */
const destinationOf = (config: NotifyConfig, name: string): DestinationConfig | undefined =>
  Object.hasOwn(config.destinations, name) ? config.destinations[name] : undefined;

/** The message as the destination shows it: the sending agent's name first, unless switched off. */
export const attributed = (destination: DestinationConfig, agent: string, text: string): string => (destination.attribution === false ? text : `**${agent}:**\n${text}`);

/** Why `callers` may not send to `name`, or `undefined` when they may. */
function refusal(name: string, destination: DestinationConfig, callers: string[] | undefined): string | undefined {
  const from = destination.from;
  if (from === undefined || (callers !== undefined && callers.every((caller) => from.includes(caller)))) return undefined;
  const who =
    callers === undefined
      ? "this conversation's chain of delegations cannot be verified, so it"
      : `this conversation (${callers.at(-1)}${callers.length > 1 ? `, delegated from ${callers.slice(0, -1).join(" then ")}` : ""})`;
  return `"${name}" takes messages only from ${from.join(", ")}; ${who} may not send there`;
}

/** The tool's description: what it does, and each destination. */
export function notifyDescription(config: NotifyConfig): string {
  return [
    "Sends a message (Markdown) to one of the chats below, by its name. It only sends: you never read that chat, and no reply comes back. It returns once the message is queued for delivery.",
    "The chats:",
    ...Object.entries(config.destinations).map(([name, d]) => `- ${name}: ${d.description}${d.from === undefined ? "" : ` (only from: ${d.from.join(", ")})`}`),
  ].join("\n");
}

/** The `notify` tool for `config`, calling the destinations' actors through `mailbox`; `within` gives a run's context the App's. */
export function createNotifyTool(config: NotifyConfig, mailbox: () => ActorMailbox, within: (context: Context) => AppContext): ToolRegistration {
  const names = Object.keys(config.destinations);
  return defineTool({
    name: NOTIFY_TOOL,
    description: notifyDescription(config),
    parameters: Type.Object({
      to: Type.Union(
        names.map((name) => Type.Literal(name)),
        { description: "The chat to send to." },
      ),
      text: Type.String({ minLength: 1, maxLength: TEXT_MAX, description: "The message, in Markdown." }),
    }),
    replay: "safe",
    async execute(args, api, context) {
      const conversation = context.value(CONVERSATION);
      if (conversation === undefined) throw new Error("notify runs only in a conversation's run");
      const destination = destinationOf(config, args.to);
      if (destination === undefined) throw new Error(`there is no chat "${args.to}" to send to; the chats are: ${names.join(", ")}`);
      if (args.text.trim() === "" || args.text.length > TEXT_MAX) throw new Error(`the text is 1 to ${TEXT_MAX} characters`);
      const callers = callersOf(conversation);
      const refused = refusal(args.to, destination, callers);
      if (refused !== undefined) throw new Error(refused);
      const message = {
        to: args.to,
        idempotencyKey: answerKey(conversation, `${KEY_PREFIX}${api.callId}`),
        text: attributed(destination, conversation.agent, args.text),
        origin: originOf(conversation).key,
        chain: callers ?? null,
      };
      try {
        await mailbox().call(destination.conversation, ENQUEUE, message, within(context));
      } catch (error) {
        throw new Error(`nothing was sent to "${args.to}": ${error instanceof Error ? error.message : String(error)}`);
      }
      return { output: [{ type: "text", text: `Queued for "${args.to}".` }] };
    },
  }) as unknown as ToolRegistration;
}

const invalid = (what: string) => new ActorCallError("invalid", `tool-notify: ${what}`);

export default defineComponent({
  name: "tool-notify",
  config: Config,
  setup(pikit, config) {
    const agents = pikit.useKeyed("agent.definition");
    const mailbox = pikit.use("actor.mailbox");
    const inbox = pikit.use("actor.inbox");
    const queue = pikit.use("outbound.queue");
    const kv = pikit.use("storage.kv");
    let app: AppContext | undefined;
    const within = (context: Context): AppContext => {
      if (app === undefined) throw new Error("tool-notify: used while the App is not running");
      return app.derive(() => context);
    };
    pikit.provideKeyed("agent.tool", NOTIFY_TOOL, { ...createNotifyTool(config, () => mailbox.get(), within), summary: "Sends a message to a chat the operator named" });

    /** One destination's calls one at a time: its count is read, then written. */
    const lines = new Map<string, Promise<unknown>>();
    const serial = <T>(name: string, work: () => Promise<T>): Promise<T> => {
      const next = (lines.get(name) ?? Promise.resolve()).then(work);
      lines.set(name, next.catch(() => {}));
      return next;
    };

    return {
      start(ctx) {
        if (Object.keys(config.destinations).length === 0) throw new Error("tool-notify: its config names no destination: name at least one");
        // Every agent a `from` names is an agent.definition.
        const missing = Object.entries(config.destinations).flatMap(([name, d]) =>
          (d.from ?? []).filter((agent) => agents.get(agent) === undefined).map((agent) => `"${agent}" in the from of "${name}"`),
        );
        if (missing.length > 0) {
          throw new Error(`tool-notify: ${missing.join("; ")} is no agent.definition (agents: ${agents.keys().join(", ") || "none"}): take it out of the config, or define it`);
        }
        app = ctx.derive(() => BACKGROUND_CONTEXT);
        const sent = kv.get().namespace("tool-notify");

        inbox.get().answer(ENQUEUE, async (key, message: JsonValue, callCtx) => {
          if (!isJsonObject(message)) throw invalid("a call is a JSON object");
          const { to, idempotencyKey, text, origin, chain } = message;
          if (typeof to !== "string" || typeof idempotencyKey !== "string" || idempotencyKey === "" || typeof text !== "string" || text === "") {
            throw invalid('"to", "idempotencyKey" and "text" are non-empty strings');
          }
          const destination = destinationOf(config, to);
          if (destination === undefined || destination.conversation !== key) throw invalid(`${key} is not the chat "${to}"`);
          const limit = destination.maxPerHour ?? config.maxPerHour;
          return serial(to, async () => {
            const now = callCtx.clock.now();
            // The last hour's messages, oldest first, by idempotency key: a replayed call is counted once.
            const counted = ((await sent.get<[string, number][]>(`hour:${to}`)) ?? []).filter(([, at]) => at > now - HOUR);
            const known = counted.some(([each]) => each === idempotencyKey);
            if (!known && counted.length >= limit) {
              const next = (counted[counted.length - limit]?.[1] ?? now) + HOUR;
              const minutes = Math.max(1, Math.ceil((next - now) / 60_000));
              throw new ActorCallError("rate_limited", `"${to}" takes at most ${limit} messages an hour; the next one fits in ${minutes} minute${minutes === 1 ? "" : "s"} (${new Date(next).toISOString()})`);
            }
            // Stored first: a refused enqueue (no transport for the channel) counts nothing.
            await queue.get().enqueue({ idempotencyKey, channel: destination.channel, conversationKey: key, text });
            // ponytail: a replay more than an hour after its first call is counted again (the queue still stores it once).
            if (!known) await sent.set(`hour:${to}`, [...counted, [idempotencyKey, now]]);
            callCtx.logger.info(`tool-notify: queued for ${to}`, { origin: typeof origin === "string" ? origin : null, chain: chain ?? null, destination: to });
            return null;
          });
        });
      },
      stop() {
        app = undefined;
      },
    };
  },
});
