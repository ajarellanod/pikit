/**
 * The Routing section's "By agent" view: one card per agent, "Trader answers in → Google Chat · 63
 * chats", its chats and senders as chips (a chat's name when the dashboard knows it), and a "Refused"
 * card for the refusals. Chats are added (several pasted at once), taken away, or moved to another
 * agent from a chip's menu; each change edits the rules (`rules.ts`' `placeIds`, `withoutId`), whose
 * order still decides: a rule's number shows on its line, a chat an earlier rule takes first is
 * orange, and a new agent's rule goes before the first rule that would take its chats first.
 */

import { Antenna, Prohibition } from "iconoir-react";
import { useState } from "react";
import { Button } from "@/components/bui/Button";
import { Combobox } from "@/components/bui/Combobox";
import { RecordMark } from "@/components/bui/RecordsTable";
import { ChannelIcon } from "@/components/pikit/party";
import { assistantName } from "@/lib/names";
import { AddIds, ChipList, channelLabel, counted, found, IdChip, idActions, named, Note } from "./parts";
import { DENIED, type Group, groupsOf, type IdField, isListOf, outcomeOf, placeIds, type Problem, type Rule, withoutId } from "./rules";

const NOUN: Record<IdField, [string, string]> = { conversations: ["chat", "chats"], actors: ["sender", "senders"] };

/** How an outcome reads: an agent's name, or "Refused". */
const outcomeLabel = (outcome: string) => (outcome === DENIED ? "Refused" : outcome === "" ? "No agent chosen" : assistantName(outcome));

/**
 * What the rule at `index` takes, said short: "Google Chat · 63 chats", "Web chat · every chat", or
 * "every other chat" when a rule above takes some of its channel's first.
 */
function takes(rules: readonly Rule[], index: number): string {
  const rule = rules[index] ?? {};
  const parts = (["conversations", "actors"] as const).flatMap((field) => (rule[field] === undefined ? [] : [counted(rule[field].length, ...NOUN[field])]));
  const before = rules.slice(0, index).some((each) => rule.channel === undefined || each.channel === undefined || each.channel === rule.channel || each.channel.startsWith(`${rule.channel}:`) || rule.channel.startsWith(`${each.channel}:`));
  return `${channelLabel(rule.channel)} · ${parts.length > 0 ? parts.join(", ") : before ? "every other chat" : "every chat"}`;
}

/** Where a change put the chats: the rule it made or added to, and the one it went before. */
type Placed = { outcome: string; at: number; before?: number };

export function ByAgent({
  rules,
  onChange,
  problems,
  agents,
  channels,
  names,
  query,
  onShowInOrder,
}: {
  rules: readonly Rule[];
  onChange: (rules: Rule[]) => void;
  problems: readonly (Problem | undefined)[];
  /** The agents a rule may name. */
  agents: readonly string[];
  /** The App's channels, then the rules' own. */
  channels: readonly string[];
  /** Chats' names, by id. */
  names: ReadonlyMap<string, string>;
  query: string;
  /** Opens the "In order" view (where a rule's place is changed). */
  onShowInOrder: () => void;
}) {
  const [placed, setPlaced] = useState<Placed>();
  const groups = groupsOf(rules);
  const searching = query.trim() !== "";
  const targetsFor = (outcome: string) => [
    ...agents.filter((name) => name !== outcome).map((name) => ({ value: name, label: assistantName(name) })),
    ...(outcome === DENIED ? [] : [{ value: DENIED, label: "Refused" }]),
  ];
  const place = (outcome: string, channel: string | undefined, field: IdField, ids: readonly string[]) => {
    const next = placeIds(rules, outcome, channel, field, ids);
    const after = next.rules[next.at + 1];
    const isNew = next.rules.length > rules.length;
    onChange(next.rules);
    setPlaced({ outcome, at: next.at, ...(isNew && after !== undefined && { before: next.at + 1 }) });
  };

  /** The groups shown, and whether only their matching chips show (the search matched no agent's name). */
  const shownGroups = groups.flatMap((group): (Group & { match?: string })[] => {
    if (!searching || found(query, outcomeLabel(group.outcome), group.outcome)) return [group];
    const hits = group.rules.some((index) => {
      const rule = rules[index];
      return rule !== undefined && (found(query, channelLabel(rule.channel)) || (["conversations", "actors"] as const).some((field) => (rule[field] ?? []).some((id) => found(query, id, names.get(id)))));
    });
    return hits ? [{ ...group, match: query }] : [];
  });

  return (
    <div className="flex flex-col gap-3">
      {rules.length === 0 && <p className="text-[13px] text-ink-3">No agent has chats of its own yet: add chats below, or rules in the &ldquo;In order&rdquo; view.</p>}
      {searching && shownGroups.length === 0 && <p className="text-[13px] text-ink-3">No agent, chat or sender matches &ldquo;{query.trim()}&rdquo;.</p>}
      {shownGroups.map((group) => {
        const deny = group.outcome === DENIED;
        const own = group.rules.map((index) => rules[index]).filter((rule): rule is Rule => rule !== undefined);
        const chats = own.reduce((sum, rule) => sum + (rule.conversations?.length ?? 0), 0);
        const listChannel = own.find((rule) => isListOf(rule, rule.channel, "conversations"))?.channel ?? channels[0];
        return (
          <section key={group.outcome} aria-label={outcomeLabel(group.outcome)} className={`flex flex-col gap-2 rounded-card p-3 ${deny ? "border border-dashed border-line-strong" : "bg-surface shadow-card"}`}>
            <header className="flex min-w-0 items-start gap-2.5">
              {deny ? (
                <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-red-tint text-red">
                  <Prohibition width={14} height={14} strokeWidth={1.8} />
                </span>
              ) : (
                <RecordMark name={group.outcome || "?"} />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-[14px] font-semibold text-ink" title={group.outcome === DENIED ? undefined : group.outcome}>
                    {outcomeLabel(group.outcome)}
                  </span>
                  {chats > 0 && <span className="shrink-0 text-[12.5px] text-ink-3 tabular-nums">{counted(chats, "chat", "chats")}</span>}
                </span>
                <span className="text-[12.5px] text-ink-2">
                  {deny ? "Refuses in" : "Answers in"} <span aria-hidden="true">→</span> {group.rules.map((index) => takes(rules, index)).join("; ")}
                </span>
              </div>
            </header>
            {group.rules.map((index) => {
              const rule = rules[index];
              if (rule === undefined) return null;
              const problem = problems[index];
              const shadowedBy = new Map((problem?.shadowed ?? []).map((each) => [`${each.field}:${each.id}`, each.by]));
              const lists = (["conversations", "actors"] as const).filter((field) => rule[field] !== undefined);
              return (
                <div key={index} className="flex flex-col gap-1.5 border-t border-line pt-2">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex h-6 w-40 shrink-0 items-center gap-2 text-[12.5px] text-ink-2">
                      <span title={`Rule ${index + 1}: the rules are read in order, and the first one a message matches decides`} className="flex h-5 min-w-5 items-center justify-center rounded-[6px] bg-inset px-1 text-[11.5px] font-medium text-ink-2 tabular-nums shadow-hairline">
                        {index + 1}
                      </span>
                      {rule.channel === undefined ? <Antenna width={14} height={14} strokeWidth={1.7} className="shrink-0 text-ink-3" /> : <ChannelIcon kind={rule.channel.split(":")[0] ?? rule.channel} size={14} className="text-ink-3" />}
                      <span className="truncate" title={rule.channel}>
                        {channelLabel(rule.channel)}
                      </span>
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      {lists.length === 0 && <span className="flex min-h-6 items-center text-[12.5px] text-ink-3">Every {rule.channel === undefined ? "message" : "chat"} no rule above takes</span>}
                      {deny && rule.reason !== undefined && <span className="flex min-h-6 items-center text-[12.5px] text-ink-3">Reason: {rule.reason}</span>}
                  {lists.map((field) => {
                    // Those an earlier rule takes first show first: never hidden behind "+N more".
                    const ids = (rule[field] ?? []).filter((id) => !searching || group.match === undefined || found(query, id, names.get(id))).toSorted((a, b) => Number(shadowedBy.has(`${field}:${b}`)) - Number(shadowedBy.has(`${field}:${a}`)));
                    const movable = isListOf(rule, rule.channel, field);
                    return (
                      <div key={field} className="flex min-w-0 items-start gap-2">
                        {lists.length > 1 || field === "actors" ? <span className="flex h-6 w-14 shrink-0 items-center text-[12px] text-ink-3">{field === "actors" ? "Senders" : "Chats"}</span> : null}
                        <ChipList count={ids.length} all={searching}>
                          {(shown) =>
                            ids.slice(0, shown).map((id) => {
                              const by = shadowedBy.get(`${field}:${id}`);
                              const name = names.get(id);
                              const label = `${NOUN[field][0]} ${name ?? id}`;
                              const remove = () => {
                                setPlaced(undefined);
                                onChange(withoutId(rules, index, field, id));
                              };
                              return (
                                <IdChip
                                  key={id}
                                  id={id}
                                  label={label}
                                  {...(name !== undefined && { name })}
                                  {...(by !== undefined && { shadowed: `Rule ${by + 1} above takes it first: here it never matches.` })}
                                  {...(movable ? { actions: idActions(targetsFor(group.outcome), (target) => place(target, rule.channel, field, [id]), remove) } : { onRemove: remove })}
                                />
                              );
                            })
                          }
                        </ChipList>
                      </div>
                    );
                  })}
                    </div>
                  </div>
                  {problem !== undefined && problem.shadowed === undefined && <Note tone={problem.level}>{`Rule ${index + 1}: ${named(problem, names)}`}</Note>}
                  {problem?.shadowed !== undefined && (
                    <Note tone="warning">
                      {`${counted(problem.shadowed.length, "chat or sender is", "chats or senders are")} also in a rule above, which takes ${problem.shadowed.length === 1 ? "it" : "them"} first (orange): here ${problem.shadowed.length === 1 ? "it never matches" : "they never match"}. `}
                      <button type="button" onClick={onShowInOrder} className="underline underline-offset-2">
                        See the order
                      </button>
                    </Note>
                  )}
                </div>
              );
            })}
            {placed !== undefined && placed.outcome === group.outcome && (
              <Note tone="info">{placed.before === undefined ? `Added to rule ${placed.at + 1}.` : `Added as rule ${placed.at + 1}, before rule ${placed.before + 1}, which would otherwise take these chats first.`}</Note>
            )}
            {!searching && (
              <AddChats
                what="chats"
                channels={channels}
                {...(listChannel !== undefined && { channel: listChannel })}
                onAdd={(channel, ids) => place(group.outcome, channel, "conversations", ids)}
                rules={rules}
                outcome={group.outcome}
                names={names}
              />
            )}
          </section>
        );
      })}
      {!searching && <NewGroup agents={agents.filter((name) => !groups.some((group) => group.outcome === name))} refused={!groups.some((group) => group.outcome === DENIED)} channels={channels} onAdd={place} rules={rules} names={names} />}
    </div>
  );
}

/**
 * "Add chats", with the channel they are of (the first one offered: the card's list's). When some are
 * another agent's (in its list of that channel), it says they move here (`placeIds` takes them out).
 */
function AddChats({ what, channels, channel: initial, onAdd, open = false, rules, outcome, names }: { what: string; channels: readonly string[]; channel?: string; onAdd: (channel: string | undefined, ids: string[]) => void; open?: boolean; rules: readonly Rule[]; outcome: string; names: ReadonlyMap<string, string> }) {
  const [channel, setChannel] = useState(initial ?? "");
  const notice = (ids: string[]) => {
    const on = channel === "" ? undefined : channel;
    const moving = ids.flatMap((id) => {
      const from = rules.find((rule) => outcomeOf(rule) !== outcome && isListOf(rule, on, "conversations") && rule.conversations?.includes(id));
      return from === undefined ? [] : [`${names.get(id) ?? id} (${outcomeLabel(outcomeOf(from))})`];
    });
    return moving.length === 0 ? undefined : `${moving.length === 1 ? "Answered by another now, it moves" : `${moving.length} are answered by another now, they move`} here: ${moving.join(", ")}.`;
  };
  return (
    <AddIds
      what={what}
      open={open}
      notice={notice}
      placeholder={"spaces/AAQA6yBxAgA\nspaces/AAQArgENa-8"}
      onAdd={(ids) => onAdd(channel === "" ? undefined : channel, ids)}
      extra={
        <span className="flex items-center gap-2 text-[12.5px] text-ink-2">
          on
          <Combobox
            label="Their channel"
            value={channel}
            options={[...channels.map((each) => ({ value: each, label: channelLabel(each) })), { value: "", label: "Any channel" }]}
            onChange={setChannel}
            className="h-7 max-w-52 min-w-32 text-[12.5px]"
          />
        </span>
      }
    />
  );
}

/** The last card: chats for an agent that has none yet (or refused, when nothing is). */
function NewGroup({ agents, refused, channels, onAdd, rules, names }: { agents: readonly string[]; refused: boolean; channels: readonly string[]; onAdd: (outcome: string, channel: string | undefined, field: IdField, ids: readonly string[]) => void; rules: readonly Rule[]; names: ReadonlyMap<string, string> }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState("");
  const options = [...agents.map((name) => ({ value: name, label: assistantName(name), group: "Agents" })), ...(refused ? [{ value: DENIED, label: "Nobody: refused", description: "The channel says it cannot answer", group: "Refuse" }] : [])];
  if (options.length === 0) return null;
  if (!open) {
    return (
      <div>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          Send chats to another agent
        </Button>
      </div>
    );
  }
  return (
    <section aria-label="Another agent" className="flex flex-col gap-2 rounded-card bg-surface p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
        <span>Send chats to</span>
        <Combobox label="The agent" value={outcome} placeholder="Choose an agent" options={options} onChange={setOutcome} className="max-w-60 min-w-40" />
        <Button size="xs" variant="quiet" className="ml-auto" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {outcome !== "" && (
        <AddChats
          what="chats"
          open
          rules={rules}
          outcome={outcome}
          names={names}
          channels={channels}
          {...(channels[0] !== undefined && { channel: channels[0] })}
          onAdd={(channel, ids) => {
            onAdd(outcome, channel, "conversations", ids);
            setOpen(false);
            setOutcome("");
          }}
        />
      )}
    </section>
  );
}
