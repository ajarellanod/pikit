/**
 * Conversations (`/conversations/all`): every conversation, the most recently active first, a page at
 * a time ("Load more", the API's cursor), where the sidebar lists only the latest (`SIDEBAR_CHATS`,
 * its "View all" leads here). A search finds them by title or key (`?q=`, the API's: any case), as the
 * operator stops typing. A choice lists one bucket of the conversation directory (`?state=`): Active,
 * Hidden by me, Archived (for everyone) or Deleted (for everyone), searched alike: the only place the
 * last three are. Each row shows its channel's icon, and opens its conversation, and its menu is the
 * sidebar row's (`useShell().conversationActions`: Show again and Restore put one back); a change made
 * anywhere here reads the list again (`useChats().changed`).
 */

import { Archive, ChatBubble, EyeClosed, Plus, Search, Trash } from "iconoir-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/bui/Button";
import { ConversationList } from "@/components/bui/ConversationList";
import EmptyState from "@/components/bui/EmptyState";
import { LoaderGrid } from "@/components/bui/LoadingState";
import { Page } from "@/components/bui/Page";
import SearchField from "@/components/bui/SearchField";
import { ErrorNote } from "@/components/pikit/error-note";
import { ChannelIcon, partyOf } from "@/components/pikit/party";
import { type Choice, Segmented } from "@/components/pikit/settings-rows";
import { SEARCH_MAX } from "@/lib/admin-api";
import { api, type ApiConversation, type ApiListState, type ApiPage } from "@/lib/api";
import { useChats } from "@/lib/chats";
import { BASE, navigate, pagePath } from "@/lib/router";
import { useShell } from "@/lib/shell";

/** The list's path. */
export const CONVERSATIONS_PATH = "/conversations/all";
const PAGE = 30;
/** How long after the last key a search goes. */
const DEBOUNCE_MS = 250;

/** The buckets, in plain words. */
const STATES: Choice<ApiListState>[] = [
  { value: "listed", label: "Active" },
  { value: "hidden", label: "Hidden by me" },
  { value: "archived", label: "Archived" },
  { value: "deleted", label: "Deleted" },
];

/** What an empty bucket says: its icon, its title, a hint. */
const EMPTY: Record<ApiListState, { icon: ReactNode; title: string; hint: string }> = {
  listed: { icon: <ChatBubble />, title: "No conversations yet", hint: "Start one with New chat, or wait for a channel's." },
  hidden: { icon: <EyeClosed />, title: "Nothing hidden", hint: "A chat you hide for yourself is listed here, until someone writes in it again." },
  archived: { icon: <Archive />, title: "No archived conversations", hint: "A chat archived for everyone is listed here, until its person writes again." },
  deleted: { icon: <Trash />, title: "No deleted conversations", hint: "A chat deleted for everyone is listed here only; Restore brings it back." },
};

/** `value`, once it stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const pathOf = ({ q, state, cursor }: { q: string; state: ApiListState; cursor?: string }): string => {
  const params = new URLSearchParams({ limit: String(PAGE) });
  if (state !== "listed") params.set("state", state);
  if (q !== "") params.set("q", q);
  if (cursor !== undefined) params.set("cursor", cursor);
  return `/conversations?${params}`;
};

/** The conversations of `state` that `q` finds: `undefined` until read; read again when `round` moves. More pages on demand. */
function useFound(q: string, state: ApiListState, round: number) {
  const key = `${state}:${q}`;
  const [found, setFound] = useState<{ key: string; items: ApiConversation[]; next?: string | undefined }>();
  const [error, setError] = useState<Error>();

  useEffect(() => {
    let live = true;
    api<ApiPage<ApiConversation>>(pathOf({ q, state })).then(
      (page) => live && (setFound({ key, items: page.items, next: page.next }), setError(undefined)),
      (thrown: unknown) => live && setError(thrown instanceof Error ? thrown : new Error(String(thrown))),
    );
    return () => {
      live = false;
    };
  }, [key, q, state, round]);

  const current = found?.key === key ? found : undefined;
  const loadMore = async () => {
    if (current?.next === undefined) return;
    const page = await api<ApiPage<ApiConversation>>(pathOf({ q, state, cursor: current.next }));
    const ids = new Set(current.items.map((each) => each.conversationId));
    setFound({ key, items: [...current.items, ...page.items.filter((each) => !ids.has(each.conversationId))], next: page.next });
  };
  return { items: current?.items, error, hasMore: current?.next !== undefined, loadMore };
}

export function ConversationsPage() {
  const chats = useChats();
  const { newChat, conversationActions } = useShell();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<ApiListState>("listed");
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<Error>();
  const q = useDebounced(query.trim(), DEBOUNCE_MS);
  const found = useFound(q, state, chats.changed);
  const empty = EMPTY[state];
  const named = STATES.find((each) => each.value === state)?.label.toLowerCase() ?? "";
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
          <Segmented value={state} options={STATES} onChange={setState} label="Which conversations" />
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
            icon={q !== "" ? <Search /> : empty.icon}
            title={q !== "" ? `No ${state === "listed" ? "" : `${named} `}conversation with “${q}”` : empty.title}
            hint={q !== "" ? "Search finds words of a title, or of a key, in any case." : empty.hint}
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
                actions: conversationActions(conversation),
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
