/**
 * The user's conversations (`GET /chat/api/conversations`), newest activity first, for the sidebar and
 * the list: the first page read again every `every(20 s)` while the person is here (busy flags, new
 * titles), older pages on demand; renaming, archiving and deleting change the list at once. The
 * archived ones (`?archived=1`) are read when asked (`loadArchived`: the sidebar's Archived opened),
 * and again after one is archived or restored, and at each `reload` (a message lists an archived one
 * again).
 *
 * Also what the pages share: the messages sent and not shown yet (`SentMessages`, the shared
 * conversation view's: New chat's first message shows in the conversation it opens), and the tabs, the
 * conversations opened (as the dashboard's), kept in this browser for this user
 * (`localStorage["pikit-chat-tabs:<user id>"]`: another user signing in here never sees them).
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { type SentMessages, useSentMessages } from "@/components/pikit/conversation";
import { every } from "./activity.ts";
import type { ChatConversation, ChatPage } from "./chat-api.ts";
import { get, request, useGet } from "./client.ts";
import { conversationsPath } from "./source.ts";

const PAGE = 30;
/** The archived ones read at once: the API's largest page. */
const ARCHIVED_PAGE = 100;
const POLL_MS = 20_000;
/** Tabs kept. */
const KEPT_TABS = 12;

/** A conversation opened as a tab: its title when last seen (the list's newer one wins). */
export interface Tab {
  id: string;
  title: string;
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
  hasOlder: boolean;
  loadOlder(): Promise<void>;
  reload(): void;
  rename(id: string, title: string): Promise<ChatConversation>;
  /** Archives it (listed apart) or restores it (`archived` false). */
  archive(id: string, archived: boolean): Promise<ChatConversation>;
  remove(id: string): Promise<void>;
  /** The archived ones, newest activity first; `undefined` until `loadArchived` read them. */
  archived: ChatConversation[] | undefined;
  loadArchived(): void;
  tabs: Tab[];
  /** A tab's title: its conversation's, as the lists have it now. */
  tabTitle(tab: Tab): string;
  /** Opens (or refreshes) the tab of `conversation`. */
  openTab(conversation: ChatConversation): void;
  /** Closes a tab; answers the tab to show instead (its neighbour), if any. */
  closeTab(id: string): Tab | undefined;
}

const Context = createContext<Conversations | undefined>(undefined);

/** `first`'s items, then those of `older` it does not have. */
const merged = (first: ChatConversation[], older: ChatConversation[]): ChatConversation[] => {
  const ids = new Set(first.map((each) => each.id));
  return [...first, ...older.filter((each) => !ids.has(each.id))];
};

export function ConversationsProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const latest = useGet<ChatPage<ChatConversation>>(conversationsPath({ limit: PAGE }), every(POLL_MS));
  const [older, setOlder] = useState<ChatConversation[]>([]);
  const [cursor, setCursor] = useState<string | null>();
  const [changed, setChanged] = useState<Map<string, ChatConversation | null>>(new Map());
  const [archived, setArchived] = useState<ChatConversation[]>();
  /** Whether the archived ones were asked for: read again after each change. */
  const [archivedAsked, setArchivedAsked] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>(() => loadTabs(userId));
  const { sentOf, addSent, updateSent, lastSentAt } = useSentMessages();
  const { reload: reloadLatest } = latest;

  // A newer read of the first page knows better than what was changed here.
  useEffect(() => setChanged(new Map()), [latest.data]);

  const next = cursor === undefined ? latest.data?.next : (cursor ?? undefined);
  const loadOlder = useCallback(async () => {
    if (next === undefined) return;
    const page = await get<ChatPage<ChatConversation>>(conversationsPath({ limit: PAGE, cursor: next }));
    setOlder((items) => merged(items, page.items));
    setCursor(page.next ?? null);
  }, [next]);

  const rename = useCallback(async (id: string, title: string) => {
    const renamed = await request<ChatConversation>("PATCH", `/conversations/${encodeURIComponent(id)}`, { title });
    setChanged((current) => new Map(current).set(id, renamed));
    setArchived((items) => items?.map((each) => (each.id === id ? renamed : each)));
    return renamed;
  }, []);

  const readArchived = useCallback(() => {
    get<ChatPage<ChatConversation>>(conversationsPath({ limit: ARCHIVED_PAGE, archived: true })).then(
      (page) => setArchived(page.items),
      () => setArchived((current) => current ?? []),
    );
  }, []);
  const loadArchived = useCallback(() => {
    setArchivedAsked(true);
    readArchived();
  }, [readArchived]);

  const reload = useCallback(() => {
    reloadLatest();
    if (archivedAsked) readArchived();
  }, [reloadLatest, archivedAsked, readArchived]);

  const archive = useCallback(
    async (id: string, archive: boolean) => {
      const now = await request<ChatConversation>("POST", `/conversations/${encodeURIComponent(id)}/${archive ? "archive" : "unarchive"}`, {});
      setChanged((current) => new Map(current).set(id, now));
      setArchived((items) => items?.filter((each) => each.id !== id));
      if (archive) setOlder((items) => items.filter((each) => each.id !== id));
      // Where it goes now: the first page (restored), the archived ones (archived).
      reload();
      return now;
    },
    [reload],
  );

  const remove = useCallback(async (id: string) => {
    await request<void>("DELETE", `/conversations/${encodeURIComponent(id)}`);
    setChanged((current) => new Map(current).set(id, null));
    setOlder((items) => items.filter((each) => each.id !== id));
    setArchived((items) => items?.filter((each) => each.id !== id));
    setTabs((all) => all.filter((tab) => tab.id !== id));
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
    return merged(latest.data.items, older).flatMap((each) => {
      const now = changed.get(each.id);
      return now === null || now?.archived === true ? [] : [now ?? each];
    });
  }, [latest.data, older, changed]);

  // The lists' titles, by conversation: a tab shows its conversation's as it is now.
  const titled = useMemo(() => new Map([...(archived ?? []), ...(items ?? [])].map((each) => [each.id, each.title])), [items, archived]);
  const tabTitle = useCallback((tab: Tab): string => titled.get(tab.id) ?? tab.title, [titled]);

  const value = useMemo<Conversations>(
    () => ({
      sentOf,
      addSent,
      updateSent,
      lastSentAt,
      items,
      error: latest.data === undefined ? latest.error : undefined,
      hasOlder: next !== undefined,
      loadOlder,
      reload,
      rename,
      archive,
      remove,
      archived,
      loadArchived,
      tabs,
      tabTitle,
      openTab,
      closeTab,
    }),
    [sentOf, addSent, updateSent, lastSentAt, items, latest.data, latest.error, next, loadOlder, reload, rename, archive, remove, archived, loadArchived, tabs, tabTitle, openTab, closeTab],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useConversations(): Conversations {
  const value = useContext(Context);
  if (value === undefined) throw new Error("useConversations outside ConversationsProvider");
  return value;
}
