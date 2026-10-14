/**
 * The signed-in page, in the dashboard's harness: Beautiful UI's sidebar (the assistant's name; New
 * chat, Conversations, Account; the user's conversations, each with Rename and Delete; at its foot the
 * user's name, opening Account, the theme and Sign out), and the screen in a window beside it. On a narrow screen the sidebar starts
 * folded to its icons, and Conversations lists them full width.
 *
 * Renaming and deleting ask in a dialog, from the sidebar, the list or a conversation alike
 * (`useChatActions`).
 */

import { ChatBubble, EditPencil, LogOut, Plus, Trash, User } from "iconoir-react";
import { createContext, type ReactNode, useContext, useState, useSyncExternalStore } from "react";
import SidebarNav, { MenuRow, MenuSeparator, type SidebarChat, type SidebarItem } from "@/components/bui/SidebarNav";
import { ThemeToggle } from "@/components/bui/ThemeToggle";
import { ConfirmDialog, RenameDialog } from "@/components/chat/dialog";
import { ErrorNote } from "@/components/pikit/error-note";
import { type ChatConversation, TITLE_MAX } from "@/lib/chat-api";
import { useConversations } from "@/lib/conversations";
import { asError } from "@/lib/errors";
import { chatIdOf, chatPath, go, type Route } from "@/lib/location";
import { useSession } from "@/lib/session";
import { AssistantBadge } from "./auth-card";

export interface ChatActions {
  rename(conversation: ChatConversation): void;
  remove(conversation: ChatConversation): void;
}

const ActionsContext = createContext<ChatActions | undefined>(undefined);

export function useChatActions(): ChatActions {
  const value = useContext(ActionsContext);
  if (value === undefined) throw new Error("useChatActions outside the layout");
  return value;
}

const NARROW = "(max-width: 767px)";
const narrowQuery = typeof window === "undefined" ? undefined : window.matchMedia(NARROW);
const subscribeNarrow = (listener: () => void): (() => void) => {
  narrowQuery?.addEventListener("change", listener);
  return () => narrowQuery?.removeEventListener("change", listener);
};
export const useNarrow = (): boolean => useSyncExternalStore(subscribeNarrow, () => narrowQuery?.matches ?? false);

/** A conversation's shown title (`New conversation` while it has none). */
export const titleOf = (conversation: ChatConversation): string => (conversation.title.trim() === "" ? "New conversation" : conversation.title);

const href = (path: string): string => `${import.meta.env.BASE_URL}#${path}`;

export function Layout({ route, children }: { route: Route; children: ReactNode }) {
  const { config, me, signOut } = useSession();
  const conversations = useConversations();
  const narrow = useNarrow();
  const [renaming, setRenaming] = useState<ChatConversation>();
  const [deleting, setDeleting] = useState<ChatConversation>();
  const [problem, setProblem] = useState<Error>();
  const openId = chatIdOf(route.path);

  const actions: ChatActions = { rename: setRenaming, remove: setDeleting };
  const remove = (conversation: ChatConversation) => {
    setProblem(undefined);
    conversations.remove(conversation.id).then(
      () => openId === conversation.id && go("/", true),
      (error: unknown) => setProblem(asError(error)),
    );
  };

  const items: SidebarItem[] = [
    { key: "new", label: "New chat", icon: <Plus />, active: route.path === "/", href: href("/"), onSelect: () => go("/") },
    { key: "chats", label: "Conversations", icon: <ChatBubble />, active: route.path === "/chats", href: href("/chats"), onSelect: () => go("/chats") },
    { key: "account", label: "Account", icon: <User />, active: route.path === "/account", href: href("/account"), onSelect: () => go("/account") },
  ];
  const chats: SidebarChat[] = (conversations.items ?? []).map((conversation) => ({
    id: conversation.id,
    label: titleOf(conversation),
    busy: conversation.busy,
    active: conversation.id === openId,
    href: href(chatPath(conversation.id)),
    actions: [
      { key: "rename", label: "Rename", icon: <EditPencil />, onSelect: () => setRenaming(conversation) },
      { key: "delete", label: "Delete", icon: <Trash />, danger: true, onSelect: () => setDeleting(conversation) },
    ],
  }));

  return (
    <ActionsContext.Provider value={actions}>
      <main className="flex h-[100dvh] bg-canvas p-1.5 pl-0 text-ink sm:p-2.5 sm:pl-0">
        <SidebarNav
          key={narrow ? "narrow" : "wide"}
          defaultCollapsed={narrow}
          workspace={{ name: config.name, logo: <AssistantBadge name={config.name} size={20} /> }}
          items={items}
          chats={chats}
          chatsEmpty={conversations.error !== undefined ? "The conversations cannot be read" : conversations.items === undefined ? "Loading" : "No conversations yet"}
          onPickChat={(id) => go(chatPath(id))}
          chatsFooter={
            conversations.hasOlder ? (
              <button
                type="button"
                onClick={() => void conversations.loadOlder().catch((error: unknown) => setProblem(asError(error)))}
                className="sidebar-copy mx-2 px-2 py-2 text-left text-[12.5px] font-medium text-ink-3 transition-colors duration-100 hover:text-ink"
              >
                Older conversations
              </button>
            ) : undefined
          }
          menuLabel={me.user.name.trim() === "" ? me.user.email : me.user.name}
          menuIcon={<User width={17} height={17} strokeWidth={1.8} className="shrink-0" />}
          menu={(close) => (
            <>
              <MenuRow
                icon={<User />}
                onClick={() => {
                  close();
                  go("/account");
                }}
              >
                Account
              </MenuRow>
              <MenuSeparator />
              <div className="flex h-10 items-center gap-1.5 px-2">
                <span className="min-w-0 flex-1 text-[13.5px] text-ink">Theme</span>
                <ThemeToggle />
              </div>
              <MenuSeparator />
              <MenuRow
                icon={<LogOut />}
                onClick={() => {
                  close();
                  void signOut();
                }}
              >
                Sign out
              </MenuRow>
            </>
          )}
        />

        <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-window border border-line bg-page">
          {problem !== undefined && (
            <div className="border-b border-line px-3 py-2">
              <ErrorNote error={problem} title="The conversation could not be changed" />
            </div>
          )}
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </section>
      </main>

      <RenameDialog
        open={renaming !== undefined}
        title={renaming === undefined ? "" : titleOf(renaming)}
        max={TITLE_MAX}
        onClose={() => setRenaming(undefined)}
        onRename={async (title) => {
          if (renaming !== undefined) await conversations.rename(renaming.id, title);
        }}
      />
      <ConfirmDialog
        open={deleting !== undefined}
        title="Delete this conversation?"
        description={<>“{deleting === undefined ? "" : titleOf(deleting)}” leaves your list for good.</>}
        action="Delete"
        onClose={() => setDeleting(undefined)}
        onConfirm={() => deleting !== undefined && remove(deleting)}
      />
    </ActionsContext.Provider>
  );
}
