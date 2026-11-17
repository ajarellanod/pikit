/**
 * A project's Overview: that everything in it is shared by its members, who they are (initials), what
 * it holds, and its ten latest changes with Undo (History has them all).
 */

import { Group } from "iconoir-react";
import { Section } from "@/components/bui/Page";
import { ErrorNote } from "@/components/pikit/error-note";
import type { ChatChange, ChatMember, ChatPage } from "@/lib/chat-api";
import { post, useGet } from "@/lib/client";
import { formatBytes, principalName, projectApi } from "@/lib/project";
import { projectPath } from "@/lib/routes";
import { useSession } from "@/lib/session";
import type { TabProps } from "./index";
import { Avatar, Card, ChangeRow, TokenMeter, useAction } from "./parts";

/** Undoes `change` of project `id`: through the store that holds it (`POST .../history/:log/:n/restore`). */
export const undo = (id: string, change: ChatChange): Promise<ChatChange> => post<ChatChange>(projectApi(id, `/history/${change.log}/${change.n}/restore`));

const SHOWN_MEMBERS = 8;

export function OverviewTab({ overview, changed }: TabProps) {
  const { me } = useSession();
  const { project } = overview;
  const members = useGet<ChatPage<ChatMember>>(projectApi(project.id, "/members?limit=50"));
  const action = useAction();
  const people = members.data?.items ?? [];

  const facts: [string, string, string?][] = [
    ["Chats", String(project.chats), projectPath(project.id, "chats")],
    ["Documents", String(overview.documents), projectPath(project.id, "context")],
    ...(overview.files === undefined ? [] : ([["Files", `${overview.files.names} · ${formatBytes(overview.files.bytes)}`, projectPath(project.id, "files")]] as [string, string, string][])),
    ...(overview.memory === undefined ? [] : ([["Rules and notes", `${overview.memory.rules} · ${overview.memory.notes}`, projectPath(project.id, "memory")]] as [string, string, string][])),
    ["Links", String(overview.links), projectPath(project.id, "context")],
  ];

  return (
    <div className="flex flex-col gap-8">
      <p className="flex items-start gap-2 rounded-card bg-inset px-3 py-2.5 text-[13px] leading-relaxed text-ink-2 shadow-hairline">
        <Group width={16} height={16} strokeWidth={1.8} className="mt-0.5 shrink-0" aria-hidden />
        Everything in a project is shared by its members: its chats, its instructions and documents, its files and what its assistants remember. Anyone in it changes them, and every change is in its History, with who made it, where any member can undo it. Keep a private chat outside the project.
      </p>

      <Section title="Members" meta={String(project.members)}>
        <Card className="flex flex-wrap items-center gap-3">
          {people.slice(0, SHOWN_MEMBERS).map((member) => (
            <span key={`${member.principal.channel}:${member.principal.id}`} className="flex items-center gap-2 text-[13px] text-ink" title={member.role === "owner" ? "Owner" : "Member"}>
              <Avatar name={principalName(member.principal)} size={26} />
              {member.you ? "You" : principalName(member.principal)}
              {member.role === "owner" && <span className="text-[12px] text-ink-3">owner</span>}
            </span>
          ))}
          {people.length > SHOWN_MEMBERS && <span className="text-[13px] text-ink-3">and {people.length - SHOWN_MEMBERS} more</span>}
          <a href={`#${projectPath(project.id, "members")}`} className="ml-auto text-[12.5px] font-medium text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink">
            Members
          </a>
        </Card>
      </Section>

      <Section title="What it holds">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {facts.map(([label, value, href]) => (
            <a key={label} href={href === undefined ? undefined : `#${href}`} className="flex flex-col gap-0.5 rounded-card border border-line bg-surface px-3.5 py-3 transition-colors duration-100 hover:bg-hover">
              <span className="text-[12px] text-ink-3">{label}</span>
              <span className="text-[17px] tracking-[-0.01em] text-ink">{value}</span>
            </a>
          ))}
        </div>
        <Card>
          <div className="mb-2 text-[12.5px] font-medium text-ink">Core documents in every request</div>
          <TokenMeter used={overview.coreTokens} budget={overview.coreBudget} />
        </Card>
      </Section>

      <Section
        title="Recent activity"
        tools={
          <a href={`#${projectPath(project.id, "history")}`} className="text-[12.5px] font-medium text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink">
            History
          </a>
        }
      >
        {action.error !== undefined && <ErrorNote error={action.error} title="That could not be undone" />}
        {overview.recent.length === 0 ? (
          <p className="text-[13px] text-ink-3">Nothing changed yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {overview.recent.map((change) => (
              <ChangeRow key={`${change.log}-${change.n}`} change={change} me={me.user.id} onUndo={async (each) => {
                  if (await action.run(() => undo(project.id, each))) changed();
                }}
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
