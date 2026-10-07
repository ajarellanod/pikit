/**
 * The conversations the sidebar and the tabs show: every one, the most recently active first (the
 * API's index: the first page read again every 10 s while the dashboard is active, 30 s on
 * Cloudflare, older pages on demand), the tabs the operator opened, and the titles this browser knows.
 *
 * A title names a conversation key, so the conversations a reset left behind share it with the key's
 * current one: for another channel's key the id in it (`telegram:12345` is `12345`, on `telegram`);
 * for one of the dashboard's own, the first message the operator wrote in it, kept in this browser
 * (`localStorage["pikit-titles"]`): when it started it here, once its transcript was read from the
 * beginning, or read for it in the background (one key at a time, once), "New chat" until then. A
 * conversation with no key (no message reached it and no reset pointed a key to it) has nothing to
 * show or do: the list leaves it out. Tabs are kept in `localStorage["pikit-tabs"]`.
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { every, usePolling } from "./activity.ts";
import { isDashboardKey, OPERATOR_NOTE } from "./admin-api.ts";
import { api, type ApiApp, type ApiConversation, type ApiPage, type ApiTranscriptEntry } from "./api.ts";

const PAGE = 50;
const TITLES = "pikit-titles";
const TABS = "pikit-tabs";
/** Titles kept, the newest; tabs kept. */
const KEPT_TITLES = 300;
const KEPT_TABS = 12;
/** A dashboard key's title is looked for in its transcript's first pages at most: `TITLE_PAGES` of `TITLE_PAGE` entries. */
const TITLE_PAGE = 200;
const TITLE_PAGES = 5;
/** The title of a dashboard conversation whose first message is not known (yet). */
export const NEW_CHAT = "New chat";

export interface Tab {
  id: string;
  /** Its conversation's key: its title follows the key's. */
  key?: string;
  title: string;
}

/** A title from a message's text: one line, at most 80 characters. */
const titleFrom = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 80);

/** What the operator or a user wrote in a user message (the runtime's JSON), without the operator's note. */
function userTextOf(message: unknown): string | undefined {
  const { role, content } = (message ?? {}) as { role?: unknown; content?: unknown };
  if (role !== "user") return undefined;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((part: { type?: unknown; text?: unknown }) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n")
        : "";
  if (!text.startsWith(OPERATOR_NOTE)) return text;
  const newline = text.indexOf("\n");
  return newline === -1 ? "" : text.slice(newline + 1);
}

/** The first message written in conversation `id`: its transcript read back to the start (bounded). */
async function firstMessageOf(id: string): Promise<string | undefined> {
  let cursor: string | undefined;
  let oldest: string | undefined;
  for (let pages = 0; pages < TITLE_PAGES; pages++) {
    const page = await api<ApiPage<ApiTranscriptEntry>>(`/conversations/${encodeURIComponent(id)}/transcript?limit=${TITLE_PAGE}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
    // Newest first: the last user message of the page is its oldest.
    for (const entry of page.items) {
      for (const message of entry.messages) {
        const text = userTextOf(message);
        if (text !== undefined && titleFrom(text) !== "") oldest = text;
      }
    }
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return oldest;
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
  /** Its key's title (`NEW_CHAT` for a dashboard key whose first message is not known yet). */
  titleOf(conversation: ApiConversation): string;
  /** A tab's title: its key's, as it is now. */
  tabTitle(tab: Tab): string;
  /** A dashboard key's title, from the first message written in it; one it has already is kept. */
  setTitle(key: string, text: string): void;
  tabs: Tab[];
  /** Opens (or refreshes) the tab of `conversation`. */
  openTab(conversation: ApiConversation): void;
  /** Closes a tab; answers the tab to show instead when it was `active`. */
  closeTab(id: string): Tab | undefined;
  /** The conversation `from` was reset into `to`: its tab follows (the title is the key's). */
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
  /** Dashboard keys whose title was looked for in this page: once each. */
  const asked = useRef(new Set<string>());

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

  const titleOfKey = useCallback((key: string | undefined): string => {
    if (key === undefined) return NEW_CHAT;
    if (isDashboardKey(key)) return titles[key] ?? NEW_CHAT;
    return key.slice(key.indexOf(":") + 1) || key;
  }, [titles]);
  const titleOf = useCallback((conversation: ApiConversation): string => titleOfKey(conversation.key), [titleOfKey]);
  const tabTitle = useCallback((tab: Tab): string => (tab.key === undefined ? tab.title : titleOfKey(tab.key)), [titleOfKey]);

  const setTitle = useCallback((key: string, text: string) => {
    const title = titleFrom(text);
    if (title === "" || !isDashboardKey(key)) return;
    setTitles((all) => (all[key] !== undefined ? all : { ...all, [key]: title }));
  }, []);

  const openTab = useCallback(
    (conversation: ApiConversation) => {
      const tab: Tab = { id: conversation.conversationId, ...(conversation.key !== undefined && { key: conversation.key }), title: titleOf(conversation) };
      setTabs((all) => {
        const at = all.findIndex((each) => each.id === tab.id);
        if (at === -1) return [...all, tab].slice(-KEPT_TABS);
        const known = all[at];
        return known?.title === tab.title && known.key === tab.key ? all : all.map((each, i) => (i === at ? tab : each));
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
    setTabs((all) => all.map((tab) => (tab.id === from ? { ...tab, id: to } : tab)));
  }, []);

  // A conversation active again since the older pages were read is on the first page: shown once.
  // One with no key has nothing to show or do: left out.
  const items = useMemo(() => {
    if (first === undefined) return undefined;
    const seen = new Set<string>();
    return [...first.items, ...older].filter((each) => each.key !== undefined && !seen.has(each.conversationId) && seen.add(each.conversationId));
  }, [first, older]);

  // The titles of the dashboard keys listed without one, one key at a time: from the key's least
  // recently active conversation listed (its first, when a reset left it behind).
  const [looking, setLooking] = useState(false);
  useEffect(() => {
    if (looking || items === undefined) return;
    const untitled = [...items].reverse().find((each) => isDashboardKey(each.key) && titles[each.key as string] === undefined && !asked.current.has(each.key as string));
    if (untitled === undefined) return;
    const key = untitled.key as string;
    asked.current.add(key);
    setLooking(true);
    firstMessageOf(untitled.conversationId)
      .then((text) => text !== undefined && setTitle(key, text))
      .catch(() => undefined)
      .finally(() => setLooking(false));
  }, [items, titles, looking, setTitle]);

  const value: Chats = { items, error, hasOlder: cursor !== undefined, loadOlder, reload, titleOf, tabTitle, setTitle, tabs, openTab, closeTab, replaced };
  return <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>;
}
