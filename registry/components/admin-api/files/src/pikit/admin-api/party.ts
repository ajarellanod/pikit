/**
 * Who a conversation is with (`ApiParty`), for the list and a conversation's page: its channel's stage
 * of the `conversation.describe` pipeline (through `describeConversation`, which cleans what it says),
 * else what its key says. It runs where the conversation is (on Cloudflare its object, where the
 * channel's object half and its storage are), with `described` (`backend.ts`).
 *
 * - **The dashboard's own** (`dashboard:<uuid>`) are described here: "Dashboard", the operator.
 * - **Described by its channel:** the describer's name, detail, ids and link, and its instance.
 * - **No stage knows it** (its channel's component is not installed, or it does not know the key): the
 *   channel's label from its kind (`CHANNEL_LABELS`), its instance from the channel recorded with the
 *   key (`telegram:ops` of `telegram:ops:12`), and the rest of the key as its "Chat id".
 *
 * Whichever, the conversation key ("Key") and the runtime's id ("Conversation") come last.
 */

import type { AppContext } from "@pikit/core";
import { channelKindOf, describeConversation } from "@pikit/contracts";
import { type ApiParty, isDashboardKey } from "./api.ts";

/** How each channel kind reads; another is its kind, capitalized. */
export const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  web: "Web chat",
  telegram: "Telegram",
  googlechat: "Google Chat",
  http: "HTTP API",
  dashboard: "Dashboard",
  delegate: "Delegated task",
  email: "Email",
};

const labelOf = (kind: string): string => CHANNEL_LABELS[kind] ?? (kind === "" ? "Unknown channel" : kind.charAt(0).toUpperCase() + kind.slice(1));

/**
 * Who the conversation `key` (the runtime's `conversationId`) is with. `channel` is the channel
 * recorded with the key (`ConversationRef.channel`), when there is one. Never throws.
 */
export async function partyOf(key: string, conversationId: string, channel: string | undefined, ctx: AppContext): Promise<ApiParty> {
  const own = [
    { label: "Key", value: key },
    { label: "Conversation", value: conversationId },
  ];
  if (isDashboardKey(key)) return { channel: { kind: "dashboard", label: labelOf("dashboard") }, name: "Operator", ids: own };
  const kind = channelKindOf(key) ?? "";
  const described = await describeConversation(ctx, key);
  if (described !== undefined) {
    return {
      channel: { kind, ...(described.instance !== undefined && { instance: described.instance }), label: labelOf(kind) },
      ...(described.name !== undefined && { name: described.name }),
      ...(described.detail !== undefined && { detail: described.detail }),
      ids: [...described.ids, ...own],
      ...(described.link !== undefined && { link: described.link }),
    };
  }
  // What the key says: its recorded channel's instance (`telegram:ops`), and the rest of it.
  const recorded = channel !== undefined && kind !== "" && channel.startsWith(`${kind}:`) && key.startsWith(`${channel}:`) ? channel : undefined;
  const instance = recorded?.slice(kind.length + 1);
  const rest = recorded !== undefined ? key.slice(recorded.length + 1) : kind === "" ? "" : key.slice(kind.length + 1);
  return {
    channel: { kind: kind === "" ? "unknown" : kind, ...(instance !== undefined && instance !== "" && { instance }), label: labelOf(kind) },
    ids: [...(rest === "" ? [] : [{ label: "Chat id", value: rest }]), ...own],
  };
}
