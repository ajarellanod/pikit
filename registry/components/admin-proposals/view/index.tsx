/**
 * admin-proposals' view (SPEC §6): the changes the agent proposes to itself, as pull requests from
 * `pikit/self/*`, open first with their checks, then the last merged or rejected; and a page per
 * proposal (`proposal.tsx`) to read it and approve or reject it. It reads the component's own routes,
 * `/admin/api/admin-proposals/*`, slowly: each read asks GitHub.
 */

import { Activity, Clock, GitBranch, GitPullRequest, User } from "iconoir-react";
import { useState } from "react";
import { ValuePill } from "@/components/bui/Chip";
import EmptyState from "@/components/bui/EmptyState";
import { FilterChips } from "@/components/bui/FilterTable";
import { Page, PageLoading, Section } from "@/components/bui/Page";
import RecordsTable, { type RecordColumn, RecordTag } from "@/components/bui/RecordsTable";
import { ErrorNote } from "@/components/pikit/error-note";
import { every } from "@/lib/activity";
import { useApi } from "@/lib/api";
import { formatAgo } from "@/lib/format";
import { Link, pagePath } from "@/lib/router";
import { defineView } from "@/lib/views";
import { BASE, ChecksLabel, StateLabel } from "./labels";
import { ProposalPage } from "./proposal";
import type { ProposalList, ProposalState, ProposalSummary } from "./types";

type Filter = "all" | ProposalState;

function ProposalsPage() {
  const { data, error } = useApi<ProposalList>(BASE, every(60_000));
  const [filter, setFilter] = useState<Filter>("open");

  if (error !== undefined && data === undefined) {
    return (
      <Page eyebrow="Proposals">
        <ErrorNote error={error} title="The proposals cannot be read" />
      </Page>
    );
  }
  if (data === undefined) return <PageLoading eyebrow="Proposals" />;

  const count = (state: ProposalState) => data.proposals.filter((proposal) => proposal.state === state).length;
  const rows = filter === "all" ? data.proposals : data.proposals.filter((proposal) => proposal.state === filter);
  const open = count("open");
  const time = (at: string) => Date.parse(at);

  const columns: RecordColumn<ProposalSummary>[] = [
    {
      key: "title",
      label: "Proposal",
      icon: <GitPullRequest />,
      width: 340,
      title: (row) => row.title,
      cell: (row) => (
        <>
          <span className="mr-1.5 shrink-0 font-mono text-[12px] text-ink-3">#{row.number}</span>
          <Link to={pagePath(BASE, String(row.number))} className="records-name hover:underline">
            {row.title}
          </Link>
        </>
      ),
    },
    { key: "state", label: "State", icon: <Activity />, width: 120, sort: (a, b) => a.state.localeCompare(b.state), cell: (row) => <StateLabel state={row.state} draft={row.draft} /> },
    {
      key: "checks",
      label: "Checks",
      icon: <Activity />,
      width: 150,
      muted: (row) => row.checks === undefined,
      cell: (row) => (row.checks === undefined ? "—" : <ChecksLabel checks={row.checks} />),
    },
    { key: "branch", label: "Branch", icon: <GitBranch />, width: 200, title: (row) => row.branch, cell: (row) => <RecordTag mono>{row.branch.slice(data.branchPrefix.length) || row.branch}</RecordTag> },
    { key: "author", label: "By", icon: <User />, width: 130, cell: (row) => row.author },
    {
      key: "updated",
      label: "Updated",
      icon: <Clock />,
      width: 120,
      sort: (a, b) => time(a.updatedAt) - time(b.updatedAt),
      cell: (row) => <span className="text-ink-2">{formatAgo(time(row.closedAt ?? row.updatedAt))}</span>,
    },
  ];

  return (
    <Page
      eyebrow="Proposals"
      title={open === 0 ? "Nothing waiting for you" : `${open} ${open === 1 ? "change waits" : "changes wait"} for you`}
      description={
        <>
          The changes your agent proposes to itself: pull requests from <ValuePill>{data.branchPrefix}…</ValuePill> on{" "}
          <a className="underline decoration-line-strong underline-offset-2 hover:text-ink" href={`https://github.com/${data.repository}/pulls`} target="_blank" rel="noreferrer">
            {data.repository}
          </a>
          . Open one to read its description, its diff and its checks, then approve it (merged, then deployed) or reject it (closed).
        </>
      }
    >
      {error !== undefined && <ErrorNote error={error} title="Not read again" />}
      <Section
        title="Proposals"
        meta={data.proposals.length}
        tools={
          <FilterChips
            label="Show the proposals that are"
            value={filter}
            onChange={setFilter}
            filters={[
              { key: "open", label: "Open", tone: "blue", count: open },
              { key: "merged", label: "Merged", tone: "green", count: count("merged") },
              { key: "closed", label: "Rejected", tone: "neutral", count: count("closed") },
              { key: "all", label: "All", count: data.proposals.length },
            ]}
          />
        }
      >
        <RecordsTable
          label="The agent's proposals"
          columns={columns}
          rows={rows}
          rowKey={(row) => String(row.number)}
          empty={
            data.proposals.length === 0 ? (
              <EmptyState
                icon={<GitPullRequest />}
                title="No proposal yet"
                hint={`Ask your agent for a change to itself: it proposes it as a pull request from a branch ${data.branchPrefix}…, which shows here.`}
              />
            ) : (
              <EmptyState icon={<GitPullRequest />} title={`No proposal is ${filter === "closed" ? "rejected" : filter}`} hint="Pick another filter to see the others." />
            )
          }
        />
      </Section>
    </Page>
  );
}

export default defineView({
  id: "admin-proposals",
  title: "Proposals",
  icon: GitPullRequest,
  order: 40,
  pages: [
    { path: BASE, component: ProposalsPage, fill: true },
    { path: `${BASE}/:number`, component: ProposalPage, fill: true },
  ],
});
