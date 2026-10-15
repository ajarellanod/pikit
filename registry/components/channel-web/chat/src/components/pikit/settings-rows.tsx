/**
 * The rows and controls of a settings dialog (the dashboard's Settings, channel-web's chat page's): a
 * heading, a row (a label, one line saying what it does, its control on the right), and the controls:
 * a segmented choice, a select (`bui/Combobox`), a text, a prompt editor (`bui/Switch` is the switch). Everything by
 * props: no admin client (`scripts/ui-shared.ts`).
 */

import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/bui/Button";
import { Combobox, type ComboboxOption } from "@/components/bui/Combobox";

/** A heading over a few rows of a section. */
export function SettingsHeading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mt-8 mb-1 flex items-center gap-3 first:mt-0">
      <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink">{children}</h3>
      {aside}
    </div>
  );
}

/**
 * One setting: its label and what it does, its control on the right (`stacked`: below, full width;
 * `wrap`: below only on a narrow screen when both do not fit side by side).
 */
export function SettingsRow({
  label,
  description,
  children,
  stacked = false,
  wrap = false,
  htmlFor,
}: {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  stacked?: boolean;
  wrap?: boolean;
  htmlFor?: string;
}) {
  const text = (
    <div className={`min-w-0 flex-1 ${wrap ? "max-sm:basis-48" : ""}`}>
      <label htmlFor={htmlFor} className="control-label block">
        {label}
      </label>
      {description !== undefined && <p className="mt-0.5 text-[13px] leading-snug text-ink-3">{description}</p>}
    </div>
  );
  if (stacked) {
    return (
      <div className="flex flex-col gap-2.5 border-b border-line py-4 last:border-b-0">
        {text}
        {children}
      </div>
    );
  }
  return (
    <div className={`flex min-h-14 items-center gap-6 border-b border-line py-3 last:border-b-0 ${wrap ? "max-sm:flex-wrap max-sm:gap-y-2.5" : ""}`}>
      {text}
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  icon?: ComponentType<{ width?: number; height?: number; strokeWidth?: number }>;
}

/** A segmented choice: a few options side by side, the chosen one raised. An option with an icon shows only its icon. */
export function Segmented<T extends string>({ value, options, onChange, label, disabled = false }: { value: T; options: Choice<T>[]; onChange: (value: T) => void; label: string; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-(--control-h) items-center gap-0.5 rounded-control bg-field p-0.5">
      {options.map((option) => {
        const Icon = option.icon;
        const chosen = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={chosen}
            aria-label={Icon === undefined ? undefined : option.label}
            title={Icon === undefined ? undefined : option.label}
            disabled={disabled}
            onClick={() => !chosen && onChange(option.value)}
            className={`flex h-full items-center justify-center rounded-[6px] text-[13px] font-medium transition-[background-color,color,box-shadow] duration-150 disabled:opacity-50 ${Icon === undefined ? "px-3" : "w-8"} ${chosen ? "bg-surface text-ink shadow-btn" : "text-ink-2 hover:text-ink"}`}
          >
            {Icon === undefined ? option.label : <Icon width={15} height={15} strokeWidth={1.8} />}
          </button>
        );
      })}
    </div>
  );
}

/** A select: the chosen option and a chevron, its list our own (`bui/Combobox`: searchable when long). */
export function SelectControl({ value, options, onChange, label, disabled = false, id }: { value: string; options: ComboboxOption[]; onChange: (value: string) => void; label: string; disabled?: boolean; id?: string }) {
  return <Combobox value={value} options={options} onChange={onChange} label={label} disabled={disabled} {...(id !== undefined && { id })} className="max-w-72 min-w-36" />;
}

/** A one-line text, saved with Enter or when it loses focus, if it changed. */
export function TextControl({ value, onSave, label, type = "text", disabled = false, id }: { value: string; onSave: (value: string) => void; label: string; type?: "text" | "number"; disabled?: boolean; id?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onSave(draft);
  return (
    <input
      id={id}
      aria-label={label}
      type={type}
      value={draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setDraft(value);
      }}
      className="control w-56"
    />
  );
}

/**
 * A multi-line prompt: edited freely, saved with its button. `fallback` is what applies with no value
 * of its own (an agent's definition), shown as the placeholder; `onReset` goes back to it.
 */
export function PromptEditor({
  value,
  fallback,
  onSave,
  onReset,
  label,
  saving = false,
  id,
}: {
  value: string | undefined;
  fallback?: string;
  onSave: (value: string) => Promise<void> | void;
  onReset?: () => Promise<void> | void;
  label: string;
  saving?: boolean;
  id?: string;
}) {
  const shown = value ?? fallback ?? "";
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const changed = draft !== shown;
  return (
    <div className="flex flex-col gap-2">
      <textarea
        id={id}
        aria-label={label}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={8}
        spellCheck
        className="control min-h-40 w-full resize-y font-mono text-[12.5px] leading-relaxed"
      />
      <div className="flex min-h-(--control-h) items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3">{value === undefined ? "Default" : "Changed from the dashboard"}</span>
        {value !== undefined && onReset !== undefined && !changed && (
          <Button size="sm" variant="quiet" disabled={saving} onClick={() => void onReset()}>
            Use default
          </Button>
        )}
        {changed && (
          <>
            <Button size="sm" variant="quiet" disabled={saving} onClick={() => setDraft(shown)}>
              Revert
            </Button>
            <Button size="sm" variant="primary" disabled={saving} onClick={() => void onSave(draft)}>
              Save
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
