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
 *
 * Above the screen, the tabs (the shared `TabBar`, as the dashboard's): the conversations opened, New
 * chat's while it shows, "+" for a fresh one; each closes, the one shown giving way to its neighbour
 * (or a fresh New chat). At the tab bar's right end a page's actions (`TabActions`: a conversation's
 * Archived, Context and menu), and beside the window a panel a page may fill (`SidePanel`: the Context).
 */

import { Archive, ChatBubble, EditPencil, LogOut, Plus, Settings, Trash, Undo, User } from "iconoir-react";
import { createContext, Fragment, type ReactNode, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { ActionsMenuItem } from "@/components/bui/ActionsMenu";
import SidebarNav, { MenuRow, MenuSeparator, type SidebarChat, type SidebarItem } from "@/components/bui/SidebarNav";
import { ThemeToggle } from "@/components/bui/ThemeToggle";
import { ConfirmDialog, RenameDialog } from "@/components/chat/dialog";
import { ErrorNote } from "@/components/pikit/error-note";
import { TabBar } from "@/components/pikit/tab-bar";
import { type ChatConversation, TITLE_MAX } from "@/lib/chat-api";
import { useConversations } from "@/lib/conversations";
import { asError } from "@/lib/errors";
import { chatIdOf, chatPath, go } from "@/lib/location";
import { type Route, settingsSectionOf } from "@/lib/routes";
import { useSession } from "@/lib/session";
import { AssistantBadge } from "./auth-card";
import { SettingsModal } from "./settings";

/** A conversation's menu, the same everywhere: its items for `conversation`; `changed` hears it was renamed, archived, restored or deleted. */
export type ConversationMenu = (conversation: ChatConversation, changed?: () => void) => ActionsMenuItem[];

interface Shell {
  menu: ConversationMenu;
  /** A fresh New chat (its draft empty), with `agent` chosen when given. */
  newChat(agent?: string): void;
  /** Where a page's actions go (the tab bar's end), and its side panel (beside the window). */
  slots: { actions: HTMLDivElement | null; side: HTMLDivElement | null };
}

const ShellContext = createContext<Shell | undefined>(undefined);

function useShell(): Shell {
  const value = useContext(ShellContext);
  if (value === undefined) throw new Error("used outside the layout");
  return value;
}

export const useConversationMenu = (): ConversationMenu => useShell().menu;
export const useNewChat = (): Shell["newChat"] => useShell().newChat;

/** A page's actions, at the tab bar's right end. */
export function TabActions({ children }: { children: ReactNode }) {
  const target = useShell().slots.actions;
  return target === null ? null : createPortal(children, target);
}

/** A panel of a page's own beside the window (wide screens): the Context. */
export function SidePanel({ children }: { children: ReactNode }) {
  const target = useShell().slots.side;
  return target === null ? null : createPortal(children, target);
}

/** The tabs over `useConversations`: the conversations opened, then New chat's while it shows. */
function ChatTabs({ route, onActions, onNewChat }: { route: Route; onActions: (element: HTMLDivElement | null) => void; onNewChat: () => void }) {
  const conversations = useConversations();
  const busy = new Map([...(conversations.archived ?? []), ...(conversations.items ?? [])].map((each) => [each.id, each.busy]));
  const shown = chatIdOf(route.path);
  const active = conversations.tabs.some((tab) => tab.id === shown) ? shown : undefined;

  const close = (id: string, wasShown: boolean) => {
    const next = conversations.closeTab(id);
    if (!wasShown) return;
    if (next === undefined) onNewChat();
    else go(chatPath(next.id));
  };
  const closeNewChat = () => {
    const last = conversations.tabs.at(-1);
    if (last === undefined) onNewChat();
    else go(chatPath(last.id));
  };

  return (
    <TabBar
      tabs={conversations.tabs.map((tab) => ({ id: tab.id, title: conversations.tabTitle(tab), busy: busy.get(tab.id) === true }))}
      active={active}
      newChat={route.path === "/" ? { onClose: closeNewChat } : undefined}
      onSelect={(id) => go(chatPath(id))}
      onClose={close}
      onNewChat={onNewChat}
      actionsRef={onActions}
    />
  );
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
  const [renaming, setRenaming] = useState<{ conversation: ChatConversation; changed?: (() => void) | undefined }>();
  const [deleting, setDeleting] = useState<{ conversation: ChatConversation; changed?: (() => void) | undefined }>();
  const [problem, setProblem] = useState<Error>();
  const [settings, setSettings] = useState<string>();
  const [draft, setDraft] = useState(0);
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const [side, setSide] = useState<HTMLDivElement | null>(null);
  const openId = chatIdOf(route.path);
  const newChat = useCallback((agent?: string) => {
    setDraft((n) => n + 1);
    go(agent === undefined ? "/" : `/?agent=${encodeURIComponent(agent)}`);
  }, []);

  // `#/settings/<section>` opens Settings over a new chat.
  const asked = settingsSectionOf(route.path);
  useEffect(() => {
    if (asked === undefined) return;
    setSettings(asked);
    go("/", true);
  }, [asked]);

  const remove = ({ conversation, changed }: { conversation: ChatConversation; changed?: (() => void) | undefined }) => {
    setProblem(undefined);
    conversations.remove(conversation.id).then(
      () => (openId === conversation.id ? go("/", true) : changed?.()),
      (error: unknown) => setProblem(asError(error)),
    );
  };

  const { archive } = conversations;
  const menu: ConversationMenu = useCallback(
    (conversation, changed) => {
      const put = (archived: boolean) => {
        setProblem(undefined);
        archive(conversation.id, archived).then(
          () => changed?.(),
          (error: unknown) => setProblem(asError(error)),
        );
      };
      return [
        { key: "rename", label: "Rename", icon: <EditPencil />, onSelect: () => setRenaming({ conversation, changed }) },
        conversation.archived
          ? { key: "unarchive", label: "Restore", icon: <Undo />, onSelect: () => put(false) }
          : { key: "archive", label: "Archive", icon: <Archive />, onSelect: () => put(true) },
        { key: "delete", label: "Delete", icon: <Trash />, danger: true, onSelect: () => setDeleting({ conversation, changed }) },
      ];
    },
    [archive],
  );

  const items: SidebarItem[] = [
    { key: "new", label: "New chat", icon: <Plus />, active: route.path === "/", href: href("/"), onSelect: () => newChat() },
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
    <ShellContext.Provider value={{ menu, newChat, slots: { actions, side } }}>
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

        <div className="flex min-w-0 flex-1 gap-2.5">
          <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-window border border-line bg-page">
            {problem !== undefined && (
              <div className="border-b border-line px-3 py-2">
                <ErrorNote error={problem} title="The conversation could not be changed" />
              </div>
            )}
            <ChatTabs route={route} onActions={setActions} onNewChat={() => newChat()} />
            {/* New chat starts anew each time it is asked for ("+", another assistant picked) */}
            <div className="flex min-h-0 flex-1 flex-col">
              <Fragment key={route.path === "/" ? `new-${draft}-${route.query.get("agent") ?? ""}` : "page"}>{children}</Fragment>
            </div>
          </section>
          <div ref={setSide} className="contents" />
        </div>
      </main>

      <SettingsModal section={settings} onClose={() => setSettings(undefined)} />
      <RenameDialog
        open={renaming !== undefined}
        title={renaming === undefined ? "" : titleOf(renaming.conversation)}
        max={TITLE_MAX}
        onClose={() => setRenaming(undefined)}
        onRename={async (title) => {
          if (renaming === undefined) return;
          await conversations.rename(renaming.conversation.id, title);
          renaming.changed?.();
        }}
      />
      <ConfirmDialog
        open={deleting !== undefined}
        title="Delete this conversation?"
        description={<>“{deleting === undefined ? "" : titleOf(deleting.conversation)}” leaves your list for good.</>}
        action="Delete"
        onClose={() => setDeleting(undefined)}
        onConfirm={() => deleting !== undefined && remove(deleting)}
      />
    </ShellContext.Provider>
  );
}
