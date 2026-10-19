import type { ReactNode } from "react";
import { capitalizeFirst } from "@/lib/format";

export type BadgeTone = "neutral" | "green" | "orange" | "red" | "accent";

/**
 * A small badge on the shared `.badge` classes (index.css): 18px, 12px text, a 4px radius. `neutral`
 * is quiet (an outline: a method, a channel, a value in prose); the others are tinted from their hue.
 * A state is a `StatusDot`, not a badge.
 */
export function Badge({ children, tone = "neutral", title, className = "" }: { children: ReactNode; tone?: BadgeTone; title?: string; className?: string }) {
  return (
    <span title={title} className={`badge align-middle ${tone === "neutral" ? "badge-outline" : `badge-tint badge-${tone}`} ${className}`}>
      {capitalizeFirst(children)}
    </span>
  );
}
