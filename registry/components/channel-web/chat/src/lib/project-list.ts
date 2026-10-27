/**
 * The projects page's list (`screens/projects.tsx`), apart from React: which projects a search finds and
 * in which order. Pure (scripts/chat.test.ts checks it).
 */

import type { ChatProject } from "./chat-api.ts";

/** Newest first, or by name. */
export type ProjectOrder = "recent" | "name";

/** `items` found by `query` (any case, anywhere in the name), in `order`. */
export function shownProjects(items: readonly ChatProject[], query: string, order: ProjectOrder): ChatProject[] {
  const needle = query.trim().toLocaleLowerCase();
  const found = needle === "" ? [...items] : items.filter((project) => project.name.toLocaleLowerCase().includes(needle));
  return found.sort((a, b) => (order === "name" ? a.name.localeCompare(b.name) : b.createdAt - a.createdAt));
}
