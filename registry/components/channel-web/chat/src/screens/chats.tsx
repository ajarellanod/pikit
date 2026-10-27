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
 *
 * A project's page (`?project=<id>`, the sidebar's project row) lists only its chats, searched and
 * archived alike, under its name, with its menu (a new chat in it, Rename, Delete); without one, each
 * chat of a project says which, and "Not in a project" lists those of none (`?project=none`).
 */

import { Archive, ChatBubble, Folder, Plus, Search } from "iconoir-react";
import { useEffect, useState } from "react";
import { ActionsMenu } from "@/components/bui/ActionsMenu";
import { Button } from "@/components/bui/Button";
import { ConversationList } from "@/components/bui/ConversationList";
import EmptyState from "@/components/bui/EmptyState";
import { LoaderGrid } from "@/components/bui/LoadingState";
import { Page } from "@/components/bui/Page";
import SearchField from "@/components/bui/SearchField";
import { Switch } from "@/components/bui/Switch";
import { ErrorNote } from "@/components/pikit/error-note";
import { type ChatConversation, type ChatPage, NO_PROJECT, SEARCH_MAX } from "@/lib/chat-api";
import { get } from "@/lib/client";
import { useConversations } from "@/lib/conversations";
import { asError } from "@/lib/errors";
import { chatPath } from "@/lib/location";
import { useProjects } from "@/lib/projects";
import { usePageTitle, useSession } from "@/lib/session";
import { conversationsPath } from "@/lib/source";
import { titleOf, useConversationMenu, useNewChat, useProjectMenu } from "./layout";

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

/**
 * The conversations `q` finds, archived or not, of `project` (an id, `NO_PROJECT`, or any): `undefined`
 * items until read; read again when `round` moves. More pages on demand.
 */
function useFound(q: string, archived: boolean, project: string | undefined, round: number) {
  const [found, setFound] = useState<{ key: string; items: ChatConversation[]; next?: string | undefined }>();
  const [error, setError] = useState<Error>();
  const key = `${archived}:${project ?? ""}:${q}`;

  useEffect(() => {
    let live = true;
    setError(undefined);
    get<ChatPage<ChatConversation>>(conversationsPath({ limit: PAGE, archived, q, project })).then(
      (page) => live && (setFound({ key, items: page.items, next: page.next }), setError(undefined)),
      (thrown: unknown) => live && setError(asError(thrown)),
    );
    return () => {
      live = false;
    };
  }, [key, q, archived, project, round]);

  const current = found?.key === key ? found : undefined;
  const loadMore = async () => {
    if (current?.next === undefined) return;
    const page = await get<ChatPage<ChatConversation>>(conversationsPath({ limit: PAGE, archived, q, project, cursor: current.next }));
    const ids = new Set(current.items.map((each) => each.id));
    setFound({ key, items: [...current.items, ...page.items.filter((each) => !ids.has(each.id))], next: page.next });
  };
  return { items: current?.items, error, hasMore: current?.next !== undefined, loadMore };
}

export function ChatsScreen({ project }: { project?: string | undefined }) {
  const { config } = useSession();
  const conversations = useConversations();
  const projects = useProjects();
  const menu = useConversationMenu();
  const projectMenu = useProjectMenu();
  const newChat = useNewChat();
  const [problem, setProblem] = useState<Error>();
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [loose, setLoose] = useState(false);
  const shown = projects.get(project);
  usePageTitle(config.name, project === undefined ? "Conversations" : (shown?.name ?? "Project"));
  const q = useDebounced(query.trim(), DEBOUNCE_MS);
  // Read again when a project's count changes too (a chat made or deleted in it).
  const found = useFound(q, archived, project ?? (loose ? NO_PROJECT : undefined), conversations.changed);
  const items = found.items;
  const nameOf = (id: string | undefined) => projects.get(id)?.name;

  return (
    <Page
      eyebrow={project === undefined ? "Conversations" : "Project"}
      title={project === undefined ? `With ${config.name}` : (shown?.name ?? "")}
      aside={
        <div className="flex items-center gap-1.5">
          <Button variant="primary" size="xs" onClick={() => newChat({ project })}>
            <Plus width={14} height={14} strokeWidth={2} aria-hidden /> New chat
          </Button>
          {shown !== undefined && <ActionsMenu actions={projectMenu(shown).filter((each) => each.key !== "new")} label="Project actions" className="btn btn-ghost btn-icon size-7 text-ink-3 hover:text-ink aria-expanded:text-ink" />}
        </div>
      }
    >
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <SearchField value={query} onChange={(value) => setQuery(value.slice(0, SEARCH_MAX))} placeholder="Search by title" label="Search the conversations" className="min-w-0 flex-1" />
          {project === undefined && (projects.items?.length ?? 0) > 0 && (
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[13px] text-ink-2">
              <Switch checked={loose} onChange={setLoose} size="sm" label="Not in a project" />
              <span aria-hidden>Not in a project</span>
            </label>
          )}
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
            icon={q !== "" ? <Search /> : archived ? <Archive /> : project !== undefined ? <Folder /> : <ChatBubble />}
            title={q !== "" ? `No ${archived ? "archived " : ""}conversation titled with “${q}”` : archived ? "No archived conversations" : project !== undefined ? "No chats in this project yet" : "No conversations yet"}
            hint={
              q !== ""
                ? "Search finds words of a title, in any case."
                : archived
                  ? "A conversation you archive is listed here."
                  : project !== undefined
                    ? "Its chats share what the assistant keeps for the project. A chat stays in the project it starts in."
                    : "Start one: what you write is answered here."
            }
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
              tag: conversation.archived && !archived ? "Archived" : project === undefined ? nameOf(conversation.project) : undefined,
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
