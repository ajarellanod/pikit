/**
 * router-rules' section of the Settings dialog, part 1 of the Routing entry (features/settings.md,
 * "Multi-agent"): its rules, an ordered list an operator edits live. Each rule is a card that reads down:
 * "When channel is [web], and chat is […], and sender is […], then answered by [Researcher]" (or
 * "nobody, refused", with a reason). Where everything else goes is router-basic's part, drawn right
 * under the last card (its default agent): this part reads and writes only router-rules' settings. The
 * config's rules are the default: the operator's replace them whole, and "Use default" takes them away.
 *
 * The channels offered are the App's (`channel-*` components, `rules.ts`' `channelsOf`), or one typed
 * (`telegram:support`). The agents are the schema's (the code's agents, without a directory), else every
 * agent of `GET /admin/api/agents`. A rule is dragged by its number, or moved from its menu. What is
 * wrong shows in its card (`problemsOf`); the list is saved whole, from the heading, which stays at the top
 * of the panel.
 */

import { Antenna, ArrowDown, ArrowRight, ArrowUp, GitFork, InfoCircle, MultiBubble, Plus, Trash, User, WarningTriangle, Xmark } from "iconoir-react";
import { type DragEvent, type ReactNode, useRef, useState } from "react";
import { ActionsMenu } from "@/components/bui/ActionsMenu";
import { Button } from "@/components/bui/Button";
import { Combobox } from "@/components/bui/Combobox";
import { ErrorNote } from "@/components/pikit/error-note";
import { SelectControl, SettingsHeading, storedOf } from "@/components/pikit/settings";
import { Input } from "@/components/ui/input";
import { assistantName } from "@/lib/names";
import { choicesOf, defineSettings, type JsonSchema, useSettings } from "@/lib/settings";
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

/** A small grip: what a rule is dragged by (its number shows it on hover). */
function Grip() {
  return (
    <svg width="8" height="12" viewBox="0 0 8 14" aria-hidden="true" className="fill-current">
      {[1, 7, 13].flatMap((y) => [<circle key={`a${y}`} cx="1.5" cy={y} r="1.3" />, <circle key={`b${y}`} cx="6.5" cy={y} r="1.3" />])}
    </svg>
  );
}

/** The left column of a card's line: "When", "And", "Then", in small capitals. */
function Word({ children }: { children: ReactNode }) {
  return <span className="w-11 shrink-0 pt-[11px] text-[11px] font-medium tracking-[0.06em] text-ink-3 uppercase select-none">{children}</span>;
}

/**
 * One line of a rule: its word, then an inset row with the field's icon and name, "is" (`relation`),
 * its control(s), and × to take it away. The field's column is one width, so every control lines up.
 */
function Line({ word, icon, field, relation = "is", onRemove, removeLabel, children }: { word: string; icon: ReactNode; field: string; relation?: string; onRemove?: () => void; removeLabel?: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <Word>{word}</Word>
      <div className="flex min-h-10 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 rounded-control bg-inset py-1 pr-1 pl-3 shadow-hairline">
        <span className="inline-flex w-[104px] shrink-0 items-center gap-2 text-[13px] text-ink-2 [&_svg]:shrink-0 [&_svg]:text-ink-3">
          {icon}
          {field}
        </span>
        <span className={`w-3.5 shrink-0 text-[13px] text-ink-3 ${relation === "" ? "invisible" : ""}`}>{relation || "is"}</span>
        {children}
        {onRemove !== undefined && (
          <Button size="xs" variant="quiet" aria-label={removeLabel} title="Remove" onClick={onRemove} className="ml-auto w-7 px-0 text-ink-3">
            <Xmark width={13} height={13} strokeWidth={2} />
          </Button>
        )}
      </div>
    </div>
  );
}

/** A note in a rule's card: an error (red), a warning (orange), or only information. */
function Note({ tone, children }: { tone: "error" | "warning" | "info"; children: ReactNode }) {
  const colors = tone === "error" ? "bg-red-tint text-red" : tone === "warning" ? "bg-orange-tint text-orange" : "text-ink-3";
  const Icon = tone === "info" ? InfoCircle : WarningTriangle;
  return (
    <p className={`ml-[84px] flex items-start gap-2 rounded-control text-[12.5px] leading-[18px] ${tone === "info" ? "px-0.5" : "px-2.5 py-1.5"} ${colors}`}>
      <Icon width={14} height={14} strokeWidth={1.8} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** The line that links one card to the next: the rules are read down, the first that matches wins. */
function Joint() {
  return <span aria-hidden="true" className="absolute -top-3 left-[23.5px] h-3 w-px bg-line-strong" />;
}

function RoutingSettings() {
  const routing = useSettings("router-rules");
  const { agents, app } = useShell();
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
  // router-basic's part, under this one, draws where everything else goes (the App's composition, not its settings).
  const fallback = app.components.some((component) => component.name === "router-basic");

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
      {failed !== undefined && !changed && (
        <div className="mb-4">
          <ErrorNote error={failed} title="Not saved" />
        </div>
      )}
      <p className="mb-5 text-[13px] text-ink-3">Read from the top: the first rule a message matches picks who answers it.</p>
      {/*
       * The heading stays at the top of the scrolling panel while the rules scroll under it, with Save and
       * Revert while there are changes: nothing comes between the last card and router-basic's part below.
       * It sits on the panel's edge past its top padding (`-top-12`, the panel's `pt-12`) and reaches its
       * sides (`-mx-6 sm:-mx-10`), so nothing shows above or beside it.
       */}
      <div className="sticky -top-12 z-10 -mx-6 bg-page px-6 pt-3 pb-2 sm:-mx-10 sm:px-10">
        <SettingsHeading
          aside={
            <>
              {!same(saved, defaults) && draft === undefined && (
                <Button size="sm" variant="quiet" disabled={routing.saving} onClick={() => save(defaults)}>
                  Use default
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={add}>
                <Plus width={14} height={14} strokeWidth={2} />
                Add rule
              </Button>
              {changed && (
                <>
                  <Button size="sm" variant="quiet" disabled={routing.saving} onClick={() => {
                    setDraft(undefined);
                    setTyped(new Set());
                    setFailed(undefined);
                  }}>
                    Revert
                  </Button>
                  <Button size="sm" variant="primary" disabled={routing.saving || blocked} onClick={() => save(rules.map(cleaned))}>
                    Save
                  </Button>
                </>
              )}
            </>
          }
        >
          Rules <span className="text-[13px] font-normal text-ink-3">{same(saved, defaults) && draft === undefined ? "(default)" : "(changed here)"}</span>
        </SettingsHeading>
        {changed && <p className="text-right text-[12px] text-ink-3">Not saved yet. Applies to new conversations once saved.</p>}
        {changed && failed !== undefined && (
          <div className="mt-2">
            <ErrorNote error={failed} title="Not saved" />
          </div>
        )}
      </div>
      {rows.length === 0 && (
        <p className="mt-3 text-[13px] text-ink-3">{fallback ? "No rules yet: every message goes to the default agent below." : "No rules yet: add one to send a channel, a chat or a sender to an agent."}</p>
      )}
      <ol className={`flex flex-col gap-3 ${rows.length > 0 ? "mt-3" : ""}`}>
        {rows.map(({ key, rule }, index) => {
          const n = index + 1;
          const deny = rule.deny === true;
          const channelValue = rule.channel === undefined ? "" : typed.has(key) || !channels.includes(rule.channel) ? TYPED : rule.channel;
          const outcome = deny ? DENY : (rule.agent ?? "");
          const problem = problems[index];
          const target = drag?.over === index && drag.from !== index;
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
              className={`group relative flex flex-col gap-1.5 rounded-card bg-surface p-3 shadow-card transition-[outline-color,opacity] duration-100 outline-2 outline-offset-2 ${target ? "outline-ink-3" : "outline-transparent"} ${drag?.from === index ? "opacity-50" : ""}`}
            >
              {index > 0 && <Joint />}
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  aria-label={`Drag rule ${n}`}
                  title="Drag to reorder"
                  onPointerDown={() => setHeld(key)}
                  onPointerUp={() => setHeld(undefined)}
                  className="mt-2 flex size-6 shrink-0 cursor-grab items-center justify-center rounded-[7px] bg-inset text-[12px] font-medium text-ink-2 tabular-nums shadow-hairline active:cursor-grabbing"
                >
                  <span className="group-hover:hidden">{n}</span>
                  <span className="hidden text-ink-3 group-hover:block">
                    <Grip />
                  </span>
                </button>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Line word="When" icon={<Antenna width={15} height={15} strokeWidth={1.7} />} field="Channel">
                    <SelectControl
                      label={`Rule ${n}: channel`}
                      value={channelValue}
                      options={[
                        { value: "", label: "Any channel" },
                        ...channels.map((channel) => ({ value: channel, label: known.includes(channel) ? channelLabel(channel) : `${channelLabel(channel)} (not installed)` })),
                        { value: TYPED, label: "Another, typed…", description: "A channel or an account not listed: telegram:support" },
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
                  </Line>
                  {rule.conversation !== undefined && (
                    <Line word="And" icon={<MultiBubble width={15} height={15} strokeWidth={1.7} />} field="Chat" onRemove={() => without(index, "conversation")} removeLabel={`Rule ${n}: remove chat`}>
                      <Input aria-label={`Rule ${n}: chat`} value={rule.conversation} placeholder="chat id" autoFocus={rule.conversation === ""} onChange={(event) => edit(index, { conversation: event.target.value })} className="h-8 w-44 text-[13px]" />
                    </Line>
                  )}
                  {rule.actor !== undefined && (
                    <Line word="And" icon={<User width={15} height={15} strokeWidth={1.7} />} field="Sender" onRemove={() => without(index, "actor")} removeLabel={`Rule ${n}: remove sender`}>
                      <Input aria-label={`Rule ${n}: sender`} value={rule.actor} placeholder="sender id" autoFocus={rule.actor === ""} onChange={(event) => edit(index, { actor: event.target.value })} className="h-8 w-44 text-[13px]" />
                    </Line>
                  )}
                  {(rule.conversation === undefined || rule.actor === undefined) && (
                    <div className="ml-[52px] flex items-center gap-1">
                      {rule.conversation === undefined && (
                        <Button size="xs" variant="quiet" title="Only the messages of one chat" onClick={() => edit(index, { conversation: "" })} className="text-ink-3">
                          <Plus width={12} height={12} strokeWidth={2} />
                          Chat
                        </Button>
                      )}
                      {rule.actor === undefined && (
                        <Button size="xs" variant="quiet" title="Only the messages of one sender" onClick={() => edit(index, { actor: "" })} className="text-ink-3">
                          <Plus width={12} height={12} strokeWidth={2} />
                          Sender
                        </Button>
                      )}
                    </div>
                  )}
                  <Line word="Then" icon={<ArrowRight width={15} height={15} strokeWidth={1.7} />} field="Answered by" relation="">
                    <Combobox
                      label={`Rule ${n}: who answers`}
                      value={outcome}
                      placeholder="Choose an agent"
                      options={[
                        ...[...new Set([...names, ...(rule.agent !== undefined && rule.agent !== "" ? [rule.agent] : [])])].map((name) => ({ value: name, label: assistantName(name), group: "Agents" })),
                        { value: DENY, label: "Nobody: refused", description: "The channel says it cannot answer", group: "Refuse" },
                      ]}
                      onChange={(value) => edit(index, value === DENY ? { deny: true, agent: undefined } : { agent: value, deny: undefined, reason: undefined })}
                      className="max-w-72 min-w-36"
                    />
                    {deny && (
                      <Input
                        aria-label={`Rule ${n}: reason`}
                        value={rule.reason ?? ""}
                        placeholder="Reason, for the log (optional)"
                        maxLength={500}
                        onChange={(event) => edit(index, { reason: event.target.value })}
                        className="h-8 min-w-40 flex-1 text-[13px]"
                      />
                    )}
                  </Line>
                </div>
                <ActionsMenu
                  label={`Actions for rule ${n}`}
                  iconSize={15}
                  className="mt-2 flex size-6 shrink-0 items-center justify-center rounded-[7px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink aria-expanded:bg-hover-2 aria-expanded:text-ink"
                  actions={[
                    ...(index > 0 ? [{ key: "up", label: "Move up", icon: <ArrowUp />, onSelect: () => move(index, index - 1) }] : []),
                    ...(index < rows.length - 1 ? [{ key: "down", label: "Move down", icon: <ArrowDown />, onSelect: () => move(index, index + 1) }] : []),
                    { key: "remove", label: "Remove", icon: <Trash />, danger: true, onSelect: () => setDraft(rows.filter((_, at) => at !== index)) },
                  ]}
                />
              </div>
              {problem !== undefined && <Note tone={problem.level}>{problem.text}</Note>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export default defineSettings({
  id: "router-rules",
  title: "Routing",
  icon: GitFork,
  group: "Agents",
  order: 2,
  entry: "routing",
  requires: ["settings"],
  keywords: ["routing", "rules", "channel", "chat", "sender", "deny", "refuse", "block", "agent"],
  component: RoutingSettings,
});
