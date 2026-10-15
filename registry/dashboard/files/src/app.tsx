/**
 * The dashboard's shell, in Beautiful UI's harness layout: the operator signs in with the token once
 * (a session cookie, `lib/api.ts`), then a sidebar (the App's menu, New chat, Conversations, the views
 * the App's composition allows, Home first, the latest conversations and "View all" when there are
 * more), a main pane with the conversations opened as
 * tabs (and New chat's while it shows; each one closes), and a side panel a page may fill (a
 * conversation's Context). A page that loads with a session still open goes straight in, and `/` opens
 * New chat.
 */

import { ChatLines, EditPencil, LogOut, Settings, SoundHigh, SoundOff } from "iconoir-react";
import { useCallback, useEffect, useState } from "react";
import { LoaderGrid } from "@/components/bui/LoadingState";
import SidebarNav, { MenuRow, MenuSeparator, type SidebarChat, type SidebarItem } from "@/components/bui/SidebarNav";
import { Switch } from "@/components/bui/Switch";
import { ThemeToggle } from "@/components/bui/ThemeToggle";
import { useChatActions } from "@/components/pikit/chat-actions";
import { ErrorNote } from "@/components/pikit/error-note";
import { Mark } from "@/components/pikit/mark";
import { SettingsDialog } from "@/components/pikit/settings-dialog";
import { SignIn } from "@/components/pikit/sign-in";
import { TabBar } from "@/components/pikit/tab-bar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setTarget } from "@/lib/activity";
import { api, type ApiAgents, type ApiApp, type ApiCommands, ApiFailure, onUnauthorized, signOut, useApi } from "@/lib/api";
import { ChatsProvider, useChats } from "@/lib/chats";
import { BASE, match, navigate, pagePath, usePath } from "@/lib/router";
import { appName, ShellContext, usePageTitle } from "@/lib/shell";
import { setSounds, useSounds } from "@/lib/sounds";
import { visibleViews } from "@/lib/views";
import { CONVERSATIONS_PATH } from "@/views/conversations/list";

const OPERATOR = "pikit-operator";
const CHAT = "/conversations";

/**
 * The tabs (the shared `TabBar`) over `useChats`: the conversations opened, then New chat while it
 * shows. Each one closes: the active one gives way to its neighbour, and closing the last one leaves a
 * fresh New chat (`onNewChat`).
 */
function ChatTabs({ path, newChatPath, onActions, onNewChat }: { path: string; newChatPath: string; onActions: (element: HTMLDivElement | null) => void; onNewChat: () => void }) {
  const chats = useChats();
  const busy = new Map((chats.items ?? []).map((conversation) => [conversation.conversationId, conversation.busy]));
  const active = chats.tabs.find((tab) => path === pagePath(CHAT, tab.id))?.id;

  const close = (id: string, shown: boolean) => {
    const next = chats.closeTab(id);
    if (!shown) return;
    if (next === undefined) onNewChat();
    else navigate(pagePath(CHAT, next.id));
  };
  const closeNewChat = () => {
    const last = chats.tabs.at(-1);
    if (last === undefined) onNewChat();
    else navigate(pagePath(CHAT, last.id));
  };

  return (
    <TabBar
      tabs={chats.tabs.map((tab) => ({ id: tab.id, title: chats.tabTitle(tab), busy: busy.get(tab.id) === true }))}
      active={active}
      newChat={path === newChatPath ? { onClose: closeNewChat } : undefined}
      onSelect={(id) => navigate(pagePath(CHAT, id))}
      onClose={close}
      onNewChat={onNewChat}
      actionsRef={onActions}
    />
  );
}

function Shell({ app, operator, onSignOut }: { app: ApiApp; operator: string | undefined; onSignOut: () => void }) {
  const path = usePath();
  const chats = useChats();
  const sounds = useSounds();
  const views = visibleViews(app);
  const found = views.flatMap((view) => view.pages.map((page) => ({ view, page, params: match(page.path, path) }))).find((each) => each.params !== undefined);
  const chatView = views.find((view) => view.id === "conversations");
  const newChatPath = chatView?.pages[0]?.path ?? views[0]?.pages[0]?.path ?? "/";
  const agents = useApi<ApiAgents>("/agents");
  const commands = useApi<ApiCommands>("/commands");
  const [draft, setDraft] = useState(0);
  /** A fresh New chat (its draft empty), with `agent` chosen when given. */
  const newChat = useCallback(
    (agent?: string) => {
      setDraft((n) => n + 1);
      navigate(agent === undefined ? newChatPath : `${newChatPath}?agent=${encodeURIComponent(agent)}`);
    },
    [newChatPath],
  );
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The Settings section to open at: `?settings=<id>` in the page's URL (repo-github-app's setup comes back to `/admin/?settings=repo-github-app`). */
  const [settingsSection, setSettingsSection] = useState<string>();
  const [side, setSide] = useState<HTMLDivElement | null>(null);
  const [narrow] = useState(() => !window.matchMedia("(min-width: 1024px)").matches);
  const name = appName(app);

  // Before the redirect to New chat below, which drops the query.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("settings");
    if (id === null) return;
    params.delete("settings");
    const rest = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest === "" ? "" : `?${rest}`}`);
    setSettingsSection(id);
    setSettingsOpen(true);
  }, []);

  useEffect(() => {
    if (found === undefined && (path === "/" || path === "")) navigate(newChatPath, { replace: true });
  }, [found, newChatPath, path]);

  // The tab's title: the conversation's (its AI title, as the sidebar names it), the view's, or New chat.
  const openId = found?.page.path === `${CHAT}/:id` ? found.params?.id : undefined;
  const openTab = openId === undefined ? undefined : chats.tabs.find((tab) => tab.id === openId);
  const openChat = openId === undefined ? undefined : (chats.items ?? []).find((conversation) => conversation.conversationId === openId);
  const listing = found?.page.path === CONVERSATIONS_PATH;
  const pageTitle =
    listing
      ? "Conversations"
      : openId !== undefined
      ? openTab !== undefined
        ? chats.tabTitle(openTab)
        : openChat !== undefined
          ? chats.titleOf(openChat)
          : "Chat"
      : found?.view.id === "conversations"
        ? "New chat"
        : found?.view.title;
  usePageTitle(pageTitle, name);

  const items: SidebarItem[] = [
    {
      key: "new",
      label: "New chat",
      icon: <EditPencil />,
      href: `${BASE}${newChatPath}`,
      onSelect: () => newChat(),
    },
    ...(chatView === undefined
      ? []
      : [{ key: "conversations", label: "Conversations", icon: <ChatLines />, active: listing, href: `${BASE}${CONVERSATIONS_PATH}`, onSelect: () => navigate(CONVERSATIONS_PATH) } satisfies SidebarItem]),
    ...views
      .filter((view) => view.id !== "conversations")
      .map((view): SidebarItem => {
        const Icon = view.icon;
        const to = view.pages[0]?.path ?? `/${view.id}`;
        return { key: view.id, label: view.title, icon: Icon === undefined ? null : <Icon />, active: found?.view.id === view.id, href: `${BASE}${to}`, onSelect: () => navigate(to) };
      }),
  ];

  const chatActions = useChatActions({ shown: openId, onLeft: () => newChat() });
  const sidebarChats: SidebarChat[] = (chats.items ?? []).map((conversation): SidebarChat => {
    const id = conversation.conversationId;
    return {
      id,
      label: chats.titleOf(conversation),
      busy: conversation.busy,
      active: path === pagePath(CHAT, id),
      href: `${BASE}${pagePath(CHAT, id)}`,
      actions: chatActions.actionsOf(conversation, false),
    };
  });

  const Page = found?.page.component;
  const page =
    Page === undefined ? (
      <div className="p-8 text-[13.5px] text-ink-3">No page here.</div>
    ) : found?.page.fill === true ? (
      // One instance per conversation: nothing of one shows in another.
      <Page key={found.page.path === newChatPath ? `new-chat-${draft}` : path} params={found.params ?? {}} />
    ) : (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-8">
          <Page params={found?.params ?? {}} />
        </div>
      </div>
    );

  return (
    <ShellContext.Provider
      value={{ app, ...(agents.data !== undefined && { agents: agents.data.items }), reloadAgents: agents.reload, ...(commands.data !== undefined && { commands: commands.data.items }), newChat, conversationActions: chatActions.actionsOf, views, operator, slots: { actions, side } }}
    >
      <main className="flex h-[100dvh] gap-0 bg-canvas p-2.5 pl-0 text-ink">
        <SidebarNav
          defaultCollapsed={narrow}
          workspace={{ name, logo: <Mark size={20} /> }}
          items={items}
          chats={sidebarChats}
          chatsEmpty={chats.error !== undefined ? "The chats cannot be read" : chats.items === undefined ? "Loading" : "No chats yet"}
          onPickChat={(id) => navigate(pagePath(CHAT, id))}
          {...(chats.hasMore && chatView !== undefined && { viewAll: { href: `${BASE}${CONVERSATIONS_PATH}`, onSelect: () => navigate(CONVERSATIONS_PATH) } })}
          menu={(close) => (
            <>
              <MenuRow
                icon={<Settings />}
                onClick={() => {
                  close();
                  setSettingsOpen(true);
                }}
              >
                Settings
              </MenuRow>
              <MenuSeparator />
              <div className="flex h-10 items-center gap-1.5 px-2">
                <span className="min-w-0 flex-1 text-[13.5px] text-ink">Theme</span>
                <ThemeToggle />
              </div>
              <MenuRow
                icon={sounds ? <SoundHigh /> : <SoundOff />}
                onClick={() => setSounds(!sounds)}
                trailing={
                  <span aria-hidden>
                    <Switch checked={sounds} size="sm" />
                  </span>
                }
              >
                Interaction sounds
              </MenuRow>
              <MenuSeparator />
              <MenuRow
                icon={<LogOut />}
                onClick={() => {
                  close();
                  onSignOut();
                }}
              >
                Sign out
              </MenuRow>
            </>
          )}
        />

        <SettingsDialog app={app} open={settingsOpen} onOpenChange={(open) => (setSettingsOpen(open), !open && setSettingsSection(undefined))} section={settingsSection} />

        {chatActions.dialogs}

        <div className="flex min-w-0 flex-1 gap-2.5">
          <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-window border border-line bg-page">
            {chatActions.error !== undefined && (
              <div className="border-b border-line px-3 py-2">
                <ErrorNote error={chatActions.error} title="The chat could not be changed" />
              </div>
            )}
            <ChatTabs path={path} newChatPath={newChatPath} onActions={setActions} onNewChat={() => newChat()} />
            <div className="flex min-h-0 flex-1 flex-col">{page}</div>
          </section>
          <div ref={setSide} className="contents" />
        </div>
      </main>
    </ShellContext.Provider>
  );
}

type State = { kind: "checking" } | { kind: "signed-out"; refused: boolean } | { kind: "signed-in"; app: ApiApp } | { kind: "failed"; error: Error };

function storedOperator(): string | undefined {
  try {
    return localStorage.getItem(OPERATOR) ?? undefined;
  } catch {
    return undefined;
  }
}

export function App() {
  const [state, setState] = useState<State>({ kind: "checking" });
  const [operator, setOperator] = useState(storedOperator);

  // The composition: with a session still open the page goes straight in; a `401` asks for the token.
  const enter = useCallback((refused: boolean) => {
    api<ApiApp>("/app")
      .then((app) => {
        setTarget(app.target);
        setState({ kind: "signed-in", app });
      })
      .catch((error: unknown) =>
        setState(error instanceof ApiFailure && error.status === 401 ? { kind: "signed-out", refused } : { kind: "failed", error: error instanceof Error ? error : new Error(String(error)) }),
      );
  }, []);

  useEffect(() => enter(false), [enter]);
  // A session that ends while in (it expired, or the token changed) asks again, saying so.
  useEffect(() => onUnauthorized(() => setState((current) => (current.kind === "signed-in" ? { kind: "signed-out", refused: true } : current))), []);

  const signedIn = (who: string | undefined) => {
    setOperator(who);
    try {
      if (who === undefined) localStorage.removeItem(OPERATOR);
      else localStorage.setItem(OPERATOR, who);
    } catch {
      // Not remembered: greeted without a name after a reload.
    }
    enter(false);
  };
  const leave = () => void signOut().then(() => setState({ kind: "signed-out", refused: false }));

  return (
    <TooltipProvider>
      {state.kind === "checking" && (
        <main className="flex min-h-svh items-center justify-center gap-2.5 bg-canvas text-[13px] text-ink-3">
          <LoaderGrid /> Loading
        </main>
      )}
      {state.kind === "failed" && (
        <main className="flex min-h-svh items-center justify-center bg-canvas p-6">
          <div className="w-full max-w-md">
            <ErrorNote error={state.error} title="The admin API cannot be read" />
          </div>
        </main>
      )}
      {state.kind === "signed-out" && <SignIn refused={state.refused} onSignedIn={signedIn} />}
      {state.kind === "signed-in" && (
        <ChatsProvider>
          <Shell app={state.app} operator={operator} onSignOut={leave} />
        </ChatsProvider>
      )}
    </TooltipProvider>
  );
}
