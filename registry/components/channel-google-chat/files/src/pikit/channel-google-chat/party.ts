// Owner: admission. Who a conversation is with, for the dashboard (`conversation.describe`).
/**
 * What the events already said, never asked of Google: each message the handler takes from an allowed
 * space keeps what it says of its space (`rememberSpace`: its kind, its display name, and in a direct
 * message the person's display name) in the channel's namespace of `storage.kv`, under
 * `party:<space>`, written only when it changed. On Cloudflare that is the conversation's object's
 * storage, where admin-api asks too. The describer reads it back for a key of one of its instances
 * (`parseConversationKey`): the space's name (a person's in a direct message), what kind of chat it is,
 * and its ids: the space, the thread of a thread's key, the app when it is a named one. A space it has
 * no record of (one from before) is described by its key.
 */

import type { AppContext } from "@pikit/core";
import type { ConversationDescriber, ConversationParty, KeyValueStore } from "@pikit/contracts";
import type { ChatSpace, ChatUser } from "./event.ts";
import { type Instance, parseConversationKey } from "./instance.ts";

/** What a space's latest message said of it. */
export type SeenSpace = {
  /** `dm`: a direct message with the app; `group`: a group chat with no name; `space`: a named space. */
  kind: "dm" | "group" | "space";
  displayName?: string;
  /** In a direct message, the person's display name. */
  person?: string;
};

/** Where what a space's messages said of it is kept. */
export const partyKey = (space: string): string => `party:${space}`;

/** The longest name kept (Google's display names are at most 128 characters). */
const KEPT = 256;
const kept = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed.slice(0, KEPT);
};

/** What a message of `sender` in `space` says of the space. */
export function seenSpaceOf(space: ChatSpace, sender: ChatUser): SeenSpace {
  const direct = space.spaceType === "DIRECT_MESSAGE" || space.type === "DM" || space.singleUserBotDm === true;
  const displayName = kept(space.displayName);
  if (direct) {
    const person = kept(sender.displayName);
    return { kind: "dm", ...(person !== undefined && { person }) };
  }
  return { kind: space.spaceType === "GROUP_CHAT" ? "group" : "space", ...(displayName !== undefined && { displayName }) };
}

/** Keeps what a message says of its space, when it changed. Never throws: a failure is logged, and the message goes on. */
export async function rememberSpace(store: KeyValueStore, space: ChatSpace, sender: ChatUser, ctx: AppContext): Promise<void> {
  try {
    const seen = seenSpaceOf(space, sender);
    const before = await store.get<SeenSpace>(partyKey(space.name));
    if (before === undefined || JSON.stringify(before) !== JSON.stringify(seen)) await store.set(partyKey(space.name), seen);
  } catch (error) {
    ctx.logger.warn("channel-google-chat: who a space is with was not kept; its next message keeps it", { space: space.name, error: error instanceof Error ? error.message : String(error) });
  }
}

const DETAIL: Record<SeenSpace["kind"], string> = { dm: "Direct message", group: "Group chat", space: "Space" };

/** Who the conversation of `instance` in `space` (and `thread`) is with, from what its messages said (`seen`, when any). */
export function partyOf(instance: Instance, space: string, thread: string | undefined, seen: SeenSpace | undefined): ConversationParty {
  const name = seen?.kind === "dm" ? seen.person : seen?.displayName;
  return {
    ...(name !== undefined && { name }),
    ...(seen !== undefined && { detail: DETAIL[seen.kind] ?? "Space" }),
    ids: [
      { label: "Space", value: space },
      ...(thread === undefined ? [] : [{ label: "Thread", value: thread }]),
      ...(instance.name === undefined ? [] : [{ label: "App", value: instance.name }]),
    ],
    ...(instance.name !== undefined && { instance: instance.name }),
  };
}

/** The describer of the conversations of `instances`, over the channel's namespace of `storage.kv` (`store`). */
export function createDescriber(instances: readonly Instance[], store: () => KeyValueStore): ConversationDescriber {
  return {
    async describe(key, ctx) {
      // Google's names have no spaces or controls: a key with one is none this channel made.
      const parts = /[\s\p{Cc}]/u.test(key) ? undefined : parseConversationKey(key);
      const instance = parts === undefined ? undefined : instances.find((each) => each.instance === parts.instance);
      if (parts === undefined || instance === undefined) return undefined;
      // A record that cannot be read: described by the key.
      const seen = await store()
        .get<SeenSpace>(partyKey(parts.space))
        .catch((error: unknown) => {
          ctx.logger.warn("channel-google-chat: who a space is with could not be read", { space: parts.space, error: error instanceof Error ? error.message : String(error) });
          return undefined;
        });
      return partyOf(instance, parts.space, parts.thread, seen);
    },
  };
}
