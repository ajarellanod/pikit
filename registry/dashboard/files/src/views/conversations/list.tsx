/**
 * Conversations (`/conversations/all`): every conversation, the most recently active first, a page at
 * a time ("Load more", the API's cursor), where the sidebar lists only the latest (`SIDEBAR_CHATS`,
 * its "View all" leads here). A search finds them by title or key (`?q=`, the API's: any case), as the
 * operator stops typing; "Archived" lists the archived ones instead (`?archived=1`), searched alike:
 * the only place they are. Each row shows its channel's icon, and opens its conversation, and its menu is the sidebar row's (Rename,
 * Archive or Restore, Delete: `useShell().conversationActions`); a change made anywhere here reads the
 * list again (`useChats().changed`).
 */

import { Archive, ChatBubble, Plus, Search } from "iconoir-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/bui/Button";
import { ConversationList } from "@/components/bui/ConversationList";
import EmptyState from "@/components/bui/EmptyState";
import { LoaderGrid } from "@/components/bui/LoadingState";
import { Page } from "@/components/bui/Page";
import SearchField from "@/components/bui/SearchField";
import { Switch } from "@/components/bui/Switch";
import { ErrorNote } from "@/components/pikit/error-note";
import { ChannelIcon, partyOf } from "@/components/pikit/party";
import { SEARCH_MAX } from "@/lib/admin-api";
import { api, type ApiConversation, type ApiPage } from "@/lib/api";
import { useChats } from "@/lib/chats";
import { BASE, navigate, pagePath } from "@/lib/router";
import { useShell } from "@/lib/shell";

/** The list's path. */
export const CONVERSATIONS_PATH = "/conversations/all";
const PAGE = 30;
/** How long after the last key a search goes. */
const DEBOUNCE_MS = 250;

/** `value`, once it stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const pathOf = ({ q, archived, cursor }: { q: string; archived: boolean; cursor?: string }): string => {
  const params = new URLSearchParams({ limit: String(PAGE) });
  if (archived) params.set("archived", "1");
  if (q !== "") params.set("q", q);
  if (cursor !== undefined) params.set("cursor", cursor);
  return `/conversations?${params}`;
};

/** The conversations `q` finds, archived or not: `undefined` until read; read again when `round` moves. More pages on demand. */
function useFound(q: string, archived: boolean, round: number) {
  const key = `${archived}:${q}`;
  const [found, setFound] = useState<{ key: string; items: ApiConversation[]; next?: string | undefined }>();
  const [error, setError] = useState<Error>();

  useEffect(() => {
    let live = true;
    api<ApiPage<ApiConversation>>(pathOf({ q, archived })).then(
      (page) => live && (setFound({ key, items: page.items.filter((each) => each.key !== undefined), next: page.next }), setError(undefined)),
      (thrown: unknown) => live && setError(thrown instanceof Error ? thrown : new Error(String(thrown))),
    );
    return () => {
      live = false;
    };
  }, [key, q, archived, round]);

  const current = found?.key === key ? found : undefined;
  const loadMore = async () => {
    if (current?.next === undefined) return;
    const page = await api<ApiPage<ApiConversation>>(pathOf({ q, archived, cursor: current.next }));
    const ids = new Set(current.items.map((each) => each.conversationId));
    setFound({ key, items: [...current.items, ...page.items.filter((each) => each.key !== undefined && !ids.has(each.conversationId))], next: page.next });
  };
  return { items: current?.items, error, hasMore: current?.next !== undefined, loadMore };
}

export function ConversationsPage() {
  const chats = useChats();
  const { newChat, conversationActions } = useShell();
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<Error>();
  const q = useDebounced(query.trim(), DEBOUNCE_MS);
  const found = useFound(q, archived, chats.changed);
  const items = found.items;

  return (
    <Page
      eyebrow="Conversations"
      title="Every chat with the App"
      aside={
        <Button variant="primary" size="xs" onClick={() => newChat()}>
          <Plus width={14} height={14} strokeWidth={2} aria-hidden /> New chat
        </Button>
      }
    >
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <SearchField value={query} onChange={(value) => setQuery(value.slice(0, SEARCH_MAX))} placeholder="Search by title" label="Search the conversations" className="min-w-0 flex-1" />
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[13px] text-ink-2">
            <Switch checked={archived} onChange={setArchived} size="sm" label="Archived" />
            <span aria-hidden>Archived</span>
          </label>
        </div>
        {found.error !== undefined && <ErrorNote error={found.error} title="The conversations cannot be read" />}
        {problem !== undefined && <ErrorNote error={problem} />}
        {items === undefined && found.error === undefined && (
          <div className="flex items-center gap-2.5 text-[13px] text-ink-3">
            <LoaderGrid /> Loading
          </div>
        )}
        {items !== undefined && items.length === 0 && (
          <EmptyState
            icon={q !== "" ? <Search /> : archived ? <Archive /> : <ChatBubble />}
            title={q !== "" ? `No ${archived ? "archived " : ""}conversation with “${q}”` : archived ? "No archived conversations" : "No conversations yet"}
            hint={q !== "" ? "Search finds words of a title, or of a key, in any case." : archived ? "A conversation you archive is listed here." : "Start one with New chat, or wait for a channel's."}
          />
        )}
        {items !== undefined && items.length > 0 && (
          <ConversationList
            items={items.map((conversation) => {
              const { channel } = partyOf(conversation);
              return {
                id: conversation.conversationId,
                title: chats.titleOf(conversation),
                icon: <ChannelIcon kind={channel.kind} label={channel.label} />,
                href: `${BASE}${pagePath("/conversations", conversation.conversationId)}`,
                lastActivity: conversation.lastActivity,
                busy: conversation.busy,
                actions: conversationActions(conversation, archived),
              };
            })}
            onOpen={(id) => navigate(pagePath("/conversations", id))}
          />
        )}
        {found.hasMore && (
          <Button
            size="xs"
            className="self-center"
            disabled={loading}
            aria-busy={loading}
            onClick={() => {
              setLoading(true);
              setProblem(undefined);
              found
                .loadMore()
                .catch((error: unknown) => setProblem(error instanceof Error ? error : new Error(String(error))))
                .finally(() => setLoading(false));
            }}
          >
            {loading ? "Loading" : "Load more"}
          </Button>
        )}
      </section>
    </Page>
  );
}
