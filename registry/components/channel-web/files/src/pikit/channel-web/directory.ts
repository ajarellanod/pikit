/**
 * channel-web as a view of `conversations.directory` (features/conversation-directory.md, "admin-api and
 * channel-web as views"): which conversations a user sees and what they may do to them is the
 * directory's, read with a people `Viewer` built here from the session, in one place (`viewerOf`).
 *
 * - **The viewer is the session's**: `{ channel: "web", id, name }` first (whose own state "Hide for me"
 *   and read marks are), then the same person's other identities (`principals.of`, when installed),
 *   never of the `dashboard` or `delegate` channel (the directory refuses those for people).
 * - **A chat as the page reads it** (`chatOf`): the entry's title (one everywhere; `UNTITLED` while it
 *   has none), its state for everyone (`archived`), this user's own (`hidden`, `unread`), who started it
 *   (`userId`, `mine`) and what this user may do to it for everyone (`may`: `permissionsOf`).
 * - **A removed user's chats** (`deleteChatsOf`): deleted for everyone by the channel itself (a
 *   component viewer), each key started over.
 */

import type { AppContext } from "@pikit/core";
import {
  type ConversationDirectory,
  type DirectoryEntry,
  type DirectoryListState,
  type EntryRef,
  NOT_PEOPLE_CHANNELS,
  type Principal,
  PRINCIPAL_NAME_MAX,
  type Principals,
  samePrincipal,
  VIEWER_PRINCIPALS_MAX,
  type Viewer,
} from "@pikit/contracts";
import type { AccountUser } from "./accounts/types.ts";
import type { ChatConversation } from "./api.ts";
import { CHANNEL, parseKey, projectOfSpace } from "./chat.ts";

/** A conversation with no title yet (its first message a command, or images only): what the page shows. */
export const UNTITLED = "New conversation";

/** The channel itself, as trusted code (`Viewer` `component`): counts, a removed user's chats. */
export const CHANNEL_VIEWER: Viewer = { kind: "component", name: "channel-web" };

export type PeopleViewer = Extract<Viewer, { kind: "people" }>;

/** `user` as a person: their principal (`{ channel: "web", id, name }`) and the directory's viewer (their other identities after it). */
export async function viewerOf(user: AccountUser, principals: Principals | undefined, ctx: AppContext): Promise<{ principal: Principal; viewer: PeopleViewer }> {
  const name = user.name.replace(/\s+/g, " ").trim().slice(0, PRINCIPAL_NAME_MAX);
  const principal: Principal = { channel: CHANNEL, id: user.id, ...(name !== "" && { name }) };
  const others = principals === undefined ? [] : await principals.of({ channel: CHANNEL, id: user.id }, ctx);
  const kept = others.filter((each) => !samePrincipal(each, principal) && !NOT_PEOPLE_CHANNELS.includes(each.channel) && each.channel !== "" && each.id !== "");
  return { principal, viewer: { kind: "people", principals: [principal, ...kept].slice(0, VIEWER_PRINCIPALS_MAX) } };
}

/** The ref of an entry (what `rename`, `setState` and `mine` take). */
export const refOfEntry = (entry: DirectoryEntry): EntryRef => ({ key: entry.key, conversationId: entry.conversationId });

/** `entry` (a `web:` key's) as `userId` reads it; `undefined` for a key of no web chat. */
export function chatOf(entry: DirectoryEntry, userId: string): ChatConversation | undefined {
  const parsed = parseKey(entry.key);
  if (parsed === undefined) return undefined;
  const project = projectOfSpace(entry.space);
  return {
    id: parsed.chatId,
    title: entry.title ?? UNTITLED,
    busy: entry.busy,
    archived: entry.state === "archived",
    hidden: entry.mine?.hidden === true,
    lastActivity: entry.lastActivity,
    createdAt: entry.createdAt,
    unread: entry.mine?.unread ?? 0,
    userId: parsed.userId,
    mine: parsed.userId === userId,
    may: { ...entry.may },
    ...(entry.agent !== "" && { agent: entry.agent }),
    ...(project !== "" && { project }),
  };
}

/** The list asked by `?archived=1` (archived for everyone) or `?hidden=1` (hidden for me), else the listed ones. */
export function stateAsked(params: URLSearchParams): DirectoryListState | undefined {
  const archived = params.get("archived");
  const hidden = params.get("hidden");
  if ((archived !== null && archived !== "1" && archived !== "0") || (hidden !== null && hidden !== "1" && hidden !== "0")) return undefined;
  if (archived === "1" && hidden === "1") return undefined;
  return archived === "1" ? "archived" : hidden === "1" ? "hidden" : "listed";
}

/** How many pages of a removed user's chats are read, at most, per list. */
const REMOVED_PAGES = 20;

/**
 * Every chat `userId` owns, deleted for everyone by the channel (their account is gone): read as them
 * (their own, every list), then each one `setState(component, deleted)`, which starts its key over. How
 * many. Never rejects: a failure is logged (an operator deletes what is left from the dashboard) and
 * the rest go on.
 */
export async function deleteChatsOf(directory: ConversationDirectory, userId: string, ctx: AppContext): Promise<number> {
  const viewer: Viewer = { kind: "people", principals: [{ channel: CHANNEL, id: userId }] };
  const refs = new Map<string, EntryRef>();
  try {
    for (const state of ["listed", "archived", "hidden"] as const) {
      let cursor: string | undefined;
      for (let page = 0; page < REMOVED_PAGES; page++) {
        const read = await directory.list(viewer, { owned: true, channels: [CHANNEL], state, limit: 100, ...(cursor !== undefined && { cursor }) }, ctx);
        for (const entry of read.items) refs.set(`${entry.key}\n${entry.conversationId}`, refOfEntry(entry));
        cursor = read.next;
        if (cursor === undefined) break;
      }
    }
  } catch (error) {
    ctx.logger.warn("channel-web: a removed user's chats could not all be listed; an operator deletes what is left from the dashboard", { user: userId, error: error instanceof Error ? error.message : String(error) });
  }
  let deleted = 0;
  for (const ref of refs.values()) {
    try {
      await directory.setState(CHANNEL_VIEWER, ref, "deleted", ctx);
      deleted++;
    } catch (error) {
      ctx.logger.warn("channel-web: a removed user's chat could not be deleted; an operator deletes it from the dashboard", {
        user: userId,
        conversation: ref.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return deleted;
}
