/**
 * projects-sql's view (features/projects.md, "Observability and the dashboard"): every project, active,
 * archived or removed (name, owner, members, space, agents, last change), and a page per project
 * (`project.tsx`) with its members, instructions, documents, links and History, and the operator's
 * powers: archive, remove and recover, add a member, transfer the ownership, restore or redact an
 * entry; and "New project", for a space to adopt (a Google Chat space's key) or a new one, owned by the
 * person named. It reads the component's own routes, `/admin/api/projects*`, slowly.
 */

import { Archive, Clock, Folder, Group, Plus, User } from "iconoir-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/bui/Button";
import EmptyState from "@/components/bui/EmptyState";
import { Field } from "@/components/bui/Field";
import { FilterChips } from "@/components/bui/FilterTable";
import { Page, PageLoading, Section } from "@/components/bui/Page";
import RecordsTable, { type RecordColumn, RecordTag } from "@/components/bui/RecordsTable";
import { StatusDot } from "@/components/bui/StatusDot";
import { ErrorNote } from "@/components/pikit/error-note";
import { every } from "@/lib/activity";
import { ApiFailure, post, useApi } from "@/lib/api";
import { formatAgo } from "@/lib/format";
import { Link, navigate, pagePath } from "@/lib/router";
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

const EMPTY_FORM = { name: "", space: "", channel: "", id: "", agents: "", description: "" };

/**
 * A new project, as the operator: in the space given (adopted: its chats, memory and files are the
 * project's at once) or a new one, owned by the person named. A space that has a project already says
 * which one.
 */
function NewProjectForm({ onCancel }: { onCancel: () => void }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const [taken, setTaken] = useState<string>();
  const set = (key: keyof typeof EMPTY_FORM) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (form.name.trim() === "" || form.channel.trim() === "" || form.id.trim() === "") return;
    setBusy(true);
    setError(undefined);
    setTaken(undefined);
    const agents = form.agents
      .split(",")
      .map((agent) => agent.trim())
      .filter((agent) => agent !== "");
    try {
      const project = await post<Project>("/projects", {
        name: form.name.trim(),
        owner: { channel: form.channel.trim(), id: form.id.trim() },
        ...(form.space.trim() !== "" && { space: form.space.trim() }),
        ...(form.description.trim() !== "" && { description: form.description.trim() }),
        ...(agents.length > 0 && { agents }),
      });
      navigate(pagePath(BASE, project.id));
    } catch (thrown) {
      const id = thrown instanceof ApiFailure ? (thrown.body as { id?: unknown }).id : undefined;
      if (typeof id === "string") setTaken(id);
      setError(thrown instanceof Error ? thrown : new Error(String(thrown)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="New project">
      <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
        <div className="flex flex-wrap items-start gap-3">
          <Field label="Name" required>
            {(control) => <input {...control} className="control w-64" maxLength={60} placeholder="AECC" value={form.name} onChange={set("name")} />}
          </Field>
          <Field label="Space" required={false} hint="A space to adopt, as its channel keys it; empty: a new one.">
            {(control) => <input {...control} className="control w-80 font-mono" placeholder="googlechat:spaces/AAA" value={form.space} onChange={set("space")} />}
          </Field>
        </div>
        <div className="flex flex-wrap items-start gap-3">
          <Field label="Owner's channel" required>
            {(control) => <input {...control} className="control w-40" placeholder="web" value={form.channel} onChange={set("channel")} />}
          </Field>
          <Field label="Owner's id" required hint="The person's id on that channel.">
            {(control) => <input {...control} className="control w-64" value={form.id} onChange={set("id")} />}
          </Field>
          <Field label="Agents" required={false} hint="Comma-separated; empty: the channel's choice.">
            {(control) => <input {...control} className="control w-64" placeholder="trader" value={form.agents} onChange={set("agents")} />}
          </Field>
        </div>
        <Field label="Description" required={false}>
          {(control) => <textarea {...control} className="control min-h-16 w-full max-w-[42rem]" maxLength={500} value={form.description} onChange={set("description")} />}
        </Field>
        {error !== undefined && <ErrorNote error={error} title="Not created" />}
        {taken !== undefined && (
          <Link to={pagePath(BASE, taken)} className="text-[13px] text-ink-2 underline underline-offset-2">
            Open the project this space has
          </Link>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            Create the project
          </Button>
          <Button type="button" variant="quiet" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Section>
  );
}

function ProjectsPage() {
  const active = useApi<Listed>("/projects?limit=200", every(30_000));
  const archived = useApi<Listed>("/projects?archived=true&limit=200", every(60_000));
  const [filter, setFilter] = useState<Filter>("active");
  const [creating, setCreating] = useState(false);

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
      aside={
        creating ? undefined : (
          <Button onClick={() => setCreating(true)}>
            <Plus width={14} height={14} strokeWidth={2} aria-hidden /> New project
          </Button>
        )
      }
    >
      {error !== undefined && <ErrorNote error={error} title="Not read again" />}
      {creating && <NewProjectForm onCancel={() => setCreating(false)} />}
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
              <EmptyState icon={<Folder />} title="No project yet" hint="People make projects in the chat; an operator adopts a space (a Google Chat space) with New project." />
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
