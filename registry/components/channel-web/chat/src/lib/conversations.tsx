/**
 * The user's latest conversations (`GET /chat/api/conversations`), newest activity first, for the
 * sidebar and the tabs: the first `PAGE` (the sidebar's `SIDEBAR_CHATS`), read again every `every(20 s)`
 * while the person is here (busy flags, new titles), never more (every one, and the archived ones, are
 * on the Conversations page, `screens/chats.tsx`); renaming, archiving, hiding and deleting change it at
 * once, and move `changed`, which that page follows. Archiving and deleting are for everyone, as the
 * server lets (`ChatConversation.may`); hiding is for this user only ("Hide for me"). Another member's
 * chat of a project is named with its author (`conversationApi`: `?user=`). A conversation written to here goes first at once
 * (`writtenFirst`), and the list is read again once the message is in (`screens/conversation.tsx`).
 *
 * Also what the pages share: the messages sent and not shown yet (`SentMessages`, the shared
 * conversation view's: New chat's first message shows in the conversation it opens), what the commands
 * typed answered (`CommandNote`: a quiet note in their conversation, this page's only, never in its
 * transcript: New chat's shows in the conversation it made), and the tabs, the
 * conversations opened (as the dashboard's), kept in this browser for this user
 * (`localStorage["pikit-chat-tabs:<user id>"]`: another user signing in here never sees them).
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { type SentMessages, useSentMessages, writtenFirst } from "@/components/pikit/conversation";
import { every } from "./activity.ts";
import type { ChatCommandResult, ChatConversation, ChatPage } from "./chat-api.ts";
import { request, useGet } from "./client.ts";
import { conversationsPath } from "./source.ts";

/** The API path of `conversation` (with `rest`): another member's chat names its author (`?user=`). */
export const conversationApi = (conversation: Pick<ChatConversation, "id" | "userId" | "mine">, rest = ""): string =>
  `/conversations/${encodeURIComponent(conversation.id)}${rest}${conversation.mine ? "" : `?user=${encodeURIComponent(conversation.userId)}`}`;

/** The conversations read: the sidebar's (`SIDEBAR_CHATS`). */
const PAGE = 20;
const POLL_MS = 20_000;
/** Tabs kept. */
const KEPT_TABS = 12;

/** A conversation opened as a tab: its title when last seen (the list's newer one wins). */
export interface Tab {
  id: string;
  title: string;
}

/** What a command typed in a conversation came to, shown there to its user only. */
export interface CommandNote {
  id: number;
  /** The command, without its slash. */
  command: string;
  text: string;
  failed: boolean;
  /** Epoch ms. */
  at: number;
}

let nextNote = 0;

/** What the note says of `result`: its own words, else what came of it. */
function noteOf(result: ChatCommandResult): Omit<CommandNote, "id" | "at"> {
  const failed = result.outcome === "failed";
  const said = result.text?.trim() ?? "";
  const text = said !== "" ? said : result.outcome === "unfinished" ? `/${result.name} is running, or did not finish: it is not run again.` : failed ? `/${result.name} did not work.` : `Ran /${result.name}.`;
  return { command: result.name, text, failed };
}

const tabsKey = (userId: string): string => `pikit-chat-tabs:${userId}`;

function loadTabs(userId: string): Tab[] {
  try {
    const raw = JSON.parse(localStorage.getItem(tabsKey(userId)) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((tab): tab is Tab => typeof tab?.id === "string" && typeof tab?.title === "string") : [];
  } catch {
    return [];
  }
}

export interface Conversations extends SentMessages {
  items: ChatConversation[] | undefined;
  error: Error | undefined;
  /** Whether there are more than `items`: the sidebar's "View all". */
  hasMore: boolean;
  reload(): void;
  /** Moves at each conversation renamed, archived, restored or deleted here: a list of its own reads again. */
  changed: number;
  /** Renames it for everyone (`may.rename`). */
  rename(conversation: ChatConversation, title: string): Promise<ChatConversation>;
  /** Archives it for everyone (listed apart) or restores it (`archived` false): `may.archive`. */
  archive(conversation: ChatConversation, archived: boolean): Promise<ChatConversation>;
  /** Hides it for this user only (listed apart until new activity) or shows it again. */
  hide(conversation: ChatConversation, hidden: boolean): Promise<ChatConversation>;
  /** Deletes it for everyone (`may.delete`). */
  remove(conversation: ChatConversation): Promise<void>;
  /** What the commands typed in conversation `id` answered, oldest first. */
  notesOf(id: string): CommandNote[];
  addNote(id: string, result: ChatCommandResult): void;
  tabs: Tab[];
  /** A tab's title: its conversation's, as the lists have it now. */
  tabTitle(tab: Tab): string;
  /** Opens (or refreshes) the tab of `conversation`. */
  openTab(conversation: ChatConversation): void;
  /** Closes a tab; answers the tab to show instead (its neighbour), if any. */
  closeTab(id: string): Tab | undefined;
}

const Context = createContext<Conversations | undefined>(undefined);

export function ConversationsProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const latest = useGet<ChatPage<ChatConversation>>(conversationsPath({ limit: PAGE }), every(POLL_MS));
  const [changed, setChanged] = useState<Map<string, ChatConversation | null>>(new Map());
  const [changes, setChanges] = useState(0);
  const [tabs, setTabs] = useState<Tab[]>(() => loadTabs(userId));
  const { sentOf, addSent, updateSent, lastSentAt } = useSentMessages();
  const [notes, setNotes] = useState<Record<string, CommandNote[]>>({});
  const notesOf = useCallback((id: string): CommandNote[] => notes[id] ?? [], [notes]);
  const addNote = useCallback((id: string, result: ChatCommandResult) => {
    setNotes((all) => ({ ...all, [id]: [...(all[id] ?? []), { ...noteOf(result), id: nextNote++, at: Date.now() }] }));
  }, []);
  const { reload: reloadLatest } = latest;

  // A newer read of the first page knows better than what was changed here.
  useEffect(() => setChanged(new Map()), [latest.data]);

  const rename = useCallback(async (conversation: ChatConversation, title: string) => {
    const renamed = await request<ChatConversation>("PATCH", conversationApi(conversation), { title });
    setChanged((current) => new Map(current).set(conversation.id, renamed));
    setChanges((n) => n + 1);
    return renamed;
  }, []);

  const reload = reloadLatest;

  /** `action` (`archive`, `unarchive`, `hide`, `unhide`) of `conversation`, its new state kept. */
  const act = useCallback(
    async (conversation: ChatConversation, action: string) => {
      const now = await request<ChatConversation>("POST", conversationApi(conversation, `/${action}`), {});
      setChanged((current) => new Map(current).set(conversation.id, now));
      setChanges((n) => n + 1);
      // Restored, it may be among the latest again.
      reload();
      return now;
    },
    [reload],
  );
  const archive = useCallback((conversation: ChatConversation, archived: boolean) => act(conversation, archived ? "archive" : "unarchive"), [act]);
  const hide = useCallback((conversation: ChatConversation, hidden: boolean) => act(conversation, hidden ? "hide" : "unhide"), [act]);

  const remove = useCallback(async (conversation: ChatConversation) => {
    await request<void>("DELETE", conversationApi(conversation));
    setChanged((current) => new Map(current).set(conversation.id, null));
    setChanges((n) => n + 1);
    setTabs((all) => all.filter((tab) => tab.id !== conversation.id));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(tabsKey(userId), JSON.stringify(tabs.slice(-KEPT_TABS)));
    } catch {
      // Not kept: this page still has them.
    }
  }, [userId, tabs]);

  const openTab = useCallback((conversation: ChatConversation) => {
    const tab: Tab = { id: conversation.id, title: conversation.title };
    setTabs((all) => {
      const at = all.findIndex((each) => each.id === tab.id);
      if (at === -1) return [...all, tab].slice(-KEPT_TABS);
      return all[at]?.title === tab.title ? all : all.map((each, i) => (i === at ? tab : each));
    });
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      const at = tabs.findIndex((tab) => tab.id === id);
      setTabs((all) => all.filter((tab) => tab.id !== id));
      return at === -1 ? undefined : (tabs[at + 1] ?? tabs[at - 1]);
    },
    [tabs],
  );

  const items = useMemo(() => {
    if (latest.data === undefined) return undefined;
    const listed = latest.data.items.flatMap((each) => {
      const now = changed.get(each.id);
      return now === null || now?.archived === true || now?.hidden === true ? [] : [now ?? each];
    });
    return writtenFirst(listed, latest.at, (each) => lastSentAt(each.id));
  }, [latest.data, latest.at, changed, lastSentAt]);

  // The list's titles, by conversation: a tab shows its conversation's as it is now.
  const titled = useMemo(() => new Map((items ?? []).map((each) => [each.id, each.title])), [items]);
  const tabTitle = useCallback((tab: Tab): string => titled.get(tab.id) ?? tab.title, [titled]);

  const value = useMemo<Conversations>(
    () => ({
      sentOf,
      addSent,
      updateSent,
      lastSentAt,
      items,
      error: latest.data === undefined ? latest.error : undefined,
      hasMore: latest.data?.next !== undefined,
      reload,
      changed: changes,
      rename,
      archive,
      hide,
      remove,
      notesOf,
      addNote,
      tabs,
      tabTitle,
      openTab,
      closeTab,
    }),
    [sentOf, addSent, updateSent, lastSentAt, items, latest.data, latest.error, reload, changes, rename, archive, hide, remove, notesOf, addNote, tabs, tabTitle, openTab, closeTab],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useConversations(): Conversations {
  const value = useContext(Context);
  if (value === undefined) throw new Error("useConversations outside ConversationsProvider");
  return value;
}
