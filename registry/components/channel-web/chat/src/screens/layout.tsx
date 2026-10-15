/**
 * The signed-in page, in the dashboard's harness: Beautiful UI's sidebar (the assistant's name; New
 * chat, Conversations; the user's conversations, each with its menu, and the archived ones apart; at
 * its foot the user's name, opening Settings, the theme and Sign out), and the screen in a window
 * beside it. On a narrow screen the sidebar starts folded to its icons, and Conversations lists them
 * full width.
 *
 * A conversation has one menu wherever it shows (the sidebar's row, the list's, its own header):
 * Rename, Archive (Restore when archived), Delete (`useConversationMenu`, `bui/ActionsMenu`). Renaming
 * and deleting ask in a dialog. Settings is a modal (`settings.tsx`), opened from the foot's menu or
 * by `#/settings/<section>` (the route opens it over a new chat).
 */

import { Archive, ChatBubble, EditPencil, LogOut, Plus, Settings, Trash, Undo, User } from "iconoir-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { ActionsMenuItem } from "@/components/bui/ActionsMenu";
import SidebarNav, { MenuRow, MenuSeparator, type SidebarChat, type SidebarItem } from "@/components/bui/SidebarNav";
import { ThemeToggle } from "@/components/bui/ThemeToggle";
import { ConfirmDialog, RenameDialog } from "@/components/chat/dialog";
import { ErrorNote } from "@/components/pikit/error-note";
import { type ChatConversation, TITLE_MAX } from "@/lib/chat-api";
import { useConversations } from "@/lib/conversations";
import { asError } from "@/lib/errors";
import { chatIdOf, chatPath, go } from "@/lib/location";
import { type Route, settingsSectionOf } from "@/lib/routes";
import { useSession } from "@/lib/session";
import { AssistantBadge } from "./auth-card";
import { SettingsModal } from "./settings";

/** A conversation's menu, the same everywhere: its items for `conversation`; `changed` hears what renaming or archiving made of it. */
export type ConversationMenu = (conversation: ChatConversation, changed?: (now: ChatConversation) => void) => ActionsMenuItem[];

const MenuContext = createContext<ConversationMenu | undefined>(undefined);

export function useConversationMenu(): ConversationMenu {
  const value = useContext(MenuContext);
  if (value === undefined) throw new Error("useConversationMenu outside the layout");
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
  const [renaming, setRenaming] = useState<{ conversation: ChatConversation; changed?: (now: ChatConversation) => void }>();
  const [deleting, setDeleting] = useState<ChatConversation>();
  const [problem, setProblem] = useState<Error>();
  const [settings, setSettings] = useState<string>();
  const openId = chatIdOf(route.path);

  // `#/settings/<section>` opens Settings over a new chat.
  const asked = settingsSectionOf(route.path);
  useEffect(() => {
    if (asked === undefined) return;
    setSettings(asked);
    go("/", true);
  }, [asked]);

  const remove = (conversation: ChatConversation) => {
    setProblem(undefined);
    conversations.remove(conversation.id).then(
      () => openId === conversation.id && go("/", true),
      (error: unknown) => setProblem(asError(error)),
    );
  };

  const { archive } = conversations;
  const menu: ConversationMenu = useCallback(
    (conversation, changed) => {
      const put = (archived: boolean) => {
        setProblem(undefined);
        archive(conversation.id, archived).then(
          (now) => changed?.(now),
          (error: unknown) => setProblem(asError(error)),
        );
      };
      return [
        { key: "rename", label: "Rename", icon: <EditPencil />, onSelect: () => setRenaming({ conversation, changed }) },
        conversation.archived
          ? { key: "unarchive", label: "Restore", icon: <Undo />, onSelect: () => put(false) }
          : { key: "archive", label: "Archive", icon: <Archive />, onSelect: () => put(true) },
        { key: "delete", label: "Delete", icon: <Trash />, danger: true, onSelect: () => setDeleting(conversation) },
      ];
    },
    [archive],
  );

  const items: SidebarItem[] = [
    { key: "new", label: "New chat", icon: <Plus />, active: route.path === "/", href: href("/"), onSelect: () => go("/") },
    { key: "chats", label: "Conversations", icon: <ChatBubble />, active: route.path === "/chats", href: href("/chats"), onSelect: () => go("/chats") },
  ];
  const rowOf = (conversation: ChatConversation): SidebarChat => ({
    id: conversation.id,
    label: titleOf(conversation),
    busy: conversation.busy,
    active: conversation.id === openId,
    href: href(chatPath(conversation.id)),
    actions: menu(conversation),
  });

  return (
    <MenuContext.Provider value={menu}>
      <main className="flex h-[100dvh] bg-canvas p-1.5 pl-0 text-ink sm:p-2.5 sm:pl-0">
        <SidebarNav
          key={narrow ? "narrow" : "wide"}
          defaultCollapsed={narrow}
          workspace={{ name: config.name, logo: <AssistantBadge name={config.name} size={20} /> }}
          items={items}
          chats={(conversations.items ?? []).map(rowOf)}
          archived={{ chats: conversations.archived?.map(rowOf), onOpen: conversations.loadArchived }}
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
                icon={<Settings />}
                onClick={() => {
                  close();
                  setSettings("profile");
                }}
              >
                Settings
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

      <SettingsModal section={settings} onClose={() => setSettings(undefined)} />
      <RenameDialog
        open={renaming !== undefined}
        title={renaming === undefined ? "" : titleOf(renaming.conversation)}
        max={TITLE_MAX}
        onClose={() => setRenaming(undefined)}
        onRename={async (title) => {
          if (renaming !== undefined) renaming.changed?.(await conversations.rename(renaming.conversation.id, title));
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
    </MenuContext.Provider>
  );
}
