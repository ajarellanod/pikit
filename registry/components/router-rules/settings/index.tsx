/**
 * router-rules' section of the Settings dialog, Routing (features/settings.md, "Multi-agent"): its
 * rules, an ordered list an operator edits live. Each rule matches on a channel, a chat and a sender
 * (any it gives), and sends the message to an agent or denies it, with a reason. The config's rules are
 * the default: "Use the config's rules" takes the operator's away.
 *
 * The agents offered are the schema's (the code's agents, without a directory), else every agent of
 * `GET /admin/api/agents` (the code's and the live ones: a rule naming a live agent is checked when a
 * message matches it). The list is saved whole, with its own button; a refusal says where it is wrong.
 */

import { ArrowDown, ArrowUp, GitFork, Plus, Trash } from "iconoir-react";
import { useState } from "react";
import { Button } from "@/components/bui/Button";
import { ErrorNote } from "@/components/pikit/error-note";
import { SelectControl, SettingsHeading, storedOf } from "@/components/pikit/settings";
import { assistantName } from "@/lib/names";
import { choicesOf, defineSettings, type JsonSchema, useSettings } from "@/lib/settings";
import { useShell } from "@/lib/shell";

/** One rule, as router-rules stores it. */
type Rule = { channel?: string; conversation?: string; actor?: string; agent?: string; deny?: true; reason?: string };

/** The select's value for a deny: no agent's name (agents are kebab-case). */
const DENY = "!deny";

const input = "h-8 w-full min-w-0 rounded-control bg-surface px-2.5 text-[13px] text-ink shadow-btn outline-none transition-shadow duration-100 placeholder:text-ink-3 focus-visible:shadow-[0_0_0_1px_var(--line-strong),0_0_0_3px_var(--accent-tint)]";

/** A rule as stored: no empty match field; an agent, or a deny and its reason. */
function cleaned(rule: Rule): Rule {
  const text = (value: string | undefined) => (value === undefined || value.trim() === "" ? undefined : value.trim());
  const channel = text(rule.channel);
  const conversation = text(rule.conversation);
  const actor = text(rule.actor);
  const reason = text(rule.reason);
  return {
    ...(channel !== undefined && { channel }),
    ...(conversation !== undefined && { conversation }),
    ...(actor !== undefined && { actor }),
    ...(rule.deny === true ? { deny: true as const, ...(reason !== undefined && { reason }) } : { agent: rule.agent ?? "" }),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function Field({ label, value, placeholder, onChange }: { label: string; value: string | undefined; placeholder: string; onChange: (value: string) => void }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-[12px] text-ink-3">{label}</span>
      <input aria-label={label} value={value ?? ""} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className={input} />
    </label>
  );
}

function RoutingSettings() {
  const routing = useSettings("router-rules");
  const { agents } = useShell();
  const [draft, setDraft] = useState<Rule[]>();
  const [failed, setFailed] = useState<Error>();

  if (routing.error !== undefined && routing.section === undefined) return <ErrorNote error={routing.error} title="The routing rules cannot be read" />;
  const section = routing.section;
  if (section === undefined) return <p className="text-[13px] text-ink-3">Loading</p>;
  const saved = (section.value.rules ?? []) as Rule[];
  const defaults = (section.defaults.rules ?? []) as Rule[];
  const rules = draft ?? saved;
  const changed = draft !== undefined && !same(draft.map(cleaned), saved);
  const agentSchema = ((section.schema.properties?.rules?.items?.anyOf as JsonSchema[] | undefined)?.[0]?.properties?.agent ?? undefined) as JsonSchema | undefined;
  const names = choicesOf(agentSchema) ?? (agents ?? []).map((agent) => agent.name);
  const incomplete = rules.some((rule) => rule.deny !== true && (rule.agent === undefined || rule.agent === ""));

  const edit = (index: number, patch: Partial<Rule>) => setDraft(rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)));
  const move = (index: number, by: number) => {
    const next = [...rules];
    const [rule] = next.splice(index, 1);
    if (rule !== undefined) next.splice(index + by, 0, rule);
    setDraft(next);
  };
  const save = (next: Rule[]) => {
    setFailed(undefined);
    routing
      .save(storedOf({ rules: next }, section.defaults))
      .then(() => setDraft(undefined))
      .catch((thrown: unknown) => setFailed(thrown instanceof Error ? thrown : new Error(String(thrown))));
  };

  return (
    <div>
      {failed !== undefined && (
        <div className="mb-4">
          <ErrorNote error={failed} title="Not saved" />
        </div>
      )}
      <p className="mb-4 text-[13px] leading-snug text-ink-3">
        In order: the first rule a message matches decides; a message none matches goes to the default agent (Agent). A rule gives any of a channel (telegram, or one account: telegram:support), a chat and a sender; empty matches any. A rule
        applies to new conversations: an existing one keeps its agent until /new.
      </p>
      <SettingsHeading
        aside={
          !same(saved, defaults) &&
          draft === undefined && (
            <Button size="sm" variant="quiet" disabled={routing.saving} onClick={() => save(defaults)}>
              Use the config's rules
            </Button>
          )
        }
      >
        {same(saved, defaults) ? "Rules (the config's)" : "Rules (changed from the dashboard)"}
      </SettingsHeading>
      {rules.length === 0 && <p className="py-3 text-[13px] text-ink-3">No rules: every message goes to the default agent.</p>}
      <ol className="flex flex-col gap-2">
        {rules.map((rule, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rules have no identity but their place
          <li key={index} className="rounded-card bg-canvas px-3 py-3 shadow-btn">
            <div className="flex items-end gap-2">
              <span className="w-5 shrink-0 pb-2 text-[12.5px] text-ink-3 tabular-nums">{index + 1}.</span>
              <Field label="Channel" value={rule.channel} placeholder="any" onChange={(channel) => edit(index, { channel })} />
              <Field label="Chat" value={rule.conversation} placeholder="any" onChange={(conversation) => edit(index, { conversation })} />
              <Field label="Sender" value={rule.actor} placeholder="anyone" onChange={(actor) => edit(index, { actor })} />
            </div>
            <div className="mt-2 flex items-center gap-2 pl-7">
              <span className="text-[13px] text-ink-2">Goes to</span>
              <SelectControl
                label={`Rule ${index + 1}: goes to`}
                value={rule.deny === true ? DENY : (rule.agent ?? "")}
                options={[
                  ...(rule.deny !== true && (rule.agent === undefined || rule.agent === "") ? [{ value: "", label: "Choose an agent" }] : []),
                  ...[...new Set([...names, ...(rule.agent !== undefined && rule.agent !== "" ? [rule.agent] : [])])].map((name) => ({
                    value: name,
                    label: names.includes(name) ? assistantName(name) : `${assistantName(name)} (no agent now)`,
                  })),
                  { value: DENY, label: "Nobody: deny" },
                ]}
                onChange={(value) => edit(index, value === DENY ? { deny: true, agent: undefined } : { agent: value, deny: undefined, reason: undefined })}
              />
              {rule.deny === true && (
                <input aria-label={`Rule ${index + 1}: reason`} value={rule.reason ?? ""} placeholder="Why (optional)" maxLength={500} onChange={(event) => edit(index, { reason: event.target.value })} className={`${input} flex-1`} />
              )}
              <div className="ml-auto flex gap-0.5">
                <Button size="xs" variant="quiet" aria-label={`Move rule ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                  <ArrowUp width={14} height={14} strokeWidth={1.8} />
                </Button>
                <Button size="xs" variant="quiet" aria-label={`Move rule ${index + 1} down`} disabled={index === rules.length - 1} onClick={() => move(index, 1)}>
                  <ArrowDown width={14} height={14} strokeWidth={1.8} />
                </Button>
                <Button size="xs" variant="quiet" aria-label={`Remove rule ${index + 1}`} onClick={() => setDraft(rules.filter((_, at) => at !== index))}>
                  <Trash width={14} height={14} strokeWidth={1.8} />
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => setDraft([...rules, { agent: "" }])}>
          <Plus width={14} height={14} strokeWidth={2} />
          Add a rule
        </Button>
        <span className="flex-1" />
        {changed && (
          <>
            <Button size="sm" variant="quiet" disabled={routing.saving} onClick={() => setDraft(undefined)}>
              Revert
            </Button>
            <Button size="sm" variant="primary" disabled={routing.saving || incomplete} onClick={() => save(rules.map(cleaned))}>
              Save
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export default defineSettings({
  id: "router-rules",
  title: "Routing",
  icon: GitFork,
  group: "Agents",
  order: 2,
  requires: ["settings"],
  keywords: ["routing", "rules", "channel", "chat", "sender", "deny", "block", "agent"],
  component: RoutingSettings,
});
