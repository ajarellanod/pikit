/**
 * The Tasks panel (Beautiful UI's right-hand pane): the tool calls of the conversation's runs, by run,
 * each with its status (running, completed, failed, waiting, or no result when the run ended first),
 * its arguments and its output, streaming while it runs.
 */

import { Xmark } from "iconoir-react";
import TaskRows, { type TaskRow } from "@/components/bui/TaskRows";
import { type Call, callDuration, describeCall } from "@/components/pikit/message";

const runTitle = (at: number | undefined) => (at === undefined ? "An earlier run" : `Run at ${new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);

const meta = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

function row(call: Call, index: number): TaskRow {
  const { label, chip } = describeCall(call.name, call.arguments);
  return {
    key: call.id,
    label: chip === undefined ? label : `${label} ${chip}`,
    amount: call.status === "running" ? "running" : callDuration(call),
    status: call.status,
    step: index + 1,
    details: [{ label: "tool", meta: call.name }, ...Object.entries(call.arguments).map(([key, value]) => ({ label: key, meta: meta(value) }))],
    output: call.status === "waiting" ? undefined : call.output,
  };
}

export function TasksPanel({ runs, onClose }: { runs: { key: string; at?: number; calls: Call[] }[]; onClose: () => void }) {
  return (
    <aside className="hidden w-[360px] shrink-0 flex-col overflow-hidden rounded-window border border-line bg-page lg:flex" style={{ animation: "fade-in 300ms ease both" }}>
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-line px-3 sm:pl-4">
        <span className="text-[13px] font-semibold text-ink">Tasks</span>
        <div className="flex items-center gap-0.5 text-ink-3">
          <button type="button" aria-label="Close the tasks" onClick={onClose} className="flex size-6 items-center justify-center rounded-[6px] transition-colors duration-100 hover:bg-hover hover:text-ink">
            <Xmark width={15} height={15} strokeWidth={2} />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-6">
          {[...runs].reverse().map((run) => (
            <section key={run.key} className="flex flex-col gap-2" style={{ animation: "fade-up 400ms cubic-bezier(0.23,1,0.32,1) both" }}>
              <div className="flex items-center gap-2 px-0.5">
                <span className="text-[13px] font-semibold text-ink">{runTitle(run.at)}</span>
                <span className="rounded-[6px] px-1.5 text-[11.5px] font-medium tabular-nums text-ink-2 shadow-hairline">{run.calls.length}</span>
              </div>
              <TaskRows rows={run.calls.map(row)} />
            </section>
          ))}
        </div>
      </div>
    </aside>
  );
}
