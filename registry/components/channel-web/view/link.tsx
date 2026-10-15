/**
 * A link the operator hands over (an invitation, a password reset), shown once: it lives in this
 * dialog's state only, and goes when the dialog closes. The API never gives it again.
 */

import { Check, Copy } from "iconoir-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/bui/Button";
import { FieldLabel } from "@/components/bui/Field";
import { formatAgo } from "@/lib/format";
import type { AdminChatLink } from "./admin-api";

/** Its label, the link on one line, a copy button, and one line on what became of it: emailed or not, until when it works. */
export function LinkShown({ link, what }: { link: AdminChatLink; what: string }) {
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  // The clipboard API is a secure context's only (a dashboard over plain http has none): then the field's text, selected.
  const copy = () => {
    const selected = () => {
      field.current?.select();
      if (document.execCommand("copy")) setCopied(true);
    };
    if (navigator.clipboard === undefined) selected();
    else navigator.clipboard.writeText(link.link).then(() => setCopied(true), selected);
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <FieldLabel htmlFor={id}>{what.charAt(0).toUpperCase() + what.slice(1)}</FieldLabel>
      <div className="flex min-w-0 items-center gap-2">
        <input
          ref={field}
          id={id}
          readOnly
          value={link.link}
          onFocus={(event) => event.currentTarget.select()}
          spellCheck={false}
          className="control min-w-0 flex-1 truncate font-mono text-[12.5px]"
        />
        <Button size="sm" variant="secondary" autoFocus aria-label={`Copy the ${what}`} onClick={copy} className={`w-[92px] ${copied ? "text-green" : ""}`}>
          {copied ? <Check width={14} height={14} strokeWidth={2.2} /> : <Copy width={14} height={14} strokeWidth={1.8} />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-[12px] text-ink-3" title={new Date(link.expiresAt).toLocaleString()}>
        {link.emailed ? "Emailed to them" : "Not emailed (no email sender): send it yourself"} · Expires {formatAgo(link.expiresAt)}
      </p>
    </div>
  );
}
