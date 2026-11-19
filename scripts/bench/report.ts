/**
 * The bench's table: one row per measurement, three columns per side (raw ms, objects started on the
 * path, modelled ms). The modelled figure is computed from the counts, not injected: the raw time plus
 * `modelMs` for each object started before the answer (LATENCY.md's model of production: every object
 * start 400 ms, in series). Times are medians; `p90` where a step ran many times.
 */

import { median, type ObjectStart, type SideResult, type Step } from "./scenarios.ts";

const p90 = (values: readonly number[]): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)] as number;
};
const ms = (value: number) => (Number.isNaN(value) ? "–" : value < 10 ? value.toFixed(1) : value.toFixed(0));

interface Cell {
  ms: string;
  objects: string;
  modelled: string;
}
const blank: Cell = { ms: "–", objects: "", modelled: "" };

function stepsCell(steps: readonly Step[], modelMs: number, spread = false): Cell {
  if (steps.length === 0) return blank;
  const times = steps.map((step) => step.ms);
  const counts = steps.map((step) => step.during.length);
  const modelled = steps.map((step) => step.ms + modelMs * step.during.length);
  return {
    ms: spread ? `${ms(median(times))} (p90 ${ms(p90(times))})` : ms(median(times)),
    objects: String(median(counts)),
    modelled: ms(median(modelled)),
  };
}

/** A series' total, per round, then the median of the rounds. */
function seriesCell(rounds: readonly (readonly Step[])[], modelMs: number): Cell {
  if (rounds.length === 0) return blank;
  const sum = (round: readonly Step[], value: (step: Step) => number) => round.reduce((total, step) => total + value(step), 0);
  return {
    ms: ms(median(rounds.map((round) => sum(round, (step) => step.ms)))),
    objects: String(median(rounds.map((round) => sum(round, (step) => step.during.length)))),
    modelled: ms(median(rounds.map((round) => sum(round, (step) => step.ms + modelMs * step.during.length)))),
  };
}

const plain = (value: number): Cell => ({ ms: ms(value), objects: "", modelled: "" });

/** The numeric fields the host logs on `pikit: object started` (from object composition on), medians over `starts`. */
function logged(starts: readonly ObjectStart[]): string {
  const names = [...new Set(starts.flatMap((start) => Object.keys(start.fields)))].sort();
  if (names.length === 0) return "";
  return names
    .map((name) => {
      const values = starts.map((start) => start.fields[name]).filter((value) => value !== undefined);
      const numbers = values.filter((value): value is number => typeof value === "number");
      return numbers.length === values.length ? `${name} ${ms(median(numbers))}` : `${name} ${[...new Set(values.map(String))].join("/")}`;
    })
    .join(", ");
}

/** The keys an owner's cold call started, in order (`?` for a key the bench did not name: a conversation's). */
const started = (step: Step | undefined) => (step === undefined ? "" : step.during.map((start) => start.key ?? "?").join(", "));

export function table(sides: readonly SideResult[], modelMs: number): string {
  const rows: { name: string; cells: Cell[] }[] = [];
  const row = (name: string, cell: (side: SideResult) => Cell) => rows.push({ name, cells: sides.map(cell) });

  row("0. script start (bundle evaluated, cold isolate)", (side) => plain(median(side.scriptStartMs)));
  row("0. Worker App start (first request, less a warm one)", (side) => plain(median(side.workerStartMs)));
  row("   HTTP round trip (warm ping)", (side) => plain(median(side.pingMs)));
  row("1. fresh owner key, first call (memory:space:…)", (side) => stepsCell(side.fresh.cold, modelMs, true));
  row("1. same key, second call (warm)", (side) => stepsCell(side.fresh.warm, modelMs));
  const owners = sides[0]?.owners.cold[0]?.map((step) => step.name) ?? [];
  owners.forEach((owner, index) => {
    row(`2. ${owner} cold`, (side) => stepsCell(side.owners.cold.map((round) => round[index]).filter((step): step is Step => step !== undefined), modelMs));
  });
  row("2. the owners in series, cold (total)", (side) => seriesCell(side.owners.cold, modelMs));
  row("2. the owners in series, warm (total)", (side) => seriesCell(side.owners.warm, modelMs));
  row("3. fresh conversation, owners cold", (side) => stepsCell(side.conversation.cold, modelMs));
  row("3. fresh conversation, owners warm", (side) => stepsCell(side.conversation.warm, modelMs, true));

  const header = ["Measurement", ...sides.flatMap((side) => [`${side.label} ms`, "objects", `modelled (+${modelMs}/object)`])];
  const lines = [`| ${header.join(" | ")} |`, `|${header.map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|`];
  for (const { name, cells } of rows) lines.push(`| ${[name, ...cells.flatMap((cell) => [cell.ms, cell.objects, cell.modelled])].join(" | ")} |`);

  const notes: string[] = [];
  for (const side of sides) {
    notes.push(`${side.label}: kit ${side.kit} at ${side.commit.replace(/^([0-9a-f]{12})[0-9a-f]*/, "$1")}, ${side.components} components in the object's App`);
    const fields = logged(side.fresh.cold.flatMap((step) => step.during.filter((start) => start.key?.startsWith("memory:") === true)));
    if (fields !== "") notes.push(`  1. the fresh object's start line: ${fields}`);
    side.owners.cold[0]?.forEach((step) => {
      const failed = step.ok ? "" : ` (answered ${step.code ?? "an error"})`;
      notes.push(`  2. ${step.name}: started ${started(step) || "nothing"}${failed}`);
    });
    const conversation = side.conversation.cold[0];
    if (conversation !== undefined) notes.push(`  3. cold conversation: started ${started(conversation) || "nothing"}${conversation.ok ? "" : ` (failed: ${conversation.code})`}`);
    const failures = [...side.fresh.cold, ...side.conversation.warm].filter((step) => !step.ok);
    if (failures.length > 0) notes.push(`  ${failures.length} repeated steps failed: ${[...new Set(failures.map((step) => step.code))].join(", ")}`);
  }
  return `${lines.join("\n")}\n\n${notes.join("\n")}\n`;
}
