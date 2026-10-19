/**
 * The Routing section's logic, apart from React (pure, no imports, so a test reads it as it is): a rule
 * as router-rules stores it, the channels an App has, and what is wrong with a list of rules.
 */

/** One rule, as router-rules stores it: what it matches, then an agent, or a refusal and its reason. */
export type Rule = { channel?: string; conversation?: string; actor?: string; agent?: string; deny?: true; reason?: string };

/** The channel each kit channel component's messages carry (`InboundMessage.channel`'s kind). */
const CHANNEL_OF: Record<string, string> = {
  "channel-web": "web",
  "channel-telegram": "telegram",
  "channel-telegram-webhook": "telegram",
  "channel-http": "http",
  "channel-google-chat": "googlechat",
};

/**
 * Where a component's named instances (`<kind>:<name>`) are in the config: the config keys read, and the
 * field that lists the names. Telegram's are `accounts`; Google Chat's `instances` (in its config, and on
 * Cloudflare its Worker half's too, `channel-google-chat-worker`, which `pikit doctor` keeps the same).
 */
const INSTANCES: Record<string, { keys: readonly string[]; field: string }> = {
  "channel-telegram": { keys: ["channel-telegram"], field: "accounts" },
  "channel-telegram-webhook": { keys: ["channel-telegram-webhook"], field: "accounts" },
  "channel-google-chat": { keys: ["channel-google-chat", "channel-google-chat-worker"], field: "instances" },
};

/**
 * The channels of an App's composition (`ApiApp`), in the order installed: each `channel-*` component's
 * kind (`channel-web` → `web`; another one's name without `channel-`), then its named instances
 * (`telegram:support`, `googlechat:ops`), each once.
 */
export function channelsOf(app: { components: readonly { name: string }[]; config: Record<string, unknown> }): string[] {
  const found: string[] = [];
  for (const { name } of app.components) {
    if (!name.startsWith("channel-")) continue;
    const kind = CHANNEL_OF[name] ?? name.slice("channel-".length);
    found.push(kind);
    const { keys = [], field = "" } = INSTANCES[name] ?? {};
    for (const key of keys) {
      const names = (app.config[key] as Record<string, unknown> | undefined)?.[field];
      if (Array.isArray(names)) for (const each of names) if (typeof each === "string" && each !== "") found.push(`${kind}:${each}`);
    }
  }
  return [...new Set(found)];
}

const text = (value: string | undefined) => (value === undefined || value.trim() === "" ? undefined : value.trim());

/** A rule as stored: its texts trimmed, no empty match field; an agent, or a refusal and its reason. */
export function cleaned(rule: Rule): Rule {
  const channel = text(rule.channel);
  const conversation = text(rule.conversation);
  const actor = text(rule.actor);
  const reason = text(rule.reason);
  return {
    ...(channel !== undefined && { channel }),
    ...(conversation !== undefined && { conversation }),
    ...(actor !== undefined && { actor }),
    ...(rule.deny === true ? { deny: true as const, ...(reason !== undefined && { reason }) } : { agent: rule.agent ?? "" }),
  };
}

/** Whether `channel` (a rule's) takes a message of `of` (another rule's channel): router-rules' `matchesChannel`. */
const channelTakes = (channel: string, of: string) => of === channel || (!channel.includes(":") && of.startsWith(`${channel}:`));

/** Whether every message rule `later` matches is matched by `earlier` first (both cleaned). */
export function covers(earlier: Rule, later: Rule): boolean {
  if (earlier.channel !== undefined && (later.channel === undefined || !channelTakes(earlier.channel, later.channel))) return false;
  if (earlier.conversation !== undefined && earlier.conversation !== later.conversation) return false;
  if (earlier.actor !== undefined && earlier.actor !== later.actor) return false;
  return true;
}

/** What is wrong with a rule: an `error` keeps the list from being saved; a `warning` does not. */
export interface Problem {
  level: "error" | "warning";
  text: string;
}

/**
 * What is wrong with each rule, by its place (`undefined`: nothing): no agent chosen, a channel with a
 * space, an agent that is not one of `agents` now (when they are known), a rule an earlier one always
 * takes first (never used).
 */
export function problemsOf(rules: readonly Rule[], agents?: readonly string[]): (Problem | undefined)[] {
  const stored = rules.map(cleaned);
  return stored.map((rule, index): Problem | undefined => {
    if (rule.deny !== true && (rule.agent === undefined || rule.agent === "")) return { level: "error", text: "Choose an agent, or refuse these messages." };
    if (rule.channel !== undefined && /\s/.test(rule.channel)) return { level: "error", text: "A channel has no spaces: web, telegram, telegram:support." };
    const earlier = stored.slice(0, index).findIndex((each) => covers(each, rule));
    if (earlier !== -1) return { level: "warning", text: `Never used: rule ${earlier + 1} above takes these messages first. Move this one above it.` };
    if (rule.deny !== true && agents !== undefined && rule.agent !== undefined && !agents.includes(rule.agent)) {
      return { level: "warning", text: `No agent is named ${rule.agent} now: these messages are refused until it is changed.` };
    }
    return undefined;
  });
}

/** `list` with the item at `from` moved to `to`. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}
