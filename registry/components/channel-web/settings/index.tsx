/**
 * channel-web's section of the Settings dialog, Web chat: who may make an account on the chat page
 * (its `signUp` setting, declared when `settings` is installed, its default the config's `signUp`):
 * only people the operator invites, also anyone whose verified email is on the allow list, or anyone.
 * Read at each sign-up, for every method (password, link, OAuth). It stores only what differs from the
 * config's value, so a value equal to it follows the config again.
 */

import { ChatLines } from "iconoir-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/bui/Button";
import { ErrorNote } from "@/components/pikit/error-note";
import { Segmented, SettingsHeading, SettingsRow, storedOf } from "@/components/pikit/settings";
import { defineSettings, useSettings } from "@/lib/settings";

type Mode = "invite" | "allowlist" | "open";
type SignUp = { mode: Mode; allow: string[] };

/** An entry of the allow list: `ana@example.com`, or `@example.com` for a whole domain (config.ts' pattern). */
const ENTRY = /^(?:[^@\s]+)?@[^@\s]+$/;
const MAX_ENTRIES = 1000;

const MODES: { value: Mode; label: string }[] = [
  { value: "invite", label: "Invited only" },
  { value: "allowlist", label: "Allow list" },
  { value: "open", label: "Anyone" },
];
const SAID: Record<Mode, string> = {
  invite: "Only the people you invite (Web users, Invite) have an account; nobody signs up alone.",
  allowlist: "The people you invite, and anyone whose verified email is on the allow list below.",
  open: "Anyone may make an account, with any sign-in method the page offers.",
};

const isSignUp = (value: unknown): value is SignUp =>
  typeof value === "object" && value !== null && typeof (value as SignUp).mode === "string" && Array.isArray((value as SignUp).allow);

/** The allow list as typed (one entry a line, or separated by commas or spaces): its entries, lowercased, once each. */
function entriesOf(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== ""))];
}

function WebChatSettings() {
  const settings = useSettings("channel-web");
  const [failed, setFailed] = useState<Error>();
  const section = settings.section;
  const current = isSignUp(section?.value.signUp) ? section.value.signUp : undefined;
  const shown = current?.allow.join("\n") ?? "";
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);

  if (settings.error !== undefined && section === undefined) return <ErrorNote error={settings.error} title="The web chat's settings cannot be read" />;
  if (section === undefined) return <p className="text-[13px] text-ink-3">Loading</p>;
  if (current === undefined) return <p className="text-[13px] text-ink-3">The web chat does not offer its sign-up setting.</p>;

  const save = (next: SignUp) => {
    setFailed(undefined);
    settings.save(storedOf({ signUp: next }, section.defaults)).catch((thrown: unknown) => setFailed(thrown instanceof Error ? thrown : new Error(String(thrown))));
  };
  const entries = entriesOf(draft);
  const wrong = entries.filter((entry) => !ENTRY.test(entry) || entry.length > 254);
  const problem = wrong.length > 0 ? `Not an email or @domain: ${wrong.slice(0, 3).join(", ")}${wrong.length > 3 ? "…" : ""}` : entries.length > MAX_ENTRIES ? `At most ${MAX_ENTRIES} entries` : undefined;
  const changed = entries.join("\n") !== current.allow.join("\n");
  const isDefault = JSON.stringify(current) === JSON.stringify(section.defaults.signUp);

  return (
    <div>
      {failed !== undefined && (
        <div className="mb-4">
          <ErrorNote error={failed} title="Not saved" />
        </div>
      )}
      <SettingsHeading
        aside={
          !isDefault &&
          isSignUp(section.defaults.signUp) && (
            <Button size="sm" variant="quiet" disabled={settings.saving} onClick={() => save(section.defaults.signUp as SignUp)}>
              Use the config's
            </Button>
          )
        }
      >
        Sign-up
      </SettingsHeading>
      <SettingsRow label="Who may make an account" description={SAID[current.mode]}>
        <Segmented label="Who may make an account" value={current.mode} options={MODES} disabled={settings.saving} onChange={(mode) => save({ ...current, mode })} />
      </SettingsRow>
      {(current.mode === "allowlist" || current.allow.length > 0) && (
        <SettingsRow
          label="Allow list"
          description={
            current.mode === "allowlist"
              ? "One a line: an address (ana@example.com), or @example.com for everyone of a domain. Their email must be verified."
              : "Read only under Allow list."
          }
          stacked
          htmlFor="settings-channel-web-allow"
        >
          <textarea
            id="settings-channel-web-allow"
            aria-label="Allow list"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={5}
            spellCheck={false}
            placeholder={"ana@example.com\n@example.com"}
            className="min-h-28 w-full resize-y rounded-card bg-surface px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-ink shadow-btn outline-none transition-shadow duration-100 focus-visible:shadow-[0_0_0_1px_var(--line-strong),0_0_0_3px_var(--accent-tint)]"
          />
          <div className="flex min-h-[27px] items-center gap-2">
            <span className={`min-w-0 flex-1 truncate text-[12.5px] ${problem === undefined ? "text-ink-3" : "text-red"}`}>{problem ?? `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`}</span>
            {changed && (
              <>
                <Button size="sm" variant="quiet" disabled={settings.saving} onClick={() => setDraft(shown)}>
                  Revert
                </Button>
                <Button size="sm" variant="primary" disabled={settings.saving || problem !== undefined} onClick={() => save({ ...current, allow: entries })}>
                  Save
                </Button>
              </>
            )}
          </div>
        </SettingsRow>
      )}
    </div>
  );
}

export default defineSettings({
  id: "channel-web",
  title: "Web chat",
  icon: ChatLines,
  requires: ["settings"],
  keywords: ["sign up", "sign-up", "accounts", "invite", "allow list", "allowlist", "open", "users", "chat"],
  component: WebChatSettings,
});
