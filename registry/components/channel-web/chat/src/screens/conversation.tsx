/**
 * One conversation, live, in the dashboard's shared view (`components/pikit/conversation.tsx`,
 * features/completed/chat-parity.md) over the chat API (`lib/source.ts`): its transcript and live events as the
 * operator lets users see them (`ChatConfig.visibility`: the thinking, the tools, cut by the server),
 * the answer as it is written, a stop while a run goes, and the composer (text, images and files; no "/"
 * menu, no web search). A message sent shows at once, marked while it waits for the run going.
 *
 * At the tab bar's end (`TabActions`): "Archived" when it is, the Context panel's button when the
 * operator's policy shows it (`visibility.context`; the panel goes beside the window, `SidePanel`), and
 * its menu (the sidebar row's own, `useConversationMenu`). Its composer shows its assistant when it
 * was made with one of `ChatConfig.agents`: a conversation keeps its assistant, so picking another
 * starts a new chat with it.
 *
 * Its project, when it was made in one, is a badge in the composer (as web search's in the dashboard: a
 * link to the project's page); another assistant picked starts the new chat in the same project. The commands the operator lets
 * users type (`ChatConfig.commands`) have the composer's "/" menu (those for its assistant, when it is
 * one users may pick; else every one): one runs in this conversation and
 * what it answered shows as a quiet note (`CommandNoteRow`), never in the transcript.
 *
 * In a project's chat, what its assistants (or its author's commands) added to the project from it
 * shows under the answer that made it, from the project's logs (`.../notices`, read again when the
 * conversation changes), with Undo: "trader added to the project: rule “Target CPA 18 EUR”".
 *
 * An archived conversation is still talked to: a message lists it again (the server's rule), and the
 * page reads it again when the live stream says it changed.
 */

import { Folder } from "iconoir-react";
import { useEffect, useMemo } from "react";
import { ActionsMenu } from "@/components/bui/ActionsMenu";
import { Badge } from "@/components/bui/Badge";
import { CommandNoteRow } from "@/components/chat/command-note";
import { ProjectNoticeRow } from "@/components/chat/project-notice";
import { ConversationView, type ThreadNote } from "@/components/pikit/conversation";
import { ErrorNote } from "@/components/pikit/error-note";
import type { ChatChange, ChatConversation, ChatNotices, ChatSendRequest, ChatSendResponse } from "@/lib/chat-api";
import { follow, get, post, useGet } from "@/lib/client";
import { useConversations } from "@/lib/conversations";
import { ChatFailure } from "@/lib/errors";
import { fileLimits, imageLimits } from "@/lib/images";
import { assistantName } from "@/lib/names";
import { useProjects } from "@/lib/projects";
import { projectApi } from "@/lib/project";
import { projectPath } from "@/lib/routes";
import { usePageTitle, useSession } from "@/lib/session";
import { chatSource, conversationPath } from "@/lib/source";
import { SidePanel, TabActions, titleOf, useConversationMenu, useNewChat } from "./layout";

const client = { get, post, follow };

export function ConversationScreen({ chatId }: { chatId: string }) {
  const { config, me } = useSession();
  const conversations = useConversations();
  const menu = useConversationMenu();
  const newChat = useNewChat();
  const projects = useProjects();
  const { openTab, reload: reloadList, addNote } = conversations;
  // Once a message is in, the sidebar reads the list again: this conversation is the latest now.
  const source = useMemo(() => {
    const chat = chatSource(chatId, client, config.target);
    return { ...chat, send: (message: Parameters<typeof chat.send>[0]) => chat.send(message).finally(reloadList) };
  }, [chatId, config.target, reloadList]);
  const summary = useGet<ChatConversation>(conversationPath(chatId));
  const conversation = summary.data?.id === chatId ? summary.data : undefined;
  usePageTitle(config.name, conversation === undefined ? undefined : titleOf(conversation));

  const { reload: reloadSummary } = summary;
  // What its project's logs say was added from here: read when it is a project's chat, again when it changes.
  const notices = useGet<ChatNotices>(config.projects !== undefined && summary.data?.project !== undefined ? `${conversationPath(chatId)}/notices` : null);
  const { reload: reloadNotices } = notices;
  useEffect(() => {
    if (conversation !== undefined) openTab(conversation);
  }, [conversation, openTab]);

  if (summary.error !== undefined && conversation === undefined) {
    const missing = summary.error instanceof ChatFailure && summary.error.status === 404;
    return (
      <div className="mx-auto w-full max-w-[720px] p-6 sm:p-8">
        <ErrorNote error={summary.error} title={missing ? "No such conversation" : "This conversation cannot be read"} />
        <a href="#/" className="mt-4 inline-block text-[13px] font-medium text-ink underline decoration-line-strong underline-offset-2">
          Start a new one
        </a>
      </div>
    );
  }

  const agents = config.agents.map((agent) => agent.name);
  const agent = conversation?.agent;
  const project = conversation?.project;
  const projectName = projects.get(project)?.name;

  /** A command typed here: run in this conversation, what it answered a note (else, sent as a message after all). */
  const runCommand = async (name: string, args: string) => {
    const body: ChatSendRequest = { text: args === "" ? `/${name}` : `/${name} ${args}` };
    const answer = await post<ChatSendResponse>(`${conversationPath(chatId)}/messages`, body);
    if (answer.command !== undefined) addNote(chatId, answer.command);
    reloadList();
  };
  const undo = async (change: ChatChange) => {
    if (project === undefined) return;
    await post(projectApi(project, `/history/${change.log}/${change.n}/restore`)).catch(() => undefined);
    reloadNotices();
  };
  const notes: ThreadNote[] = [
    ...conversations.notesOf(chatId).map((note) => ({ key: `note-${note.id}`, at: note.at, node: <CommandNoteRow note={note} /> })),
    ...(project === undefined
      ? []
      : (notices.data?.items ?? []).map((change) => ({
          key: `project-${change.log}-${change.n}`,
          at: change.at,
          node: <ProjectNoticeRow change={change} me={me.user.id} projectHref={`#${projectPath(project, "history")}`} onUndo={() => undo(change)} />,
        }))),
  ];

  return (
    <ConversationView
      source={source}
      sent={conversations}
      notes={notes}
      context={config.visibility.context}
      toolDetails={config.visibility.tools === "full"}
      // Its busy flag, its title and where it is listed (a message lists an archived one again) follow.
      onChange={() => {
        reloadSummary();
        reloadList();
        reloadNotices();
      }}
      actions={(contextButton) =>
        conversation !== undefined && (
          <TabActions>
            {conversation.archived && <Badge>Archived</Badge>}
            {contextButton}
            <ActionsMenu
              actions={menu(conversation, reloadSummary)}
              label="Conversation actions"
              className="btn btn-ghost btn-icon size-7 text-ink-3 hover:text-ink aria-expanded:text-ink"
            />
          </TabActions>
        )
      }
      side={(panel) => <SidePanel>{panel}</SidePanel>}
      composer={{
        disabled: conversation === undefined,
        badges:
          project === undefined || projectName === undefined
            ? []
            : [{ key: "project", label: projectName, title: `Project: ${projectName}`, href: `#${projectPath(project)}`, icon: <Folder width={12} height={12} strokeWidth={2} aria-hidden /> }],
        commands: config.commands,
        ...(agent !== undefined && { agent }),
        commandsMenu: config.commands.length > 0,
        commandsNote: "Runs here, never sent to the assistant",
        onCommand: runCommand,
        images: imageLimits(config.target),
        ...(config.files && { files: fileLimits(config.target) }),
        placeholder: (busy) => (busy ? "Reply: it runs after the answer going" : "Reply"),
        picker:
          agent === undefined
            ? undefined
            : {
                label: "assistant",
                options: (agents.includes(agent) ? agents : [agent, ...agents]).map((name) => ({ key: name, name: assistantName(name), ...(name !== agent && { tag: "new chat" }) })),
                value: agent,
                onChange: (name) => newChat({ agent: name, project }),
                ...(agents.some((name) => name !== agent) && { note: "A chat keeps its assistant: another one starts a new chat with it." }),
              },
      }}
    />
  );
}
