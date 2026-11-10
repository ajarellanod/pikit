/**
 * The Settings dialog's Agents, as runtime-pi's part (the code's agents) and agents-live's (the agents
 * made here) both show them: a row per agent in the list (`AgentRow`), and an agent's page opened in
 * place of the list (`AgentPage`: its mark, name and model, its actions, a way back, then tabs), with a
 * searchable list of switches grouped by family for its tools, skills and extensions (`ToggleList`).
 * Everything by props: each part keeps its own data, saves and settings (features/settings.md, "A
 * component's settings are its own").
 */

import { NavArrowLeft } from "iconoir-react";
import { Tabs } from "radix-ui";
import { type ComponentType, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/bui/Button";
import SearchField from "@/components/bui/SearchField";
import { assistantName } from "@/lib/names";

type Icon = ComponentType<{ width?: number; height?: number; strokeWidth?: number; className?: string }>;

/** `n` things: "no tools", "1 tool", "21 tools". */
export const countOf = (n: number, one: string) => `${n === 0 ? "no" : n} ${one}${n === 1 ? "" : "s"}`;

/** An agent's mark: its initial, in a rounded square (`large` on its page). */
export function AgentMark({ name, large = false }: { name: string; large?: boolean }) {
  return (
    <span aria-hidden className={`flex shrink-0 items-center justify-center rounded-[9px] bg-field font-semibold text-ink-2 shadow-btn ${large ? "size-10 text-[16px]" : "size-8 text-[13px]"}`}>
      {assistantName(name).slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * One agent in the list: its mark, its name (`assistantName`), its badges, a line (its model, what it
 * has), its actions on the right. `focus`: its first action takes the focus when it shows (back from
 * the agent's page).
 */
export function AgentRow({ name, line, badges, actions, focus = false }: { name: string; line: ReactNode; badges?: ReactNode; actions: ReactNode; focus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) ref.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [focus]);
  return (
    <div className="flex min-h-16 items-center gap-3 border-b border-line py-3 last:border-b-0">
      <AgentMark name={name} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-[14px] font-medium text-ink" title={name}>
            {assistantName(name)}
          </span>
          {badges}
        </div>
        <div className="mt-0.5 min-w-0 truncate text-[12.5px] text-ink-3">{line}</div>
      </div>
      <div ref={ref} className="flex shrink-0 items-center gap-1">
        {actions}
      </div>
    </div>
  );
}

/** One tab of an agent's page: its label and icon, a count beside them (`"21/40"`), what it shows. */
export interface AgentTab {
  id: string;
  label: string;
  icon: Icon;
  count?: string;
  content: ReactNode;
}

/** The nearest ancestor that scrolls (the dialog's panel), to its top: a page opens at its start. */
function scrollToTop(element: HTMLElement | null) {
  for (let each = element?.parentElement; each !== null && each !== undefined; each = each.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(each).overflowY)) {
      each.scrollTop = 0;
      return;
    }
  }
}

/**
 * An agent's page, in place of the list: "← Agents" (`onBack`), its mark, name, `line` (its model) and
 * `badges`, `actions` on the right, a `notice` (an error) under them, then its `tabs`. It takes the
 * focus when it opens (its heading), so a screen reader starts there.
 */
export function AgentPage({
  name,
  line,
  badges,
  actions,
  notice,
  tabs,
  onBack,
  backLabel = "Agents",
}: {
  name: string;
  line?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  notice?: ReactNode;
  tabs: readonly AgentTab[];
  onBack: () => void;
  backLabel?: string;
}) {
  const [tab, setTab] = useState(tabs[0]?.id ?? "");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    scrollToTop(heading.current);
    heading.current?.focus({ preventScroll: true });
  }, []);
  const title = name === "" ? "New agent" : assistantName(name);
  return (
    <div className="rise-in">
      <Button size="xs" variant="quiet" className="-ml-2 mb-4" onClick={onBack} aria-label={`Back to ${backLabel}`}>
        <NavArrowLeft width={14} height={14} strokeWidth={2} />
        {backLabel}
      </Button>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <AgentMark name={name === "" ? "+" : name} large />
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 ref={heading} tabIndex={-1} className="min-w-0 truncate text-[19px] font-semibold text-ink outline-none" title={name === "" ? undefined : name}>
                {title}
              </h2>
              {badges}
            </div>
            {line !== undefined && <div className="mt-0.5 min-w-0 truncate text-[12.5px] text-ink-3">{line}</div>}
          </div>
        </div>
        {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {notice !== undefined && <div className="mt-4">{notice}</div>}
      <Tabs.Root value={tab} onValueChange={setTab} className="mt-6">
        <Tabs.List aria-label={`${title}'s settings`} className="-mx-1 flex gap-1 overflow-x-auto border-b border-line px-1">
          {tabs.map(({ id, label, icon: TabIcon, count }) => (
            <Tabs.Trigger
              key={id}
              value={id}
              className="relative -mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-2.5 text-[13.5px] font-medium text-ink-2 transition-colors duration-100 hover:text-ink data-[state=active]:border-ink data-[state=active]:text-ink"
            >
              <TabIcon width={15} height={15} strokeWidth={1.8} />
              {label}
              {count !== undefined && <span className="rounded-full bg-field px-1.5 py-px text-[11.5px] font-medium text-ink-3 tabular-nums">{count}</span>}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {tabs.map(({ id, content }) => (
          <Tabs.Content key={id} value={id} className="pt-4 outline-none">
            {content}
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </div>
  );
}

/** A thing to switch on or off: its name, and what it does in one line (none: `ToggleList`'s `on`/`off` lines). */
export interface Toggleable {
  name: string;
  summary?: string;
}

/** `names` with what each does (`GET /admin/api/agents`' `tools` or `skills`: its `summary`, none when empty or not read yet). */
export function toggleables(names: readonly string[], summaries: readonly { name: string; summary: string }[] | undefined): Toggleable[] {
  return names.map((name) => {
    const summary = summaries?.find((each) => each.name === name)?.summary;
    return summary === undefined || summary === "" ? { name } : { name, summary };
  });
}

const SEPARATOR = /[_\-.:]/;

/**
 * The families of `names`: a name's first word (up to `_`, `-`, `.` or `:`) when another name shares
 * it (`delegate_tasks` and `delegate_status`: `delegate_*`); every other name in "Other", last.
 */
export function familiesOf(names: readonly string[]): { label: string; names: string[] }[] {
  const prefixOf = (name: string) => {
    const at = name.search(SEPARATOR);
    return at <= 0 ? undefined : name.slice(0, at + 1);
  };
  const counts = new Map<string, number>();
  for (const name of names) {
    const prefix = prefixOf(name);
    if (prefix !== undefined) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const families = new Map<string, string[]>();
  const other: string[] = [];
  for (const name of names) {
    const prefix = prefixOf(name);
    if (prefix !== undefined && (counts.get(prefix) ?? 0) > 1) families.set(prefix, [...(families.get(prefix) ?? []), name]);
    else other.push(name);
  }
  return [
    ...[...families].sort(([a], [b]) => a.localeCompare(b)).map(([prefix, members]) => ({ label: `${prefix}*`, names: members })),
    ...(other.length > 0 ? [{ label: "Other", names: other }] : []),
  ];
}

/** One thing's switch: the whole row toggles it, its name the switch's name, its line the description. */
function ToggleRow({ item, checked, disabled, line, onToggle }: { item: Toggleable; checked: boolean; disabled: boolean; line: string | undefined; onToggle: () => void }) {
  const id = useId();
  // aria-disabled, not disabled: a focused button that turns disabled (while a change saves) drops the focus
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={item.name}
      aria-describedby={line === undefined ? undefined : id}
      aria-disabled={disabled}
      onClick={() => !disabled && onToggle()}
      className="flex w-full items-center gap-4 rounded-[8px] px-2.5 py-2 text-left transition-colors duration-100 hover:bg-hover aria-disabled:cursor-default aria-disabled:opacity-60"
    >
      <span className="min-w-0 flex-1">
        <span className={`block truncate font-mono text-[12.5px] ${checked ? "text-ink" : "text-ink-2"}`}>{item.name}</span>
        {line !== undefined && (
          <span id={id} className="mt-0.5 block truncate text-[12.5px] text-ink-3" title={line}>
            {line}
          </span>
        )}
      </span>
      {/* the switch's look (index.css's `.switch`, ink when on: its aria-checked is the row's); the row is the switch */}
      <span aria-hidden className="switch" style={checked ? { background: "var(--ink)" } : undefined}>
        <span className="switch-thumb" style={checked ? { translate: "calc(var(--thumb) - 4px) 0" } : undefined} />
      </span>
    </button>
  );
}

/**
 * Switches for `items` (`noun`: "tool", "skill", "extension"), the names in `on` on: a search (by name
 * and line), how many are on, the families (`familiesOf`) each with its count and "All on" / "All off"
 * for what it shows. `onChange` gets every name on, in `items`' order. `onLine` / `offLine`: a thing's
 * line when it has no summary (none: a name alone).
 */
export function ToggleList({
  noun,
  items,
  on,
  onChange,
  disabled = false,
  onLine,
  offLine,
  empty,
}: {
  noun: string;
  items: readonly Toggleable[];
  on: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  onLine?: string;
  offLine?: string;
  /** What shows when there is nothing to switch. */
  empty: string;
}) {
  const [query, setQuery] = useState("");
  if (items.length === 0) return <p className="py-3 text-[13px] text-ink-3">{empty}</p>;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const byName = new Map(items.map((item) => [item.name, item]));
  const matches = (item: Toggleable) => words.every((word) => `${item.name} ${item.summary ?? ""}`.toLowerCase().includes(word));
  const set = (names: readonly string[], value: boolean) => onChange(items.map((item) => item.name).filter((name) => (names.includes(name) ? value : on.includes(name))));
  const families = familiesOf(items.map((item) => item.name))
    .map((family) => ({ ...family, shown: family.names.filter((name) => matches(byName.get(name) as Toggleable)) }))
    .filter((family) => family.shown.length > 0);
  const grouped = familiesOf(items.map((item) => item.name)).length > 1;
  const enabled = items.filter((item) => on.includes(item.name)).length;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SearchField value={query} onChange={setQuery} placeholder={`Search ${items.length} ${noun}s`} label={`Search the ${noun}s`} className="min-w-48 flex-1" />
        <span className="text-[12.5px] text-ink-3 tabular-nums" aria-live="polite">
          {enabled} of {items.length} on
        </span>
      </div>
      {families.length === 0 && <p className="py-6 text-center text-[13px] text-ink-3">No {noun} matches.</p>}
      {families.map((family) => {
        const all = family.shown.every((name) => on.includes(name));
        const count = family.names.filter((name) => on.includes(name)).length;
        return (
          <section key={family.label} aria-label={grouped ? `${family.label} ${noun}s` : `${noun}s`} className="mt-4">
            <div className="flex min-h-7 items-center gap-2 px-2.5 pb-1">
              {grouped && <h4 className={`text-[12.5px] font-semibold text-ink-2 ${family.label === "Other" ? "" : "font-mono"}`}>{family.label}</h4>}
              <span className="flex-1 text-[12px] text-ink-3 tabular-nums">
                {count}/{family.names.length}
              </span>
              <Button
                size="xs"
                variant="quiet"
                aria-disabled={disabled}
                className="aria-disabled:opacity-50"
                aria-label={`Turn ${all ? "off" : "on"} every ${grouped && family.label !== "Other" ? `${family.label} ` : ""}${noun}${words.length > 0 ? " shown" : ""}`}
                onClick={() => !disabled && set(family.shown, !all)}
              >
                {all ? "All off" : "All on"}
              </Button>
            </div>
            <div className="flex flex-col">
              {family.shown.map((name) => {
                const item = byName.get(name) as Toggleable;
                const checked = on.includes(name);
                return <ToggleRow key={name} item={item} checked={checked} disabled={disabled} line={item.summary ?? (checked ? onLine : offLine)} onToggle={() => set([name], !checked)} />;
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
