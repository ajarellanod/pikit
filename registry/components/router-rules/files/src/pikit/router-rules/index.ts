/**
 * router-rules: each message goes to the agent of the first rule it matches (SPEC §5, "Routing to
 * many agents").
 *
 * It adds a stage to `route.resolve` at priority 1: after the project stages the docs show (10 and
 * up), which can still route around it, and right before `router-basic` (0), which answers what no
 * rule matched. A message no rule matches is left undecided, so without `router-basic` it is
 * `no_route`. A decision an earlier stage made is left as it is.
 *
 * Rules are values, not strategies (S7): choosing the agent from the chat itself is another
 * component. A rule matches on `channel` (an instance, `telegram:support`, or a kind, `telegram`,
 * which matches every account of it), `conversation` and `actor`; a rule with none of them matches
 * everything. `thread` waits for `InboundMessage.threadId`: until then a rule naming it is invalid
 * config rather than a rule that silently matches every thread.
 *
 * A `deny` rule decides `{ agent: "", access: "deny" }`: `RouteDecision.agent` is required, and a
 * denied message has no agent. `admitInbound` never reads it for a deny; the channel refuses the
 * message (`403 denied`, "Sorry, I can't answer that here.").
 *
 * It refuses to start when a rule names an agent that is not an `agent.definition`.
 *
 * Targets: `server` and `cloudflare` (it imports nothing platform-specific).
 */

import { defineComponent, type InboundMessage } from "@pikit/core";
import Type, { type Static } from "typebox";

/** What a rule matches on. Each field it gives must match; none given matches every message. */
const match = {
  /** A channel instance (`telegram:support`), or a kind (`telegram`) for all of its accounts. */
  channel: Type.Optional(Type.String({ minLength: 1 })),
  /** `InboundMessage.conversationId`: a chat, an HTTP client's conversation. */
  conversation: Type.Optional(Type.String({ minLength: 1 })),
  /** `InboundMessage.actor.id`: who sent it. */
  actor: Type.Optional(Type.String({ minLength: 1 })),
};

// Unknown fields are rejected, so a rule cannot give both `agent` and `deny`, or neither, and a typo
// in a match field is an error instead of a catch-all.
const Rule = Type.Union([
  Type.Object({ ...match, agent: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ ...match, deny: Type.Literal(true), reason: Type.Optional(Type.String()) }, { additionalProperties: false }),
]);

type Rule = Static<typeof Rule>;

const Config = Type.Object({
  /** In order: the first rule that matches decides. */
  rules: Type.Array(Rule, { minItems: 1 }),
});

function matches(rule: Rule, message: InboundMessage): boolean {
  if (rule.channel !== undefined && !matchesChannel(rule.channel, message.channel)) return false;
  if (rule.conversation !== undefined && rule.conversation !== message.conversationId) return false;
  if (rule.actor !== undefined && rule.actor !== message.actor.id) return false;
  return true;
}

/** `telegram` matches `telegram` and `telegram:<account>`; `telegram:support` matches only itself. */
function matchesChannel(rule: string, channel: string): boolean {
  return channel === rule || (!rule.includes(":") && channel.startsWith(`${rule}:`));
}

export default defineComponent({
  name: "router-rules",
  config: Config,
  setup(pikit, config) {
    const agents = pikit.useKeyed("agent.definition");

    pikit.pipeline(
      "route.resolve",
      (value) => {
        if (value.decision !== undefined) return value;
        const rule = config.rules.find((candidate) => matches(candidate, value.message));
        if (rule === undefined) return value;
        if ("agent" in rule) return { ...value, decision: { agent: rule.agent, access: "allow" } };
        return { ...value, decision: { agent: "", access: "deny", ...(rule.reason !== undefined && { reason: rule.reason }) } };
      },
      { id: "router-rules", priority: 1 },
    );

    return {
      start() {
        const unknown = [...new Set(config.rules.flatMap((rule) => ("agent" in rule && agents.get(rule.agent) === undefined ? [rule.agent] : [])))];
        if (unknown.length > 0) {
          const known = agents.keys().map((name) => `"${name}"`).join(", ") || "none";
          const names = unknown.map((name) => `"${name}"`).join(", ");
          throw new Error(`router-rules: rules name ${names}, not an agent.definition (agents: ${known})`);
        }
      },
    };
  },
});
