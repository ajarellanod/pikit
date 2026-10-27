/**
 * The user's projects (`GET /chat/api/projects`): places several of their conversations share (what the
 * assistant keeps for a project: memory, instructions, files). A conversation is made in one or in
 * none, for good. Read once, and again after each change made here; a project with conversations is
 * not deleted (the server's `409`, said as it says it).
 */

import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import type { ChatPage, ChatProject } from "./chat-api.ts";
import { request, useGet } from "./client.ts";

export interface Projects {
  items: ChatProject[] | undefined;
  error: Error | undefined;
  reload(): void;
  /** The project `id`, when it is one of the user's. */
  get(id: string | undefined): ChatProject | undefined;
  create(name: string): Promise<ChatProject>;
  rename(id: string, name: string): Promise<ChatProject>;
  remove(id: string): Promise<void>;
}

const Context = createContext<Projects | undefined>(undefined);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const read = useGet<ChatPage<ChatProject>>("/projects");
  const { reload } = read;
  const items = read.data?.items;

  const create = useCallback(
    async (name: string) => {
      const made = await request<ChatProject>("POST", "/projects", { name });
      reload();
      return made;
    },
    [reload],
  );
  const rename = useCallback(
    async (id: string, name: string) => {
      const renamed = await request<ChatProject>("PATCH", `/projects/${encodeURIComponent(id)}`, { name });
      reload();
      return renamed;
    },
    [reload],
  );
  const remove = useCallback(
    async (id: string) => {
      await request<void>("DELETE", `/projects/${encodeURIComponent(id)}`);
      reload();
    },
    [reload],
  );
  const get = useCallback((id: string | undefined) => (id === undefined ? undefined : items?.find((each) => each.id === id)), [items]);

  const value = useMemo<Projects>(
    () => ({ items, error: read.data === undefined ? read.error : undefined, reload, get, create, rename, remove }),
    [items, read.data, read.error, reload, get, create, rename, remove],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useProjects(): Projects {
  const value = useContext(Context);
  if (value === undefined) throw new Error("useProjects outside ProjectsProvider");
  return value;
}
