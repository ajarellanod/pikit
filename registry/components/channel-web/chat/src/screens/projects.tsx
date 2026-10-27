/**
 * The user's projects (`#/projects`, the sidebar's Projects): a title, then cards, two a row on a wide
 * screen, each a project's name and when it was made, opening its page (`#/projects/<id>`, its chats)
 * and with its menu (a new chat in it, Rename, Delete: `useProjectMenu`). At the title's right: a search
 * by name (a field the search button opens, on the projects read once: at most 100), the order
 * (newest first, or by name), and "New project" (`useNewProject`: asks a name, makes it, opens it).
 *
 * A project is a place the user's chats share (what the assistant keeps for it: rules, memory, saved
 * files); a chat is made in one or in none, for good.
 */

import { Folder, Plus, Search, Sort, Xmark } from "iconoir-react";
import { useState } from "react";
import { ActionsMenu } from "@/components/bui/ActionsMenu";
import { Button } from "@/components/bui/Button";
import EmptyState from "@/components/bui/EmptyState";
import { LoaderGrid } from "@/components/bui/LoadingState";
import SearchField from "@/components/bui/SearchField";
import { ErrorNote } from "@/components/pikit/error-note";
import { type ProjectOrder, shownProjects } from "@/lib/project-list";
import { useProjects } from "@/lib/projects";
import { projectPath } from "@/lib/routes";
import { usePageTitle, useSession } from "@/lib/session";
import { useNewProject, useProjectMenu } from "./layout";

const DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

const TOOL = "flex size-8 items-center justify-center rounded-[8px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink aria-pressed:bg-hover aria-pressed:text-ink";

export function ProjectsScreen() {
  const { config } = useSession();
  const projects = useProjects();
  const projectMenu = useProjectMenu();
  const newProject = useNewProject();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<ProjectOrder>("recent");
  usePageTitle(config.name, "Projects");

  const items = projects.items;
  const shown = items === undefined ? undefined : shownProjects(items, searching ? query : "", order);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-5 px-5 py-8 sm:px-10 sm:py-10">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 flex-1 text-[24px] font-normal tracking-[-0.02em] text-ink sm:text-[26px]">Projects</h1>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={searching ? "Close the search" : "Search the projects"}
              aria-pressed={searching}
              title="Search"
              onClick={() => {
                setSearching((now) => !now);
                setQuery("");
              }}
              className={TOOL}
            >
              {searching ? <Xmark width={16} height={16} strokeWidth={1.9} /> : <Search width={16} height={16} strokeWidth={1.9} />}
            </button>
            <button
              type="button"
              aria-label={order === "recent" ? "Newest first: order by name" : "By name: order newest first"}
              title={order === "recent" ? "Newest first" : "By name"}
              onClick={() => setOrder((now) => (now === "recent" ? "name" : "recent"))}
              className={TOOL}
            >
              <Sort width={16} height={16} strokeWidth={1.9} />
            </button>
            <Button size="xs" className="ml-1.5" onClick={newProject}>
              <Plus width={14} height={14} strokeWidth={2} aria-hidden /> New project
            </Button>
          </div>
        </header>

        {searching && <SearchField value={query} onChange={(value) => setQuery(value.slice(0, 120))} placeholder="Search by name" label="Search the projects" />}
        {projects.error !== undefined && <ErrorNote error={projects.error} title="The projects cannot be read" />}
        {shown === undefined && projects.error === undefined && (
          <div className="flex items-center gap-2.5 text-[13px] text-ink-3">
            <LoaderGrid /> Loading
          </div>
        )}
        {shown !== undefined && shown.length === 0 && (
          <EmptyState
            icon={searching && query.trim() !== "" ? <Search /> : <Folder />}
            title={searching && query.trim() !== "" ? `No project named with “${query.trim()}”` : "No projects yet"}
            hint={searching && query.trim() !== "" ? "Search finds words of a name, in any case." : "A project's chats share what the assistant keeps for it: its rules, its memory, its saved files."}
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
      </div>
    </div>
  );
}
