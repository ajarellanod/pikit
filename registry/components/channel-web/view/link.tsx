/**
 * A link the operator hands over (an invitation, a password reset), shown once: it lives in this
 * dialog's state only, and goes when the dialog closes. The API never gives it again.
 */

import { Check, Copy } from "iconoir-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/bui/Button";
import { formatAgo } from "@/lib/format";
import type { AdminChatLink } from "./admin-api";

/** The link, a copy button, and what became of it: emailed or not, and until when it works. */
export function LinkShown({ link, what }: { link: AdminChatLink; what: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    navigator.clipboard?.writeText(link.link).then(
      () => setCopied(true),
      () => undefined,
    );
  };
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex min-w-0 items-start gap-2 rounded-lg bg-field px-3 py-2 shadow-[var(--shadow-hairline)]">
        <code className="min-w-0 flex-1 font-mono text-[12px] leading-relaxed break-all text-ink select-all">{link.link}</code>
        <Button size="xs" variant="quiet" aria-label={`Copy the ${what}`} onClick={copy} className={copied ? "text-green" : undefined}>
          {copied ? <Check width={13} height={13} strokeWidth={2.2} /> : <Copy width={13} height={13} strokeWidth={1.8} />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-[12.5px] leading-snug text-ink-3">
        {link.emailed ? "It was also emailed to them. " : "It was not emailed (no email sender is installed): send it to them yourself. "}
        It works until {new Date(link.expiresAt).toLocaleString()} ({formatAgo(link.expiresAt)}), and is shown only now.
      </p>
    </div>
  );
}
