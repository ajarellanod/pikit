/**
 * channel-web's section of the Settings dialog, Web chat (its settings, declared when `settings` is
 * installed, their defaults the config's; each read at each request):
 * - Sign-up (`signUp`): who may make an account on the chat page: only people the operator invites,
 *   also anyone whose verified email is on the allow list, or anyone. For every method (password, link,
 *   OAuth).
 * - What users see (`visibility`): the model's thinking, the tools (none, their names, all of them),
 *   the Context panel. Applied to history too.
 * - Assistants users may pick (`agents`), for a new chat: the App's agents (`GET /admin/api/agents`),
 *   none by default (the router decides).
 * It stores only what differs from the config's values, so a value equal to one follows the config again.
 */

import { ChatLines } from "iconoir-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/bui/Button";
import { Switch } from "@/components/bui/Switch";
import { ErrorNote } from "@/components/pikit/error-note";
import { Segmented, SettingsHeading, SettingsRow, storedOf } from "@/components/pikit/settings";
import { defineSettings, useSettings } from "@/lib/settings";
import { useShell } from "@/lib/shell";

type Mode = "invite" | "allowlist" | "open";
type SignUp = { mode: Mode; allow: string[] };
type Tools = "none" | "names" | "full";
type Visibility = { thinking: boolean; tools: Tools; context: boolean };

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

const TOOLS: { value: Tools; label: string }[] = [
  { value: "none", label: "None" },
  { value: "names", label: "Names" },
  { value: "full", label: "Full" },
];
const TOOLS_SAID: Record<Tools, string> = {
  none: "Users see no tool at all.",
  names: "Users see which tool runs, never its arguments or its result.",
  full: "Users see each tool's arguments, output and result.",
};

const isVisibility = (value: unknown): value is Visibility =>
  typeof value === "object" && value !== null && typeof (value as Visibility).thinking === "boolean" && typeof (value as Visibility).tools === "string" && typeof (value as Visibility).context === "boolean";
const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every((each) => typeof each === "string");

const isSignUp = (value: unknown): value is SignUp =>
  typeof value === "object" && value !== null && typeof (value as SignUp).mode === "string" && Array.isArray((value as SignUp).allow);

/** The allow list as typed (one entry a line, or separated by commas or spaces): its entries, lowercased, once each. */
function entriesOf(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== ""))];
}

function WebChatSettings() {
  const settings = useSettings("channel-web");
  const { agents } = useShell();
  const [failed, setFailed] = useState<Error>();
  const section = settings.section;
  const current = isSignUp(section?.value.signUp) ? section.value.signUp : undefined;
  const visibility = isVisibility(section?.value.visibility) ? section.value.visibility : undefined;
  const picked = isNames(section?.value.agents) ? section.value.agents : [];
  const shown = current?.allow.join("\n") ?? "";
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);

  if (settings.error !== undefined && section === undefined) return <ErrorNote error={settings.error} title="The web chat's settings cannot be read" />;
  if (section === undefined) return <p className="text-[13px] text-ink-3">Loading</p>;
  if (current === undefined) return <p className="text-[13px] text-ink-3">The web chat does not offer its sign-up setting.</p>;

  /** Saves `change` over the current values, only what differs from the config's. */
  const store = (change: Record<string, unknown>) => {
    setFailed(undefined);
    settings.save(storedOf({ ...section.value, ...change }, section.defaults)).catch((thrown: unknown) => setFailed(thrown instanceof Error ? thrown : new Error(String(thrown))));
  };
  const save = (next: SignUp) => store({ signUp: next });
  const see = (change: Partial<Visibility>) => visibility !== undefined && store({ visibility: { ...visibility, ...change } });
  // The App's agents, then any picked that is no agent now (kept until taken away).
  const choices = [...(agents ?? []).map((agent) => ({ name: agent.name, description: agent.description })), ...picked.filter((name) => !(agents ?? []).some((agent) => agent.name === name)).map((name) => ({ name, description: "No agent now: users do not see it." }))];
  const pick = (name: string, on: boolean) => store({ agents: on ? [...picked, name] : picked.filter((each) => each !== name) });
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
              Use default
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
            className="control min-h-28 w-full resize-y font-mono text-[12.5px] leading-relaxed"
          />
          <div className="flex min-h-(--control-h) items-center gap-2">
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
      {visibility !== undefined && (
        <>
          <SettingsHeading
            aside={
              JSON.stringify(visibility) !== JSON.stringify(section.defaults.visibility) &&
              isVisibility(section.defaults.visibility) && (
                <Button size="sm" variant="quiet" disabled={settings.saving} onClick={() => store({ visibility: section.defaults.visibility })}>
                  Use default
                </Button>
              )
            }
          >
            What users see
          </SettingsHeading>
          <SettingsRow label="Thinking" description={visibility.thinking ? "Users read the model's thinking." : "The model's thinking stays hidden."}>
            <Switch checked={visibility.thinking} label="Thinking" onChange={(thinking) => see({ thinking })} />
          </SettingsRow>
          <SettingsRow label="Tools" description={TOOLS_SAID[visibility.tools]} wrap>
            <Segmented label="Tools" value={visibility.tools} options={TOOLS} disabled={settings.saving} onChange={(tools) => see({ tools })} />
          </SettingsRow>
          <SettingsRow
            label="Context"
            description={visibility.context ? (visibility.tools === "full" ? "The Context panel: the images sent, what searches and fetches found." : "The Context panel: the images sent (sources need Tools: Full).") : "No Context panel."}
          >
            <Switch checked={visibility.context} label="Context" onChange={(context) => see({ context })} />
          </SettingsRow>
        </>
      )}
      {isNames(section.value.agents) && (
        <>
          <SettingsHeading>Assistants users may pick</SettingsHeading>
          {choices.length === 0 && <p className="py-3 text-[13px] text-ink-3">{agents === undefined ? "Loading" : "No agent."}</p>}
          {choices.map((agent) => (
            <SettingsRow key={agent.name} label={agent.name} description={agent.description ?? (picked.includes(agent.name) ? "Offered for a new chat." : "Not offered.")}>
              <Switch checked={picked.includes(agent.name)} label={agent.name} onChange={(on) => pick(agent.name, on)} />
            </SettingsRow>
          ))}
          {choices.length > 0 && <p className="pt-2 text-[12.5px] text-ink-3">{picked.length === 0 ? "None picked: users get no choice, and Routing decides." : "A user's pick wins over Routing's rules."}</p>}
        </>
      )}
    </div>
  );
}

export default defineSettings({
  id: "channel-web",
  title: "Web chat",
  icon: ChatLines,
  requires: ["settings"],
  keywords: ["sign up", "sign-up", "accounts", "invite", "allow list", "allowlist", "open", "users", "chat", "visibility", "thinking", "tools", "context", "agents", "assistants"],
  component: WebChatSettings,
});
