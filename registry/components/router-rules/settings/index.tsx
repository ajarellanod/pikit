/**
 * router-rules' section of the Settings dialog, part 1 of the Routing entry (features/settings.md,
 * "Multi-agent"): its rules, an ordered list an operator edits live, in two views of the same draft.
 *
 * - **By agent** (the first): one card per agent, "Trader answers in → Google Chat · 63 chats", its
 *   chats and senders as chips, and the refusals' card; chats added (several pasted at once), taken
 *   away, moved to another agent (`by-agent.tsx`).
 * - **In order**: the rules as they are read, the first that matches deciding, each a card dragged by
 *   its number or moved from its menu (`in-order.tsx`).
 *
 * Where everything else goes is router-basic's part, drawn right under this one (its default agent):
 * this part reads and writes only router-rules' settings. The config's rules are the default: the
 * operator's replace them whole, and "Use default" takes them away. A chat shows its name when the
 * dashboard has seen it (its conversations' parties), else its id; with many, a search narrows both
 * views. The channels offered are the App's (`channel-*` components, `rules.ts`' `channelsOf`), or one
 * typed (`telegram:support`). The agents are the schema's (the code's agents, without a directory),
 * else every agent of `GET /admin/api/agents`. What is wrong shows where it is (`problemsOf`); the list
 * is saved whole, from the heading, which stays at the top of the panel.
 */

import { GitFork, Plus } from "iconoir-react";
import { useRef, useState } from "react";
import { Button } from "@/components/bui/Button";
import SearchField from "@/components/bui/SearchField";
import { ErrorNote } from "@/components/pikit/error-note";
import { Segmented, SettingsHeading, storedOf } from "@/components/pikit/settings";
import { choicesOf, defineSettings, type JsonSchema, useSettings } from "@/lib/settings";
import { useShell } from "@/lib/shell";
import { ByAgent } from "./by-agent";
import { InOrder, type Row } from "./in-order";
import { useChatNames } from "./parts";
import { channelsOf, cleaned, problemsOf, type Rule } from "./rules";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** More ids than this in the rules, or more rules: a search over them. */
const SEARCH_FROM = 12;

type View = "agents" | "order";

function RoutingSettings() {
  const routing = useSettings("router-rules");
  const { agents, app } = useShell();
  const names = useChatNames();
  const [view, setView] = useState<View>("agents");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Row[]>();
  /** The rows whose channel is typed, not chosen. */
  const [typed, setTyped] = useState<ReadonlySet<number>>(new Set());
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
  const choices = choicesOf(agentSchema) ?? (agents ?? []).map((agent) => agent.name);
  const problems = problemsOf(rules, agentSchema === undefined && agents === undefined ? undefined : choices);
  const blocked = problems.some((problem) => problem?.level === "error");
  const known = channelsOf(app);
  const channels = [...new Set([...known, ...rules.flatMap((rule) => (rule.channel !== undefined && rule.channel !== "" ? [rule.channel] : []))])];
  // router-basic's part, under this one, draws where everything else goes (the App's composition, not its settings).
  const fallback = app.components.some((component) => component.name === "router-basic");
  const ids = rules.reduce((sum, rule) => sum + (rule.conversations?.length ?? 0) + (rule.actors?.length ?? 0), 0);
  const searchable = ids > SEARCH_FROM || rules.length > SEARCH_FROM;

  /** The draft as `next`: a rule kept as it was keeps its row's key; a changed or new one gets a new key. */
  const setRules = (next: readonly Rule[]) => {
    const byRule = new Map(rows.map((row) => [row.rule, row.key]));
    setDraft(next.map((rule) => ({ key: byRule.get(rule) ?? nextKey.current++, rule })));
  };
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
    setDraft([...rows, { key, rule: { ...(known[0] !== undefined && { channel: known[0] }), agent: "" } }]);
  };

  return (
    <div>
      {failed !== undefined && !changed && (
        <div className="mb-4">
          <ErrorNote error={failed} title="Not saved" />
        </div>
      )}
      <p className="mb-5 text-[13px] text-ink-3">
        {view === "agents"
          ? "Who answers where. A chat is one agent's: when two rules list it, the first one wins (In order shows the order)."
          : "Read from the top: the first rule a message matches picks who answers it."}
      </p>
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
              {view === "order" && (
                <Button size="sm" variant="secondary" onClick={add}>
                  <Plus width={14} height={14} strokeWidth={2} />
                  Add rule
                </Button>
              )}
              {changed && (
                <>
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={routing.saving}
                    onClick={() => {
                      setDraft(undefined);
                      setTyped(new Set());
                      setFailed(undefined);
                    }}
                  >
                    Revert
                  </Button>
                  <Button size="sm" variant="primary" disabled={routing.saving || blocked} title={blocked ? "Fix the rules marked in red first" : undefined} onClick={() => save(rules.map(cleaned))}>
                    Save
                  </Button>
                </>
              )}
            </>
          }
        >
          Rules <span className="text-[13px] font-normal text-ink-3">{same(saved, defaults) && draft === undefined ? "(default)" : "(changed here)"}</span>
        </SettingsHeading>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Segmented<View>
            label="Show the rules"
            value={view}
            options={[
              { value: "agents", label: "By agent" },
              { value: "order", label: "In order" },
            ]}
            onChange={setView}
          />
          {searchable && <SearchField value={query} onChange={setQuery} placeholder="Search agents, chats, ids" label="Search the rules" className="min-w-40 flex-1" />}
        </div>
        {changed && <p className="mt-1 text-right text-[12px] text-ink-3">{blocked ? "Not saved yet: fix what is marked in red first." : "Not saved yet. Applies to new conversations once saved."}</p>}
        {changed && failed !== undefined && (
          <div className="mt-2">
            <ErrorNote error={failed} title="Not saved" />
          </div>
        )}
      </div>
      {view === "agents" ? (
        <div className="mt-3">
          <ByAgent rules={rules} onChange={setRules} problems={problems} agents={choices} channels={channels} names={names} query={query} onShowInOrder={() => setView("order")} />
        </div>
      ) : (
        <InOrder rows={rows} onChange={setDraft} problems={problems} agents={choices} channels={channels} known={known} names={names} query={query} typed={typed} setTyped={setTyped} fallback={fallback} />
      )}
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
  keywords: ["routing", "rules", "channel", "chat", "chats", "space", "sender", "deny", "refuse", "block", "agent", "by agent"],
  component: RoutingSettings,
});
