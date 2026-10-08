/**
 * router-rules: each message goes to the agent of the first rule it matches (`route.resolve`, in
 * @pikit/contracts' inbound.ts).
 *
 * It adds a stage to `route.resolve` at priority 1: after the project stages the docs show (10 and
 * up), which can still route around it, and right before `router-basic` (0), which answers what no
 * rule matched. A message no rule matches is left undecided, so without `router-basic` it is
 * `no_route`. A decision an earlier stage made is left as it is.
 *
 * Rules are values, not strategies (MANIFESTO, principle 8): choosing the agent from the chat itself is another
 * component. A rule matches on `channel` (an instance, `telegram:support`, or a kind, `telegram`,
 * which matches every account of it), `conversation` and `actor`; a rule with none of them matches
 * everything. `thread` waits for `InboundMessage.threadId`: until then a rule naming it is invalid
 * config rather than a rule that silently matches every thread.
 *
 * A `deny` rule decides `{ agent: "", access: "deny" }`: `RouteDecision.agent` is required, and a
 * denied message has no agent. `admitInbound` never reads it for a deny; the channel refuses the
 * message (`403 denied`, "Sorry, I can't answer that here.").
 *
 * **A setting too** (`settings`, when a provider is installed; features/settings.md): an operator edits
 * the rules from the dashboard (its Routing section, `settings/`), live. The config's `rules` are the
 * default, what the project deploys with; the operator's replace them whole, validated as the config's
 * are. They are read at every message this stage routes; settings that cannot be read leave the config's
 * (logged).
 *
 * **Agents.** It refuses to start when a rule of its config names an agent that is not an
 * `agent.definition`, unless `agent.directory` is installed (agents-live: agents that are data): then a
 * name the code does not have may be a live agent, and is checked when a message matches its rule. A
 * rule whose agent is no agent then halts the message (the channel refuses it, saying it cannot take
 * it), logged with why. Without a directory, the rules an operator sets may name only the code's agents.
 *
 * Targets: `server` and `durable` (it imports nothing platform-specific).
 */

import { type AppContext, defineComponent, halt } from "@pikit/core";
import type { InboundMessage, SettingsValue } from "@pikit/contracts";
import Type, { type Static, type TSchema } from "typebox";

/** An agent's name, as `defineAgent` checks it. */
const AGENT_NAME = "^[a-z][a-z0-9]*(-[a-z0-9]+)*$";
/** The most rules an operator may set. */
export const MAX_RULES = 500;

/** What a rule matches on. Each field it gives must match; none given matches every message. */
const match = {
  /** A channel instance (`telegram:support`), or a kind (`telegram`) for all of its accounts. */
  channel: Type.Optional(Type.String({ minLength: 1, title: "Channel", description: "A channel (telegram), or one account of it (telegram:support)." })),
  /** `InboundMessage.conversationId`: a chat, an HTTP client's conversation. */
  conversation: Type.Optional(Type.String({ minLength: 1, title: "Chat", description: "The platform's conversation: a chat's id." })),
  /** `InboundMessage.actor.id`: who sent it. */
  actor: Type.Optional(Type.String({ minLength: 1, title: "Sender", description: "Who sent it: the platform's id of a person." })),
};

/**
 * A rule whose agent is `agent`. Unknown fields are rejected, so a rule cannot give both `agent` and
 * `deny`, or neither, and a typo in a match field is an error instead of a catch-all.
 */
const ruleOf = <Agent extends TSchema>(agent: Agent) =>
  Type.Union([
    Type.Object({ ...match, agent }, { additionalProperties: false }),
    Type.Object({ ...match, deny: Type.Literal(true), reason: Type.Optional(Type.String({ maxLength: 500 })) }, { additionalProperties: false }),
  ]);

const Rule = ruleOf(Type.String({ minLength: 1 }));

type Rule = Static<typeof Rule>;

const Config = Type.Object({
  /** In order: the first rule that matches decides. */
  // Empty by default: installed with no rules, it routes nothing, and router-basic answers everything
  // until rules are written.
  rules: Type.Array(Rule, { default: [] }),
});

/** Its settings: the rules an operator set, in order (default: the config's). */
export type RulesSettings = { rules: Rule[] };

/**
 * The schema of its settings: rules whose agent is one of `agents` (the code's), or, with a directory
 * (`live`), any agent's name, checked when used.
 */
export function rulesSchema(agents: readonly string[], live: boolean): TSchema {
  const agent = live
    ? Type.String({ pattern: AGENT_NAME, title: "Agent" })
    : agents.length === 0
      ? Type.Never()
      : Type.Union([...agents].sort().map((name) => Type.Literal(name)), { title: "Agent" });
  return Type.Object(
    { rules: Type.Array(ruleOf(agent), { maxItems: MAX_RULES, title: "Rules", description: "In order: the first rule a message matches decides." }) },
    { additionalProperties: false },
  );
}

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
    const settings = pikit.useOptional("settings");
    const directory = pikit.useOptional("agent.directory");
    let declared = false;

    /** The rules now: the operator's, else the config's. */
    const rules = async (ctx: AppContext): Promise<readonly Rule[]> => {
      const store = settings.get();
      if (store === undefined || !declared) return config.rules;
      try {
        return (await store.get<RulesSettings>("router-rules", ctx)).rules;
      } catch (error) {
        ctx.logger.warn("router-rules: its settings could not be read; the config's rules apply", { error: error instanceof Error ? error.message : String(error) });
        return config.rules;
      }
    };

    /** Whether `name` is an agent now: the code's, or a live one of the directory. */
    const isAgent = async (name: string, ctx: AppContext): Promise<boolean> => {
      if (agents.get(name) !== undefined) return true;
      const live = directory.get();
      return live !== undefined && (await live.get(name, ctx)) !== undefined;
    };

    pikit.pipeline(
      "route.resolve",
      async (value, ctx) => {
        if (value.decision !== undefined) return value;
        const rule = (await rules(ctx)).find((candidate) => matches(candidate, value.message));
        if (rule === undefined) return value;
        if ("agent" in rule) {
          if (!(await isAgent(rule.agent, ctx))) {
            ctx.logger.warn("router-rules: a rule names an agent that is no agent now; the message is not taken", { agent: rule.agent, channel: value.message.channel });
            return halt(`router-rules: the rule for this message names "${rule.agent}", which is no agent (neither an agent.definition nor a live agent)`);
          }
          return { ...value, decision: { agent: rule.agent, access: "allow" } };
        }
        return { ...value, decision: { agent: "", access: "deny", ...(rule.reason !== undefined && { reason: rule.reason }) } };
      },
      { id: "router-rules", priority: 1 },
    );

    return {
      start() {
        const live = directory.get() !== undefined;
        const named = [...new Set(config.rules.flatMap((rule) => ("agent" in rule ? [rule.agent] : [])))];
        // With a directory, a name the code does not have may be a live agent: checked when used.
        const unknown = named.filter((name) => agents.get(name) === undefined && (!live || !new RegExp(AGENT_NAME).test(name)));
        if (unknown.length > 0) {
          const known = agents.keys().map((name) => `"${name}"`).join(", ") || "none";
          const names = unknown.map((name) => `"${name}"`).join(", ");
          throw new Error(
            live
              ? `router-rules: rules name ${names}, which can be no agent (an agent's name is kebab-case; agents: ${known})`
              : `router-rules: rules name ${names}, not an agent.definition (agents: ${known})`,
          );
        }
        const store = settings.get();
        if (store === undefined) return;
        store.declare("router-rules", rulesSchema(agents.keys(), live), { rules: config.rules } as unknown as SettingsValue);
        declared = true;
      },
      stop() {
        declared = false;
      },
    };
  },
});
