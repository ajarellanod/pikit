/**
 * One proposal: the agent's description (markdown), its checks, its deploy, its diff file by file, and
 * Approve / Reject, each behind a confirmation; at the side, its details (state, who proposes it, its
 * branch, its changes, when, links). A few small files show open; more files or more lines than that
 * start folded, and open one by one (or all at once). Approve sends the head commit the page shows, so
 * a branch the agent pushed again since is not approved unread. Where checks run before an approval
 * (CI) and do not pass, the confirmation says so and approves anyway (`override`); where they run
 * after (the deployer), it says what the deployer does.
 */

import { Activity, ArrowLeft, Check, Collapse, Expand, GitBranch, GitPullRequest, InfoCircle, NavArrowRight, OpenNewWindow, Xmark } from "iconoir-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/bui/Button";
import { ValuePill } from "@/components/bui/Chip";
import EmptyState from "@/components/bui/EmptyState";
import { Page, PageLoading, Section } from "@/components/bui/Page";
import RecordsTable, { type RecordColumn, RecordName, RecordTag } from "@/components/bui/RecordsTable";
import { ErrorNote } from "@/components/pikit/error-note";
import { Markdown } from "@/components/pikit/markdown";
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
import { post, useApi } from "@/lib/api";
import { formatAgo } from "@/lib/format";
import { Link } from "@/lib/router";
import { BASE, BranchName, CARD, ChecksLabel, StateLabel } from "./labels";
import type { ApproveBody, ApproveResponse, ProposalCheck, ProposalDetail, ProposalFile, RejectBody, RejectResponse } from "./types";

const CHECK_TONE = { passing: "green", failing: "red", pending: "orange", skipped: "neutral" } as const;
/** Up to this many files, and this many lines changed in all, every file starts open; past either, each starts folded. */
const OPEN_FILES = 3;
const OPEN_LINES = 300;

const linkClass = "inline-flex items-center gap-1 underline decoration-line-strong underline-offset-2 hover:text-ink";

/** A line of a unified diff, coloured by what it is. */
function lineClass(line: string): string {
  if (line.startsWith("@@")) return "bg-inset text-ink-3";
  if (line.startsWith("+")) return "bg-green-tint text-ink";
  if (line.startsWith("-")) return "bg-red-tint text-ink";
  return "text-ink-2";
}

/** `+12 -3`, in their colours. */
function Delta({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[12px]">
      <span className="text-green">+{additions}</span>
      <span className="text-red">-{deletions}</span>
    </span>
  );
}

/** A changed file: its header (folder quiet, name in bold) opens and folds its diff, drawn only while open. */
function FileDiff({ file, open, onToggle }: { file: ProposalFile; open: boolean; onToggle: () => void }) {
  const slash = file.path.lastIndexOf("/");
  const lines = open ? (file.patch?.split("\n") ?? []) : [];
  return (
    <div className={CARD}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={`flex h-11 w-full cursor-pointer items-center gap-2 px-4 text-left text-[12.5px] transition-colors hover:bg-hover ${open ? "border-b border-line" : ""}`}
      >
        <NavArrowRight width={14} height={14} strokeWidth={2} className={`shrink-0 text-ink-3 transition-transform duration-150 ${open ? "rotate-90" : ""}`} aria-hidden />
        <span className="min-w-0 truncate font-mono" title={file.previousPath !== undefined ? `${file.previousPath} → ${file.path}` : file.path}>
          {file.previousPath !== undefined && <span className="text-ink-3">{file.previousPath} → </span>}
          <span className="text-ink-3">{file.path.slice(0, slash + 1)}</span>
          <span className="font-semibold text-ink">{file.path.slice(slash + 1)}</span>
        </span>
        <RecordTag>{file.status}</RecordTag>
        <span className="ml-auto" />
        <Delta additions={file.additions} deletions={file.deletions} />
      </button>
      {open &&
        (file.patch === undefined ? (
          <p className="px-4 py-3 text-[12.5px] text-ink-3">{file.truncated ? "Not shown: the diff is too large for this page." : "No diff to show: a binary file."}</p>
        ) : (
          <div className="overflow-x-auto py-2 font-mono text-[12px] leading-[1.6]">
            {lines.map((line, i) => (
              <div key={i} className={`min-w-max px-4 whitespace-pre ${lineClass(line)}`}>
                {line === "" ? " " : line}
              </div>
            ))}
            {file.truncated && <div className="px-4 pt-2 font-sans text-[12.5px] text-ink-3">Cut here: the rest is too large for this page.</div>}
          </div>
        ))}
    </div>
  );
}

/** One part of the details at the side: a quiet label over its value. */
function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-4 py-3">
      <dt className="text-[11.5px] font-medium text-ink-3">{label}</dt>
      <dd className="flex min-w-0 flex-col gap-1 text-[13px] text-ink">{children}</dd>
    </div>
  );
}

/** Where a link goes, by its host (`github.com`); the link's own words when it is not a URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "Open";
  }
}

/** When, relative, with the exact time as its tooltip. */
function When({ at }: { at: string }) {
  const time = Date.parse(at);
  return <span title={new Date(time).toLocaleString()}>{formatAgo(time)}</span>;
}

/** The proposal's details, by part: its state, who proposes it, its branch, its changes, when, and links. */
function Details({ data }: { data: ProposalDetail }) {
  return (
    <dl className={`${CARD} divide-y divide-line`}>
      <Detail label="State">
        <StateLabel state={data.state} draft={data.draft} />
      </Detail>
      <Detail label="Proposed by">
        <span className="min-w-0 truncate" title={data.author}>
          {data.author}
        </span>
      </Detail>
      <Detail label="Branch">
        <span className="flex min-w-0 items-start gap-1.5">
          <GitBranch width={14} height={14} className="mt-px shrink-0 text-ink-3" aria-hidden />
          <BranchName wrap>{data.branch}</BranchName>
        </span>
        <span className="flex min-w-0 items-start gap-1.5 text-ink-3">
          <span className="w-3.5 shrink-0 text-center">→</span>
          <span className="shrink-0 text-[12.5px]">into</span>
          <BranchName wrap>{data.base}</BranchName>
        </span>
      </Detail>
      <Detail label="Changes">
        <span className="flex items-center gap-2">
          <Delta additions={data.additions} deletions={data.deletions} />
          <span className="text-ink-2">
            in {data.changedFiles} {data.changedFiles === 1 ? "file" : "files"}
          </span>
        </span>
      </Detail>
      <Detail label={data.closedAt !== undefined ? "Closed" : "Updated"}>
        <When at={data.closedAt ?? data.updatedAt} />
        <span className="text-[12px] text-ink-3">
          opened <When at={data.createdAt} />
        </span>
      </Detail>
      {(data.url !== undefined || data.previewUrl !== undefined) && (
        <Detail label="Links">
          {data.url !== undefined && (
            <a className={`${linkClass} self-start`} href={data.url} target="_blank" rel="noreferrer">
              {hostOf(data.url)} <OpenNewWindow width={12} height={12} />
            </a>
          )}
          {data.previewUrl !== undefined && (
            <a className={`${linkClass} self-start`} href={data.previewUrl} target="_blank" rel="noreferrer">
              Preview <OpenNewWindow width={12} height={12} />
            </a>
          )}
        </Detail>
      )}
    </dl>
  );
}

const checkColumns: RecordColumn<ProposalCheck>[] = [
  {
    key: "name",
    label: "Check",
    icon: <Activity />,
    width: 320,
    title: (check) => check.name,
    cell: (check) =>
      check.url === undefined ? (
        <RecordName>{check.name}</RecordName>
      ) : (
        <a className="records-name hover:underline" href={check.url} target="_blank" rel="noreferrer">
          {check.name}
        </a>
      ),
  },
  {
    key: "state",
    label: "State",
    icon: <Activity />,
    width: 130,
    cell: (check) => <ValuePill tone={CHECK_TONE[check.state]}>{check.state}</ValuePill>,
  },
  { key: "detail", label: "Detail", icon: <InfoCircle />, width: 300, title: (check) => check.detail, cell: (check) => check.detail },
];

type Dialog = "approve" | "reject" | undefined;

export function ProposalPage({ params }: { params: Record<string, string> }) {
  // Its own state per proposal: another proposal's page starts afresh.
  return <Proposal key={params.id} id={params.id ?? ""} />;
}

function Proposal({ id }: { id: string }) {
  const path = `${BASE}/${encodeURIComponent(id)}`;
  const { data, error, reload } = useApi<ProposalDetail>(path, every(60_000));
  const [dialog, setDialog] = useState<Dialog>();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<Error>();
  const [done, setDone] = useState<string>();
  // The files the operator opened or folded, by path; the others as they start.
  const [opened, setOpened] = useState<Record<string, boolean>>({});

  if (error !== undefined && data === undefined) {
    return (
      <Page eyebrow={`Proposal ${id}`}>
        <ErrorNote error={error} title="This proposal cannot be read" />
        <Link to={BASE} className="text-[13px] text-ink-2 underline underline-offset-2">
          Back to the proposals
        </Link>
      </Page>
    );
  }
  if (data === undefined) return <PageLoading eyebrow={`Proposal ${id}`} />;

  const name = data.ref ?? data.id;
  const after = data.checksRun === "after-approval";
  // Checks that run after an approval are the deployer's: nothing to override.
  const passing = after || data.checks.state === "passing";
  const act = async (action: "approve" | "reject") => {
    setBusy(true);
    setActionError(undefined);
    try {
      if (action === "approve") {
        const body: ApproveBody = { head: data.head, ...(!passing && { override: true }) };
        const answer = await post<ApproveResponse>(`${path}/approve`, body);
        setDone(answer.message);
      } else {
        const body: RejectBody = comment.trim() === "" ? {} : { comment: comment.trim() };
        const answer = await post<RejectResponse>(`${path}/reject`, body);
        setDone(answer.message);
        setComment("");
      }
      reload();
    } catch (thrown) {
      setActionError(thrown instanceof Error ? thrown : new Error(String(thrown)));
      reload();
    } finally {
      setBusy(false);
    }
  };

  const checksWord = data.checks.state === "failing" ? `${data.checks.failed} failing` : data.checks.state === "pending" ? `${data.checks.pending} still running` : "none ran";
  const wrongBase = data.base !== data.defaultBranch;
  const startOpen = data.files.length <= OPEN_FILES && data.files.reduce((sum, file) => sum + file.additions + file.deletions, 0) <= OPEN_LINES;
  const isOpen = (file: ProposalFile) => opened[file.path] ?? startOpen;
  const openAll = (open: boolean) => setOpened(Object.fromEntries(data.files.map((file) => [file.path, open])));
  const allOpen = data.files.every(isOpen);

  return (
    <Page
      eyebrow={`Proposal ${name}`}
      title={data.title}
      aside={
        data.state !== "open" ? undefined : (
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setDialog("reject")}>
              <Xmark width={16} height={16} strokeWidth={2} aria-hidden />
              Reject
            </Button>
            <Button variant="primary" disabled={busy || wrongBase} onClick={() => setDialog("approve")}>
              <Check width={16} height={16} strokeWidth={2} aria-hidden />
              Approve
            </Button>
          </>
        )
      }
      description={
        <Link to={BASE} className="inline-flex items-center gap-1.5 text-ink-2 hover:text-ink">
          <ArrowLeft width={14} height={14} aria-hidden /> All proposals
        </Link>
      }
    >
      {done !== undefined && <p className="rounded-card bg-green-tint px-3 py-2.5 text-[13px] text-green">{done}</p>}
      {actionError !== undefined && <ErrorNote error={actionError} title="Not done" />}
      {error !== undefined && <ErrorNote error={error} title="Not read again" />}
      {wrongBase && (
        <p className="rounded-card bg-orange-tint px-3 py-2.5 text-[13px] text-orange">
          It merges into {data.base}, not {data.defaultBranch}, the default branch: it cannot be approved here.
        </p>
      )}
      {data.state === "open" && data.mergeable === false && (
        <p className="rounded-card bg-orange-tint px-3 py-2.5 text-[13px] text-orange">
          It cannot be merged as it is{data.mergeDetail !== undefined && ` (${data.mergeDetail})`}: ask the agent to bring it up to date.
        </p>
      )}
      {data.state === "open" && data.mergeable !== false && data.mergeDetail !== undefined && (
        <p className="rounded-card bg-inset px-3 py-2.5 text-[13px] text-ink-2">Merging: {data.mergeDetail}.</p>
      )}
      {data.deploy !== undefined && (
        <p className={`rounded-card px-3 py-2.5 text-[13px] ${data.deploy.outcome === "deployed" ? "bg-green-tint text-green" : data.deploy.outcome === "rolled back" || data.deploy.outcome === "failed" ? "bg-red-tint text-red" : "bg-orange-tint text-orange"}`}>
          Deploy: {data.deploy.outcome}, {formatAgo(Date.parse(data.deploy.at))}. {data.deploy.message}
        </p>
      )}

      <div className="grid items-start gap-x-8 gap-y-10 lg:grid-cols-[minmax(0,1fr)_272px]">
        <aside aria-label="Details" className="min-w-0 lg:sticky lg:top-6 lg:order-2">
          <Section title="Details">
            <Details data={data} />
          </Section>
        </aside>

        <div className="flex min-w-0 flex-col gap-10 lg:order-1">
          <Section title="Description" meta="the agent's">
            <div className={`${CARD} px-5 py-4 text-[14px] leading-relaxed`}>
              {data.body.trim() === "" ? <span className="text-ink-3">No description.</span> : <Markdown text={data.body} />}
            </div>
          </Section>

          <Section title="Checks" meta={<ChecksLabel checks={data.checks} />}>
            <RecordsTable
              label="The checks of the proposal's head commit"
              columns={checkColumns}
              rows={data.checks.items}
              rowKey={(check) => `${check.name}#${check.url ?? ""}#${check.detail}`}
              empty={
                <EmptyState
                  icon={<Activity />}
                  title="No check ran"
                  hint={after ? "The deployer runs the checks once you approve it, before it deploys: install, typecheck, tests." : "The project's workflow (.github/workflows/pikit-checks.yml) runs on every pull request."}
                />
              }
            />
          </Section>

          <Section
            title="Changes"
            meta={data.files.length < data.changedFiles ? `the first ${data.files.length} of ${data.changedFiles} files` : `${data.changedFiles} ${data.changedFiles === 1 ? "file" : "files"}`}
            tools={
              data.files.length < 2 ? undefined : (
                <Button size="xs" variant="quiet" onClick={() => openAll(!allOpen)}>
                  {allOpen ? <Collapse width={13} height={13} aria-hidden /> : <Expand width={13} height={13} aria-hidden />}
                  {allOpen ? "Fold all" : "Open all"}
                </Button>
              )
            }
          >
            {data.files.length === 0 ? (
              <div className={CARD}>
                <EmptyState icon={<GitPullRequest />} title="No file changed" />
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {data.files.map((file) => (
                  <FileDiff key={file.path} file={file} open={isOpen(file)} onToggle={() => setOpened((now) => ({ ...now, [file.path]: !isOpen(file) }))} />
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>

      <AlertDialog open={dialog === "approve"} onOpenChange={(open) => !open && setDialog(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{passing ? `Approve ${name}?` : `Approve ${name} anyway?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {after
                ? `The deployer merges it into ${data.base}, runs the checks, rebuilds and restarts the app, and rolls back if it is unhealthy.`
                : passing
                  ? `It is merged into ${data.base}, and the deploy follows.`
                  : `Its checks did not pass (${checksWord}). Merged into ${data.base} as it is, it deploys untested: approve it only if you read the change.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={passing ? undefined : "bg-red text-white hover:bg-red/90"} onClick={() => void act("approve")}>
              {after ? "Approve" : passing ? "Approve and merge" : "Approve anyway"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={dialog === "reject"} onOpenChange={(open) => !open && setDialog(undefined)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject {name}?</AlertDialogTitle>
            <AlertDialogDescription>It is closed, never deployed. A comment, if you write one, is kept with it for the agent to read.</AlertDialogDescription>
          </AlertDialogHeader>
          <textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            maxLength={10_000}
            rows={3}
            placeholder="Why (optional)"
            aria-label="A comment for the agent (optional)"
            className="w-full resize-y rounded-lg bg-field px-3 py-2 text-[13px] text-ink shadow-[var(--shadow-hairline)] outline-none placeholder:text-ink-3"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red text-white hover:bg-red/90" onClick={() => void act("reject")}>
              Reject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
