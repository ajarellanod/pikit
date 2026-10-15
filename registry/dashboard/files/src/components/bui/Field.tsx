import { WarningCircle } from "iconoir-react";
import { type ReactNode, useId } from "react";

/* ---------------------------------------------------------
 * FIELD
 * A label over its control (`.control-label`), a hint or
 * what is wrong under it. The label marks the field
 * required or optional (`FieldMark`, the one place that
 * says how). The control is the caller's: it gets the id,
 * the description's id and the invalid state to put on it.
 * --------------------------------------------------------- */

/** What the control of a `Field` puts on itself (its `<input>`, `<textarea>`, a wrapper's inner input). */
export type FieldControlProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  required?: true;
};

/**
 * How a label marks its field: required with a red asterisk, optional with a quiet "(optional)";
 * nothing when the form does not say. Every form reads it from here: change it here only.
 */
export function FieldMark({ required }: { required?: boolean }) {
  if (required === undefined) return null;
  if (required) {
    return (
      <span className="text-red" aria-hidden>
        *
      </span>
    );
  }
  return <span className="font-normal text-ink-3">(optional)</span>;
}

/** A field's label: `.control-label`, then its mark. */
export function FieldLabel({ htmlFor, required, children, className = "" }: { htmlFor?: string; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={`control-label inline-flex items-baseline gap-1 ${className}`}>
      {children}
      <FieldMark required={required} />
    </label>
  );
}

/** What is wrong with a field, or a form: in red, with a mark. */
export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-[12.5px] leading-[1.5] text-red" style={{ animation: "fade-in 160ms ease both" }}>
      <WarningCircle width={15} height={15} strokeWidth={1.9} className="mt-[1.5px] shrink-0" aria-hidden />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}

/**
 * A labelled field: `required` true marks it required (and sets `required` on the control), false
 * optional, absent neither. `hint` is under it until there is an `error`, which replaces it.
 */
export function Field({
  label,
  required,
  hint,
  error,
  id,
  className = "",
  children,
}: {
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  /** the control's id (one is made when absent) */
  id?: string;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}) {
  const made = useId();
  const controlId = id ?? made;
  const shown = error !== undefined && error !== null && error !== false;
  const described = shown ? `${controlId}-error` : hint !== undefined ? `${controlId}-hint` : undefined;
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <FieldLabel htmlFor={controlId} required={required}>
        {label}
      </FieldLabel>
      {children({ id: controlId, ...(described !== undefined && { "aria-describedby": described }), ...(shown && { "aria-invalid": true }), ...(required === true && { required: true }) })}
      {shown ? (
        <FieldError id={`${controlId}-error`}>{error}</FieldError>
      ) : (
        hint !== undefined && (
          <p id={`${controlId}-hint`} className="text-[12px] leading-[1.5] text-ink-3">
            {hint}
          </p>
        )
      )}
    </div>
  );
}
