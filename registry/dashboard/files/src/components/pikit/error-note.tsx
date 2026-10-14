import { WarningCircle } from "iconoir-react";

/** An error to show: an `Error`, or an API's failure with its HTTP status (`ApiFailure` is one). */
export interface ShownError {
  message: string;
  status?: number;
}

/** An error, said plainly: with its status when it has one. */
export function ErrorNote({ error, title = "Something went wrong" }: { error: ShownError; title?: string }) {
  return (
    <div role="alert" className="flex gap-2.5 rounded-card bg-red-tint px-3 py-2.5 text-[13px]">
      <WarningCircle width={16} height={16} strokeWidth={2} className="mt-0.5 shrink-0 text-red" />
      <div className="min-w-0">
        <div className="font-medium text-red">{typeof error.status === "number" ? `${title} (${error.status})` : title}</div>
        <div className="text-ink-2 [overflow-wrap:anywhere]">{error.message}</div>
      </div>
    </div>
  );
}
