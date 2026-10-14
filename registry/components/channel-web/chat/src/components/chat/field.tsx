/**
 * A labelled field in the sign-in card's look (an inset well that lifts when focused), saying what is
 * wrong under it. A password's can be shown.
 */

import { Eye, EyeClosed, WarningCircle } from "iconoir-react";
import { type HTMLInputAutoCompleteAttribute, type ReactNode, useId, useState } from "react";

export function TextField({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  autoFocus = false,
  required = false,
  minLength,
  maxLength,
  placeholder,
  help,
  problem,
  disabled = false,
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "password";
  autoComplete?: HTMLInputAutoCompleteAttribute;
  autoFocus?: boolean;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
  help?: ReactNode;
  problem?: string;
  disabled?: boolean;
  /** Shown, not to be changed (an email a link names). */
  readOnly?: boolean;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const described = problem !== undefined ? `${id}-problem` : help !== undefined ? `${id}-help` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[12.5px] font-medium text-ink-2">
        {label}
      </label>
      <div
        className={`flex h-11 items-center gap-2 rounded-[12px] bg-inset pr-1.5 pl-3 shadow-inset-field ring-1 transition-[box-shadow,background-color] duration-150 focus-within:bg-surface focus-within:ring-2 ${problem === undefined ? "ring-line focus-within:ring-line-strong" : "ring-red/50 focus-within:ring-red/60"}`}
      >
        <input
          id={id}
          type={type === "password" && shown ? "text" : type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          required={required}
          minLength={minLength}
          maxLength={maxLength}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          spellCheck={false}
          aria-invalid={problem !== undefined}
          aria-describedby={described}
          className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3 disabled:opacity-60 read-only:text-ink-2"
        />
        {type === "password" && (
          <button
            type="button"
            aria-label={shown ? "Hide the password" : "Show the password"}
            aria-pressed={shown}
            onClick={() => setShown((current) => !current)}
            className="flex size-8 shrink-0 items-center justify-center rounded-[8px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"
          >
            {shown ? <EyeClosed width={16} height={16} strokeWidth={1.9} /> : <Eye width={16} height={16} strokeWidth={1.9} />}
          </button>
        )}
      </div>
      {problem !== undefined ? (
        <p id={`${id}-problem`} role="alert" className="flex items-start gap-1.5 text-[12.5px] leading-[1.5] text-red">
          <WarningCircle width={15} height={15} strokeWidth={1.9} className="mt-[1.5px] shrink-0" aria-hidden />
          {problem}
        </p>
      ) : (
        help !== undefined && (
          <p id={`${id}-help`} className="text-[12px] leading-[1.5] text-ink-3">
            {help}
          </p>
        )
      )}
    </div>
  );
}

/** A form's own problem (not one field's), or what happened: in red, or quiet. */
export function FormNote({ tone = "problem", children }: { tone?: "problem" | "done"; children: ReactNode }) {
  return tone === "problem" ? (
    <p role="alert" className="flex items-start gap-1.5 text-[12.5px] leading-[1.5] text-red" style={{ animation: "fade-in 160ms ease both" }}>
      <WarningCircle width={15} height={15} strokeWidth={1.9} className="mt-[1.5px] shrink-0" aria-hidden />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  ) : (
    <p role="status" className="rounded-[10px] bg-green-tint px-3 py-2 text-[12.5px] leading-[1.5] text-green" style={{ animation: "fade-in 160ms ease both" }}>
      {children}
    </p>
  );
}

/** A submit button that shows its progress. */
export function Spinner() {
  return <span className="size-3.5 rounded-full border-[1.5px] border-current border-t-transparent" style={{ animation: "spin 700ms linear infinite" }} aria-hidden />;
}
