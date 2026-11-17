/**
 * The project page's small pieces: a person's avatar (initials, never an image from elsewhere: the
 * page's CSP is same origin), who changed something and from where, a change with its Undo, a card, a
 * text area on the shared `.control` look, the core documents' token meter, and a hook that runs an
 * action and keeps its error.
 */

import { Undo } from "iconoir-react";
import { type ReactNode, useCallback, useState } from "react";
import { Button } from "@/components/bui/Button";
import { Field } from "@/components/bui/Field";
import type { ChatAuthor, ChatChange } from "@/lib/chat-api";
import { asError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { authorName, authorSource, changeSentence, chatOfKey, initialsOf, principalName } from "@/lib/project";

/** A person's (or an agent's) initials in a circle. */
export function Avatar({ name, agent = false, size = 24 }: { name: string; agent?: boolean; size?: number }) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full font-medium shadow-hairline ${agent ? "bg-accent-tint text-accent-ink" : "bg-inset text-ink-2"}`}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)) }}
    >
      {initialsOf(name)}
    </span>
  );
}

/** Who made something and from where, and when: `ana · in a chat, answering ben · 3 minutes ago` (without the name when the line around says it). */
export function AuthorLine({ by, at, me, named = true }: { by: ChatAuthor | undefined; at?: number; me: string; named?: boolean }) {
  const source = authorSource(by, me);
  const chat = by !== undefined && (by.kind === "agent" || by.kind === "person") ? chatOfKey(by.conversation) : undefined;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12px] text-ink-3">
      {named && <span className="text-ink-2">{authorName(by, me)}</span>}
      {source !== undefined &&
        (chat !== undefined && chat.userId === me ? (
          <a href={`#/c/${chat.chatId}`} className="underline decoration-line-strong underline-offset-2 hover:text-ink">
            {source}
          </a>
        ) : (
          <span>{source}</span>
        ))}
      {at !== undefined && (
        <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
          · {formatAgo(at)}
        </time>
      )}
    </span>
  );
}

/** One change of the History: who, what, from where, when, and Undo while it can be undone. */
export function ChangeRow({ change, me, onUndo }: { change: ChatChange; me: string; onUndo?: (change: ChatChange) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const name = change.by.kind === "person" ? principalName(change.by.principal) : authorName(change.by, me);
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Avatar name={name} agent={change.by.kind === "agent"} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] text-ink [overflow-wrap:anywhere]">{changeSentence(change, me)}</span>
        <AuthorLine by={change.by} at={change.at} me={me} named={false} />
      </div>
      {onUndo !== undefined && change.restorable && (
        <Button
          variant="quiet"
          size="xs"
          disabled={busy}
          aria-busy={busy}
          title="Bring back what was there before this change"
          onClick={() => {
            setBusy(true);
            onUndo(change).finally(() => setBusy(false));
          }}
        >
          <Undo width={13} height={13} strokeWidth={2} aria-hidden /> Undo
        </Button>
      )}
    </li>
  );
}

/** A card of the page. */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-card border border-line bg-surface p-4 ${className}`}>{children}</div>;
}

/** A labelled text area on the shared `.control` look. */
export function TextArea({
  label,
  value,
  onChange,
  rows = 6,
  maxLength,
  placeholder,
  hint,
  problem,
  disabled = false,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  hint?: ReactNode;
  problem?: string | undefined;
  disabled?: boolean;
  required?: boolean;
}) {
  return (
    <Field label={label} required={required} hint={hint} error={problem}>
      {(control) => (
        <textarea
          {...control}
          className="control min-h-0 w-full resize-y py-2 leading-relaxed"
          rows={rows}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

/** The core documents' tokens against their budget: a bar, and what is left. */
export function TokenMeter({ used, budget, adding = 0 }: { used: number; budget: number; adding?: number }) {
  const share = budget <= 0 ? 1 : Math.min(1, (used + adding) / budget);
  const over = used + adding > budget;
  return (
    <div className="flex flex-col gap-1.5" title="Core documents are in every request of the project's assistants, whole, within this budget">
      <div className="h-1.5 overflow-hidden rounded-full bg-inset shadow-hairline" role="meter" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={used + adding} aria-label="Core documents' tokens">
        <div className={`h-full rounded-full ${over ? "bg-red" : share > 0.85 ? "bg-orange" : "bg-ink-2"}`} style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
      <span className={`text-[12px] ${over ? "text-red" : "text-ink-3"}`}>
        {(used + adding).toLocaleString()} of {budget.toLocaleString()} tokens in context
        {over ? `: ${(used + adding - budget).toLocaleString()} too many` : `, ${(budget - used - adding).toLocaleString()} left`}
      </span>
    </div>
  );
}

/** Runs actions one at a time, keeping the last one's error to show. */
export function useAction(): { busy: boolean; error: Error | undefined; clear(): void; run(action: () => Promise<unknown>): Promise<boolean> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      return true;
    } catch (thrown) {
      setError(asError(thrown));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, clear: useCallback(() => setError(undefined), []), run };
}
