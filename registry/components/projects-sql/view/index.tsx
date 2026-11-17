/**
 * projects-sql's view (features/projects.md, "Observability and the dashboard"): every project, active,
 * archived or removed (name, owner, members, space, agents, last change), and a page per project
 * (`project.tsx`) with its members, instructions, documents, links and History, and the operator's
 * powers: archive, remove and recover, add a member, transfer the ownership, restore or redact an
 * entry. It reads the component's own routes, `/admin/api/projects*`, slowly.
 */

import { Archive, Clock, Folder, Group, User } from "iconoir-react";
import { useState } from "react";
import EmptyState from "@/components/bui/EmptyState";
import { FilterChips } from "@/components/bui/FilterTable";
import { Page, PageLoading, Section } from "@/components/bui/Page";
import RecordsTable, { type RecordColumn, RecordTag } from "@/components/bui/RecordsTable";
import { StatusDot } from "@/components/bui/StatusDot";
import { ErrorNote } from "@/components/pikit/error-note";
import { every } from "@/lib/activity";
import { useApi } from "@/lib/api";
import { formatAgo } from "@/lib/format";
import { Link, pagePath } from "@/lib/router";
import { defineView } from "@/lib/views";
import { BASE, ProjectPage } from "./project";
import { type Project, type ProjectPage as Listed, principalName } from "./types";

type Filter = "active" | "archived" | "removed";

/** A project's state, as a dot and a word. */
export function ProjectState({ project }: { project: Project }) {
  if (project.removedAt !== undefined) return <StatusDot tone="red">Removed</StatusDot>;
  if (project.archivedAt !== undefined) return <StatusDot tone="neutral">Archived</StatusDot>;
  return <StatusDot tone="green">Active</StatusDot>;
}

function ProjectsPage() {
  const active = useApi<Listed>("/projects?limit=200", every(30_000));
  const archived = useApi<Listed>("/projects?archived=true&limit=200", every(60_000));
  const [filter, setFilter] = useState<Filter>("active");

  const error = active.error ?? archived.error;
  if (error !== undefined && (active.data === undefined || archived.data === undefined)) {
    return (
      <Page eyebrow="Projects">
        <ErrorNote error={error} title="The projects cannot be read" />
      </Page>
    );
  }
  if (active.data === undefined || archived.data === undefined) return <PageLoading eyebrow="Projects" />;

  const all = [...active.data.items, ...archived.data.items];
  const removed = all.filter((project) => project.removedAt !== undefined);
  const lists: Record<Filter, Project[]> = {
    active: active.data.items.filter((project) => project.removedAt === undefined),
    archived: archived.data.items.filter((project) => project.removedAt === undefined),
    removed,
  };
  const rows = lists[filter];

  const columns: RecordColumn<Project>[] = [
    {
      key: "name",
      label: "Project",
      icon: <Folder />,
      width: 260,
      sort: (a, b) => a.name.localeCompare(b.name),
      title: (row) => row.description || row.name,
      cell: (row) => (
        <Link to={pagePath(BASE, row.id)} className="records-name hover:underline">
          {row.name}
        </Link>
      ),
    },
    { key: "state", label: "State", icon: <Archive />, width: 120, cell: (row) => <ProjectState project={row} /> },
    { key: "owner", label: "Owner", icon: <User />, width: 180, title: (row) => `${row.owner.channel}:${row.owner.id}`, cell: (row) => principalName(row.owner) },
    { key: "members", label: "Members", icon: <Group />, width: 100, sort: (a, b) => a.members - b.members, cell: (row) => row.members },
    { key: "space", label: "Space", icon: <Folder />, width: 260, title: (row) => row.space, cell: (row) => <RecordTag mono>{row.space}</RecordTag> },
    {
      key: "updated",
      label: "Last change",
      icon: <Clock />,
      width: 140,
      sort: (a, b) => a.updatedAt - b.updatedAt,
      cell: (row) => <span className="text-ink-2">{formatAgo(row.updatedAt)}</span>,
    },
  ];

  return (
    <Page
      eyebrow="Projects"
      title={`${lists.active.length} ${lists.active.length === 1 ? "project" : "projects"}`}
      description="Each project is the record of one space, shared by its members and its agents: its members, instructions, documents, links, and the History of every change with who made it. Open one to see it, restore or redact a change, or archive, remove or recover it."
    >
      {error !== undefined && <ErrorNote error={error} title="Not read again" />}
      <Section
        title="Projects"
        meta={rows.length}
        tools={
          <FilterChips
            label="Show the projects that are"
            value={filter}
            onChange={setFilter}
            filters={[
              { key: "active", label: "Active", tone: "green", count: lists.active.length },
              { key: "archived", label: "Archived", tone: "neutral", count: lists.archived.length },
              { key: "removed", label: "Removed", tone: "red", count: removed.length },
            ]}
          />
        }
      >
        <RecordsTable
          label="The projects"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          initialSort={{ key: "updated", dir: -1 }}
          empty={
            all.length === 0 ? (
              <EmptyState icon={<Folder />} title="No project yet" hint="People make projects in the chat; an adopted space (a Google Chat space) becomes one through its component." />
            ) : (
              <EmptyState icon={<Folder />} title={`No project is ${filter}`} hint="Pick another filter to see the others." />
            )
          }
        />
      </Section>
    </Page>
  );
}

export default defineView({
  id: "projects-sql",
  title: "Projects",
  icon: Folder,
  requires: ["projects"],
  order: 35,
  pages: [
    { path: BASE, component: ProjectsPage, fill: true },
    { path: `${BASE}/:id`, component: ProjectPage, fill: true },
  ],
});
