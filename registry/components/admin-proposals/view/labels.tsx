/** What the list and a proposal's page both show: a proposal's state (a dot), its checks (a pill), its branch, its cards. */

import { type PillTone, StatePill, TONE_DOT } from "@/components/bui/FilterTable";
import type { ProposalChecks, ProposalState } from "./types";

export const BASE = "/admin-proposals";

/** A card of the view, as the records table's shell draws it: a hairline border and a soft shadow. */
export const CARD = "overflow-hidden rounded-[10px] border border-line bg-surface shadow-[0_1px_2px_oklch(0_0_0/0.06)]";

export const STATE_TONE: Record<ProposalState, PillTone> = { open: "blue", approved: "orange", merged: "green", failed: "red", closed: "neutral" };
const STATE_LABEL: Record<ProposalState, string> = { open: "Open", approved: "Approved", merged: "Merged", failed: "Failed", closed: "Rejected" };
export const CHECKS_TONE: Record<ProposalChecks["state"], PillTone> = { passing: "green", failing: "red", pending: "orange", none: "neutral" };

/** A state as the view says it, with its dot as the filter chips show it: a closed proposal was rejected; an approved one waits for its deploy. */
export function StateLabel({ state, draft = false }: { state: ProposalState; draft?: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[13px] font-medium text-ink">
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: TONE_DOT[STATE_TONE[state]] }} aria-hidden />
      {STATE_LABEL[state]}
      {draft && state === "open" && <span className="font-normal text-ink-3">· draft</span>}
    </span>
  );
}

/** A branch's name, set off in bold monospace: cut to its cell, or wrapped where it has room to grow. */
export function BranchName({ children, title, wrap = false }: { children: string; title?: string; wrap?: boolean }) {
  return (
    <span className={`min-w-0 font-mono text-[12.5px] font-semibold text-ink ${wrap ? "[overflow-wrap:anywhere]" : "truncate"}`} title={title ?? children}>
      {children}
    </span>
  );
}

/** The checks in a word and a count: `passing 3/3`, `failing 1`. */
export function ChecksLabel({ checks }: { checks: ProposalChecks }) {
  const total = checks.passed + checks.failed + checks.pending;
  const figure = checks.state === "failing" ? `${checks.failed} of ${total}` : checks.state === "pending" ? `${checks.pending} of ${total}` : checks.state === "passing" ? `${checks.passed}` : "";
  return (
    <StatePill tone={CHECKS_TONE[checks.state]} title={checks.items.map((item) => `${item.name}: ${item.detail}`).join("\n") || "No check ran on this change"}>
      {checks.state === "none" ? "no checks" : checks.state}
      {figure !== "" && ` · ${figure}`}
    </StatePill>
  );
}
