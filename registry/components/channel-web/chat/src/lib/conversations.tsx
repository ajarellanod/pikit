/**
 * The user's conversations (`GET /chat/api/conversations`), newest activity first, for the sidebar and
 * the list: the first page read again every `every(20 s)` while the person is here (busy flags, new
 * titles), older pages on demand; renaming, archiving and deleting change the list at once. The
 * archived ones (`?archived=1`) are read when asked (`loadArchived`: the sidebar's Archived opened),
 * and again after one is archived or restored.
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { every } from "./activity.ts";
import type { ChatConversation, ChatPage } from "./chat-api.ts";
import { get, request, useGet } from "./client.ts";

const PAGE = 30;
/** The archived ones read at once: the API's largest page. */
const ARCHIVED_PAGE = 100;
const POLL_MS = 20_000;

export interface Conversations {
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
}

const Context = createContext<Conversations | undefined>(undefined);

/** `first`'s items, then those of `older` it does not have. */
const merged = (first: ChatConversation[], older: ChatConversation[]): ChatConversation[] => {
  const ids = new Set(first.map((each) => each.id));
  return [...first, ...older.filter((each) => !ids.has(each.id))];
};

export function ConversationsProvider({ children }: { children: ReactNode }) {
  const latest = useGet<ChatPage<ChatConversation>>(`/conversations?limit=${PAGE}`, every(POLL_MS));
  const [older, setOlder] = useState<ChatConversation[]>([]);
  const [cursor, setCursor] = useState<string | null>();
  const [changed, setChanged] = useState<Map<string, ChatConversation | null>>(new Map());
  const [archived, setArchived] = useState<ChatConversation[]>();
  /** Whether the archived ones were asked for: read again after each change. */
  const [archivedAsked, setArchivedAsked] = useState(false);
  const { reload } = latest;

  // A newer read of the first page knows better than what was changed here.
  useEffect(() => setChanged(new Map()), [latest.data]);

  const next = cursor === undefined ? latest.data?.next : (cursor ?? undefined);
  const loadOlder = useCallback(async () => {
    if (next === undefined) return;
    const page = await get<ChatPage<ChatConversation>>(`/conversations?limit=${PAGE}&cursor=${encodeURIComponent(next)}`);
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
    get<ChatPage<ChatConversation>>(`/conversations?archived=1&limit=${ARCHIVED_PAGE}`).then(
      (page) => setArchived(page.items),
      () => setArchived((current) => current ?? []),
    );
  }, []);
  const loadArchived = useCallback(() => {
    setArchivedAsked(true);
    readArchived();
  }, [readArchived]);

  const archive = useCallback(
    async (id: string, archive: boolean) => {
      const now = await request<ChatConversation>("POST", `/conversations/${encodeURIComponent(id)}/${archive ? "archive" : "unarchive"}`, {});
      setChanged((current) => new Map(current).set(id, now));
      setArchived((items) => items?.filter((each) => each.id !== id));
      if (archive) setOlder((items) => items.filter((each) => each.id !== id));
      // Where it goes now: the first page (restored), the archived ones (archived).
      reload();
      if (archivedAsked) readArchived();
      return now;
    },
    [reload, archivedAsked, readArchived],
  );

  const remove = useCallback(async (id: string) => {
    await request<void>("DELETE", `/conversations/${encodeURIComponent(id)}`);
    setChanged((current) => new Map(current).set(id, null));
    setOlder((items) => items.filter((each) => each.id !== id));
    setArchived((items) => items?.filter((each) => each.id !== id));
  }, []);

  const items = useMemo(() => {
    if (latest.data === undefined) return undefined;
    return merged(latest.data.items, older).flatMap((each) => {
      const now = changed.get(each.id);
      return now === null || now?.archived === true ? [] : [now ?? each];
    });
  }, [latest.data, older, changed]);

  const value = useMemo<Conversations>(
    () => ({ items, error: latest.data === undefined ? latest.error : undefined, hasOlder: next !== undefined, loadOlder, reload, rename, archive, remove, archived, loadArchived }),
    [items, latest.data, latest.error, next, loadOlder, reload, rename, archive, remove, archived, loadArchived],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useConversations(): Conversations {
  const value = useContext(Context);
  if (value === undefined) throw new Error("useConversations outside ConversationsProvider");
  return value;
}
