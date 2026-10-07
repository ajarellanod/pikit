/**
 * The conversations the sidebar and the tabs show: every one, the most recently active first (the
 * API's index: the first page read again every 10 s while the dashboard is active, 30 s on
 * Cloudflare, older pages on demand), the tabs the operator opened, and what the commands answered.
 *
 * A title names a conversation key, so the conversations a reset left behind share it with the key's
 * current one. It is the API's (`ApiConversation.title`: a model's, made after the key's first run, or
 * the operator's `/name`); until there is one, the first message written in the key when this page
 * has it at hand (sent from the home, or read in the open conversation's transcript: never looked
 * for), else for another channel's key the id in it (`telegram:12345` is `12345`), and "New chat" for
 * one of the dashboard's own. A conversation with no key (no message reached it and no reset pointed a
 * key to it) has nothing to show or do: the list leaves it out. Tabs are kept in
 * `localStorage["pikit-tabs"]`.
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { every, usePolling } from "./activity.ts";
import { cleanTitle, isDashboardKey } from "./admin-api.ts";
import { api, type ApiApp, type ApiConversation, type ApiPage } from "./api.ts";

const PAGE = 50;
const TABS = "pikit-tabs";
/** Tabs kept. */
const KEPT_TABS = 12;
/** The title of a dashboard conversation with no title and no first message at hand. */
export const NEW_CHAT = "New chat";

/** What a command answered in a conversation: a quiet note there, in this page only (no channel gets it). */
export interface CommandNote {
  id: number;
  /** The command, without its slash. */
  command: string;
  text: string;
  at: number;
}

let nextNote = 0;

export interface Tab {
  id: string;
  /** Its conversation's key: its title follows the key's. */
  key?: string;
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
  /** Its key's title: the API's, else the first message at hand, the id in its key, or `NEW_CHAT`. */
  titleOf(conversation: ApiConversation): string;
  /** A tab's title: its key's, as it is now. */
  tabTitle(tab: Tab): string;
  /** The first message written in `key`, as this page knows it: the title until the API has one. */
  setFirstMessage(key: string, text: string): void;
  /** The notes the commands run in conversation `id` answered, oldest first. */
  notesOf(id: string): CommandNote[];
  /** A command's answer in conversation `id`. */
  addNote(id: string, command: string, text: string): void;
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
  const [firsts, setFirsts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, CommandNote[]>>({});
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

  useEffect(() => save(TABS, tabs.slice(-KEPT_TABS)), [tabs]);

  // The API's titles, by key: any conversation of a key carries it.
  const titled = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const each of [...(first?.items ?? []), ...older]) if (each.key !== undefined && each.title !== undefined) byKey.set(each.key, each.title);
    return byKey;
  }, [first, older]);

  const titleOfKey = useCallback(
    (key: string | undefined, title?: string): string => {
      if (key === undefined) return NEW_CHAT;
      const known = title ?? titled.get(key) ?? firsts[key];
      if (known !== undefined) return known;
      return isDashboardKey(key) ? NEW_CHAT : key.slice(key.indexOf(":") + 1) || key;
    },
    [titled, firsts],
  );
  const titleOf = useCallback((conversation: ApiConversation): string => titleOfKey(conversation.key, conversation.title), [titleOfKey]);
  const tabTitle = useCallback((tab: Tab): string => (tab.key === undefined ? tab.title : titleOfKey(tab.key)), [titleOfKey]);

  const setFirstMessage = useCallback((key: string, text: string) => {
    const title = cleanTitle(text);
    if (title === undefined) return;
    setFirsts((all) => (all[key] !== undefined ? all : { ...all, [key]: title }));
  }, []);

  const notesOf = useCallback((id: string): CommandNote[] => notes[id] ?? [], [notes]);
  const addNote = useCallback((id: string, command: string, text: string) => {
    setNotes((all) => ({ ...all, [id]: [...(all[id] ?? []), { id: nextNote++, command, text, at: Date.now() }] }));
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

  const value: Chats = { items, error, hasOlder: cursor !== undefined, loadOlder, reload, titleOf, tabTitle, setFirstMessage, notesOf, addNote, tabs, openTab, closeTab, replaced };
  return <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>;
}
