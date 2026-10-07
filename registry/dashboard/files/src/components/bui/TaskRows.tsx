import { useState, type ReactNode } from "react";

/* ---------------------------------------------------------
 * TASK ROWS
 * Beautiful UI's task list, fed by real work: a running task
 * spins (and opens itself to show what it is doing), a finished
 * one is Completed or Failed, and every row expands to its
 * details and output.
 * --------------------------------------------------------- */

function SpinnerRing({ active, children }: { active?: boolean; children?: ReactNode }) {
  const size = 24,
    stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="absolute inset-0" style={active ? { animation: "spin 1.1s linear infinite" } : undefined} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        {active && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--ink-3)" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${c * 0.28} ${c * 0.72}`} />}
      </svg>
      <span className="relative text-[10.5px] font-semibold tabular-nums text-ink">{children}</span>
    </span>
  );
}

function Badge({ tone, children }: { tone: "red" | "green"; children: ReactNode }) {
  return (
    <span className={`flex size-5.5 shrink-0 items-center justify-center rounded-full text-white ${tone === "red" ? "bg-red" : "bg-green"}`} style={{ animation: "pop-in 300ms cubic-bezier(0.23,1,0.32,1) both" }}>
      {children}
    </span>
  );
}

const XIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" aria-hidden>
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);
const CheckIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

/* One detail line shown when a task row is expanded. */
export type TaskDetail = { label: string; meta: string };

/**
 * A task: `done` (green check, Completed), `failed` (red cross, Failed), `running` (spinning ring),
 * `waiting` (still ring: not started), `none` (still ring: it ended without a result).
 */
export type TaskRow = {
  key: string;
  label: string;
  amount?: string;
  status: "done" | "failed" | "running" | "waiting" | "none";
  /** shown in the ring */
  step?: number;
  details: TaskDetail[];
  /** what it returned, or is returning */
  output?: string;
};

export default function TaskRows({ rows, className }: { rows: TaskRow[]; className?: string }) {
  const [manualOpen, setManualOpen] = useState<Record<string, boolean>>({});

  const badgeFor = (row: TaskRow) => {
    if (row.status === "done") return <Badge tone="green">{CheckIcon}</Badge>;
    if (row.status === "failed") return <Badge tone="red">{XIcon}</Badge>;
    return <SpinnerRing active={row.status === "running"}>{row.step}</SpinnerRing>;
  };

  const pillFor = (row: TaskRow) => {
    if (row.status === "done") return <span className="inline-flex h-5.5 shrink-0 items-center rounded-full bg-green-tint px-2 text-[11.5px] font-medium text-green">Completed</span>;
    if (row.status === "failed") return <span className="inline-flex h-5.5 shrink-0 items-center rounded-full bg-red-tint px-2 text-[11.5px] font-medium text-red">Failed</span>;
    if (row.status === "none") return <span className="inline-flex h-5.5 shrink-0 items-center rounded-full bg-inset px-2 text-[11.5px] font-medium text-ink-2">No result</span>;
    return null;
  };

  return (
    <div className={`flex w-full flex-col gap-0 self-start overflow-hidden rounded-card bg-surface shadow-card${className ? ` ${className}` : ""}`}>
      {rows.map((row, i) => {
        const open = manualOpen[row.key] ?? row.status === "running";
        return (
          <div
            key={row.key}
            className="self-stretch overflow-hidden border-b border-line transition-[border-radius,background-color] duration-300 last:border-0 hover:bg-inset"
            style={{ animation: `fade-up 450ms cubic-bezier(0.23,1,0.32,1) ${Math.min(i, 8) * 80}ms both` }}
          >
            <button type="button" aria-expanded={open} onClick={() => setManualOpen((current) => ({ ...current, [row.key]: !open }))} className="flex h-11 w-full items-center gap-2.5 px-2.5 text-left" title={row.label}>
              <span className="flex size-6 shrink-0 items-center justify-center">{badgeFor(row)}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{row.label}</span>
              {row.amount !== undefined && <span className="shrink-0 text-[12.5px] text-ink-2 tabular-nums">{row.amount}</span>}
              {pillFor(row)}
              <span aria-hidden="true" className="-ml-2 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-300" style={{ transform: open ? "rotate(180deg)" : "rotate(0)" }}>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </span>
            </button>

            {/* dropdown detail: the same expandable grammar as the thinking trace */}
            <div className="grid transition-[grid-template-rows,opacity] duration-300" style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0, transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)" }}>
              <div className="overflow-hidden">
                <div className="mb-2.5 grid grid-cols-[24px_1fr] gap-2.5 px-2.5">
                  <span aria-hidden className="mx-auto h-full w-px bg-line" />
                  <div className="flex min-w-0 flex-col gap-1.5">
                    {row.details.map((d, j) => (
                      <div key={`${d.label}-${j}`} className="flex min-w-0 items-center justify-between gap-3" style={open ? { animation: `fade-up 300ms cubic-bezier(0.23,1,0.32,1) ${120 + j * 100}ms both` } : undefined}>
                        <span className="shrink-0 text-[12px] text-ink-2">{d.label}</span>
                        <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-3 tabular-nums" title={d.meta}>
                          {d.meta}
                        </span>
                      </div>
                    ))}
                    {row.output !== undefined && (
                      <pre className={`max-h-48 overflow-auto rounded-[6px] bg-inset px-2 py-1.5 font-mono text-[11px] leading-[1.6] whitespace-pre-wrap shadow-hairline [overflow-wrap:anywhere] ${row.status === "failed" ? "text-red" : "text-ink-2"}`}>
                        {row.output === "" ? "(no output)" : row.output}
                      </pre>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
