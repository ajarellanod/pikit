/**
 * One project, as an operator sees it: its record and state, its members (add one, make one the owner),
 * its instructions, its documents (read one), its links, and its History, newest first, with Restore
 * and Redact on each entry; Archive, Remove and Recover. Every act is the store's, as the operator
 * (`{ kind: "operator" }`): what it refuses is shown as it said it. Removing, redacting and restoring
 * ask first.
 */

import { ArrowLeft, Clock, Folder, Group, Journal, Link as LinkIcon, Page as PageIcon, User } from "iconoir-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Button } from "@/components/bui/Button";
import EmptyState from "@/components/bui/EmptyState";
import { Field } from "@/components/bui/Field";
import { Page, PageLoading, Section } from "@/components/bui/Page";
import RecordsTable, { type RecordColumn, RecordTag } from "@/components/bui/RecordsTable";
import { StatusDot } from "@/components/bui/StatusDot";
import { ErrorNote } from "@/components/pikit/error-note";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { every } from "@/lib/activity";
import { api, post, useApi } from "@/lib/api";
import { formatAgo } from "@/lib/format";
import { Link } from "@/lib/router";
import { authorName, type Change, type ChangePage, type DocumentRead, type Link as ProjectLink, type Member, type ProjectDocument, type ProjectOverview, principalName } from "./types";

/** The view's pages. */
export const BASE = "/projects-sql";
/** Its routes, under /admin/api. */
const API = "/projects";

const ACTION_TONE = { added: "green", changed: "blue", removed: "red", restored: "orange" } as const;

/** What a confirmation asks before an act. */
type Ask = { title: string; text: string; label: string; danger?: boolean; run: () => Promise<unknown> };

export function ProjectPage({ params }: { params: Record<string, string> }) {
  // Its own state per project: another project's page starts afresh.
  return <OneProject key={params.id} id={params.id ?? ""} />;
}

function OneProject({ id }: { id: string }) {
  const path = `${API}/${encodeURIComponent(id)}`;
  const overview = useApi<ProjectOverview>(path, every(30_000));
  const [before, setBefore] = useState<number>();
  const history = useApi<ChangePage>(`${path}/history?limit=50${before === undefined ? "" : `&before=${before}`}`, every(30_000));
  const [ask, setAsk] = useState<Ask>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<Error>();
  const [reading, setReading] = useState<DocumentRead>();
  const [principal, setPrincipal] = useState({ channel: "", id: "" });

  const reload = () => {
    overview.reload();
    history.reload();
  };
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(undefined);
    try {
      await work();
    } catch (thrown) {
      setActionError(thrown instanceof Error ? thrown : new Error(String(thrown)));
    } finally {
      setBusy(false);
      reload();
    }
  };

  if (overview.error !== undefined && overview.data === undefined) {
    return (
      <Page eyebrow="Project">
        <ErrorNote error={overview.error} title="This project cannot be read" />
        <Link to={BASE} className="text-[13px] text-ink-2 underline underline-offset-2">
          Back to the projects
        </Link>
      </Page>
    );
  }
  if (overview.data === undefined) return <PageLoading eyebrow="Project" />;
  const { project, members, instructions, documents, links } = overview.data;
  const removed = project.removedAt !== undefined;
  const archived = project.archivedAt !== undefined;

  const addMember = (event: FormEvent) => {
    event.preventDefault();
    if (principal.channel.trim() === "" || principal.id.trim() === "") return;
    void act(async () => {
      await post(`${path}/members`, { principal: { channel: principal.channel.trim(), id: principal.id.trim() } });
      setPrincipal({ channel: "", id: "" });
    });
  };

  const memberColumns: RecordColumn<Member>[] = [
    { key: "who", label: "Member", icon: <User />, width: 240, title: (row) => `${row.principal.channel}:${row.principal.id}`, cell: (row) => principalName(row.principal) },
    { key: "role", label: "Role", icon: <Group />, width: 110, cell: (row) => (row.role === "owner" ? <StatusDot tone="blue">Owner</StatusDot> : "Member") },
    { key: "source", label: "Source", icon: <LinkIcon />, width: 220, cell: (row) => (row.source === "manual" ? "Added by hand" : <RecordTag mono>{row.source}</RecordTag>) },
    { key: "since", label: "Since", icon: <Clock />, width: 120, cell: (row) => <span className="text-ink-2">{formatAgo(row.at)}</span> },
    {
      key: "acts",
      label: "",
      width: 220,
      cell: (row) =>
        row.role === "owner" || removed ? null : (
          <span className="flex gap-1.5">
            <Button size="xs" disabled={busy} onClick={() => void act(() => post(`${path}/owner`, { principal: row.principal }))}>
              Make owner
            </Button>
            {row.source === "manual" && (
              <Button size="xs" variant="quiet" disabled={busy} onClick={() => void act(() => post(`${path}/members/remove`, { principal: row.principal }))}>
                Remove
              </Button>
            )}
          </span>
        ),
    },
  ];

  const documentColumns: RecordColumn<ProjectDocument>[] = [
    {
      key: "title",
      label: "Document",
      icon: <PageIcon />,
      width: 280,
      title: (row) => row.title,
      cell: (row) => (
        <button
          type="button"
          className="records-name cursor-pointer hover:underline"
          onClick={() => void act(async () => setReading(await api<DocumentRead>(`${path}/documents/${encodeURIComponent(row.id)}?part=1`)))}
        >
          {row.title}
        </button>
      ),
    },
    { key: "mode", label: "Mode", width: 110, cell: (row) => (row.mode === "core" ? <StatusDot tone="blue">Core</StatusDot> : "Reference") },
    { key: "tokens", label: "Tokens", width: 100, sort: (a, b) => a.tokens - b.tokens, cell: (row) => row.tokens },
    { key: "version", label: "Version", width: 90, cell: (row) => row.version },
    { key: "by", label: "By", icon: <User />, width: 200, cell: (row) => authorName(row.by) },
    { key: "at", label: "When", icon: <Clock />, width: 120, cell: (row) => <span className="text-ink-2">{formatAgo(row.at)}</span> },
  ];

  const linkColumns: RecordColumn<ProjectLink>[] = [
    {
      key: "title",
      label: "Link",
      icon: <LinkIcon />,
      width: 320,
      title: (row) => row.url,
      cell: (row) => (
        <a href={row.url} target="_blank" rel="noreferrer" className="records-name hover:underline">
          {row.title}
        </a>
      ),
    },
    { key: "note", label: "Note", width: 260, muted: (row) => row.note === undefined, cell: (row) => row.note ?? "—" },
    { key: "by", label: "By", icon: <User />, width: 220, cell: (row) => authorName(row.by) },
    { key: "at", label: "When", icon: <Clock />, width: 120, cell: (row) => <span className="text-ink-2">{formatAgo(row.at)}</span> },
  ];

  const historyColumns: RecordColumn<Change>[] = [
    { key: "n", label: "#", width: 60, cell: (row) => row.n },
    {
      key: "what",
      label: "Change",
      icon: <Journal />,
      width: 320,
      title: (row) => row.item.title,
      cell: (row) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <StatusDot tone={ACTION_TONE[row.action]}>{row.action}</StatusDot>
          <RecordTag>{row.item.kind}</RecordTag>
          <span className="truncate">{row.redacted !== undefined ? <em className="text-ink-3">redacted by {authorName(row.redacted.by)}</em> : row.item.title}</span>
          {row.restores !== undefined && <span className="text-ink-3">(undoes #{row.restores})</span>}
        </span>
      ),
    },
    { key: "by", label: "By", icon: <User />, width: 220, title: (row) => (row.by.kind === "agent" ? `in ${row.by.conversation}` : undefined), cell: (row) => authorName(row.by) },
    { key: "at", label: "When", icon: <Clock />, width: 120, cell: (row) => <span className="text-ink-2">{formatAgo(row.at)}</span> },
    {
      key: "acts",
      label: "",
      width: 200,
      cell: (row) => (
        <span className="flex gap-1.5">
          {row.restorable && !removed && (
            <Button
              size="xs"
              disabled={busy}
              onClick={() =>
                setAsk({
                  title: `Restore what change #${row.n} replaced?`,
                  text: "The item goes back to how it was just before this change, as a new change of yours in the History; the members see it at once.",
                  label: "Restore",
                  run: () => post(`${path}/history/${row.n}/restore`),
                })
              }
            >
              Restore
            </Button>
          )}
          {row.redacted === undefined && (
            <Button
              size="xs"
              variant="quiet"
              disabled={busy}
              onClick={() =>
                setAsk({
                  title: `Redact change #${row.n}?`,
                  text: "Its title and the state it kept are blanked for good (and the text it wrote, unless it is the current one); who and when stay, marked as redacted by you. It cannot be restored after.",
                  label: "Redact",
                  danger: true,
                  run: () => post(`${path}/history/${row.n}/redact`),
                })
              }
            >
              Redact
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <Page
      eyebrow="Project"
      title={project.name}
      aside={removed ? <StatusDot tone="red">Removed</StatusDot> : archived ? <StatusDot tone="neutral">Archived</StatusDot> : <StatusDot tone="green">Active</StatusDot>}
      description={
        <>
          {project.description !== "" && <span className="block pb-1">{project.description}</span>}
          Owned by {principalName(project.owner)}, {project.members} {project.members === 1 ? "member" : "members"}; space <RecordTag mono>{project.space}</RecordTag>
          {project.agents.length > 0 && <> ; agents {project.agents.join(", ")}</>}. Changed {formatAgo(project.updatedAt)}.
          {removed && " Removed: purged 30 days after its removal, unless you recover it."}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link to={BASE} className="inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink">
          <ArrowLeft width={14} height={14} /> Projects
        </Link>
        <span className="ml-auto" />
        {removed ? (
          <Button variant="primary" disabled={busy} onClick={() => void act(() => post(`${path}/recover`))}>
            Recover
          </Button>
        ) : (
          <>
            <Button disabled={busy} onClick={() => void act(() => post(`${path}/archive`, { archived: !archived }))}>
              {archived ? "Unarchive" : "Archive"}
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                setAsk({
                  title: `Remove ${project.name}?`,
                  text: "It is gone for its members and agents at once, and purged with its space's memory after 30 days, unless you recover it before.",
                  label: "Remove",
                  danger: true,
                  run: () => post(`${path}/remove`),
                })
              }
            >
              Remove
            </Button>
          </>
        )}
      </div>
      {actionError !== undefined && <ErrorNote error={actionError} title="Not done" />}
      {overview.error !== undefined && <ErrorNote error={overview.error} title="Not read again" />}

      <Section title="Members" meta={members.length}>
        <RecordsTable label="The project's members" columns={memberColumns} rows={members} rowKey={(row) => `${row.principal.channel}:${row.principal.id}`} empty={<EmptyState icon={<Group />} title="No members" />} />
        {!removed && (
          <form className="flex flex-wrap items-end gap-2 pt-3" onSubmit={addMember}>
            <Field label="Channel" required>
              {(control) => <input {...control} className="control w-40" placeholder="web" value={principal.channel} onChange={(event) => setPrincipal({ ...principal, channel: event.target.value })} />}
            </Field>
            <Field label="Id" required>
              {(control) => <input {...control} className="control w-64" placeholder="the person's id on that channel" value={principal.id} onChange={(event) => setPrincipal({ ...principal, id: event.target.value })} />}
            </Field>
            <Button type="submit" disabled={busy}>
              Add a member
            </Button>
          </form>
        )}
      </Section>

      <Section title="Instructions" meta={instructions === undefined ? "none" : `version ${instructions.version}`}>
        {instructions === undefined || instructions.text === "" ? (
          <EmptyState icon={<Journal />} title="No instructions" hint="The members write them in the project's page." />
        ) : (
          <Block footer={`By ${authorName(instructions.by)}, ${formatAgo(instructions.at)}`}>{instructions.text}</Block>
        )}
      </Section>

      <Section title="Documents" meta={documents.length}>
        <RecordsTable
          label="The project's documents"
          columns={documentColumns}
          rows={documents}
          rowKey={(row) => row.id}
          empty={<EmptyState icon={<PageIcon />} title="No documents" hint="The members add them in the project's page." />}
        />
        {reading !== undefined && (
          <div className="pt-3">
            <Block
              footer={
                <span className="flex items-center gap-2">
                  {reading.document.title}, version {reading.document.version}, part {reading.part} of {reading.parts}
                  <span className="ml-auto" />
                  {reading.part < reading.parts && (
                    <Button
                      size="xs"
                      onClick={() =>
                        void act(async () => setReading(await api<DocumentRead>(`${path}/documents/${encodeURIComponent(reading.document.id)}?part=${reading.part + 1}`)))
                      }
                    >
                      Next part
                    </Button>
                  )}
                  <Button size="xs" variant="quiet" onClick={() => setReading(undefined)}>
                    Close
                  </Button>
                </span>
              }
            >
              {reading.text}
            </Block>
          </div>
        )}
      </Section>

      <Section title="Links" meta={links.length}>
        <RecordsTable
          label="The project's links"
          columns={linkColumns}
          rows={links}
          rowKey={(row) => row.id}
          empty={<EmptyState icon={<LinkIcon />} title="No links" hint="Members and agents add them." />}
        />
      </Section>

      <Section
        title="History"
        meta={history.data?.items.length ?? 0}
        tools={
          <span className="flex gap-1.5">
            {before !== undefined && (
              <Button size="xs" onClick={() => setBefore(undefined)}>
                Newest
              </Button>
            )}
            {history.data?.next !== undefined && (
              <Button size="xs" onClick={() => setBefore(history.data?.next)}>
                Older
              </Button>
            )}
          </span>
        }
      >
        {history.error !== undefined && <ErrorNote error={history.error} title="The History cannot be read" />}
        <RecordsTable
          label="Every change, newest first"
          columns={historyColumns}
          rows={history.data?.items ?? []}
          rowKey={(row) => String(row.n)}
          empty={<EmptyState icon={<Folder />} title="No change yet" />}
        />
      </Section>

      <AlertDialog open={ask !== undefined} onOpenChange={(open) => !open && setAsk(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{ask?.title}</AlertDialogTitle>
            <AlertDialogDescription>{ask?.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={ask?.danger ? "destructive" : "default"}
              onClick={() => {
                const run = ask?.run;
                setAsk(undefined);
                if (run !== undefined) void act(run);
              }}
            >
              {ask?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

/** A text as it was written, in a card, with a quiet line under it. */
function Block({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-surface shadow-table">
      <pre className="max-h-[420px] overflow-auto px-4 py-3 font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{children}</pre>
      <div className="border-t border-line px-4 py-2 text-[12px] text-ink-3">{footer}</div>
    </div>
  );
}
