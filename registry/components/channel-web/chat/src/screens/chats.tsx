/**
 * The user's conversations, newest activity first, full width, a page at a time ("Load more"): the
 * sidebar lists only the latest (`SIDEBAR_CHATS`; its "View all" leads here). Each row opens its
 * conversation (the shared `ConversationList`, as the dashboard's Conversations), and its menu (the
 * sidebar row's own, `useConversationMenu`) renames, archives or deletes it; a change made anywhere on
 * the page reads the list again (`useConversations().changed`).
 *
 * A search field finds them by title (`?q=`, the server's: the user's own only, any case), as the
 * person stops typing; "Archived" lists the archived ones instead (`?archived=1`), searched alike: the
 * only place they are.
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
import { type ChatConversation, type ChatPage, SEARCH_MAX } from "@/lib/chat-api";
import { get } from "@/lib/client";
import { useConversations } from "@/lib/conversations";
import { asError } from "@/lib/errors";
import { chatPath } from "@/lib/location";
import { usePageTitle, useSession } from "@/lib/session";
import { conversationsPath } from "@/lib/source";
import { titleOf, useConversationMenu, useNewChat } from "./layout";

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

/** The conversations `q` finds, archived or not: `undefined` items until read; read again when `round` moves. More pages on demand. */
function useFound(q: string, archived: boolean, round: number) {
  const [found, setFound] = useState<{ key: string; items: ChatConversation[]; next?: string | undefined }>();
  const [error, setError] = useState<Error>();
  const key = `${archived}:${q}`;

  useEffect(() => {
    let live = true;
    get<ChatPage<ChatConversation>>(conversationsPath({ limit: PAGE, archived, q })).then(
      (page) => live && (setFound({ key, items: page.items, next: page.next }), setError(undefined)),
      (thrown: unknown) => live && setError(asError(thrown)),
    );
    return () => {
      live = false;
    };
  }, [key, q, archived, round]);

  const current = found?.key === key ? found : undefined;
  const loadMore = async () => {
    if (current?.next === undefined) return;
    const page = await get<ChatPage<ChatConversation>>(conversationsPath({ limit: PAGE, archived, q, cursor: current.next }));
    const ids = new Set(current.items.map((each) => each.id));
    setFound({ key, items: [...current.items, ...page.items.filter((each) => !ids.has(each.id))], next: page.next });
  };
  return { items: current?.items, error, hasMore: current?.next !== undefined, loadMore };
}

export function ChatsScreen() {
  const { config } = useSession();
  const conversations = useConversations();
  const menu = useConversationMenu();
  const newChat = useNewChat();
  const [problem, setProblem] = useState<Error>();
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  usePageTitle(config.name, "Conversations");
  const q = useDebounced(query.trim(), DEBOUNCE_MS);
  const found = useFound(q, archived, conversations.changed);
  const items = found.items;

  return (
    <Page
      eyebrow="Conversations"
      title={`With ${config.name}`}
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
            title={q !== "" ? `No ${archived ? "archived " : ""}conversation titled with “${q}”` : archived ? "No archived conversations" : "No conversations yet"}
            hint={q !== "" ? "Search finds words of a title, in any case." : archived ? "A conversation you archive is listed here." : "Start one: what you write is answered here."}
          />
        )}
        {items !== undefined && items.length > 0 && (
          <ConversationList
            items={items.map((conversation) => ({
              id: conversation.id,
              title: titleOf(conversation),
              href: `#${chatPath(conversation.id)}`,
              lastActivity: conversation.lastActivity,
              busy: conversation.busy,
              tag: conversation.archived && !archived ? "Archived" : undefined,
              actions: menu(conversation),
            }))}
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
                .catch((error: unknown) => setProblem(asError(error)))
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
