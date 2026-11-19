/**
 * The conversations the sidebar and the tabs show: the most recently active (the API's list, the
 * conversation directory's: its
 * first `PAGE`, which the sidebar lists, read again every 10 s while the dashboard is active, 30 s on
 * Cloudflare; never more: every one is on the Conversations page, `views/conversations/list.tsx`), the
 * tabs the operator opened, what the commands answered, and the messages sent from here that the
 * conversation does not show yet (shown at once, where they go). A conversation written to from here
 * goes first at once (`writtenFirst`), and the list is read again once the message is in (the open
 * conversation's page calls `reload`).
 *
 * A title names one conversation (a reset's new one has its own). It is the API's, the same in every
 * view (`ApiConversation.title`: a channel's first message, a model's, or a rename, `/name` or Rename); until there is one, its first message when
 * this page has it at hand (sent from New chat, or read in the open conversation's transcript: never
 * looked for), else for another channel's conversation who it is with (its party's name), else the id
 * in its key (`telegram:12345` is `12345`), and "New
 * chat" for one of the dashboard's own. Tabs are kept in `localStorage["pikit-tabs"]`.
 *
 * The operator puts a conversation away from its row (`act`): "Hide for me" (this operator's list
 * only), "Archive for everyone", "Delete for everyone" (every view stops listing it; its key starts a
 * new conversation), each listed apart on the Conversations page, where "Show again" and "Restore" put
 * it back. The runtime keeps it; new activity lists a hidden or archived one again by itself. Each
 * change made here moves `changed`, which a list of its own (the Conversations page) follows.
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { type SentMessages, useSentMessages, writtenFirst } from "@/components/pikit/conversation";
import { every, usePolling } from "./activity.ts";
import { cleanTitle, isDashboardKey } from "./admin-api.ts";
import { type ApiAgent, api, type ApiApp, type ApiConversation, type ApiPage, type ApiRenameRequest, type ApiStateResponse, post } from "./api.ts";

/** The conversations read: the sidebar's (`SIDEBAR_CHATS`). */
const PAGE = 20;
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
  /** Its conversation's title when it was opened; the API's newer one wins. */
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

/**
 * The App's agents: those `GET /admin/api/agents` listed (`described`: the code's, then the live ones),
 * else, until it answered, the keys of `agent.definition`.
 */
export const agentsOf = (app: ApiApp | undefined, described?: readonly ApiAgent[]): string[] =>
  described !== undefined ? described.map((agent) => agent.name) : Object.keys(app?.capabilities["agent.definition"]?.keys ?? {}).sort();

/** The agent the App answers with when none is named (router-basic's `defaultAgent`), if it is one of `agents`. */
export function defaultAgentOf(app: ApiApp | undefined): string | undefined {
  const agents = agentsOf(app);
  const named = (app?.config["router-basic"] as { defaultAgent?: unknown } | undefined)?.defaultAgent;
  return typeof named === "string" && agents.includes(named) ? named : agents[0];
}

/** What the operator does to a conversation from its menu: for them (`hide`, `unhide`) or for everyone (`archive`, `delete`, `restore`). */
export type ChatAction = "hide" | "unhide" | "archive" | "delete" | "restore";

/** With the messages sent from here and not shown yet (`SentMessages`, the shared conversation view's). */
export interface Chats extends SentMessages {
  /** Undefined until the first page is read. */
  items: ApiConversation[] | undefined;
  error: Error | undefined;
  /** Whether there are more than `items`: the sidebar's "View all". */
  hasMore: boolean;
  reload(): void;
  /** Moves at each conversation renamed, hidden, archived, deleted or restored here: a list of its own reads again. */
  changed: number;
  /** Its title: the API's, else the first message at hand, its party's name, the id in its key, or `NEW_CHAT`. */
  titleOf(conversation: ApiConversation): string;
  /** A tab's title: its conversation's, as it is now. */
  tabTitle(tab: Tab): string;
  /** The first message written in conversation `id`, as this page knows it: the title until the API has one. */
  setFirstMessage(id: string, text: string): void;
  /** The notes the commands run in conversation `id` answered, oldest first. */
  notesOf(id: string): CommandNote[];
  /** A command's answer in conversation `id`. */
  addNote(id: string, command: string, text: string): void;
  tabs: Tab[];
  /** Opens (or refreshes) the tab of `conversation`. */
  openTab(conversation: ApiConversation): void;
  /** Closes a tab; answers the tab to show instead when it was `active`. */
  closeTab(id: string): Tab | undefined;
  /** The conversation `from` was reset into `to`: its tab follows (to the new one's title). */
  replaced(from: string, to: string): void;
  /** Hides, archives or deletes a conversation, or puts it back. Its tab closes when it leaves the list. */
  act(id: string, action: ChatAction): Promise<void>;
  /** Titles a conversation for everyone with the operator's `title` (the API cleans it, as `/name` does); the lists are read again. */
  rename(id: string, title: string): Promise<void>;
}

const ChatsContext = createContext<Chats | undefined>(undefined);

export function useChats(): Chats {
  const chats = useContext(ChatsContext);
  if (chats === undefined) throw new Error("useChats: outside ChatsProvider");
  return chats;
}

export function ChatsProvider({ children }: { children: ReactNode }) {
  /** The first page, and when it was asked for (epoch ms): a slower answer to an older request never replaces it. */
  const [read, setRead] = useState<{ page: ApiPage<ApiConversation>; at: number }>();
  const first = read?.page;
  const [changed, setChanged] = useState(0);
  const [error, setError] = useState<Error>();
  const [firsts, setFirsts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, CommandNote[]>>({});
  const [tabs, setTabs] = useState<Tab[]>(() => load<Tab[]>(TABS, []).filter((tab) => typeof tab?.id === "string"));
  /** Put away by this page, with their activity then: left out of the pages read until newer activity lists one again. */
  const [gone, setGone] = useState<ReadonlyMap<string, number>>(new Map());

  const reload = useCallback(() => {
    const at = Date.now();
    api<ApiPage<ApiConversation>>(`/conversations?limit=${PAGE}`)
      .then((page) => (setRead((current) => (current !== undefined && current.at > at ? current : { page, at })), setError(undefined)))
      .catch((thrown: unknown) => setError(thrown instanceof Error ? thrown : new Error(String(thrown))));
  }, []);
  useEffect(reload, [reload]);
  usePolling(reload, every(10_000));

  useEffect(() => save(TABS, tabs.slice(-KEPT_TABS)), [tabs]);

  // The API's titles, by conversation.
  const titled = useMemo(() => {
    const byId = new Map<string, string>();
    for (const each of first?.items ?? []) if (each.title !== undefined) byId.set(each.conversationId, each.title);
    return byId;
  }, [first]);

  const titleOf = useCallback(
    (conversation: ApiConversation): string => {
      const known = conversation.title ?? titled.get(conversation.conversationId) ?? firsts[conversation.conversationId];
      if (known !== undefined) return known;
      const key = conversation.key;
      if (key === undefined || isDashboardKey(key)) return NEW_CHAT;
      const name = (conversation as ApiConversation & { party?: { name?: string } }).party?.name;
      if (name !== undefined && name.trim() !== "") return name;
      return key.slice(key.indexOf(":") + 1) || key;
    },
    [titled, firsts],
  );
  const tabTitle = useCallback((tab: Tab): string => titled.get(tab.id) ?? firsts[tab.id] ?? tab.title, [titled, firsts]);

  const setFirstMessage = useCallback((id: string, text: string) => {
    const title = cleanTitle(text);
    if (title === undefined) return;
    setFirsts((all) => (all[id] !== undefined ? all : { ...all, [id]: title }));
  }, []);

  const sent = useSentMessages();
  const { lastSentAt } = sent;

  const notesOf = useCallback((id: string): CommandNote[] => notes[id] ?? [], [notes]);
  const addNote = useCallback((id: string, command: string, text: string) => {
    setNotes((all) => ({ ...all, [id]: [...(all[id] ?? []), { id: nextNote++, command, text, at: Date.now() }] }));
  }, []);

  const openTab = useCallback(
    (conversation: ApiConversation) => {
      const tab: Tab = { id: conversation.conversationId, title: titleOf(conversation) };
      setTabs((all) => {
        const at = all.findIndex((each) => each.id === tab.id);
        if (at === -1) return [...all, tab].slice(-KEPT_TABS);
        const known = all[at];
        return known?.title === tab.title ? all : all.map((each, i) => (i === at ? tab : each));
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

  // One this page just put away is left out. One written to since goes first.
  const items = useMemo(() => {
    if (read === undefined) return undefined;
    const listed = read.page.items.filter((each) => !gone.has(each.conversationId));
    return writtenFirst(listed, read.at, (each) => lastSentAt(each.conversationId));
  }, [read, gone, lastSentAt]);

  const act = useCallback(
    async (id: string, action: ChatAction) => {
      await post<ApiStateResponse>(`/conversations/${encodeURIComponent(id)}/${action}`);
      if (action === "unhide" || action === "restore") setGone((all) => new Map([...all].filter(([each]) => each !== id)));
      else {
        const at = first?.items.find((each) => each.conversationId === id)?.lastActivity ?? 0;
        setGone((all) => new Map([...all, [id, at]]));
        setTabs((all) => all.filter((tab) => tab.id !== id));
      }
      setChanged((n) => n + 1);
      reload();
    },
    [first, reload],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      await post<ApiConversation>(`/conversations/${encodeURIComponent(id)}/rename`, { title } satisfies ApiRenameRequest);
      setChanged((n) => n + 1);
      reload();
    },
    [reload],
  );

  // Active again since it was hidden or archived (a person wrote): the API lists it again, and so does this page.
  useEffect(() => {
    if (first === undefined || gone.size === 0) return;
    const back = first.items.filter((each) => (gone.get(each.conversationId) ?? Infinity) < (each.lastActivity ?? 0)).map((each) => each.conversationId);
    if (back.length > 0) setGone((all) => new Map([...all].filter(([id]) => !back.includes(id))));
  }, [first, gone]);

  const value: Chats = { items, error, hasMore: first?.next !== undefined, reload, changed, titleOf, tabTitle, setFirstMessage, notesOf, addNote, ...sent, tabs, openTab, closeTab, replaced, act, rename };
  return <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>;
}
