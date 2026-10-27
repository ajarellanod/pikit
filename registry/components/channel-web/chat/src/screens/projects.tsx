/**
 * The user's projects (`#/projects`, the sidebar's Projects), in the same page as Conversations (`Page`:
 * its width, its two-tone title, "New project" where Conversations has "New chat"): a search by name
 * (on the projects read once: at most 100) and the order (newest first, or by name) where
 * Conversations has its search and "Archived", then cards, two a row on a wide screen, each a
 * project's name and when it was made, opening its page (`#/projects/<id>`, its chats) and with its
 * menu (a new chat in it, Rename, Delete: `useProjectMenu`). "New project" (`useNewProject`) asks a
 * name, makes it and opens it.
 *
 * A project is a place the user's chats share (what the assistant keeps for it: rules, memory, saved
 * files); a chat is made in one or in none, for good.
 */

import { Folder, Plus, Search, Sort } from "iconoir-react";
import { useState } from "react";
import { ActionsMenu } from "@/components/bui/ActionsMenu";
import { Button } from "@/components/bui/Button";
import EmptyState from "@/components/bui/EmptyState";
import { LoaderGrid } from "@/components/bui/LoadingState";
import { Page } from "@/components/bui/Page";
import SearchField from "@/components/bui/SearchField";
import { ErrorNote } from "@/components/pikit/error-note";
import { type ProjectOrder, shownProjects } from "@/lib/project-list";
import { useProjects } from "@/lib/projects";
import { projectPath } from "@/lib/routes";
import { usePageTitle, useSession } from "@/lib/session";
import { useNewProject, useProjectMenu } from "./layout";

const DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

export function ProjectsScreen() {
  const { config } = useSession();
  const projects = useProjects();
  const projectMenu = useProjectMenu();
  const newProject = useNewProject();
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<ProjectOrder>("recent");
  usePageTitle(config.name, "Projects");

  const items = projects.items;
  const searched = query.trim() !== "";
  const shown = items === undefined ? undefined : shownProjects(items, query, order);

  return (
    <Page
      eyebrow="Projects"
      title="Your projects"
      aside={
        <Button variant="primary" size="xs" onClick={newProject}>
          <Plus width={14} height={14} strokeWidth={2} aria-hidden /> New project
        </Button>
      }
    >
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <SearchField value={query} onChange={(value) => setQuery(value.slice(0, 120))} placeholder="Search by name" label="Search the projects" className="min-w-0 flex-1" />
          <Button
            variant="quiet"
            size="xs"
            aria-label={order === "recent" ? "Newest first: order by name" : "By name: order newest first"}
            onClick={() => setOrder((now) => (now === "recent" ? "name" : "recent"))}
          >
            <Sort width={14} height={14} strokeWidth={1.9} aria-hidden /> {order === "recent" ? "Newest first" : "By name"}
          </Button>
        </div>
        {projects.error !== undefined && <ErrorNote error={projects.error} title="The projects cannot be read" />}
        {shown === undefined && projects.error === undefined && (
          <div className="flex items-center gap-2.5 text-[13px] text-ink-3">
            <LoaderGrid /> Loading
          </div>
        )}
        {shown !== undefined && shown.length === 0 && (
          <EmptyState
            icon={searched ? <Search /> : <Folder />}
            title={searched ? `No project named with “${query.trim()}”` : "No projects yet"}
            hint={searched ? "Search finds words of a name, in any case." : "A project's chats share what the assistant keeps for it: its rules, its memory, its saved files."}
          />
        )}
        {shown !== undefined && shown.length > 0 && (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {shown.map((project) => (
              <li key={project.id} className="group/card relative flex items-center gap-3 rounded-[12px] border border-line bg-surface px-4 py-3.5 transition-colors duration-150 hover:bg-hover has-[a:focus-visible]:bg-hover">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-inset text-ink-2 shadow-hairline">
                  <Folder width={16} height={16} strokeWidth={1.8} aria-hidden />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <a href={`#${projectPath(project.id)}`} title={project.name} className="truncate text-[14px] font-medium text-ink outline-none after:absolute after:inset-0 after:content-['']">
                    {project.name}
                  </a>
                  <time className="text-[12.5px] text-ink-3" dateTime={new Date(project.createdAt).toISOString()}>
                    {DATE.format(project.createdAt)}
                  </time>
                </span>
                <ActionsMenu
                  actions={projectMenu(project)}
                  label={`Actions for ${project.name}`}
                  className="relative z-10 size-7 shrink-0 rounded-[7px] text-ink-3 opacity-0 transition-[opacity,background-color,color] duration-100 group-hover/card:opacity-100 group-has-[a:focus-visible]/card:opacity-100 hover:bg-hover-2 hover:text-ink focus-visible:opacity-100 aria-expanded:bg-hover-2 aria-expanded:text-ink aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </Page>
  );
}
