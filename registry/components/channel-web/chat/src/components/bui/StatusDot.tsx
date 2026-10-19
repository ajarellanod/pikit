import type { ReactNode } from "react";
import { capitalizeFirst } from "@/lib/format";
import { type PillTone, TONE_DOT } from "./FilterTable";

/* ---------------------------------------------------------
 * STATUS DOT
 * A state as the filter chips show it: a small dot in the
 * state's colour, the label in ink. No fill: the colour is
 * the dot's alone. For a state in a table's cell, a page's
 * header or a settings row (up, banned, delivered…).
 * --------------------------------------------------------- */

export function StatusDot({ tone, children, title, className = "" }: { tone: PillTone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={`inline-flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap text-[13px] font-medium text-ink ${className}`}>
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: TONE_DOT[tone] }} aria-hidden />
      {capitalizeFirst(children)}
    </span>
  );
}
