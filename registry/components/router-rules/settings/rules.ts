/**
 * The Routing section's logic, apart from React (pure, no imports, so a test reads it as it is): a rule
 * as router-rules stores it, the channels an App has, what is wrong with a list of rules, and the edits
 * the "By agent" view makes (a chat added to an agent, moved to another, taken away), which keep the
 * order's meaning: first match wins.
 */

/**
 * One rule, as router-rules stores it: what it matches (a channel; chats, `conversations`, and senders,
 * `actors`, any one of a list), then an agent, or a refusal and its reason.
 */
export type Rule = { channel?: string; conversations?: string[]; actors?: string[]; agent?: string; deny?: true; reason?: string };

/** A rule's lists of ids: its chats and its senders. */
export type IdField = "conversations" | "actors";

/** The ids in a pasted or typed text: split at spaces, new lines, commas and semicolons, each once, in order. */
export function idsIn(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).filter((id) => id !== ""))];
}

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

/** A list as stored: each id trimmed, the empty ones gone, each once. */
const idList = (ids: readonly string[]) => [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ""))];

/**
 * A rule as stored: its texts trimmed, an empty channel gone, each list's ids trimmed and once; an
 * agent, or a refusal and its reason. A list left with no id stays (empty): taking it away would make
 * the rule match every chat, so `problemsOf` says it is an error instead.
 */
export function cleaned(rule: Rule): Rule {
  const channel = text(rule.channel);
  const reason = text(rule.reason);
  return {
    ...(channel !== undefined && { channel }),
    ...(rule.conversations !== undefined && { conversations: idList(rule.conversations) }),
    ...(rule.actors !== undefined && { actors: idList(rule.actors) }),
    ...(rule.deny === true ? { deny: true as const, ...(reason !== undefined && { reason }) } : { agent: rule.agent ?? "" }),
  };
}

/** Whether `channel` (a rule's) takes a message of `of` (another rule's channel): router-rules' `matchesChannel`. */
const channelTakes = (channel: string, of: string) => of === channel || (!channel.includes(":") && of.startsWith(`${channel}:`));

/** Whether a list of `earlier` takes every id `later`'s takes: no list takes any; a list, only its own. */
const within = (earlier: readonly string[] | undefined, later: readonly string[] | undefined) => earlier === undefined || (later !== undefined && later.every((id) => earlier.includes(id)));

/** Whether every message rule `later` matches is matched by `earlier` first (both cleaned). */
export function covers(earlier: Rule, later: Rule): boolean {
  if (earlier.channel !== undefined && (later.channel === undefined || !channelTakes(earlier.channel, later.channel))) return false;
  return within(earlier.conversations, later.conversations) && within(earlier.actors, later.actors);
}

/** An id of a rule's list that an earlier rule always takes first: here it never matches. */
export interface Shadowed {
  field: IdField;
  id: string;
  /** The place of the rule that takes it first. */
  by: number;
}

/** What is wrong with a rule: an `error` keeps the list from being saved; a `warning` does not. */
export interface Problem {
  level: "error" | "warning";
  text: string;
  /** The ids of its lists an earlier rule takes first (some, not all: then the whole rule is never used). */
  shadowed?: Shadowed[];
}

const NOUN: Record<IdField, [string, string]> = { conversations: ["chat", "chats"], actors: ["sender", "senders"] };

/**
 * What is wrong with each rule, by its place (`undefined`: nothing): no agent chosen, a channel with a
 * space, a list with no id (it would match nothing), an agent that is not one of `agents` now (when
 * they are known), a rule an earlier one always takes first (never used), and ids of its lists an
 * earlier rule takes first (a chat listed in two rules: here it never matches).
 */
export function problemsOf(rules: readonly Rule[], agents?: readonly string[]): (Problem | undefined)[] {
  const stored = rules.map(cleaned);
  return stored.map((rule, index): Problem | undefined => {
    if (rule.deny !== true && (rule.agent === undefined || rule.agent === "")) return { level: "error", text: "Choose an agent, or refuse these messages." };
    if (rule.channel !== undefined && /\s/.test(rule.channel)) return { level: "error", text: "A channel has no spaces: web, telegram, telegram:support." };
    for (const field of ["conversations", "actors"] as const) {
      if (rule[field]?.length === 0) return { level: "error", text: `No ${NOUN[field][1]} listed: add one, or take the condition away.` };
    }
    const before = stored.slice(0, index);
    const earlier = before.findIndex((each) => covers(each, rule));
    if (earlier !== -1) return { level: "warning", text: `Never used: rule ${earlier + 1} above takes these messages first. Move this one above it.` };
    const shadowed = shadowedIn(before, rule);
    if (shadowed.length > 0) {
      const [first] = shadowed;
      const text =
        shadowed.length === 1 && first !== undefined
          ? `${first.id}: rule ${first.by + 1} above takes this ${NOUN[first.field][0]} first, so here it never matches.`
          : `${shadowed.length} of these are taken first by rules above (${[...new Set(shadowed.map((each) => each.by + 1))].map((n) => `rule ${n}`).join(", ")}), so here they never match.`;
      return { level: "warning", text, shadowed };
    }
    if (rule.deny !== true && agents !== undefined && rule.agent !== undefined && !agents.includes(rule.agent)) {
      return { level: "warning", text: `No agent is named ${rule.agent} now: these messages are refused until it is changed.` };
    }
    return undefined;
  });
}

/** The ids of `rule`'s lists that one of `before` (cleaned, in order) takes first: the rule with only that id is covered. */
function shadowedIn(before: readonly Rule[], rule: Rule): Shadowed[] {
  const found: Shadowed[] = [];
  for (const field of ["conversations", "actors"] as const) {
    for (const id of rule[field] ?? []) {
      const by = before.findIndex((each) => covers(each, { ...rule, [field]: [id] }));
      if (by !== -1) found.push({ field, id, by });
    }
  }
  return found;
}

/** What a rule decides: an agent's name, or `DENIED` for a refusal. */
export const DENIED = "!deny";
export const outcomeOf = (rule: Rule): string => (rule.deny === true ? DENIED : (rule.agent ?? ""));

/** The rules of one outcome, for the "By agent" view: the agent (or `DENIED`) and its rules' places, in order. */
export interface Group {
  outcome: string;
  rules: number[];
}

/** The rules grouped by what they decide, each agent in the order its first rule comes, the refusals last. */
export function groupsOf(rules: readonly Rule[]): Group[] {
  const groups = new Map<string, number[]>();
  rules.forEach((rule, index) => {
    const outcome = outcomeOf(rule);
    groups.set(outcome, [...(groups.get(outcome) ?? []), index]);
  });
  const all = [...groups].map(([outcome, places]) => ({ outcome, rules: places }));
  return [...all.filter((group) => group.outcome !== DENIED), ...all.filter((group) => group.outcome === DENIED)];
}

/** The other list of a rule. */
const otherOf = (field: IdField): IdField => (field === "conversations" ? "actors" : "conversations");

/** Whether `rule` lists only ids of `field` on `channel` (and has no other condition): a list the "By agent" view adds to and takes from. */
export const isListOf = (rule: Rule, channel: string | undefined, field: IdField): boolean =>
  rule.channel === channel && rule[field] !== undefined && rule[otherOf(field)] === undefined;

/** `rules` without `id` in the list `field` of the rule at `index`; a rule left with no id is taken away (it would match nothing). */
export function withoutId(rules: readonly Rule[], index: number, field: IdField, id: string): Rule[] {
  return rules.flatMap((rule, at) => {
    const list = rule[field];
    if (at !== index || list === undefined) return [rule];
    const left = list.filter((each) => each !== id);
    return left.length === 0 ? [] : [{ ...rule, [field]: left }];
  });
}

/**
 * `rules` with `ids` (chats or senders of `channel`) decided by `outcome` (an agent's name, or
 * `DENIED`), as the "By agent" view adds and moves them:
 *
 * - each id is taken out of the other rules that list only ids of that channel (`isListOf`): a chat is
 *   one agent's, never two (a rule left with none is taken away);
 * - they join the first rule of `outcome` that is such a list;
 * - with none, a new rule `{ channel, [field]: ids }` of `outcome` goes right before the first rule that
 *   would take all its messages first (a catch-all of the channel, a refusal of every other chat), or
 *   last when none would: a new rule is never added where it can never match.
 *
 * `at` is the place of the rule they are in now.
 */
export function placeIds(rules: readonly Rule[], outcome: string, channel: string | undefined, field: IdField, ids: readonly string[]): { rules: Rule[]; at: number } {
  const wanted = idList(ids);
  const decides = (rule: Rule) => outcomeOf(rule) === outcome;
  const target = rules.findIndex((rule) => decides(rule) && isListOf(rule, channel, field));
  const next: (Rule | undefined)[] = rules.map((rule, at) => {
    if (at === target) return { ...rule, [field]: [...new Set([...(rule[field] ?? []), ...wanted])] };
    if (!isListOf(rule, channel, field)) return rule;
    const left = (rule[field] ?? []).filter((id) => !wanted.includes(id));
    return left.length === (rule[field] ?? []).length ? rule : left.length === 0 ? undefined : { ...rule, [field]: left };
  });
  if (target !== -1) {
    const kept = next.filter((rule): rule is Rule => rule !== undefined);
    return { rules: kept, at: target - next.slice(0, target).filter((rule) => rule === undefined).length };
  }
  const kept = next.filter((rule): rule is Rule => rule !== undefined);
  const added: Rule = { ...(channel !== undefined && { channel }), [field]: wanted, ...(outcome === DENIED ? { deny: true as const } : { agent: outcome }) };
  const before = kept.findIndex((rule) => covers(cleaned(rule), added));
  const at = before === -1 ? kept.length : before;
  return { rules: [...kept.slice(0, at), added, ...kept.slice(at)], at };
}

/** `list` with the item at `from` moved to `to`. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}
