/**
 * The dashboard's shell: the operator signs in with the token once (a session cookie, `lib/api.ts`),
 * then the sidebar lists the views the App's composition allows (src/views/, `visibleViews`) and the
 * page the path names is shown. A page that loads with a session still open goes straight in.
 */

import { LogOut } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorNote } from "@/components/pikit/error-note";
import { SignIn } from "@/components/pikit/sign-in";
import { setTarget } from "@/lib/activity";
import { api, type ApiApp, ApiFailure, onUnauthorized, signOut } from "@/lib/api";
import { Link, match, navigate, usePath } from "@/lib/router";
import { type View, visibleViews } from "@/lib/views";

function Shell({ app, onSignOut }: { app: ApiApp; onSignOut: () => void }) {
  const path = usePath();
  const views = visibleViews(app);
  const found = views.flatMap((view) => view.pages.map((page) => ({ view, page, params: match(page.path, path) }))).find((each) => each.params !== undefined);
  const home = views[0]?.pages[0]?.path;

  useEffect(() => {
    if (found === undefined && home !== undefined && (path === "/" || path === "")) navigate(home, { replace: true });
  }, [found, home, path]);

  const active = (view: View) => found?.view.id === view.id;
  const Page = found?.page.component;

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="px-2 py-1.5 text-lg font-semibold tracking-tight">pikit</div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {views.map((view) => {
                  const Icon = view.icon;
                  return (
                    <SidebarMenuItem key={view.id}>
                      <SidebarMenuButton asChild isActive={active(view)}>
                        <Link to={view.pages[0]?.path ?? `/${view.id}`}>
                          {Icon !== undefined && <Icon />}
                          <span>{view.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={onSignOut}>
                <LogOut />
                <span>Sign out</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <span className="text-sm font-medium">{found?.view.title ?? "Not found"}</span>
        </header>
        <main className="flex-1 p-4 md:p-6">
          {Page !== undefined ? <Page params={found?.params ?? {}} /> : <p className="text-muted-foreground">No page here.</p>}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

type State = { kind: "checking" } | { kind: "signed-out"; refused: boolean } | { kind: "signed-in"; app: ApiApp } | { kind: "failed"; error: Error };

export function App() {
  const [state, setState] = useState<State>({ kind: "checking" });

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
  useEffect(() => onUnauthorized(() => setState({ kind: "signed-out", refused: true })), []);

  const leave = () => void signOut().then(() => setState({ kind: "signed-out", refused: false }));

  return (
    <TooltipProvider>
      {state.kind === "checking" && <div className="p-6 text-muted-foreground">Loading…</div>}
      {state.kind === "failed" && (
        <div className="p-6">
          <ErrorNote error={state.error} title="The admin API cannot be read" />
        </div>
      )}
      {state.kind === "signed-out" && <SignIn refused={state.refused} onSignedIn={() => enter(false)} />}
      {state.kind === "signed-in" && <Shell app={state.app} onSignOut={leave} />}
    </TooltipProvider>
  );
}
