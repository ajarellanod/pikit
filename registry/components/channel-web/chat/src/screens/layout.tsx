/**
 * The signed-in page, in the dashboard's harness: Beautiful UI's sidebar (the assistant's name; New
 * chat, Conversations, Projects; the user's latest conversations, each with its menu, and "View all" to
 * Conversations when there are more: the archived ones are there only; at its foot the user's name,
 * opening Settings, the theme and Sign out), and the screen in a window beside it. On a narrow screen
 * the sidebar starts folded to its icons, and Conversations lists them full width.
 *
 * Projects (`useProjects`, when the App has them: `ChatConfig.projects`) are listed on their own page
 * (`#/projects`, `screens/projects.tsx`), never in the sidebar; "New project" there asks a name and a
 * description (`useNewProject`) and opens it. A project's page (`#/projects/<id>`, `screens/project/`)
 * has its tabs; its menu (`useProjectMenu`) starts a new chat in it (`#/?project=<id>`), renames it,
 * and for its owner archives it (or puts it back) and removes it once it has no chats (the server
 * refuses before: its words are shown); a member leaves it. A chat's project is fixed when it is made.
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

import { Archive, ChatBubble, EditPencil, Folder, LogOut, Plus, Settings, Trash, Undo, User } from "iconoir-react";
import { createContext, Fragment, type ReactNode, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { ActionsMenuItem } from "@/components/bui/ActionsMenu";
import SidebarNav, { MenuRow, MenuSeparator, type SidebarChat, type SidebarItem } from "@/components/bui/SidebarNav";
import { ThemeToggle } from "@/components/bui/ThemeToggle";
import { Button } from "@/components/bui/Button";
import { ConfirmDialog, Dialog, RenameDialog } from "@/components/chat/dialog";
import { FormNote, TextField } from "@/components/chat/field";
import { ErrorNote } from "@/components/pikit/error-note";
import { TabBar } from "@/components/pikit/tab-bar";
import { type ChatConversation, type ChatProject, memberKey, PROJECT_DESCRIPTION_MAX, PROJECT_NAME_MAX, TITLE_MAX } from "@/lib/chat-api";
import { request } from "@/lib/client";
import { projectApi } from "@/lib/project";
import { useConversations } from "@/lib/conversations";
import { asError } from "@/lib/errors";
import { chatIdOf, chatPath, go } from "@/lib/location";
import { useProjects } from "@/lib/projects";
import { newChatPath, PROJECTS_PATH, projectIdOf, projectPath, type Route, settingsSectionOf } from "@/lib/routes";
import { useSession } from "@/lib/session";
import { AssistantBadge } from "./auth-card";
import { TextArea } from "./project/parts";
import { SettingsModal } from "./settings";

/** A conversation's menu, the same everywhere: its items for `conversation`; `changed` hears it was renamed, archived, restored or deleted. */
export type ConversationMenu = (conversation: ChatConversation, changed?: () => void) => ActionsMenuItem[];
/** A project's menu, the same everywhere: a new chat in it, Rename; the owner's Archive and Delete; a member's Leave. */
export type ProjectMenu = (project: ChatProject) => ActionsMenuItem[];

/** What a new chat starts with: an assistant chosen, a project it is made in. */
export type NewChatOptions = { agent?: string | undefined; project?: string | undefined };

interface Shell {
  menu: ConversationMenu;
  projectMenu: ProjectMenu;
  /** A fresh New chat (its draft empty), with `agent` chosen and in `project` when given. */
  newChat(options?: NewChatOptions): void;
  /** Asks a new project's name, makes it and opens it. */
  newProject(): void;
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
export const useNewProject = (): Shell["newProject"] => useShell().newProject;

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

/** Where the page is about a project now: its page, or New chat in it (`?project=`). */
const routeProject = (route: Route): string | undefined => projectIdOf(route.path) ?? (route.path === "/" ? (route.query.get("project") ?? undefined) : undefined);

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
  const [leavingProject, setLeavingProject] = useState<ChatProject>();
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
      () => shownProject === project.id && go(route.path === "/" ? "/" : PROJECTS_PATH, true),
      (error: unknown) => setProblem({ error: asError(error), title: `“${project.name}” could not be deleted` }),
    );
  };

  const { update } = projects;
  const projectMenu: ProjectMenu = useCallback(
    (project) => {
      const archive = (archived: boolean) => {
        setProblem(undefined);
        update(project.id, { archived }).then(
          () => undefined,
          (error: unknown) => setProblem({ error: asError(error), title: `“${project.name}” could not be changed` }),
        );
      };
      return [
        ...(project.archived ? [] : [{ key: "new", label: "New chat here", icon: <Plus />, onSelect: () => newChat({ project: project.id }) }]),
        { key: "rename", label: "Rename", icon: <EditPencil />, onSelect: () => setRenamingProject(project) },
        ...(project.role === "owner"
          ? [
              project.archived
                ? { key: "unarchive", label: "Put back from the archive", icon: <Undo />, onSelect: () => archive(false) }
                : { key: "archive", label: "Archive (read only)", icon: <Archive />, onSelect: () => archive(true) },
              { key: "delete", label: "Delete", icon: <Trash />, danger: true, onSelect: () => setDeletingProject(project) },
            ]
          : [{ key: "leave", label: "Leave", icon: <LogOut />, danger: true, onSelect: () => setLeavingProject(project) }]),
      ];
    },
    [newChat, update],
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
    { key: "chats", label: "Conversations", icon: <ChatBubble />, active: route.path === "/chats", href: href("/chats"), onSelect: () => go("/chats") },
    ...(projects.enabled
      ? [
          {
            key: "projects",
            label: "Projects",
            icon: <Folder />,
            active: route.path === PROJECTS_PATH || projectIdOf(route.path) !== undefined,
            href: href(PROJECTS_PATH),
            onSelect: () => go(PROJECTS_PATH),
          },
        ]
      : []),
  ];
  const pick = (id: string) => go(chatPath(id));
  const newProject = useCallback(() => setMaking(true), []);
  const rowOf = (conversation: ChatConversation): SidebarChat => ({
    id: conversation.id,
    label: titleOf(conversation),
    busy: conversation.busy,
    active: conversation.id === openId,
    href: href(chatPath(conversation.id)),
    actions: menu(conversation),
  });

  return (
    <ShellContext.Provider value={{ menu, projectMenu, newChat, newProject, slots: { actions, side } }}>
      <main className="flex h-[100dvh] bg-canvas p-1.5 pl-0 text-ink sm:p-2.5 sm:pl-0">
        <SidebarNav
          key={narrow ? "narrow" : "wide"}
          defaultCollapsed={narrow}
          workspace={{ name: config.name, logo: <AssistantBadge name={config.name} size={20} /> }}
          items={items}
          chats={(conversations.items ?? []).map(rowOf)}
          chatsEmpty={conversations.error !== undefined ? "The conversations cannot be read" : conversations.items === undefined ? "Loading" : "No conversations yet"}
          onPickChat={pick}
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
      <NewProjectDialog
        open={making}
        onClose={() => setMaking(false)}
        onMake={async (name, description) => {
          const made = await projects.create(name, description);
          go(projectPath(made.id));
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
            <>“{deletingProject.name}” has no chats: it goes, with its context, files and memory, for every member.</>
          ) : (
            <>
              “{deletingProject.name}” has {deletingProject.chats === 1 ? "a chat" : `${deletingProject.chats} chats`}, which its members still read: archive it instead, and it stays, read only.
            </>
          )
        }
        action="Delete"
        onClose={() => setDeletingProject(undefined)}
        onConfirm={() => deletingProject !== undefined && removeProject(deletingProject)}
      />
      <ConfirmDialog
        open={leavingProject !== undefined}
        title="Leave this project?"
        description={<>You no longer see “{leavingProject?.name ?? ""}”, its chats or its files. A member can add you again.</>}
        action="Leave"
        onClose={() => setLeavingProject(undefined)}
        onConfirm={() => {
          const project = leavingProject;
          if (project === undefined) return;
          setProblem(undefined);
          request<void>("DELETE", projectApi(project.id, `/members/${encodeURIComponent(memberKey({ channel: "web", id: me.user.id }))}`)).then(
            () => {
              projects.reload();
              if (shownProject === project.id) go(PROJECTS_PATH, true);
            },
            (error: unknown) => setProblem({ error: asError(error), title: `You could not leave “${project.name}”` }),
          );
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

/** "New project": its name and what it is for; made, its owner the user. */
function NewProjectDialog({ open, onClose, onMake }: { open: boolean; onClose: () => void; onMake: (name: string, description: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setProblem(undefined);
  }, [open]);
  const make = async () => {
    if (name.trim() === "" || saving) return;
    setSaving(true);
    try {
      await onMake(name.trim(), description.trim());
      onClose();
    } catch (error) {
      setProblem(asError(error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} title="New project" description="A place its members share: its chats, instructions, documents, files and what its assistants remember. You add the people after." onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void make();
        }}
      >
        <TextField label="Name" value={name} onChange={setName} maxLength={PROJECT_NAME_MAX} placeholder="AECC 2027" required autoFocus />
        <TextArea label="What it is for" value={description} onChange={setDescription} rows={3} maxLength={PROJECT_DESCRIPTION_MAX} placeholder="The client's 2027 campaign: media plan, budget and reports" required={false} />
        {problem !== undefined && <FormNote>{problem}</FormNote>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={name.trim() === "" || saving} aria-busy={saving}>
            Make it
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
