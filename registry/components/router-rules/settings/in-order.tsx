/**
 * The Routing section's "In order" view: the rules as they are read, each a card that reads down: "When
 * channel is [web], and chat is one of [chips…], and sender is one of […], then answered by
 * [Researcher]" (or "nobody, refused", with a reason). A rule is dragged by its number, or moved from its
 * menu; what is wrong shows in its card (`problemsOf`), a chat an earlier rule takes first in orange.
 */

import { Antenna, ArrowDown, ArrowRight, ArrowUp, MultiBubble, Plus, Trash, User, Xmark } from "iconoir-react";
import { type DragEvent, type ReactNode, useState } from "react";
import { ActionsMenu } from "@/components/bui/ActionsMenu";
import { Button } from "@/components/bui/Button";
import { Combobox } from "@/components/bui/Combobox";
import { SelectControl } from "@/components/pikit/settings";
import { Input } from "@/components/ui/input";
import { assistantName } from "@/lib/names";
import { ChipList, channelLabel, found, IdChip, named, Note } from "./parts";
import { type IdField, idsIn, moved, type Problem, type Rule } from "./rules";

/** A rule being edited, and a key it keeps while it moves. */
export type Row = { key: number; rule: Rule };

/** The outcome select's value for a refusal: no agent's name (agents are kebab-case). */
const DENY = "!deny";
/** The channel select's value for one typed. */
const TYPED = "!typed";

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
      <div className="flex min-h-10 min-w-0 flex-1 items-start gap-x-2 rounded-control bg-inset py-1 pr-1 pl-3 shadow-hairline">
        <span className="inline-flex h-8 w-[104px] shrink-0 items-center gap-2 text-[13px] text-ink-2 [&_svg]:shrink-0 [&_svg]:text-ink-3">
          {icon}
          {field}
        </span>
        <span className={`flex h-8 shrink-0 items-center text-[13px] text-ink-3 ${relation === "" ? "invisible w-3.5" : ""}`}>{relation || "is"}</span>
        <div className="flex min-h-8 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">{children}</div>
        {onRemove !== undefined && (
          <Button size="xs" variant="quiet" aria-label={removeLabel} title="Remove" onClick={onRemove} className="mt-0.5 w-7 shrink-0 px-0 text-ink-3">
            <Xmark width={13} height={13} strokeWidth={2} />
          </Button>
        )}
      </div>
    </div>
  );
}

/** The line that links one card to the next: the rules are read down, the first that matches wins. */
function Joint() {
  return <span aria-hidden="true" className="absolute -top-3 left-[23.5px] h-3 w-px bg-line-strong" />;
}

/** A list's chips and a field that takes more (typed, or several pasted at once: Enter, a comma, a space). */
function IdsField({ ids, onChange, label, placeholder, names, shadowed, query }: { ids: readonly string[]; onChange: (ids: string[]) => void; label: string; placeholder: string; names: ReadonlyMap<string, string>; shadowed: ReadonlyMap<string, number>; query: string }) {
  const [text, setText] = useState("");
  const take = (value: string) => {
    const added = idsIn(value).filter((id) => !ids.includes(id));
    if (added.length > 0) onChange([...ids, ...added]);
    setText("");
  };
  // Those an earlier rule takes first show first: never hidden behind "+N more".
  const shown = (query.trim() === "" ? ids : ids.filter((id) => found(query, id, names.get(id)))).toSorted((a, b) => Number(shadowed.has(b)) - Number(shadowed.has(a)));
  return (
    <>
      <ChipList count={shown.length} all={query.trim() !== ""}>
        {(count) =>
          shown.slice(0, count).map((id) => {
            const name = names.get(id);
            const by = shadowed.get(id);
            return (
              <IdChip
                key={id}
                id={id}
                label={`${label} ${name ?? id}`}
                {...(name !== undefined && { name })}
                {...(by !== undefined && { shadowed: `Rule ${by + 1} above takes it first: here it never matches.` })}
                onRemove={() => onChange(ids.filter((each) => each !== id))}
              />
            );
          })
        }
      </ChipList>
      <Input
        aria-label={`${label}: add`}
        aria-invalid={ids.length === 0 ? true : undefined}
        value={text}
        placeholder={ids.length === 0 ? placeholder : "Add more"}
        autoFocus={ids.length === 0}
        onChange={(event) => (/[\s,;]/.test(event.target.value) ? take(event.target.value) : setText(event.target.value))}
        onPaste={(event) => {
          event.preventDefault();
          take(text + event.clipboardData.getData("text"));
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            take(text);
          }
        }}
        onBlur={() => take(text)}
        className="h-7 w-36 min-w-24 flex-1 text-[12.5px]"
      />
    </>
  );
}

export function InOrder({
  rows,
  onChange,
  problems,
  agents,
  channels,
  known,
  names,
  query,
  typed,
  setTyped,
  fallback,
}: {
  rows: readonly Row[];
  onChange: (rows: Row[]) => void;
  problems: readonly (Problem | undefined)[];
  agents: readonly string[];
  channels: readonly string[];
  /** The App's own channels (the others are "not installed"). */
  known: readonly string[];
  names: ReadonlyMap<string, string>;
  query: string;
  /** The rows whose channel is typed, not chosen. */
  typed: ReadonlySet<number>;
  setTyped: (change: (current: ReadonlySet<number>) => ReadonlySet<number>) => void;
  /** Whether router-basic's part, under this one, takes what no rule matches. */
  fallback: boolean;
}) {
  /** The row whose handle is held (only it may be dragged), and the drag going on. */
  const [held, setHeld] = useState<number>();
  const [drag, setDrag] = useState<{ from: number; over: number }>();
  const searching = query.trim() !== "";

  const edit = (index: number, patch: Partial<Rule>) => onChange(rows.map((row, at) => (at === index ? { ...row, rule: { ...row.rule, ...patch } } : row)));
  const without = (index: number, field: IdField) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, rule: Object.fromEntries(Object.entries(row.rule).filter(([name]) => name !== field)) as Rule } : row)));
  const move = (from: number, to: number) => from !== to && onChange(moved(rows, from, to));
  const dropOn = (index: number) => (event: DragEvent) => {
    event.preventDefault();
    if (drag !== undefined) move(drag.from, index);
    setDrag(undefined);
    setHeld(undefined);
  };
  const matching = (rule: Rule) =>
    !searching || found(query, channelLabel(rule.channel), rule.channel, rule.agent, rule.agent === undefined ? undefined : assistantName(rule.agent), rule.reason) || (["conversations", "actors"] as const).some((field) => (rule[field] ?? []).some((id) => found(query, id, names.get(id))));
  const shown = rows.map((row, index) => ({ ...row, index })).filter((row) => matching(row.rule));

  return (
    <>
      {rows.length === 0 && (
        <p className="mt-3 text-[13px] text-ink-3">{fallback ? "No rules yet: every message goes to the default agent below." : "No rules yet: add one to send a channel, chats or senders to an agent."}</p>
      )}
      {searching && shown.length === 0 && <p className="mt-3 text-[13px] text-ink-3">No rule matches &ldquo;{query.trim()}&rdquo;.</p>}
      <ol className={`flex flex-col gap-3 ${shown.length > 0 ? "mt-3" : ""}`}>
        {shown.map(({ key, rule, index }, place) => {
          const n = index + 1;
          const deny = rule.deny === true;
          const channelValue = rule.channel === undefined ? "" : typed.has(key) || !channels.includes(rule.channel) ? TYPED : rule.channel;
          const outcome = deny ? DENY : (rule.agent ?? "");
          const problem = problems[index];
          const shadowedIn = (field: IdField) => new Map((problem?.shadowed ?? []).filter((each) => each.field === field).map((each) => [each.id, each.by]));
          const target = drag?.over === index && drag.from !== index;
          return (
            <li
              key={key}
              draggable={held === key && !searching}
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
              {place > 0 && !searching && <Joint />}
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  aria-label={`Drag rule ${n}`}
                  title={searching ? `Rule ${n}` : "Drag to reorder"}
                  onPointerDown={() => setHeld(key)}
                  onPointerUp={() => setHeld(undefined)}
                  className={`mt-2 flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-inset text-[12px] font-medium text-ink-2 tabular-nums shadow-hairline ${searching ? "" : "cursor-grab active:cursor-grabbing"}`}
                >
                  <span className={searching ? "" : "group-hover:hidden"}>{n}</span>
                  {!searching && (
                    <span className="hidden text-ink-3 group-hover:block">
                      <Grip />
                    </span>
                  )}
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
                  {rule.conversations !== undefined && (
                    <Line word="And" icon={<MultiBubble width={15} height={15} strokeWidth={1.7} />} field="Chat" relation="in" onRemove={() => without(index, "conversations")} removeLabel={`Rule ${n}: remove chats`}>
                      <IdsField ids={rule.conversations} onChange={(conversations) => edit(index, { conversations })} label={`Rule ${n}: chat`} placeholder="chat ids" names={names} shadowed={shadowedIn("conversations")} query={query} />
                    </Line>
                  )}
                  {rule.actors !== undefined && (
                    <Line word="And" icon={<User width={15} height={15} strokeWidth={1.7} />} field="Sender" relation="in" onRemove={() => without(index, "actors")} removeLabel={`Rule ${n}: remove senders`}>
                      <IdsField ids={rule.actors} onChange={(actors) => edit(index, { actors })} label={`Rule ${n}: sender`} placeholder="sender ids" names={names} shadowed={shadowedIn("actors")} query={query} />
                    </Line>
                  )}
                  {(rule.conversations === undefined || rule.actors === undefined) && (
                    <div className="ml-[52px] flex items-center gap-1">
                      {rule.conversations === undefined && (
                        <Button size="xs" variant="quiet" title="Only the messages of some chats" onClick={() => edit(index, { conversations: [] })} className="text-ink-3">
                          <Plus width={12} height={12} strokeWidth={2} />
                          Chats
                        </Button>
                      )}
                      {rule.actors === undefined && (
                        <Button size="xs" variant="quiet" title="Only the messages of some senders" onClick={() => edit(index, { actors: [] })} className="text-ink-3">
                          <Plus width={12} height={12} strokeWidth={2} />
                          Senders
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
                        ...[...new Set([...agents, ...(rule.agent !== undefined && rule.agent !== "" ? [rule.agent] : [])])].map((name) => ({ value: name, label: assistantName(name), group: "Agents" })),
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
                    { key: "remove", label: "Remove", icon: <Trash />, danger: true, onSelect: () => onChange(rows.filter((_, at) => at !== index)) },
                  ]}
                />
              </div>
              {problem !== undefined && (
                <Note tone={problem.level} className="ml-[84px]">
                  {named(problem, names)}
                </Note>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
