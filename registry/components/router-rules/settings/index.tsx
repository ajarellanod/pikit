/**
 * router-rules' section of the Settings dialog, Routing (features/settings.md, "Multi-agent"): its
 * rules, an ordered list an operator edits live, each one read as a sentence: "Messages from [web]
 * (in chat …) (from sender …) [go to Researcher]", or "[are refused] (reason)". The last line is fixed:
 * everything else goes to the default agent (router-basic's, set in Agent). The config's rules are the
 * default: the operator's replace them whole, and "Use default" takes them away.
 *
 * The channels offered are the App's (`channel-*` components, `rules.ts`' `channelsOf`), or one typed
 * (`telegram:support`). The agents are the schema's (the code's agents, without a directory), else every
 * agent of `GET /admin/api/agents`. A rule is dragged by its handle, or moved with its arrows. What is
 * wrong shows under its rule (`problemsOf`); the list is saved whole, with its own button.
 */

import { ArrowDown, ArrowUp, GitFork, Plus, Trash, Xmark } from "iconoir-react";
import { type DragEvent, useRef, useState } from "react";
import { Button } from "@/components/bui/Button";
import { ErrorNote } from "@/components/pikit/error-note";
import { SelectControl, SettingsHeading, storedOf } from "@/components/pikit/settings";
import { Input } from "@/components/ui/input";
import { useApi } from "@/lib/api";
import { assistantName } from "@/lib/names";
import { type ApiSettingsSection, choicesOf, defineSettings, type JsonSchema, useOpenSettingsSection, useSettings } from "@/lib/settings";
import { useShell } from "@/lib/shell";
import { channelsOf, cleaned, moved, problemsOf, type Rule } from "./rules";

/** A rule being edited, and a key it keeps while it moves. */
type Row = { key: number; rule: Rule };

/** The outcome select's value for a refusal: no agent's name (agents are kebab-case). */
const DENY = "!deny";
/** The channel select's value for one typed. */
const TYPED = "!typed";

/** How a channel reads: its platform's name, and an account after it. */
const PLATFORM: Record<string, string> = { web: "Web chat", telegram: "Telegram", http: "HTTP API", googlechat: "Google Chat" };
function channelLabel(channel: string): string {
  const [kind = channel, account] = channel.split(/:(.*)/s);
  const platform = PLATFORM[kind] ?? kind;
  return account === undefined || account === "" ? platform : `${platform}: ${account}`;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isWeb = (channel: string | undefined) => channel === "web" || channel?.startsWith("web:") === true;

/** A small grip: what a rule is dragged by. */
function Grip() {
  return (
    <svg width="8" height="14" viewBox="0 0 8 14" aria-hidden="true" className="fill-current">
      {[1, 7, 13].flatMap((y) => [<circle key={`a${y}`} cx="1.5" cy={y} r="1.3" />, <circle key={`b${y}`} cx="6.5" cy={y} r="1.3" />])}
    </svg>
  );
}

/** An optional match field, shown once added: its words, its text, and × to take it away. */
function Optional({ words, value, placeholder, label, onChange, onRemove }: { words: string; value: string; placeholder: string; label: string; onChange: (value: string) => void; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[13px] text-ink-2">{words}</span>
      <Input aria-label={label} value={value} placeholder={placeholder} autoFocus={value === ""} onChange={(event) => onChange(event.target.value)} className="h-8 w-36 text-[13px]" />
      <Button size="xs" variant="quiet" aria-label={`Remove ${label.toLowerCase()}`} title="Remove" onClick={onRemove} className="w-7 px-0">
        <Xmark width={13} height={13} strokeWidth={2} />
      </Button>
    </span>
  );
}

function RoutingSettings() {
  const routing = useSettings("router-rules");
  const { agents, app } = useShell();
  const openSection = useOpenSettingsSection();
  const installed = (name: string) => app.components.some((component) => component.name === name);
  // The default agent (router-basic's setting) for the last line; channel-web's pickable assistants for the Web rules.
  const basic = useApi<ApiSettingsSection>(installed("router-basic") ? "/settings/router-basic" : null).data;
  const web = useApi<ApiSettingsSection>(installed("channel-web") ? "/settings/channel-web" : null).data;
  const [draft, setDraft] = useState<Row[]>();
  /** The rows whose channel is typed, not chosen. */
  const [typed, setTyped] = useState<ReadonlySet<number>>(new Set());
  /** The row whose handle is held (only it may be dragged), and the drag going on. */
  const [held, setHeld] = useState<number>();
  const [drag, setDrag] = useState<{ from: number; over: number }>();
  const [failed, setFailed] = useState<Error>();
  const nextKey = useRef(1_000_000);

  if (routing.error !== undefined && routing.section === undefined) return <ErrorNote error={routing.error} title="The routing rules cannot be read" />;
  const section = routing.section;
  if (section === undefined) return <p className="text-[13px] text-ink-3">Loading</p>;
  const saved = (section.value.rules ?? []) as Rule[];
  const defaults = (section.defaults.rules ?? []) as Rule[];
  const rows = draft ?? saved.map((rule, key) => ({ key, rule }));
  const rules = rows.map((row) => row.rule);
  const changed = draft !== undefined && !same(rules.map(cleaned), saved);
  const agentSchema = ((section.schema.properties?.rules?.items?.anyOf as JsonSchema[] | undefined)?.[0]?.properties?.agent ?? undefined) as JsonSchema | undefined;
  const names = choicesOf(agentSchema) ?? (agents ?? []).map((agent) => agent.name);
  const problems = problemsOf(rules, agentSchema === undefined && agents === undefined ? undefined : names);
  const blocked = problems.some((problem) => problem?.level === "error");
  const channels = [...new Set([...channelsOf(app), ...rules.flatMap((rule) => (rule.channel !== undefined && rule.channel !== "" ? [rule.channel] : []))])];
  const known = channelsOf(app);
  const defaultAgent = typeof basic?.value.defaultAgent === "string" ? basic.value.defaultAgent : undefined;
  const webPicks = Array.isArray(web?.value.agents) && web.value.agents.length > 0;

  const edit = (index: number, patch: Partial<Rule>) => setDraft(rows.map((row, at) => (at === index ? { ...row, rule: { ...row.rule, ...patch } } : row)));
  const without = (index: number, field: "conversation" | "actor") =>
    setDraft(rows.map((row, at) => (at === index ? { ...row, rule: Object.fromEntries(Object.entries(row.rule).filter(([name]) => name !== field)) as Rule } : row)));
  const move = (from: number, to: number) => from !== to && setDraft(moved(rows, from, to));
  const save = (next: Rule[]) => {
    setFailed(undefined);
    routing
      .save(storedOf({ rules: next }, section.defaults))
      .then(() => {
        setDraft(undefined);
        setTyped(new Set());
      })
      .catch((thrown: unknown) => setFailed(thrown instanceof Error ? thrown : new Error(String(thrown))));
  };
  const add = () => {
    const key = nextKey.current++;
    setDraft([...rows, { key, rule: { channel: known[0], agent: "" } }]);
  };
  const dropOn = (index: number) => (event: DragEvent) => {
    event.preventDefault();
    if (drag !== undefined) move(drag.from, index);
    setDrag(undefined);
    setHeld(undefined);
  };

  return (
    <div>
      {failed !== undefined && (
        <div className="mb-4">
          <ErrorNote error={failed} title="Not saved" />
        </div>
      )}
      <p className="mb-5 text-[13px] text-ink-3">Read from the top: the first rule a message matches picks who answers it.</p>
      <SettingsHeading
        aside={
          !same(saved, defaults) &&
          draft === undefined && (
            <Button size="sm" variant="quiet" disabled={routing.saving} onClick={() => save(defaults)}>
              Use default
            </Button>
          )
        }
      >
        Rules <span className="text-[13px] font-normal text-ink-3">{same(saved, defaults) && draft === undefined ? "(default)" : "(changed here)"}</span>
      </SettingsHeading>
      <ol className="mt-2 flex flex-col gap-2">
        {rows.map(({ key, rule }, index) => {
          const n = index + 1;
          const deny = rule.deny === true;
          const channelValue = rule.channel === undefined ? "" : typed.has(key) || !channels.includes(rule.channel) ? TYPED : rule.channel;
          const outcome = deny ? DENY : (rule.agent ?? "");
          const problem = problems[index];
          return (
            <li
              key={key}
              draggable={held === key}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", String(n));
                setDrag({ from: index, over: index });
              }}
              onDragOver={(event) => {
                if (drag === undefined) return;
                event.preventDefault();
                if (drag.over !== index) setDrag({ ...drag, over: index });
              }}
              onDrop={dropOn(index)}
              onDragEnd={() => {
                setDrag(undefined);
                setHeld(undefined);
              }}
              className={`rounded-card border bg-surface px-3 py-2.5 transition-[border-color,opacity] duration-100 ${drag?.over === index && drag.from !== index ? "border-ink-3" : "border-line"} ${drag?.from === index ? "opacity-50" : ""}`}
            >
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  aria-label={`Drag rule ${n}`}
                  title="Drag to reorder"
                  onPointerDown={() => setHeld(key)}
                  onPointerUp={() => setHeld(undefined)}
                  className="mt-2 flex h-4 w-3 shrink-0 cursor-grab items-center justify-center text-ink-3 hover:text-ink-2 active:cursor-grabbing"
                >
                  <Grip />
                </button>
                <span className="mt-[7px] w-4 shrink-0 text-right text-[12.5px] text-ink-3 tabular-nums">{n}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
                    <span className="text-[13px] text-ink-2">Messages from</span>
                    <SelectControl
                      label={`Rule ${n}: channel`}
                      value={channelValue}
                      options={[
                        { value: "", label: "any channel" },
                        ...channels.map((channel) => ({ value: channel, label: known.includes(channel) ? channelLabel(channel) : `${channelLabel(channel)} (not installed)` })),
                        { value: TYPED, label: "another, typed…" },
                      ]}
                      onChange={(value) => {
                        setTyped((current) => {
                          const next = new Set(current);
                          if (value === TYPED) next.add(key);
                          else next.delete(key);
                          return next;
                        });
                        edit(index, { channel: value === "" ? undefined : value === TYPED ? (rule.channel ?? "") : value });
                      }}
                    />
                    {channelValue === TYPED && (
                      <Input
                        aria-label={`Rule ${n}: channel, typed`}
                        aria-invalid={/\s/.test((rule.channel ?? "").trim()) ? true : undefined}
                        value={rule.channel ?? ""}
                        placeholder="telegram:support"
                        autoFocus={rule.channel === ""}
                        onChange={(event) => edit(index, { channel: event.target.value })}
                        className="h-8 w-40 text-[13px]"
                      />
                    )}
                    {rule.conversation !== undefined && (
                      <Optional words="in chat" label="Chat" value={rule.conversation} placeholder="chat id" onChange={(conversation) => edit(index, { conversation })} onRemove={() => without(index, "conversation")} />
                    )}
                    {rule.actor !== undefined && (
                      <Optional words="from sender" label="Sender" value={rule.actor} placeholder="sender id" onChange={(actor) => edit(index, { actor })} onRemove={() => without(index, "actor")} />
                    )}
                    <SelectControl
                      label={`Rule ${n}: what happens`}
                      value={outcome}
                      options={[
                        ...(outcome === "" ? [{ value: "", label: "go to… (choose)" }] : []),
                        ...[...new Set([...names, ...(rule.agent !== undefined && rule.agent !== "" ? [rule.agent] : [])])].map((name) => ({ value: name, label: `go to ${assistantName(name)}` })),
                        { value: DENY, label: "are refused" },
                      ]}
                      onChange={(value) => edit(index, value === DENY ? { deny: true, agent: undefined } : { agent: value, deny: undefined, reason: undefined })}
                    />
                    {deny && (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-[13px] text-ink-2">reason</span>
                        <Input aria-label={`Rule ${n}: reason`} value={rule.reason ?? ""} placeholder="optional, for the log" maxLength={500} onChange={(event) => edit(index, { reason: event.target.value })} className="h-8 w-48 text-[13px]" />
                      </span>
                    )}
                    {(rule.conversation === undefined || rule.actor === undefined) && (
                      <span className="inline-flex items-center">
                        {rule.conversation === undefined && (
                          <Button size="xs" variant="quiet" title="Only the messages of one chat" onClick={() => edit(index, { conversation: "" })} className="text-ink-3">
                            <Plus width={12} height={12} strokeWidth={2} />
                            chat
                          </Button>
                        )}
                        {rule.actor === undefined && (
                          <Button size="xs" variant="quiet" title="Only the messages of one sender" onClick={() => edit(index, { actor: "" })} className="text-ink-3">
                            <Plus width={12} height={12} strokeWidth={2} />
                            sender
                          </Button>
                        )}
                      </span>
                    )}
                  </div>
                  {problem !== undefined && <p className={`mt-2 text-[12.5px] ${problem.level === "error" ? "text-red" : "text-orange"}`}>{problem.text}</p>}
                  {problem === undefined && webPicks && isWeb(rule.channel) && <p className="mt-2 text-[12.5px] text-ink-3">In the web chat, an assistant a user picks wins over this rule.</p>}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button size="xs" variant="quiet" aria-label={`Move rule ${n} up`} title="Up" disabled={index === 0} onClick={() => move(index, index - 1)} className="w-7 px-0">
                    <ArrowUp width={14} height={14} strokeWidth={1.8} />
                  </Button>
                  <Button size="xs" variant="quiet" aria-label={`Move rule ${n} down`} title="Down" disabled={index === rows.length - 1} onClick={() => move(index, index + 1)} className="w-7 px-0">
                    <ArrowDown width={14} height={14} strokeWidth={1.8} />
                  </Button>
                  <Button size="xs" variant="quiet" aria-label={`Remove rule ${n}`} title="Remove" onClick={() => setDraft(rows.filter((_, at) => at !== index))} className="w-7 px-0">
                    <Trash width={14} height={14} strokeWidth={1.8} />
                  </Button>
                </div>
              </div>
            </li>
          );
        })}
        <li className="flex items-center gap-2 rounded-card border border-dashed border-line px-3 py-2.5 text-[13px] text-ink-2">
          <span className="w-3 shrink-0" />
          <span className="w-4 shrink-0" />
          <span className="min-w-0 flex-1">
            {rows.length === 0 ? "Every message goes to " : "Everything else goes to "}
            <span className="font-medium text-ink">{defaultAgent === undefined ? "the default agent" : assistantName(defaultAgent)}</span>
            {defaultAgent !== undefined && <span className="text-ink-3">, the default agent</span>}
          </span>
          {installed("router-basic") && (
            <Button size="xs" variant="quiet" onClick={() => openSection("router-basic")}>
              Change in Agent
            </Button>
          )}
        </li>
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" onClick={add}>
          <Plus width={14} height={14} strokeWidth={2} />
          Add a rule
        </Button>
        <span className="flex-1" />
        {changed && (
          <>
            <span className="text-[12.5px] text-ink-3">Applies to new conversations.</span>
            <Button
              size="sm"
              variant="quiet"
              disabled={routing.saving}
              onClick={() => {
                setDraft(undefined);
                setTyped(new Set());
              }}
            >
              Revert
            </Button>
            <Button size="sm" variant="primary" disabled={routing.saving || blocked} onClick={() => save(rules.map(cleaned))}>
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
  keywords: ["routing", "rules", "channel", "chat", "sender", "deny", "refuse", "block", "agent"],
  component: RoutingSettings,
});
