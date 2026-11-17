/**
 * The user's projects (`GET /chat/api/projects`, those not archived), when the App has projects
 * (`ChatConfig.projects`): each the record of a place its members share (its chats, instructions,
 * documents, files, memory and links), the user a member or its owner. A conversation is made in one or
 * in none, for good. Read once, and again after each change made here; a project with conversations is
 * not deleted (the server's `409`, said as it says it): its owner archives it.
 */

import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import type { ChatPage, ChatProject, ChatProjectUpdate } from "./chat-api.ts";
import { request, useGet } from "./client.ts";
import { projectApi } from "./project.ts";

export interface Projects {
  /** Whether the App has projects at all. */
  enabled: boolean;
  items: ChatProject[] | undefined;
  error: Error | undefined;
  reload(): void;
  /** The project `id`, when it is one of the user's (not archived). */
  get(id: string | undefined): ChatProject | undefined;
  create(name: string, description?: string): Promise<ChatProject>;
  update(id: string, change: ChatProjectUpdate): Promise<ChatProject>;
  rename(id: string, name: string): Promise<ChatProject>;
  remove(id: string): Promise<void>;
}

const Context = createContext<Projects | undefined>(undefined);

export function ProjectsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const read = useGet<ChatPage<ChatProject>>(enabled ? "/projects" : null);
  const { reload } = read;
  const items = enabled ? read.data?.items : [];

  const create = useCallback(
    async (name: string, description?: string) => {
      const made = await request<ChatProject>("POST", "/projects", { name, ...(description !== undefined && description.trim() !== "" && { description }) });
      reload();
      return made;
    },
    [reload],
  );
  const update = useCallback(
    async (id: string, change: ChatProjectUpdate) => {
      const changed = await request<ChatProject>("PATCH", projectApi(id), change);
      reload();
      return changed;
    },
    [reload],
  );
  const rename = useCallback((id: string, name: string) => update(id, { name }), [update]);
  const remove = useCallback(
    async (id: string) => {
      await request<void>("DELETE", projectApi(id));
      reload();
    },
    [reload],
  );
  const get = useCallback((id: string | undefined) => (id === undefined ? undefined : items?.find((each) => each.id === id)), [items]);

  const value = useMemo<Projects>(
    () => ({ enabled, items, error: read.data === undefined ? read.error : undefined, reload, get, create, update, rename, remove }),
    [enabled, items, read.data, read.error, reload, get, create, update, rename, remove],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useProjects(): Projects {
  const value = useContext(Context);
  if (value === undefined) throw new Error("useProjects outside ProjectsProvider");
  return value;
}
