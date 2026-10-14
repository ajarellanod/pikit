/**
 * The card every signed-out screen is in, in the dashboard sign-in's look: the product's banner (a
 * field of dots, a warm light) behind a raised card with the assistant's name, a title, a line, then
 * the screen's own.
 */

import type { ReactNode } from "react";

/** Each part of the card rises in after the one before it (`sign-in-rise`; none with reduced motion). */
export const rise = (step: number) => ({ animation: `sign-in-rise 620ms cubic-bezier(0.16, 1, 0.3, 1) ${80 + step * 60}ms both` });

/** The assistant's initial in a quiet square: its avatar. */
export function AssistantBadge({ name, size = 26 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-[8px] bg-ink font-semibold text-canvas"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
    >
      {(name.trim().charAt(0) || "?").toLocaleUpperCase()}
    </span>
  );
}

export function AuthCard({ name, title, lead, children, footer }: { name: string; title: string; lead?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="relative flex min-h-svh items-center justify-center overflow-hidden bg-canvas p-4 text-ink sm:p-6">
      <div aria-hidden className="sign-in-glow pointer-events-none absolute inset-0" />
      <div aria-hidden className="sign-in-dots pointer-events-none absolute inset-0" />

      <div className="relative w-full max-w-[400px]" style={rise(0)}>
        <div className="rounded-[20px] bg-surface p-1.5 shadow-overlay">
          <div className="rounded-[15px] px-5 pt-6 pb-5 sm:px-6">
            <div className="flex items-center gap-2.5" style={rise(1)}>
              <AssistantBadge name={name} />
              <span className="min-w-0 truncate text-[19px] leading-[26px] font-semibold tracking-[-0.02em] text-ink">{name}</span>
            </div>
            <h1 className="mt-5 text-[22px] font-medium tracking-[-0.02em] text-ink" style={rise(2)}>
              {title}
            </h1>
            {lead !== undefined && (
              <div className="mt-1.5 text-[13.5px] leading-[1.55] text-ink-2" style={rise(2)}>
                {lead}
              </div>
            )}
            <div className="mt-6 flex flex-col gap-3" style={rise(3)}>
              {children}
            </div>
          </div>
        </div>
        {footer !== undefined && (
          <div className="mt-4 text-center text-[13px] text-ink-2" style={rise(4)}>
            {footer}
          </div>
        )}
      </div>
    </main>
  );
}

/** A line between two ways of signing in. */
export function Or() {
  return (
    <div className="my-1 flex items-center gap-3 text-[12px] text-ink-3" aria-hidden>
      <span className="h-px flex-1 bg-line" />
      or
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/** A link to another signed-out screen. */
export function ScreenLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a href={`#${to}`} className="font-medium text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink">
      {children}
    </a>
  );
}
