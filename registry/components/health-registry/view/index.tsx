/**
 * health-registry's view (SPEC §5): what is up, degraded or down in the App, why, and since when;
 * which components are essential and the grace before one makes the App `down`. It reads the
 * component's own route, `GET /admin/api/health-registry`, every few seconds.
 */

import { Activity, Clock, Cube, InfoCircle, ShieldCheck } from "iconoir-react";
import { useState } from "react";
import { ValuePill } from "@/components/bui/Chip";
import EmptyState from "@/components/bui/EmptyState";
import { FilterChips, type PillTone, StatePill } from "@/components/bui/FilterTable";
import { Page, PageLoading, Section } from "@/components/bui/Page";
import RecordsTable, { type RecordColumn, RecordMark, RecordName } from "@/components/bui/RecordsTable";
import { StatusPill } from "@/components/bui/StatusPill";
import { ErrorNote } from "@/components/pikit/error-note";
import { useApi } from "@/lib/api";
import { formatAgo } from "@/lib/format";
import { defineView } from "@/lib/views";

type Status = "up" | "degraded" | "down";

/** What the route answers (health-registry's `HealthView`). */
type HealthView = {
  status: Status;
  components: { name: string; status: Status; reason?: string; since: number; essential: boolean }[];
  essential: string[];
  /** This process's grace: longer after `down` verdicts in a row that restarts did not fix. */
  graceMs: number;
  downVerdicts: number;
  now: number;
};

type Row = HealthView["components"][number];

const TONE: Record<Status, PillTone> = { up: "green", degraded: "orange", down: "red" };
/** Worst first. */
const RANK: Record<Status, number> = { down: 0, degraded: 1, up: 2 };

function HealthPage() {
  const { data, error } = useApi<HealthView>("/health-registry", 5000);
  const [filter, setFilter] = useState<"all" | Status>("all");

  if (error !== undefined && data === undefined) {
    return (
      <Page eyebrow="Health">
        <ErrorNote error={error} title="The App's health cannot be read" />
      </Page>
    );
  }
  if (data === undefined) return <PageLoading eyebrow="Health" />;

  const count = (status: Status) => data.components.filter((component) => component.status === status).length;
  const rows = filter === "all" ? data.components : data.components.filter((component) => component.status === filter);
  const columns: RecordColumn<Row>[] = [
    {
      key: "name",
      label: "Component",
      icon: <Cube />,
      width: 260,
      sort: (a, b) => a.name.localeCompare(b.name),
      cell: (row) => (
        <>
          <RecordMark name={row.name} />
          <RecordName>{row.name}</RecordName>
          {row.essential && <ValuePill className="ml-1.5 shrink-0">essential</ValuePill>}
        </>
      ),
    },
    { key: "status", label: "Status", icon: <Activity />, width: 140, sort: (a, b) => RANK[a.status] - RANK[b.status], cell: (row) => <StatePill tone={TONE[row.status]}>{row.status}</StatePill> },
    { key: "reason", label: "Why", icon: <InfoCircle />, width: 360, muted: (row) => row.reason === undefined, title: (row) => row.reason, cell: (row) => row.reason ?? "—" },
    { key: "since", label: "Since", icon: <Clock />, width: 160, sort: (a, b) => a.since - b.since, cell: (row) => <span className="text-ink-2">{formatAgo(row.since, data.now)}</span> },
  ];

  return (
    <Page
      eyebrow="Health"
      title={`The App is ${data.status}`}
      aside={<StatusPill tone={data.status === "up" ? "green" : data.status === "degraded" ? "orange" : "red"}>{data.status}</StatusPill>}
      description={
        <>
          What each component reported last. An essential component (
          {data.essential.length === 0 ? "none is" : data.essential.map((name) => <ValuePill key={name}>{name}</ValuePill>)}) down for{" "}
          <ValuePill>{Math.round(data.graceMs / 1000)} s</ValuePill> makes the App down, and its <code className="font-mono text-[12.5px]">/health</code> fails so that the process is
          restarted; anything else down or degraded makes it degraded.
          {data.downVerdicts > 0 &&
            ` The App was found down ${data.downVerdicts} time(s) in a row and the restarts did not fix it: the grace grew, so an outage outside it restarts it less often.`}
        </>
      }
    >
      {error !== undefined && <ErrorNote error={error} title="Not read again" />}
      <Section
        title="Components"
        meta={data.components.length}
        tools={
          <FilterChips
            label="Show the components that are"
            value={filter}
            onChange={setFilter}
            filters={[
              { key: "all", label: "All", count: data.components.length },
              { key: "up", label: "Up", tone: "green", count: count("up") },
              { key: "degraded", label: "Degraded", tone: "orange", count: count("degraded") },
              { key: "down", label: "Down", tone: "red", count: count("down") },
            ]}
          />
        }
      >
        <RecordsTable
          label="The components and their health"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.name}
          initialSort={{ key: "status", dir: 1 }}
          empty={
            data.components.length === 0 ? (
              <EmptyState icon={<ShieldCheck />} title="No component has reported yet" hint="A component that reports its health shows here once it does." />
            ) : (
              <EmptyState icon={<ShieldCheck />} title={`No component is ${filter}`} hint="Pick another filter to see the others." />
            )
          }
        />
      </Section>
    </Page>
  );
}

export default defineView({
  id: "health-registry",
  title: "Health",
  icon: Activity,
  requires: ["health"],
  order: 20,
  pages: [{ path: "/health-registry", component: HealthPage, fill: true }],
});
