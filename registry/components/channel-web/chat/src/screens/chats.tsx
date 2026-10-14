/**
 * The user's conversations, newest activity first, full width (the sidebar's list on a narrow screen):
 * each opens, and renames or deletes from its row. Older ones page in on demand.
 */

import { ChatBubble, EditPencil, Plus, Trash } from "iconoir-react";
import { useState } from "react";
import { Button } from "@/components/bui/Button";
import EmptyState from "@/components/bui/EmptyState";
import { LoaderGrid } from "@/components/bui/LoadingState";
import { Page } from "@/components/bui/Page";
import { StatusPill } from "@/components/bui/StatusPill";
import { ErrorNote } from "@/components/pikit/error-note";
import { useConversations } from "@/lib/conversations";
import { asError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { chatPath, go } from "@/lib/location";
import { usePageTitle, useSession } from "@/lib/session";
import { titleOf, useChatActions } from "./layout";

export function ChatsScreen() {
  const { config } = useSession();
  const conversations = useConversations();
  const actions = useChatActions();
  const [problem, setProblem] = useState<Error>();
  const [loading, setLoading] = useState(false);
  usePageTitle(config.name, "Conversations");
  const items = conversations.items;

  return (
    <Page
      eyebrow="Conversations"
      title={`With ${config.name}`}
      aside={
        <Button size="sm" variant="primary" onClick={() => go("/")}>
          <Plus width={14} height={14} strokeWidth={2} aria-hidden /> New chat
        </Button>
      }
    >
      <section className="flex flex-col gap-3">
        {conversations.error !== undefined && <ErrorNote error={conversations.error} title="The conversations cannot be read" />}
        {problem !== undefined && <ErrorNote error={problem} />}
        {items === undefined && conversations.error === undefined && (
          <div className="flex items-center gap-2.5 text-[13px] text-ink-3">
            <LoaderGrid /> Loading
          </div>
        )}
        {items !== undefined && items.length === 0 && <EmptyState icon={<ChatBubble />} title="No conversations yet" hint="Start one: what you write is answered here." />}
        {items !== undefined && items.length > 0 && (
          <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-card bg-surface shadow-card">
            {items.map((conversation) => (
              <li key={conversation.id} className="flex items-center gap-2 pr-2 transition-colors duration-100 hover:bg-hover">
                <a href={`#${chatPath(conversation.id)}`} className="flex min-w-0 flex-1 flex-col gap-0.5 py-3 pl-4">
                  <span className="truncate text-[14px] font-medium text-ink">{titleOf(conversation)}</span>
                  <span className="text-[12.5px] text-ink-3">{formatAgo(conversation.lastActivity)}</span>
                </a>
                {conversation.busy && <StatusPill tone="accent">Answering</StatusPill>}
                <button
                  type="button"
                  aria-label={`Rename “${titleOf(conversation)}”`}
                  onClick={() => actions.rename(conversation)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-[7px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink"
                >
                  <EditPencil width={15} height={15} strokeWidth={1.9} />
                </button>
                <button
                  type="button"
                  aria-label={`Delete “${titleOf(conversation)}”`}
                  onClick={() => actions.remove(conversation)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-[7px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-red"
                >
                  <Trash width={15} height={15} strokeWidth={1.9} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {conversations.hasOlder && (
          <Button
            size="sm"
            className="self-center"
            disabled={loading}
            aria-busy={loading}
            onClick={() => {
              setLoading(true);
              conversations
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
