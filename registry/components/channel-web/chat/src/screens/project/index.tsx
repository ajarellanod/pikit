/**
 * A project's page (`#/projects/<id>[/<tab>]`, features/projects.md "UI"), in the page's harness (`Page`:
 * its width, its two-tone title): the project's name and description, "New chat" in it and its menu,
 * then its tabs, each a link (`projectPath(id, tab)`):
 *
 * - **Overview**: what it is, its members (initials), what it holds (chats, documents and the core
 *   documents' token budget, files, memory, links) and its latest changes, each with Undo; and the rule
 *   every member reads first: everything in a project is shared by its members.
 * - **Context**: the instructions, written over a version (another member's newer one is said, never
 *   overwritten), with their versions; the documents, core (in every request, within a budget the meter
 *   shows) or reference (searched), added from text or a file (`document.convert` reads PDFs and Office
 *   files when the App has one).
 * - **Files** (with `space.files`): uploaded by people, saved by agents, with their versions and
 *   authors; downloaded, trashed for 30 days and restored; one made a document.
 * - **Memory** (with `memory`): the rules every assistant of the project follows and the notes they
 *   keep, each with who added it and from where, editable and removable by any member; the summaries of
 *   quiet chats; the rules proposed before the space was a project, added or discarded.
 * - **Members**: added by email by any member; the owner hands the project over and removes others;
 *   anyone leaves (the owner after handing it over).
 * - **Chats**: every member's chats of the project; one's own opens, another's reads (read only).
 * - **History**: the project's, its memory's and its files' changes merged, newest first, with Undo.
 *
 * Every change made here reads the overview again (the counts, the latest changes). An archived project
 * reads alike, and makes no new chat.
 */

import { Folder, Plus } from "iconoir-react";
import { ActionsMenu } from "@/components/bui/ActionsMenu";
import { Badge } from "@/components/bui/Badge";
import { Button } from "@/components/bui/Button";
import { Page, PageLoading } from "@/components/bui/Page";
import { ErrorNote } from "@/components/pikit/error-note";
import type { ChatProjectOverview } from "@/lib/chat-api";
import { useGet } from "@/lib/client";
import { ChatFailure } from "@/lib/errors";
import { projectApi } from "@/lib/project";
import { useProjects } from "@/lib/projects";
import { PROJECTS_PATH, projectPath, type ProjectTab } from "@/lib/routes";
import { usePageTitle, useSession } from "@/lib/session";
import { useNewChat, useProjectMenu } from "../layout";
import { ChatsTab, ProjectChatReader } from "./chats";
import { ContextTab } from "./context";
import { FilesTab } from "./files";
import { HistoryTab } from "./history";
import { MembersTab } from "./members";
import { MemoryTab } from "./memory";
import { OverviewTab } from "./overview";

const TAB_NAMES: Record<ProjectTab, string> = { overview: "Overview", context: "Context", files: "Files", memory: "Memory", members: "Members", chats: "Chats", history: "History" };

/** What a tab gets: the project's overview as last read, and a way to read it again after a change. */
export interface TabProps {
  overview: ChatProjectOverview;
  /** The page changed something: the overview (counts, recent changes) is read again. */
  changed(): void;
}

export function ProjectScreen({ id, tab, chat }: { id: string; tab: ProjectTab; chat?: string | undefined }) {
  const { config } = useSession();
  const projects = useProjects();
  const projectMenu = useProjectMenu();
  const newChat = useNewChat();
  const read = useGet<ChatProjectOverview>(projectApi(id), 30_000);
  const overview = read.data?.project.id === id ? read.data : undefined;
  usePageTitle(config.name, overview?.project.name ?? "Project");
  const features = config.projects;

  if (read.error !== undefined && overview === undefined) {
    const missing = read.error instanceof ChatFailure && read.error.status === 404;
    return (
      <Page eyebrow="Project">
        <ErrorNote error={read.error} title={missing ? "No such project, or you are not one of its members" : "This project cannot be read"} />
        <a href={`#${PROJECTS_PATH}`} className="text-[13px] font-medium text-ink underline decoration-line-strong underline-offset-2">
          Your projects
        </a>
      </Page>
    );
  }
  if (overview === undefined) return <PageLoading eyebrow="Project" />;
  // Another member's chat, read only, fills the pane.
  if (tab === "chats" && chat !== undefined) return <ProjectChatReader project={overview.project} chatId={chat} />;

  const project = overview.project;
  const changed = () => {
    read.reload();
    projects.reload();
  };
  const tabs = (Object.keys(TAB_NAMES) as ProjectTab[]).filter((each) => (each !== "files" || features?.files === true) && (each !== "memory" || features?.memory === true));
  const props: TabProps = { overview, changed };

  return (
    <Page
      eyebrow="Project"
      title={
        <span className="flex items-center gap-2.5">
          <span className="min-w-0 truncate">{project.name}</span>
          {project.archived && <Badge>Archived</Badge>}
        </span>
      }
      aside={
        <div className="flex items-center gap-1.5">
          {!project.archived && (
            <Button variant="primary" size="xs" onClick={() => newChat({ project: project.id })}>
              <Plus width={14} height={14} strokeWidth={2} aria-hidden /> New chat
            </Button>
          )}
          <ActionsMenu actions={projectMenu(project).filter((each) => each.key !== "new")} label="Project actions" className="btn btn-ghost btn-icon size-7 text-ink-3 hover:text-ink aria-expanded:text-ink" />
        </div>
      }
      description={project.description === "" ? undefined : <p className="whitespace-pre-wrap">{project.description}</p>}
    >
      <nav aria-label="The project's pages" className="-mt-4 flex gap-1 overflow-x-auto border-b border-line">
        {tabs.map((each) => (
          <a
            key={each}
            href={`#${projectPath(project.id, each)}`}
            aria-current={each === tab ? "page" : undefined}
            className={`-mb-px shrink-0 border-b-2 px-2.5 pt-1 pb-2 text-[13px] font-medium transition-colors duration-100 ${each === tab ? "border-ink text-ink" : "border-transparent text-ink-3 hover:text-ink"}`}
          >
            {TAB_NAMES[each]}
          </a>
        ))}
      </nav>
      {tab === "overview" && <OverviewTab {...props} />}
      {tab === "context" && <ContextTab {...props} />}
      {tab === "files" && features?.files === true && <FilesTab {...props} />}
      {tab === "memory" && features?.memory === true && <MemoryTab {...props} />}
      {tab === "members" && <MembersTab {...props} />}
      {tab === "chats" && <ChatsTab {...props} />}
      {tab === "history" && <HistoryTab {...props} />}
      {((tab === "files" && features?.files !== true) || (tab === "memory" && features?.memory !== true)) && (
        <div className="flex items-center gap-2 text-[13px] text-ink-3">
          <Folder width={15} height={15} aria-hidden /> This App keeps no {tab} for its projects.
        </div>
      )}
    </Page>
  );
}
