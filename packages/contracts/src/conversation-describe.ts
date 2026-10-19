/**
 * `conversation.describe`: who a conversation is with, as its channel knows it, for an operator (the
 * dashboard's conversations name "Ana López" or "@ana", not `web:3f2a…:9b1c…`). A **pipeline**, not a
 * capability: each channel adds a stage that describes the keys it made and leaves every other value
 * as it is, as each channel's stage of `http.authenticate` acts only on its own requests:
 *
 *   pikit.pipeline("conversation.describe", describeStage({
 *     async describe(key, ctx) {
 *       const chat = chatOf(key);                     // undefined for any key this channel did not make
 *       if (chat === undefined) return undefined;
 *       const seen = await store.get(`party:${key}`); // what the bot already received
 *       return { name: seen?.username, detail: "Direct message", ids: [{ label: "Chat id", value: String(chat) }] };
 *     },
 *   }), { id: "channel-telegram" });
 *
 * - **Why a pipeline:** whoever describes (admin-api) would otherwise depend on every channel, and
 *   channel-web depends on admin-api already (it runs admin-api's `/name`, an `agent.command`): a
 *   keyed capability made that a start-order cycle. A pipeline orders nobody, and needs no provider.
 * - **Value** `{ key, party? }`: a stage that finds a `party` leaves it (the first stage that knows the
 *   key decides); one that does not know the key leaves the value as it is. A channel describes all
 *   its instances (`instance` says which: `ops` of `telegram:ops`), parsing the key itself.
 * - **Where it runs:** where the conversation is (on a server the one App; on Cloudflare the
 *   conversation's Durable Object, where the channel's object half and its `storage.kv` are). A stage
 *   reads only what the channel already has: what its platform sent with a message (a chat's title, a
 *   person's name), kept in its own storage, or its own accounts. It asks its platform nothing.
 * - **What it says:** `name` (the person or the chat, readable), `detail` (one more line: an email, a
 *   group's name, "Direct message"), `ids` (identifiers an operator may need, labelled, in order),
 *   `link` (a dashboard path about this party, relative to the dashboard: `/channel-web?user=…`) and
 *   `instance` (the channel's instance, when not its default). Nothing secret, nothing the person did
 *   not show the channel. A key it made but knows nothing of yet (a conversation from before it kept
 *   names) is described by what the key says (its ids), never a throw.
 * - **Enforced once:** a channel's stage is `describeStage(describer)`: a describer that throws, or
 *   answers something that is not a party, leaves the value as it is (logged), so it never stops
 *   another channel's. A runner reads it only through `describeConversation(ctx, key)`, which never
 *   throws and cleans what it gets (`cleanParty`): control and bidirectional-override characters
 *   replaced, spaces collapsed, `name` and `detail` cut to `PARTY_LIMITS` (with an ellipsis), at most
 *   `PARTY_LIMITS.ids` ids, an id with no label or value or too long left out, a `link` that is not a
 *   dashboard path left out, an `instance` that is not an instance's name left out.
 */

import { type AppContext, Halt } from "@pikit/core";

/** One identifier an operator may need: "Chat id" `12345`. */
export interface PartyId {
  label: string;
  value: string;
}

/** Who a conversation is with, as its channel describes it. */
export interface ConversationParty {
  /** The person or the chat, readable: "Ana López", "@ana", "Ops team". Absent when not known. */
  name?: string;
  /** One more line: an email, a group's or a space's name, "Direct message". */
  detail?: string;
  /** Identifiers an operator may need, in order ("User id", "Chat id", "Space"). */
  ids: PartyId[];
  /** A dashboard page about this party: its path relative to the dashboard (`/channel-web?user=…`), and how it reads. */
  link?: { label: string; path: string };
  /** The channel's instance when it is not the default one: `ops` of `telegram:ops`. */
  instance?: string;
}

/** A channel's describer of its conversations: its stage of `conversation.describe` is `describeStage(describer)`. */
export interface ConversationDescriber {
  /**
   * Who the conversation `key` is with, or `undefined` when `key` is not one this channel made.
   * Reads only what the channel has; never throws for missing data (a key it made but knows nothing
   * of is described by its ids).
   */
  describe(key: string, ctx: AppContext): Promise<ConversationParty | undefined>;
}

/** What `cleanParty` keeps at most: characters of each field, and ids. */
export const PARTY_LIMITS = { name: 80, detail: 120, label: 32, value: 200, ids: 4, linkLabel: 40, path: 300 } as const;

/** A channel's kind, and an instance's name: lowercase letters, digits and `-`, starting with a letter. */
const KIND = /^[a-z][a-z0-9-]*$/;
const MAX_KIND = 64;

/** The channel kind of a conversation key: its text before the first `:` (`telegram` of `telegram:ops:1`), or `undefined` when it has none. */
export function channelKindOf(key: string): string | undefined {
  const at = key.indexOf(":");
  const kind = at === -1 ? "" : key.slice(0, at);
  return kind.length <= MAX_KIND && KIND.test(kind) ? kind : undefined;
}

/** Characters never shown: controls (`\p{Cc}`), and the bidirectional overrides and isolates that reorder text. */
const HIDDEN = new RegExp(`[\\p{Cc}${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}]`, "gu");
const ELLIPSIS = String.fromCharCode(0x2026);

/** `value` as one line: hidden characters replaced by spaces, spaces collapsed, trimmed; `undefined` when not a string or empty. */
function line(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(HIDDEN, " ").replace(/\s+/gu, " ").trim();
  return cleaned === "" ? undefined : cleaned;
}

/** `line(value)`, cut to `max` characters (at a code point, with an ellipsis). */
function cut(value: unknown, max: number): string | undefined {
  const text = line(value);
  if (text === undefined) return undefined;
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join("").trimEnd()}${ELLIPSIS}`;
}

const fieldsOf = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** A dashboard path: `/` then no `/` or `\` first, no spaces or hidden characters, at most `PARTY_LIMITS.path`. */
const isDashboardPath = (path: unknown): path is string =>
  typeof path === "string" && path.length <= PARTY_LIMITS.path && /^\/(?![/\\])\S*$/u.test(path) && !new RegExp(HIDDEN.source, "u").test(path);

/**
 * What a describer answered, as a runner may show it, or `undefined` when it is not a party (not an
 * object): the rules of the header. Never throws.
 */
export function cleanParty(value: unknown): ConversationParty | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const party = value as Record<string, unknown>;
  const name = cut(party.name, PARTY_LIMITS.name);
  const detail = cut(party.detail, PARTY_LIMITS.detail);
  const ids = (Array.isArray(party.ids) ? party.ids : []).flatMap((each): PartyId[] => {
    const id = fieldsOf(each);
    const label = cut(id.label, PARTY_LIMITS.label);
    const shown = line(id.value);
    // An id cut would be a wrong id: one too long is left out.
    return label === undefined || shown === undefined || [...shown].length > PARTY_LIMITS.value ? [] : [{ label, value: shown }];
  });
  const link = fieldsOf(party.link);
  const linkLabel = cut(link.label, PARTY_LIMITS.linkLabel);
  const instance = typeof party.instance === "string" && party.instance.length <= MAX_KIND && KIND.test(party.instance) ? party.instance : undefined;
  return {
    ...(name !== undefined && { name }),
    ...(detail !== undefined && { detail }),
    ids: ids.slice(0, PARTY_LIMITS.ids),
    ...(linkLabel !== undefined && isDashboardPath(link.path) && { link: { label: linkLabel, path: link.path } }),
    ...(instance !== undefined && { instance }),
  };
}

/** The value of `conversation.describe`: a key, and who it is with once a stage knew. */
export interface DescribedConversation {
  key: string;
  party?: ConversationParty;
}

/**
 * A channel's stage of `conversation.describe` over `describer`: a value already described, or a key
 * it does not know, is left as it is; a describer that throws or answers no party leaves it too
 * (a throw logged). Never throws, so a broken channel never stops another's.
 */
export function describeStage(describer: ConversationDescriber): (value: DescribedConversation, ctx: AppContext) => Promise<DescribedConversation> {
  return async (value, ctx) => {
    if (value.party !== undefined) return value;
    try {
      const party = cleanParty(await describer.describe(value.key, ctx));
      return party === undefined ? value : { ...value, party };
    } catch (error) {
      ctx.logger.warn("conversation.describe: a channel's describer failed; the conversation is described by its key", {
        kind: channelKindOf(value.key),
        error: error instanceof Error ? error.message : String(error),
      });
      return value;
    }
  };
}

/**
 * Who the conversation `key` is with: `conversation.describe` run, what a stage set cleaned
 * (`cleanParty`); `undefined` when no stage knew the key, a stage halted or threw (logged). Never throws.
 */
export async function describeConversation(ctx: AppContext, key: string): Promise<ConversationParty | undefined> {
  try {
    const described = await ctx.run("conversation.describe", { key });
    return described instanceof Halt ? undefined : cleanParty(described.party);
  } catch (error) {
    ctx.logger.warn("conversation.describe: the pipeline failed; the conversation is described by its key", { error: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

declare module "@pikit/core" {
  interface AppPipelines {
    /**
     * Who a conversation is with, for an operator: each channel's stage (`describeStage`) sets `party`
     * for the keys it made and leaves every other value, and a `party` already set, as it is.
     */
    "conversation.describe": DescribedConversation;
  }
}
