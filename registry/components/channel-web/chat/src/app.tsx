/**
 * The users' chat page (`/chat/`, channel-web, features/completed/channel-web.md section 5): reads what the App
 * offers (`GET /chat/api/config`) and who is signed in (`GET /chat/api/me`, a `401` when nobody is),
 * then shows the signed-out screens (sign in, make an account, forgot password, an invitation's or a
 * reset's landing, "confirm your email") or the signed-in page (a new chat, a conversation, the
 * conversations, the account). A session that ends meanwhile (a `401`) shows the sign-in again.
 * Each signed-out screen starts anew on another route (`screenKey`), and while nobody is signed in
 * the config is read again whenever the tab comes back (`onVisibleAgain`): a sign-up mode changed
 * meanwhile shows.
 *
 * The tab is titled with the assistant's name; the theme is the dashboard's, light or dark.
 */

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { LoaderGrid } from "@/components/bui/LoadingState";
import { ErrorNote } from "@/components/pikit/error-note";
import { setTarget } from "@/lib/activity";
import { signOut as endSession } from "@/lib/auth";
import type { ChatConfig, ChatMe } from "@/lib/chat-api";
import { get, onUnauthorized } from "@/lib/client";
import { ConversationsProvider } from "@/lib/conversations";
import { asError, ChatFailure, landingText } from "@/lib/errors";
import { chatIdOf, go, takeLandingError, useRoute } from "@/lib/location";
import { screenKey, setPasswordOf } from "@/lib/routes";
import { type ChatSession, SessionContext } from "@/lib/session";
import { onVisibleAgain } from "@/lib/visible";
import { AccountScreen } from "./screens/account";
import { ChatsScreen } from "./screens/chats";
import { ConversationScreen } from "./screens/conversation";
import { Layout } from "./screens/layout";
import { NewChatScreen } from "./screens/new-chat";
import { SetPasswordScreen, VerifyScreen } from "./screens/set-password";
import { ForgotScreen, SignInScreen, SignUpScreen } from "./screens/sign-in";

type State = { kind: "loading" } | { kind: "failed"; error: Error } | { kind: "ready"; config: ChatConfig; me: ChatMe | undefined };

/** The routes of the signed-out screens: signed in, they lead to a new chat (all but a link's landing). */
const SIGNED_OUT = new Set(["/sign-in", "/sign-up", "/forgot", "/verify"]);

/** `GET /chat/api/me`; `undefined` when nobody is signed in. */
const readMe = (): Promise<ChatMe | undefined> =>
  get<ChatMe>("/me").catch((error: unknown) => {
    if (error instanceof ChatFailure && error.status === 401) return undefined;
    throw error;
  });

function Centered({ children }: { children: ReactNode }) {
  return <main className="flex min-h-svh items-center justify-center gap-2.5 bg-canvas p-6 text-[13px] text-ink-3">{children}</main>;
}

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [landing, setLanding] = useState<string | undefined>(() => {
    const found = takeLandingError();
    return found === undefined ? undefined : landingText(found.code);
  });
  const route = useRoute();

  useEffect(() => {
    Promise.all([get<ChatConfig>("/config"), readMe()]).then(
      ([config, me]) => {
        setTarget(config.target);
        document.title = config.name;
        setState({ kind: "ready", config, me });
      },
      (error: unknown) => setState({ kind: "failed", error: asError(error) }),
    );
  }, []);

  const setMe = useCallback((me: ChatMe | undefined) => setState((current) => (current.kind === "ready" ? { ...current, me } : current)), []);
  const reloadMe = useCallback(async () => setMe(await readMe()), [setMe]);
  useEffect(() => onUnauthorized(() => setMe(undefined)), [setMe]);

  const signedIn = state.kind === "ready" && state.me !== undefined;
  const signedOut = state.kind === "ready" && state.me === undefined;
  // Signed out, what one may do here is read again when the tab comes back; a failed read keeps the last.
  useEffect(() => {
    if (!signedOut) return;
    return onVisibleAgain(document, () => {
      get<ChatConfig>("/config").then(
        (config) => setState((current) => (current.kind === "ready" ? { ...current, config } : current)),
        () => undefined,
      );
    });
  }, [signedOut]);
  // Signed in, the signed-out screens lead to a new chat.
  useEffect(() => {
    if (signedIn && SIGNED_OUT.has(route.path)) go("/", true);
  }, [signedIn, route.path]);

  if (state.kind === "loading") {
    return (
      <Centered>
        <LoaderGrid /> Loading
      </Centered>
    );
  }
  if (state.kind === "failed") {
    return (
      <Centered>
        <div className="w-full max-w-md">
          <ErrorNote error={state.error} title="The chat cannot be reached" />
        </div>
      </Centered>
    );
  }

  const { config, me } = state;
  const enter = () => {
    setLanding(undefined);
    reloadMe().catch((error: unknown) => setState({ kind: "failed", error: asError(error) }));
  };

  if (route.path === "/set-password") {
    return <SetPasswordScreen key={screenKey(route)} config={config} onSignedIn={enter} link={setPasswordOf(route.query)} />;
  }
  if (me === undefined) {
    const key = screenKey(route);
    const props = { config, onSignedIn: enter };
    if (route.path === "/sign-up") return <SignUpScreen key={key} {...props} />;
    if (route.path === "/forgot") return <ForgotScreen key={key} {...props} initialEmail={route.query.get("email") ?? undefined} />;
    if (route.path === "/verify") return <VerifyScreen key={key} {...props} email={route.query.get("email")} again={route.query.get("again") === "1"} />;
    return <SignInScreen key={key} {...props} {...(landing !== undefined && { landing })} />;
  }

  const session: ChatSession = {
    config,
    me,
    reloadMe,
    signOut: async () => {
      await endSession().catch(() => undefined);
      setMe(undefined);
      go("/sign-in", true);
    },
    signedOut: () => {
      setMe(undefined);
      go("/sign-in", true);
    },
  };
  const chatId = chatIdOf(route.path);
  const screen =
    chatId !== undefined ? (
      <ConversationScreen key={chatId} chatId={chatId} />
    ) : route.path === "/" || SIGNED_OUT.has(route.path) ? (
      <NewChatScreen />
    ) : route.path === "/chats" ? (
      <ChatsScreen />
    ) : route.path === "/account" ? (
      <AccountScreen />
    ) : (
      <div className="p-8 text-[13.5px] text-ink-3">
        No page here. <a href="#/" className="font-medium text-ink underline underline-offset-2">Start a new chat</a>
      </div>
    );

  return (
    <SessionContext.Provider value={session}>
      <ConversationsProvider>
        <Layout route={route}>
          {landing !== undefined && (
            <div className="flex items-start gap-2 border-b border-line px-3 py-2">
              <div className="min-w-0 flex-1">
                <ErrorNote error={{ message: landing }} title="That did not work" />
              </div>
              <button type="button" onClick={() => setLanding(undefined)} className="mt-1 rounded-[6px] px-2 py-1 text-[12.5px] font-medium text-ink-2 hover:bg-hover">
                Dismiss
              </button>
            </div>
          )}
          {screen}
        </Layout>
      </ConversationsProvider>
    </SessionContext.Provider>
  );
}
