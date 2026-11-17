/**
 * A project's Chats: every member's (a project's chats are shared by its members), newest activity
 * first, each saying whose it is. One's own opens as any conversation; another member's opens read only
 * (`ProjectChatReader`, `#/projects/<id>/chats?chat=<chat id>`): its transcript in the shared view, cut by
 * the operator's policy as one's own, with no composer: only its author writes in it.
 */

import { ChatBubble, Plus } from "iconoir-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/bui/Button";
import { ConversationList } from "@/components/bui/ConversationList";
import EmptyState from "@/components/bui/EmptyState";
import { Section } from "@/components/bui/Page";
import { ConversationView } from "@/components/pikit/conversation";
import { ErrorNote } from "@/components/pikit/error-note";
import type { ChatMember, ChatPage, ChatProject, ChatProjectConversation, ChatTranscriptEntry } from "@/lib/chat-api";
import { get, useGet } from "@/lib/client";
import { useConversations } from "@/lib/conversations";
import { asError } from "@/lib/errors";
import { chatPath } from "@/lib/location";
import { principalName, projectApi } from "@/lib/project";
import { projectPath } from "@/lib/routes";
import type { LiveEvent } from "@/lib/transcript";
import { titleOf, useNewChat } from "../layout";
import type { TabProps } from "./index";

const PAGE = 30;

export function ChatsTab({ overview }: TabProps) {
  const { project } = overview;
  const newChat = useNewChat();
  const read = useGet<ChatPage<ChatProjectConversation>>(projectApi(project.id, `/conversations?limit=${PAGE}`), 30_000);
  const [more, setMore] = useState<{ items: ChatProjectConversation[]; next?: string | undefined }>();
  const [error, setError] = useState<Error>();
  const items = [...(read.data?.items ?? []), ...(more?.items ?? [])];
  const next = more === undefined ? read.data?.next : more.next;
  const members = useGet<ChatPage<ChatMember>>(projectApi(project.id, "/members?limit=100"));
  /** Whose a chat is: its author's name among the members (one gone: "A former member's"). */
  const nameOf = (userId: string) => {
    const member = members.data?.items.find((each) => each.principal.channel === "web" && each.principal.id === userId);
    return member === undefined ? "A former member's" : `${principalName(member.principal)}'s`;
  };

  return (
    <Section
      title="Chats"
      meta={String(project.chats)}
      tools={
        !project.archived && (
          <Button size="xs" onClick={() => newChat({ project: project.id })}>
            <Plus width={14} height={14} strokeWidth={2} aria-hidden /> New chat
          </Button>
        )
      }
    >
      <p className="text-[12.5px] text-ink-3">Every member of the project reads its chats; only who started one writes in it.</p>
      {(read.error ?? error) !== undefined && <ErrorNote error={(read.error ?? error) as Error} title="The chats cannot be read" />}
      {read.data !== undefined && items.length === 0 && <EmptyState icon={<ChatBubble />} title="No chats in this project yet" hint="A chat started here shares the project's context, memory and files." />}
      {items.length > 0 && (
        <ConversationList
          items={items.map((conversation) => ({
            id: conversation.id,
            title: titleOf(conversation),
            href: conversation.mine ? `#${chatPath(conversation.id)}` : `#${projectPath(project.id, "chats")}?chat=${conversation.id}`,
            lastActivity: conversation.lastActivity,
            busy: conversation.busy,
            tag: conversation.mine ? "Yours" : nameOf(conversation.userId),
            actions: [],
          }))}
        />
      )}
      {next !== undefined && (
        <Button
          size="xs"
          className="self-center"
          onClick={() =>
            get<ChatPage<ChatProjectConversation>>(projectApi(project.id, `/conversations?limit=${PAGE}&cursor=${encodeURIComponent(next)}`)).then(
              (page) => setMore({ items: [...(more?.items ?? []), ...page.items], next: page.next }),
              (thrown: unknown) => setError(asError(thrown)),
            )
          }
        >
          Load more
        </Button>
      )}
    </Section>
  );
}

/** Another member's chat of `project`, read only, in the shared view. */
export function ProjectChatReader({ project, chatId }: { project: ChatProject; chatId: string }) {
  const sent = useConversations();
  const source = useMemo(
    () => ({
      id: `${project.id}:${chatId}`,
      transcript: ({ limit, cursor }: { limit: number; cursor?: string }) =>
        get<ChatPage<ChatTranscriptEntry>>(projectApi(project.id, `/conversations/${chatId}/transcript?limit=${limit}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`)),
      // No live view of another's chat: its state is read once, then the stream waits until the view goes.
      follow: (onEvent: (event: LiveEvent) => void, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          onEvent({ type: "live", ops: [["r", { busy: false, tools: [] }]] } as LiveEvent);
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      send: () => Promise.reject(new Error("Only who started this chat writes in it.")),
      abort: () => Promise.resolve(),
    }),
    [project.id, chatId],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-[13px] text-ink-2">
        <a href={`#${projectPath(project.id, "chats")}`} className="font-medium text-ink underline decoration-line-strong underline-offset-2">
          {project.name}
        </a>
        <span className="text-ink-3">· a member's chat, read only</span>
      </div>
      <ConversationView
        source={source}
        sent={sent}
        context={false}
        closed={<p className="mx-auto w-full max-w-[720px] px-4 pb-4 text-center text-[12.5px] text-ink-3">Only who started this chat writes in it. Start your own in the project to go on.</p>}
      />
    </div>
  );
}
