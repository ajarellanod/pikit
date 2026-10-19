/**
 * One conversation, live, in the shared view (`components/pikit/conversation.tsx`) over the admin API
 * (`source.ts`); and what an operator does to it (SPEC §5): a message (with images, a web search), a
 * stop, a reset (`/new`). Its top bar holds an info button on who it is with (`PartyChip`: its Details,
 * the channel, the name, the ids, a link to where the channel shows them), the Context panel's button, when there is any (the images
 * sent in it, what its web searches and fetches found), and its menu (Rename, Archive or Restore,
 * Delete: the sidebar row's). Its composer shows its assistant: a conversation never changes agent, so
 * picking another starts a new chat with it. Its "/" runs the App's commands here (`POST
 * …/commands/:name`): what one answers is a quiet note in the thread, for the operator only (no channel
 * gets it); one that left the conversation behind (`/new`) is followed to its key's new conversation,
 * the note with it.
 *
 * The dashboard is a channel of its own: a message from here is a follow-up (it waits for a run
 * going) whose answer stays here. In another channel's conversation nothing said here reaches that
 * channel's chat (the agent reads that the message is the operator's, and that the user sees neither
 * it nor the answer); a run that also answers a user's message is delivered to the user, as always.
 *
 * With an outbound queue (`lib/delivery-feed.ts`, read once for the whole dashboard), an answer of this
 * conversation the queue gave up, or that is stuck in it, gets a quiet note in the thread where the
 * queue says it was (an answer is stored when its run ends; one given up after 24 hours is noted when
 * it was): "Not delivered: <why>", with a link to Delivery.
 */

import { Clock, WarningTriangle } from "iconoir-react";
import { useCallback, useEffect, useMemo } from "react";
import { ActionsMenu } from "@/components/bui/ActionsMenu";
import { ConversationView, type ThreadNote } from "@/components/pikit/conversation";
import { ErrorNote } from "@/components/pikit/error-note";
import { PartyChip, partyOf } from "@/components/pikit/party";
import { api, type ApiCommandResponse, type ApiConversation, type ApiPage, post, useApi } from "@/lib/api";
import { agentsOf, type CommandNote, useChats } from "@/lib/chats";
import type { StuckAnswer, UndeliveredAnswer } from "@/lib/delivery";
import { useDelivery } from "@/lib/delivery-feed";
import { formatAgo } from "@/lib/format";
import { Link, navigate, pagePath } from "@/lib/router";
import { SidePanel, TabActions, useShell } from "@/lib/shell";
import { assistantOptions, imageLimits, webSearchOf } from "./composer";
import { adminSource } from "./source";

/** What a command answered: a quiet note in the thread, the operator's only. */
function CommandNoteRow({ note }: { note: CommandNote }) {
  return (
    <div className="flex items-start gap-2.5 rounded-card bg-inset px-3 py-2.5 shadow-hairline" style={{ animation: "fade-up 320ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <span className="mt-px flex h-5 shrink-0 items-center rounded-chip bg-surface px-1.5 font-mono chat-text-11.5 text-ink-2 shadow-hairline">/{note.command}</span>
      <p className="min-w-0 flex-1 chat-text-13 leading-5 text-ink-2 [overflow-wrap:anywhere]">{note.text}</p>
      <span className="mt-0.5 shrink-0 chat-text-11 text-ink-3">Only you see this</span>
    </div>
  );
}

/** An answer of this conversation the queue gave up, or holds stuck: a quiet note, a link to Delivery. */
function DeliveryNoteRow({ answer }: { answer: { kind: "undelivered"; of: UndeliveredAnswer } | { kind: "stuck"; of: StuckAnswer } }) {
  const undelivered = answer.kind === "undelivered";
  const text = undelivered
    ? `Not delivered: ${answer.of.reason}`
    : answer.of.retrying
      ? `Not delivered yet: retrying${answer.of.lastError === undefined ? "" : ` (${answer.of.lastError})`}`
      : "Not delivered yet: waiting to be sent";
  const Icon = undelivered ? WarningTriangle : Clock;
  return (
    <div role="note" className="flex items-start gap-2.5 rounded-card bg-inset px-3 py-2.5 shadow-hairline" style={{ animation: "fade-up 320ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <Icon width={15} height={15} strokeWidth={1.9} aria-hidden className={`mt-0.5 shrink-0 ${undelivered ? "text-red" : "text-orange"}`} />
      <p className="min-w-0 flex-1 chat-text-13 leading-5 text-ink-2 [overflow-wrap:anywhere]">{text}</p>
      <span className="mt-0.5 shrink-0 chat-text-11 text-ink-3">
        {undelivered ? `Given up ${formatAgo(answer.of.at)}` : `Since ${formatAgo(answer.of.since)}`} ·{" "}
        <Link to="/delivery" className="underline-offset-2 hover:text-ink hover:underline">
          Delivery
        </Link>
      </span>
    </div>
  );
}

export function ConversationPage({ params }: { params: Record<string, string> }) {
  const id = params.id ?? "";
  const chats = useChats();
  const { app, agents: described, commands, newChat, conversationActions } = useShell();
  const agents = agentsOf(app, described);
  const delivery = useDelivery((app.capabilities["outbound.queue"]?.providers.length ?? 0) > 0).problems;
  const source = useMemo(() => adminSource(id), [id]);
  const summary = useApi<ApiConversation>(`/conversations/${encodeURIComponent(id)}`);
  const { reload } = summary;
  const conversation = summary.data?.conversationId === id ? summary.data : undefined;

  const { openTab, setFirstMessage } = chats;
  useEffect(() => {
    if (conversation !== undefined) openTab(conversation);
  }, [conversation, openTab]);

  // Until the API titles it, a chat is named by the first words written in it, once read here.
  const onFirstText = useCallback(
    (text: string) => {
      if (conversation !== undefined && conversation.title === undefined) setFirstMessage(conversation.conversationId, text);
    },
    [conversation, setFirstMessage],
  );

  if (summary.error !== undefined) {
    return (
      <div className="mx-auto w-full max-w-[720px] p-8">
        <ErrorNote error={summary.error} title="This conversation cannot be read" />
      </div>
    );
  }

  /**
   * Runs `/name args` here. Its note stays in this page; a command that left this conversation behind
   * (`/new`) is followed to its key's current one, which gets the note. What fails, the view shows.
   */
  const runCommand = async (name: string, args: string) => {
    if (conversation === undefined) return;
    const answer = await post<ApiCommandResponse>(`/conversations/${encodeURIComponent(conversation.conversationId)}/commands/${encodeURIComponent(name)}`, { args });
    let target = conversation.conversationId;
    const now = await api<ApiConversation>(`/conversations/${encodeURIComponent(conversation.conversationId)}`).catch(() => undefined);
    if (now?.current === false && now.key !== undefined) {
      const page = await api<ApiPage<ApiConversation>>("/conversations?limit=50").catch(() => undefined);
      target = page?.items.find((each) => each.key === now.key && each.current === true)?.conversationId ?? target;
    }
    chats.addNote(target, name, answer.text ?? `Ran /${name}.`);
    chats.reload();
    if (target === conversation.conversationId) reload();
    else {
      chats.replaced(conversation.conversationId, target);
      navigate(pagePath("/conversations", target), { replace: true });
    }
  };

  const notes: ThreadNote[] = [
    ...chats.notesOf(id).map((note) => ({ key: `note-${note.id}`, at: note.at, node: <CommandNoteRow note={note} /> })),
    ...(delivery?.undelivered ?? [])
      .filter((answer) => answer.conversationId === id)
      .map((answer) => ({ key: `undelivered-${answer.key}`, at: answer.at, node: <DeliveryNoteRow answer={{ kind: "undelivered", of: answer }} /> })),
    ...(delivery?.stuck ?? [])
      .filter((answer) => answer.conversationId === id)
      .map((answer) => ({ key: `stuck-${answer.key}`, at: answer.since, node: <DeliveryNoteRow answer={{ kind: "stuck", of: answer }} /> })),
  ].sort((a, b) => a.at - b.at);
  const archived = chats.archived?.some((each) => each.conversationId === id) === true;

  return (
    <ConversationView
      source={source}
      sent={chats}
      context={conversation !== undefined}
      onChange={reload}
      onFirstText={onFirstText}
      notes={notes}
      actions={(contextButton) =>
        conversation !== undefined && (
          <TabActions>
            <PartyChip party={partyOf(conversation)} />
            {contextButton}
            <ActionsMenu
              actions={conversationActions(conversation, archived)}
              label="Conversation actions"
              // Archived or not: the archived ones are read when the menu opens.
              onOpenChange={(open) => open && chats.archived === undefined && chats.loadArchived()}
              className="size-7 rounded-[7px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink aria-expanded:bg-hover-2 aria-expanded:text-ink"
            />
          </TabActions>
        )
      }
      side={(panel) => <SidePanel>{panel}</SidePanel>}
      closed={
        conversation !== undefined && conversation.current !== true ? (
          <p className="rounded-card bg-inset px-3 py-2.5 chat-text-13 text-ink-2 shadow-hairline">
            {conversation.current === false ? "A reset left this conversation behind: it can be read, not talked to." : "No message has reached this conversation yet."}
          </p>
        ) : undefined
      }
      composer={{
        disabled: conversation === undefined,
        picker:
          conversation?.agent === undefined
            ? undefined
            : {
                label: "assistant",
                options: assistantOptions(agents.includes(conversation.agent) ? agents : [conversation.agent, ...agents], (name) => (name !== conversation.agent ? "new chat" : undefined)),
                value: conversation.agent,
                onChange: (agent) => newChat(agent),
                ...(agents.some((name) => name !== conversation.agent) && { note: "A chat keeps its assistant: another one starts a new chat with it." }),
              },
        images: imageLimits(app),
        webSearch: webSearchOf(described, conversation?.agent),
        commands: commands ?? [],
        onCommand: runCommand,
      }}
    />
  );
}
