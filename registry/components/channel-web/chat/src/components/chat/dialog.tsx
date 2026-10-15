/**
 * A modal dialog in the look of the dashboard's (a raised card over a dimmed page), on the browser's
 * own `<dialog>`: focus moves into it and stays, Escape and a click outside close it, the page behind
 * is inert. `RenameDialog` and `ConfirmDialog` are the two the page needs.
 */

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/bui/Button";
import { TextField } from "./field";

export function Dialog({ open, title, description, onClose, children }: { open: boolean; title: string; description?: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => event.target === ref.current && onClose()}
      className="m-auto w-[calc(100%-2rem)] max-w-[420px] rounded-[14px] bg-surface p-0 text-ink shadow-overlay backdrop:bg-black/40"
    >
      {open && (
        <div className="flex flex-col gap-4 p-5" style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both" }}>
          <div className="flex flex-col gap-1.5">
            <h2 id={titleId} className="text-[16px] font-medium tracking-[-0.01em] text-ink">
              {title}
            </h2>
            {description !== undefined && <div className="text-[13.5px] leading-[1.55] text-ink-2">{description}</div>}
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

/** Asks for a conversation's new title (1 to `max` characters). */
export function RenameDialog({ open, title, max, onClose, onRename }: { open: boolean; title: string; max: number; onClose: () => void; onRename: (title: string) => Promise<void> }) {
  const [value, setValue] = useState(title);
  const [problem, setProblem] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValue(title);
    setProblem(undefined);
  }, [open, title]);

  const save = async () => {
    const next = value.trim();
    if (next === "" || saving) return;
    setSaving(true);
    try {
      await onRename(next);
      onClose();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} title="Rename the conversation" onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <TextField label="Title" value={value} onChange={setValue} maxLength={max} autoFocus problem={problem} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={value.trim() === "" || saving} aria-busy={saving}>
            Rename
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Asks before something that cannot be undone; `action` names the button. */
export function ConfirmDialog({
  open,
  title,
  description,
  action,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  action: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} title={title} description={description} onClose={onClose}>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} autoFocus>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {action}
        </Button>
      </div>
    </Dialog>
  );
}
