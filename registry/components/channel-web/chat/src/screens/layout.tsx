/**
 * The signed-in page, in the dashboard's harness: Beautiful UI's sidebar (the assistant's name; New
 * chat, Conversations; the user's latest conversations, each with its menu, and "View all" to
 * Conversations when there are more: the archived ones are there only; under them the user's projects
 * and "New project"; at its foot the user's name, opening Settings, the theme and Sign out), and the screen in a window
 * beside it. On a narrow screen the sidebar starts folded to its icons, and Conversations lists them
 * full width.
 *
 * A project (`useProjects`) opens Conversations showing only its chats (`#/chats?project=<id>`); its
 * menu (`useProjectMenu`, the sidebar row's and that page's) starts a new chat in it
 * (`#/?project=<id>`), renames it, or deletes it once it has no chats (the server refuses before:
 * its words are shown). A chat's project is fixed when it is made.
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

import { Archive, ChatBubble, EditPencil, Folder, FolderPlus, LogOut, Plus, Settings, Trash, Undo, User } from "iconoir-react";
import { createContext, Fragment, type ReactNode, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { ActionsMenuItem } from "@/components/bui/ActionsMenu";
import SidebarNav, { MenuRow, MenuSeparator, type SidebarChat, type SidebarItem } from "@/components/bui/SidebarNav";
import { ThemeToggle } from "@/components/bui/ThemeToggle";
import { ConfirmDialog, RenameDialog } from "@/components/chat/dialog";
import { ErrorNote } from "@/components/pikit/error-note";
import { TabBar } from "@/components/pikit/tab-bar";
import { type ChatConversation, type ChatProject, PROJECT_NAME_MAX, TITLE_MAX } from "@/lib/chat-api";
import { useConversations } from "@/lib/conversations";
import { asError } from "@/lib/errors";
import { chatIdOf, chatPath, go } from "@/lib/location";
import { useProjects } from "@/lib/projects";
import { newChatPath, projectPath, type Route, settingsSectionOf } from "@/lib/routes";
import { useSession } from "@/lib/session";
import { AssistantBadge } from "./auth-card";
import { SettingsModal } from "./settings";

/** A conversation's menu, the same everywhere: its items for `conversation`; `changed` hears it was renamed, archived, restored or deleted. */
export type ConversationMenu = (conversation: ChatConversation, changed?: () => void) => ActionsMenuItem[];
/** A project's menu, the same everywhere: a new chat in it, Rename, Delete. */
export type ProjectMenu = (project: ChatProject) => ActionsMenuItem[];

/** What a new chat starts with: an assistant chosen, a project it is made in. */
export type NewChatOptions = { agent?: string | undefined; project?: string | undefined };

interface Shell {
  menu: ConversationMenu;
  projectMenu: ProjectMenu;
  /** A fresh New chat (its draft empty), with `agent` chosen and in `project` when given. */
  newChat(options?: NewChatOptions): void;
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
export const useProjectMenu = (): ProjectMenu => useShell().projectMenu;
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
  const busy = new Map((conversations.items ?? []).map((each) => [each.id, each.busy]));
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

/** The sidebar's row that makes a project (in the projects' section, which never has a project of that id). */
const NEW_PROJECT = "new-project";
const PROJECT_ROW = "project:";

/** Where the page is about a project now: Conversations or New chat in it (`?project=`). */
const routeProject = (route: Route): string | undefined => (route.path === "/" || route.path === "/chats" ? (route.query.get("project") ?? undefined) : undefined);

export function Layout({ route, children }: { route: Route; children: ReactNode }) {
  const { config, me, signOut } = useSession();
  const conversations = useConversations();
  const projects = useProjects();
  const narrow = useNarrow();
  const [renaming, setRenaming] = useState<{ conversation: ChatConversation; changed?: (() => void) | undefined }>();
  const [deleting, setDeleting] = useState<{ conversation: ChatConversation; changed?: (() => void) | undefined }>();
  const [making, setMaking] = useState(false);
  const [renamingProject, setRenamingProject] = useState<ChatProject>();
  const [deletingProject, setDeletingProject] = useState<ChatProject>();
  const [problem, setProblem] = useState<{ error: Error; title: string }>();
  const [settings, setSettings] = useState<string>();
  const [draft, setDraft] = useState(0);
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const [side, setSide] = useState<HTMLDivElement | null>(null);
  const openId = chatIdOf(route.path);
  const newChat = useCallback((options: NewChatOptions = {}) => {
    setDraft((n) => n + 1);
    go(newChatPath(options));
  }, []);
  const shownProject = routeProject(route);

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
      () => {
        projects.reload();
        if (openId === conversation.id) go("/", true);
        else changed?.();
      },
      (error: unknown) => setProblem({ error: asError(error), title: "The conversation could not be changed" }),
    );
  };

  const removeProject = (project: ChatProject) => {
    setProblem(undefined);
    projects.remove(project.id).then(
      () => shownProject === project.id && go(route.path === "/chats" ? "/chats" : "/", true),
      (error: unknown) => setProblem({ error: asError(error), title: `“${project.name}” could not be deleted` }),
    );
  };

  const projectMenu: ProjectMenu = useCallback(
    (project) => [
      { key: "new", label: "New chat here", icon: <Plus />, onSelect: () => newChat({ project: project.id }) },
      { key: "rename", label: "Rename", icon: <EditPencil />, onSelect: () => setRenamingProject(project) },
      { key: "delete", label: "Delete", icon: <Trash />, danger: true, onSelect: () => setDeletingProject(project) },
    ],
    [newChat],
  );

  const { archive } = conversations;
  const menu: ConversationMenu = useCallback(
    (conversation, changed) => {
      const put = (archived: boolean) => {
        setProblem(undefined);
        archive(conversation.id, archived).then(
          () => changed?.(),
          (error: unknown) => setProblem({ error: asError(error), title: "The conversation could not be changed" }),
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
    { key: "new", label: "New chat", icon: <Plus />, active: route.path === "/" && shownProject === undefined, href: href("/"), onSelect: () => newChat() },
    { key: "chats", label: "Conversations", icon: <ChatBubble />, active: route.path === "/chats" && shownProject === undefined, href: href("/chats"), onSelect: () => go("/chats") },
  ];
  // The projects, under the chats: each opens its chats; the last row makes one.
  const projectRows: SidebarChat[] = [
    ...(projects.items ?? []).map((project) => ({
      id: `${PROJECT_ROW}${project.id}`,
      label: project.name,
      icon: <Folder />,
      active: shownProject === project.id,
      href: href(projectPath(project.id)),
      actions: projectMenu(project),
    })),
    { id: NEW_PROJECT, label: "New project", icon: <FolderPlus /> },
  ];
  const pick = (id: string) => {
    if (id === NEW_PROJECT) setMaking(true);
    else if (id.startsWith(PROJECT_ROW)) go(projectPath(id.slice(PROJECT_ROW.length)));
    else go(chatPath(id));
  };
  const rowOf = (conversation: ChatConversation): SidebarChat => ({
    id: conversation.id,
    label: titleOf(conversation),
    busy: conversation.busy,
    active: conversation.id === openId,
    href: href(chatPath(conversation.id)),
    actions: menu(conversation),
  });

  return (
    <ShellContext.Provider value={{ menu, projectMenu, newChat, slots: { actions, side } }}>
      <main className="flex h-[100dvh] bg-canvas p-1.5 pl-0 text-ink sm:p-2.5 sm:pl-0">
        <SidebarNav
          key={narrow ? "narrow" : "wide"}
          defaultCollapsed={narrow}
          workspace={{ name: config.name, logo: <AssistantBadge name={config.name} size={20} /> }}
          items={items}
          chats={(conversations.items ?? []).map(rowOf)}
          chatsEmpty={conversations.error !== undefined ? "The conversations cannot be read" : conversations.items === undefined ? "Loading" : "No conversations yet"}
          onPickChat={pick}
          moreChats={{ label: "Projects", chats: projectRows }}
          {...(conversations.hasMore && { viewAll: { href: href("/chats"), onSelect: () => go("/chats") } })}
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
                <ErrorNote error={problem.error} title={problem.title} />
              </div>
            )}
            <ChatTabs route={route} onActions={setActions} onNewChat={() => newChat()} />
            {/* New chat starts anew each time it is asked for ("+", another assistant picked) */}
            <div className="flex min-h-0 flex-1 flex-col">
              <Fragment key={route.path === "/" ? `new-${draft}-${route.query.get("agent") ?? ""}-${shownProject ?? ""}` : "page"}>{children}</Fragment>
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
      <RenameDialog
        open={making}
        title=""
        max={PROJECT_NAME_MAX}
        heading="New project"
        label="Name"
        placeholder="Work"
        action="Make it"
        onClose={() => setMaking(false)}
        onRename={async (name) => {
          const made = await projects.create(name);
          newChat({ project: made.id });
        }}
      />
      <RenameDialog
        open={renamingProject !== undefined}
        title={renamingProject?.name ?? ""}
        max={PROJECT_NAME_MAX}
        heading="Rename the project"
        label="Name"
        placeholder="Work"
        onClose={() => setRenamingProject(undefined)}
        onRename={async (name) => {
          if (renamingProject !== undefined) await projects.rename(renamingProject.id, name);
        }}
      />
      <ConfirmDialog
        open={deletingProject !== undefined}
        title="Delete this project?"
        description={
          deletingProject === undefined ? "" : deletingProject.chats === 0 ? (
            <>“{deletingProject.name}” has no chats: it goes for good.</>
          ) : (
            <>
              “{deletingProject.name}” still has {deletingProject.chats === 1 ? "a chat" : `${deletingProject.chats} chats`}: only a project with none is deleted. Delete them first.
            </>
          )
        }
        action="Delete"
        onClose={() => setDeletingProject(undefined)}
        onConfirm={() => deletingProject !== undefined && removeProject(deletingProject)}
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
