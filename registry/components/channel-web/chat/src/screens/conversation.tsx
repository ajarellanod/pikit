/**
 * One conversation, live, in the dashboard's shared view (`components/pikit/conversation.tsx`,
 * features/completed/chat-parity.md) over the chat API (`lib/source.ts`): its transcript and live events as the
 * operator lets users see them (`ChatConfig.visibility`: the thinking, the tools, cut by the server),
 * the answer as it is written, a stop while a run goes, and the composer (text and images; no "/"
 * menu, no web search). A message sent shows at once, marked while it waits for the run going.
 *
 * At the tab bar's end (`TabActions`): "Archived" when it is, the Context panel's button when the
 * operator's policy shows it (`visibility.context`; the panel goes beside the window, `SidePanel`), and
 * its menu (the sidebar row's own, `useConversationMenu`). Its composer shows its assistant when it
 * was made with one of `ChatConfig.agents`: a conversation keeps its assistant, so picking another
 * starts a new chat with it.
 *
 * An archived conversation is still talked to: a message lists it again (the server's rule), and the
 * page reads it again when the live stream says it changed.
 */

import { useEffect, useMemo } from "react";
import { ActionsMenu } from "@/components/bui/ActionsMenu";
import { StatusPill } from "@/components/bui/StatusPill";
import { ConversationView } from "@/components/pikit/conversation";
import { ErrorNote } from "@/components/pikit/error-note";
import type { ChatConversation } from "@/lib/chat-api";
import { follow, get, post, useGet } from "@/lib/client";
import { useConversations } from "@/lib/conversations";
import { ChatFailure } from "@/lib/errors";
import { imageLimits } from "@/lib/images";
import { assistantName } from "@/lib/names";
import { usePageTitle, useSession } from "@/lib/session";
import { chatSource, conversationPath } from "@/lib/source";
import { SidePanel, TabActions, titleOf, useConversationMenu, useNewChat } from "./layout";

const client = { get, post, follow };

export function ConversationScreen({ chatId }: { chatId: string }) {
  const { config } = useSession();
  const conversations = useConversations();
  const menu = useConversationMenu();
  const newChat = useNewChat();
  const source = useMemo(() => chatSource(chatId, client, config.target), [chatId, config.target]);
  const summary = useGet<ChatConversation>(conversationPath(chatId));
  const conversation = summary.data?.id === chatId ? summary.data : undefined;
  usePageTitle(config.name, conversation === undefined ? undefined : titleOf(conversation));

  const { openTab, reload: reloadList } = conversations;
  const { reload: reloadSummary } = summary;
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

  return (
    <ConversationView
      source={source}
      sent={conversations}
      context={config.visibility.context}
      toolDetails={config.visibility.tools === "full"}
      // Its busy flag, its title and where it is listed (a message lists an archived one again) follow.
      onChange={() => {
        reloadSummary();
        reloadList();
      }}
      actions={(contextButton) =>
        conversation !== undefined && (
          <TabActions>
            {conversation.archived && <StatusPill tone="neutral">Archived</StatusPill>}
            {contextButton}
            <ActionsMenu
              actions={menu(conversation, reloadSummary)}
              label="Conversation actions"
              className="size-7 rounded-[7px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink aria-expanded:bg-hover-2 aria-expanded:text-ink"
            />
          </TabActions>
        )
      }
      side={(panel) => <SidePanel>{panel}</SidePanel>}
      composer={{
        disabled: conversation === undefined,
        commandsMenu: false,
        images: imageLimits(config.target),
        placeholder: (busy) => (busy ? "Reply: it runs after the answer going" : "Reply"),
        picker:
          agent === undefined
            ? undefined
            : {
                label: "assistant",
                options: (agents.includes(agent) ? agents : [agent, ...agents]).map((name) => ({ key: name, name: assistantName(name), ...(name !== agent && { tag: "new chat" }) })),
                value: agent,
                onChange: (name) => newChat(name),
                ...(agents.some((name) => name !== agent) && { note: "A chat keeps its assistant: another one starts a new chat with it." }),
              },
      }}
    />
  );
}
