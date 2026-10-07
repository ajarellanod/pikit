/**
 * The conversations the sidebar and the tabs show: every one, the most recently active first (the
 * API's index: the first page read again every 10 s while the dashboard is active, 30 s on
 * Cloudflare, older pages on demand), the tabs the operator opened, and the titles this browser knows.
 *
 * A title: for another channel's conversation the id in its key (`telegram:12345` is `12345`, on
 * `telegram`); for one of the dashboard's own, the first message the operator wrote in it, kept in
 * this browser (`localStorage["pikit-titles"]`) when it started it here or once its transcript was
 * read from the beginning. Tabs are kept in `localStorage["pikit-tabs"]`.
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { every, usePolling } from "./activity.ts";
import { isDashboardKey } from "./admin-api.ts";
import { api, type ApiApp, type ApiConversation, type ApiPage } from "./api.ts";

const PAGE = 50;
const TITLES = "pikit-titles";
const TABS = "pikit-tabs";
/** Titles kept, the newest; tabs kept. */
const KEPT_TITLES = 300;
const KEPT_TABS = 12;

export interface Tab {
  id: string;
  title: string;
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not kept: this page still has it.
  }
}

/** The channel of conversation `key`: `telegram`, `http`, `dashboard`. */
export const channelOf = (key: string | undefined): string | undefined => (key === undefined ? undefined : key.split(":")[0]);

/** The App's agents: the keys of `agent.definition`. */
export const agentsOf = (app: ApiApp | undefined): string[] => Object.keys(app?.capabilities["agent.definition"]?.keys ?? {}).sort();

/** The agent the App answers with when none is named (router-basic's `defaultAgent`), if it is one of `agents`. */
export function defaultAgentOf(app: ApiApp | undefined): string | undefined {
  const agents = agentsOf(app);
  const named = (app?.config["router-basic"] as { defaultAgent?: unknown } | undefined)?.defaultAgent;
  return typeof named === "string" && agents.includes(named) ? named : agents[0];
}

export interface Chats {
  /** Undefined until the first page is read. */
  items: ApiConversation[] | undefined;
  error: Error | undefined;
  hasOlder: boolean;
  loadOlder(): Promise<void>;
  reload(): void;
  titleOf(conversation: ApiConversation): string;
  /** A dashboard conversation's title: the first message written in it. */
  setTitle(conversationId: string, text: string): void;
  tabs: Tab[];
  /** Opens (or refreshes) the tab of `conversation`. */
  openTab(conversation: ApiConversation): void;
  /** Closes a tab; answers the tab to show instead when it was `active`. */
  closeTab(id: string): Tab | undefined;
  /** The conversation `from` was reset into `to`: its tab and title follow. */
  replaced(from: string, to: string): void;
}

const ChatsContext = createContext<Chats | undefined>(undefined);

export function useChats(): Chats {
  const chats = useContext(ChatsContext);
  if (chats === undefined) throw new Error("useChats: outside ChatsProvider");
  return chats;
}

export function ChatsProvider({ children }: { children: ReactNode }) {
  const [first, setFirst] = useState<ApiPage<ApiConversation>>();
  const [older, setOlder] = useState<ApiConversation[]>([]);
  const [next, setNext] = useState<string | null>();
  const [error, setError] = useState<Error>();
  const [titles, setTitles] = useState<Record<string, string>>(() => load(TITLES, {}));
  const [tabs, setTabs] = useState<Tab[]>(() => load<Tab[]>(TABS, []).filter((tab) => typeof tab?.id === "string"));

  const reload = useCallback(() => {
    api<ApiPage<ApiConversation>>(`/conversations?limit=${PAGE}`)
      .then((page) => (setFirst(page), setError(undefined)))
      .catch((thrown: unknown) => setError(thrown instanceof Error ? thrown : new Error(String(thrown))));
  }, []);
  useEffect(reload, [reload]);
  usePolling(reload, every(10_000));

  const cursor = next === undefined ? first?.next : (next ?? undefined);
  const loadOlder = useCallback(async () => {
    if (cursor === undefined) return;
    try {
      const page = await api<ApiPage<ApiConversation>>(`/conversations?limit=${PAGE}&cursor=${encodeURIComponent(cursor)}`);
      setOlder((items) => [...items, ...page.items]);
      setNext(page.next ?? null);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown : new Error(String(thrown)));
    }
  }, [cursor]);

  useEffect(() => save(TITLES, Object.fromEntries(Object.entries(titles).slice(-KEPT_TITLES))), [titles]);
  useEffect(() => save(TABS, tabs.slice(-KEPT_TABS)), [tabs]);

  const titleOf = useCallback(
    (conversation: ApiConversation): string => {
      const { key, conversationId } = conversation;
      if (key === undefined) return `#${conversationId}`;
      if (isDashboardKey(key)) return titles[conversationId] ?? `${conversation.agent ?? "chat"} ${key.slice(key.indexOf(":") + 1, key.indexOf(":") + 9)}`;
      return key.slice(key.indexOf(":") + 1);
    },
    [titles],
  );

  const setTitle = useCallback((conversationId: string, text: string) => {
    const title = text.replace(/\s+/g, " ").trim().slice(0, 80);
    if (title === "") return;
    setTitles((all) => (all[conversationId] === title ? all : { ...all, [conversationId]: title }));
    setTabs((all) => all.map((tab) => (tab.id === conversationId ? { ...tab, title } : tab)));
  }, []);

  const openTab = useCallback(
    (conversation: ApiConversation) => {
      const tab = { id: conversation.conversationId, title: titleOf(conversation) };
      setTabs((all) => {
        const at = all.findIndex((each) => each.id === tab.id);
        if (at === -1) return [...all, tab].slice(-KEPT_TABS);
        return all[at]?.title === tab.title ? all : all.map((each, i) => (i === at ? tab : each));
      });
    },
    [titleOf],
  );

  const closeTab = useCallback(
    (id: string) => {
      const at = tabs.findIndex((tab) => tab.id === id);
      setTabs((all) => all.filter((tab) => tab.id !== id));
      return at === -1 ? undefined : (tabs[at + 1] ?? tabs[at - 1]);
    },
    [tabs],
  );

  const replaced = useCallback((from: string, to: string) => {
    setTitles((all) => (all[from] === undefined ? all : { ...all, [to]: all[from] as string }));
    setTabs((all) => all.map((tab) => (tab.id === from ? { ...tab, id: to } : tab)));
  }, []);

  // A conversation active again since the older pages were read is on the first page: shown once.
  const items = useMemo(() => {
    if (first === undefined) return undefined;
    const seen = new Set<string>();
    return [...first.items, ...older].filter((each) => !seen.has(each.conversationId) && seen.add(each.conversationId));
  }, [first, older]);

  const value: Chats = { items, error, hasOlder: cursor !== undefined, loadOlder, reload, titleOf, setTitle, tabs, openTab, closeTab, replaced };
  return <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>;
}
