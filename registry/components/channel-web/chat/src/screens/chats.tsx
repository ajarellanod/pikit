/**
 * The user's conversations, newest activity first, full width (the sidebar's list on a narrow screen):
 * each opens, and its row's menu (the sidebar row's own, `useConversationMenu`) renames, archives or
 * deletes it. Older ones page in on demand.
 *
 * A search field finds them by title (`?q=`, the server's: the user's own only, any case), as the
 * person stops typing; "Archived" lists the archived ones instead (`?archived=1`), searched alike.
 * Without either, the list is the sidebar's (`useConversations`).
 */

import { Archive, ChatBubble, Plus, Search } from "iconoir-react";
import { useCallback, useEffect, useState } from "react";
import { ActionsMenu } from "@/components/bui/ActionsMenu";
import { Badge } from "@/components/bui/Badge";
import { Button } from "@/components/bui/Button";
import EmptyState from "@/components/bui/EmptyState";
import { LoaderGrid } from "@/components/bui/LoadingState";
import { Page } from "@/components/bui/Page";
import SearchField from "@/components/bui/SearchField";
import { StatusDot } from "@/components/bui/StatusDot";
import { Switch } from "@/components/bui/Switch";
import { ErrorNote } from "@/components/pikit/error-note";
import { type ChatConversation, type ChatPage, SEARCH_MAX } from "@/lib/chat-api";
import { get } from "@/lib/client";
import { useConversations } from "@/lib/conversations";
import { asError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { chatPath, go } from "@/lib/location";
import { usePageTitle, useSession } from "@/lib/session";
import { conversationsPath } from "@/lib/source";
import { titleOf, useConversationMenu } from "./layout";

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

/** The conversations `q` finds, archived or not; `undefined` items until read. Older pages on demand. */
function useFound(q: string, archived: boolean, enabled: boolean) {
  const [found, setFound] = useState<{ key: string; items: ChatConversation[]; next?: string | undefined }>();
  const [error, setError] = useState<Error>();
  const [round, setRound] = useState(0);
  const key = `${archived}:${q}`;

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void round;
    get<ChatPage<ChatConversation>>(conversationsPath({ limit: PAGE, archived, q })).then(
      (page) => live && (setFound({ key, items: page.items, next: page.next }), setError(undefined)),
      (thrown: unknown) => live && setError(asError(thrown)),
    );
    return () => {
      live = false;
    };
  }, [key, q, archived, enabled, round]);

  const current = found?.key === key ? found : undefined;
  const loadOlder = async () => {
    if (current?.next === undefined) return;
    const page = await get<ChatPage<ChatConversation>>(conversationsPath({ limit: PAGE, archived, q, cursor: current.next }));
    const ids = new Set(current.items.map((each) => each.id));
    setFound({ key, items: [...current.items, ...page.items.filter((each) => !ids.has(each.id))], next: page.next });
  };
  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { items: current?.items, error, hasOlder: current?.next !== undefined, loadOlder, reload };
}

export function ChatsScreen() {
  const { config } = useSession();
  const conversations = useConversations();
  const menu = useConversationMenu();
  const [problem, setProblem] = useState<Error>();
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  usePageTitle(config.name, "Conversations");
  const q = useDebounced(query.trim(), DEBOUNCE_MS);
  const searching = q !== "" || archived;
  const found = useFound(q, archived, searching);
  const list = searching ? found : conversations;
  const items = list.items;
  // A row changed here (renamed, archived, restored, deleted): the search reads again.
  const changed = searching ? found.reload : undefined;

  return (
    <Page
      eyebrow="Conversations"
      title={`With ${config.name}`}
      aside={
        <Button variant="primary" onClick={() => go("/")}>
          <Plus width={15} height={15} strokeWidth={2} aria-hidden /> New chat
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
        {list.error !== undefined && <ErrorNote error={list.error} title="The conversations cannot be read" />}
        {problem !== undefined && <ErrorNote error={problem} />}
        {items === undefined && list.error === undefined && (
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
          <ul className="records-shell flex flex-col divide-y divide-line">
            {items.map((conversation) => (
              <li key={conversation.id} className="flex items-center gap-2 pr-2 transition-colors duration-100 hover:bg-hover">
                <a href={`#${chatPath(conversation.id)}`} className="flex min-w-0 flex-1 flex-col gap-0.5 py-3 pl-4">
                  <span className="truncate text-[14px] font-medium text-ink">{titleOf(conversation)}</span>
                  <span className="text-[12.5px] text-ink-3">{formatAgo(conversation.lastActivity)}</span>
                </a>
                {conversation.busy && <StatusDot tone="blue">Answering</StatusDot>}
                {conversation.archived && !archived && <Badge>Archived</Badge>}
                <ActionsMenu
                  actions={menu(conversation, changed)}
                  label={`Actions for ${titleOf(conversation)}`}
                  className="btn btn-ghost btn-icon text-ink-3 hover:text-ink aria-expanded:text-ink"
                />
              </li>
            ))}
          </ul>
        )}
        {list.hasOlder && (
          <Button
            className="self-center"
            disabled={loading}
            aria-busy={loading}
            onClick={() => {
              setLoading(true);
              list
                .loadOlder()
                .catch((error: unknown) => setProblem(asError(error)))
                .finally(() => setLoading(false));
            }}
          >
            Older conversations
          </Button>
        )}
      </section>
    </Page>
  );
}
