/**
 * The dashboard's shell: the operator signs in with the token, then the sidebar lists the views the
 * App's composition allows (src/views/, `visibleViews`) and the page the path names is shown.
 */

import { LogOut } from "lucide-react";
import { useEffect, useState } from "react";
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
import { type ApiApp, onUnauthorized, token, useApi } from "@/lib/api";
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

function SignedIn({ onSignOut }: { onSignOut: () => void }) {
  const { data: app, error } = useApi<ApiApp>("/app");
  if (error !== undefined) return <div className="p-6"><ErrorNote error={error} title="The admin API cannot be read" /></div>;
  if (app === undefined) return <div className="p-6 text-muted-foreground">Loading…</div>;
  return <Shell app={app} onSignOut={onSignOut} />;
}

export function App() {
  const [signedIn, setSignedIn] = useState(token.get() !== null);
  const [refused, setRefused] = useState(false);

  useEffect(
    () =>
      onUnauthorized(() => {
        token.clear();
        setRefused(true);
        setSignedIn(false);
      }),
    [],
  );

  const signOut = () => {
    token.clear();
    setRefused(false);
    setSignedIn(false);
  };

  return (
    <TooltipProvider>
      {signedIn ? <SignedIn onSignOut={signOut} /> : <SignIn refused={refused} onSignedIn={() => (setRefused(false), setSignedIn(true))} />}
    </TooltipProvider>
  );
}
