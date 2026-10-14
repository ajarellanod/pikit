/**
 * The user's conversations (`GET /chat/api/conversations`), newest activity first, for the sidebar and
 * the list: the first page read again every `every(20 s)` while the person is here (busy flags, new
 * titles), older pages on demand; renaming and deleting change the list at once.
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { every } from "./activity.ts";
import type { ChatConversation, ChatPage } from "./chat-api.ts";
import { get, request, useGet } from "./client.ts";

const PAGE = 30;
const POLL_MS = 20_000;

export interface Conversations {
  items: ChatConversation[] | undefined;
  error: Error | undefined;
  hasOlder: boolean;
  loadOlder(): Promise<void>;
  reload(): void;
  rename(id: string, title: string): Promise<ChatConversation>;
  remove(id: string): Promise<void>;
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
    return renamed;
  }, []);

  const remove = useCallback(async (id: string) => {
    await request<void>("DELETE", `/conversations/${encodeURIComponent(id)}`);
    setChanged((current) => new Map(current).set(id, null));
    setOlder((items) => items.filter((each) => each.id !== id));
  }, []);

  const items = useMemo(() => {
    if (latest.data === undefined) return undefined;
    return merged(latest.data.items, older).flatMap((each) => {
      const now = changed.get(each.id);
      return now === null ? [] : [now ?? each];
    });
  }, [latest.data, older, changed]);

  const value = useMemo<Conversations>(
    () => ({ items, error: latest.data === undefined ? latest.error : undefined, hasOlder: next !== undefined, loadOlder, reload, rename, remove }),
    [items, latest.data, latest.error, next, loadOlder, reload, rename, remove],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useConversations(): Conversations {
  const value = useContext(Context);
  if (value === undefined) throw new Error("useConversations outside ConversationsProvider");
  return value;
}
