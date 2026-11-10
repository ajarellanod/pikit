/**
 * agents-live's section of the Settings dialog (features/settings.md, "Multi-agent"): part 2 of the
 * Agents entry, right after runtime-pi's agents of the code, the agents an operator made (agents-live's
 * settings: one key per agent), created, edited and removed here, live. It reads and writes only
 * agents-live's settings; the code's agents' names (the shell's agents list) only keep a new one from
 * taking one. Each tool and skill says what it does in one line (`GET /admin/api/agents`' `tools` and `skills`).
 *
 * The list ("Made here") shows each agent, with Edit and Remove (Remove asks again, saying what becomes
 * of its conversations); New agent and Edit open the agent's page in place of the list
 * (`useSettingsPage`, the shared `agent-editor`): General (name, description, model, system prompt),
 * Tools, Skills and Extensions (searchable switches, by family), all saved at once with Save (Create
 * for a new one) or dropped with Cancel.
 *
 * What agents-live's schema says is all it offers: the models the installed providers have, the
 * installed tools and extensions, the project's skills (each agent's `patternProperties`), and no code agent's name
 * (`propertyNames`). A save stores every live agent at once (`PUT`), refused whole when one is wrong.
 */

import { Community, EditPencil, GraduationCap, Plus, Puzzle, Settings, Tools, Trash } from "iconoir-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/bui/Badge";
import { Button } from "@/components/bui/Button";
import { AgentPage, AgentRow, countOf, ToggleList, toggleables } from "@/components/pikit/agent-editor";
import { ErrorNote } from "@/components/pikit/error-note";
import { type ApiAgents, useApi } from "@/lib/api";
import { SelectControl, SettingsHeading, SettingsRow } from "@/components/pikit/settings";
import { assistantName } from "@/lib/names";
import { choicesOf, defineSettings, type JsonSchema, type SettingsValue, useSettings, useSettingsPage } from "@/lib/settings";
import { useShell } from "@/lib/shell";

/** An agent's name, as agents-live's schema says it. */
const AGENT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** The page of a new agent: no agent's name (`AGENT_NAME`). */
const NEW = "+new";

/** A live agent's fields, as stored under its name. */
type Fields = { description?: string; model: string; systemPrompt?: string; tools?: string[]; extensions?: string[]; skills?: string[] };

/** The agent being edited: `original` undefined while it is new. */
type Draft = { original?: string; name: string; fields: Fields };

const field = "control w-full";

const LIVE = (
  <span title="Made in the dashboard: it is data, not the project's code">
    <Badge>live</Badge>
  </span>
);

/** One agent's page, new or made before: its fields edited here, saved together (`onSave`) or dropped (`onCancel`). */
function LiveAgentPage({
  draft,
  schema,
  taken,
  saving,
  failed,
  onSave,
  onCancel,
}: {
  draft: Draft;
  schema: JsonSchema;
  taken: readonly string[];
  saving: boolean;
  failed: Error | undefined;
  onSave: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const catalog = useApi<ApiAgents>("/agents").data;
  const [name, setName] = useState(draft.name);
  const [fields, setFields] = useState<Fields>(draft.fields);
  const properties = schema.properties ?? {};
  const models = choicesOf(properties.model) ?? [];
  const tools = choicesOf(properties.tools?.items) ?? [];
  const extensions = choicesOf(properties.extensions?.items) ?? [];
  const skills = choicesOf(properties.skills?.items) ?? [];
  const isNew = draft.original === undefined;
  const nameProblem = !isNew
    ? undefined
    : name === ""
      ? "Give it a name."
      : !AGENT_NAME.test(name)
        ? "Lowercase letters and digits, words joined by -: support, sales-eu."
        : taken.includes(name)
          ? "An agent has this name already."
          : undefined;
  const set = (patch: Partial<Fields>) => setFields((current) => ({ ...current, ...patch }));
  const noModel = fields.model === "" ? "Choose its model." : undefined;
  const blocked = nameProblem ?? noModel;

  return (
    <AgentPage
      name={isNew ? (AGENT_NAME.test(name) ? name : "") : (draft.original as string)}
      onBack={onCancel}
      line={fields.model === "" ? undefined : <span className="font-mono text-[12px]">{fields.model}</span>}
      badges={LIVE}
      actions={
        <>
          <Button size="sm" variant="quiet" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={saving || blocked !== undefined} title={blocked} onClick={() => onSave({ ...draft, name, fields })}>
            {isNew ? "Create" : "Save"}
          </Button>
        </>
      }
      notice={failed === undefined ? undefined : <ErrorNote error={failed} title="Not saved" />}
      tabs={[
        {
          id: "general",
          label: "General",
          icon: Settings,
          content: (
            <>
              <SettingsRow label="Name" description={isNew ? "How routing rules and conversations name it; it cannot change once made." : "It cannot change: routing rules and conversations name it."} htmlFor="agent-name">
                <input id="agent-name" aria-label="Name" value={name} disabled={!isNew} onChange={(event) => setName(event.target.value.trim())} placeholder="support" aria-invalid={nameProblem !== undefined && name !== ""} aria-describedby={nameProblem !== undefined && name !== "" ? "agent-name-problem" : undefined} className={`${field} w-56`} />
              </SettingsRow>
              {nameProblem !== undefined && name !== "" && (
                <p id="agent-name-problem" className="pb-2 text-[12.5px] text-red">
                  {nameProblem}
                </p>
              )}
              <SettingsRow label="Description" description="One line: what it is for." htmlFor="agent-description">
                <input id="agent-description" aria-label="Description" value={fields.description ?? ""} maxLength={300} onChange={(event) => set({ description: event.target.value })} placeholder="Answers billing questions" className={`${field} w-72`} />
              </SettingsRow>
              <SettingsRow label="Model" description="The model that answers, among the installed providers'." htmlFor="agent-model">
                <SelectControl id="agent-model" label="Model" value={fields.model} options={models.map((model) => ({ value: model, label: model }))} onChange={(model) => set({ model })} />
              </SettingsRow>
              <SettingsRow label="System prompt" description="What the agent is told before every conversation." stacked htmlFor="agent-prompt">
                <textarea
                  id="agent-prompt"
                  aria-label="System prompt"
                  value={fields.systemPrompt ?? ""}
                  onChange={(event) => set({ systemPrompt: event.target.value })}
                  rows={8}
                  spellCheck
                  placeholder="You answer billing questions for Acme's customers, briefly and kindly."
                  className="control min-h-40 w-full resize-y font-mono text-[12.5px] leading-relaxed"
                />
              </SettingsRow>
            </>
          ),
        },
        {
          id: "tools",
          label: "Tools",
          icon: Tools,
          count: `${fields.tools?.length ?? 0}/${tools.length}`,
          content: (
            <ToggleList
              noun="tool"
              items={toggleables(tools, catalog?.tools)}
              on={fields.tools ?? []}
              onChange={(next) => set({ tools: next })}
              onLine="The agent may call it."
              offLine="Off: the agent does not have it."
              empty="No tool is installed."
            />
          ),
        },
        {
          id: "skills",
          label: "Skills",
          icon: GraduationCap,
          count: `${fields.skills?.length ?? 0}/${skills.length}`,
          content: (
            <ToggleList
              noun="skill"
              items={toggleables(skills, catalog?.skills)}
              on={fields.skills ?? []}
              onChange={(next) => set({ skills: next })}
              onLine="The agent knows it, and loads it when a task needs it."
              offLine="Off: the agent does not know it."
              empty="The project has no skill."
            />
          ),
        },
        {
          id: "extensions",
          label: "Extensions",
          icon: Puzzle,
          count: `${fields.extensions?.length ?? 0}/${extensions.length}`,
          content: (
            <ToggleList
              noun="extension"
              items={toggleables(extensions, undefined)}
              on={fields.extensions ?? []}
              onChange={(next) => set({ extensions: next })}
              empty="No extension is installed."
            />
          ),
        },
      ]}
    />
  );
}

/** What to store of an agent's fields: nothing empty. */
function storedFields(fields: Fields): Fields {
  return {
    ...(fields.description !== undefined && fields.description.trim() !== "" && { description: fields.description.trim() }),
    model: fields.model,
    ...(fields.systemPrompt !== undefined && fields.systemPrompt !== "" && { systemPrompt: fields.systemPrompt }),
    ...(fields.tools !== undefined && fields.tools.length > 0 && { tools: fields.tools }),
    ...(fields.extensions !== undefined && fields.extensions.length > 0 && { extensions: fields.extensions }),
    ...(fields.skills !== undefined && fields.skills.length > 0 && { skills: fields.skills }),
  };
}

function AgentsSettings() {
  const live = useSettings("agents-live");
  const { agents, reloadAgents } = useShell();
  const page = useSettingsPage();
  const [failed, setFailed] = useState<Error>();
  /** The agent whose removal waits for a second click. */
  const [removing, setRemoving] = useState<string>();
  const newAgent = useRef<HTMLSpanElement>(null);
  // back from a new agent's page (Cancel, or made): New agent takes the focus back
  useEffect(() => {
    if (page.closed === NEW) newAgent.current?.querySelector("button")?.focus();
  }, [page.closed]);

  if (live.error !== undefined && live.section === undefined)
    return (
      <div className="mt-10">
        <ErrorNote error={live.error} title="The live agents cannot be read" />
      </div>
    );
  const section = live.section;
  if (section === undefined) return <p className="mt-10 text-[13px] text-ink-3">Loading</p>;
  const schema = (Object.values((section.schema.patternProperties ?? {}) as Record<string, JsonSchema>)[0] ?? {}) as JsonSchema;
  const models = choicesOf(schema.properties?.model) ?? [];
  const stored = section.value as Record<string, Fields>;
  const names = Object.keys(stored).sort();
  const code = (agents ?? []).filter((agent) => agent.live !== true);
  const taken = [...names, ...code.map((agent) => agent.name)];

  const save = (value: SettingsValue) => {
    setFailed(undefined);
    live
      .save(value)
      .then(() => {
        page.close();
        reloadAgents();
      })
      .catch((thrown: unknown) => setFailed(thrown instanceof Error ? thrown : new Error(String(thrown))));
  };
  const saveDraft = (next: Draft) => {
    const value: SettingsValue = { ...section.value, [next.name]: storedFields(next.fields) };
    save(value);
  };
  const remove = (name: string) => {
    setRemoving(undefined);
    const value: SettingsValue = { ...section.value };
    delete value[name];
    save(value);
  };
  const open = (id: string) => {
    setFailed(undefined);
    setRemoving(undefined);
    page.open(id);
  };

  const draft: Draft | undefined =
    page.page === NEW
      ? { name: "", fields: { model: models[0] ?? "", tools: [], extensions: [], skills: [] } }
      : page.page !== undefined && stored[page.page] !== undefined
        ? { original: page.page, name: page.page, fields: { ...(stored[page.page] as Fields) } }
        : undefined;
  if (draft !== undefined)
    return <LiveAgentPage key={page.page} draft={draft} schema={schema} taken={taken} saving={live.saving} failed={failed} onSave={saveDraft} onCancel={page.close} />;

  // a second block, right under runtime-pi's part (the parts of an entry have no gap of their own)
  return (
    <div className="mt-10">
      {failed !== undefined && (
        <div className="mb-4">
          <ErrorNote error={failed} title="Not saved" />
        </div>
      )}
      <SettingsHeading
        aside={
          <span ref={newAgent} className="contents">
            <Button size="sm" variant="secondary" disabled={models.length === 0} onClick={() => open(NEW)}>
              <Plus width={14} height={14} strokeWidth={2} />
              New agent
            </Button>
          </span>
        }
      >
        Made here
      </SettingsHeading>
      {names.length === 0 && (
        <p className="py-3 text-[13px] text-ink-3">None yet. An agent made here answers from its first message, with no deploy: start a conversation with it, or route a channel to it in Routing.</p>
      )}
      {names.map((name) => {
        const agent = stored[name] as Fields;
        return (
          <AgentRow
            key={name}
            name={name}
            focus={page.closed === name}
            line={
              removing === name ? (
                <span className="whitespace-normal text-ink-2">
                  Its conversations keep their history; at their next message each moves to the agent routed now (a rule's, or the default agent), in a new conversation. A rule naming it refuses its messages until changed.
                </span>
              ) : (
                <>
                  {agent.description !== undefined && `${agent.description} · `}
                  <span className="font-mono text-[12px]">{agent.model}</span>
                  {` · ${countOf(agent.tools?.length ?? 0, "tool")} · ${countOf(agent.skills?.length ?? 0, "skill")}`}
                </>
              )
            }
            actions={
              removing === name ? (
                <>
                  <Button size="sm" variant="quiet" onClick={() => setRemoving(undefined)}>
                    Keep
                  </Button>
                  <Button size="sm" variant="danger" disabled={live.saving} onClick={() => remove(name)}>
                    Remove
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="quiet" aria-label={`Edit ${assistantName(name)}`} disabled={live.saving} onClick={() => open(name)}>
                    <EditPencil width={14} height={14} strokeWidth={1.8} />
                    Edit
                  </Button>
                  <Button size="sm" variant="quiet" aria-label={`Remove ${assistantName(name)}`} disabled={live.saving} onClick={() => setRemoving(name)}>
                    <Trash width={14} height={14} strokeWidth={1.8} />
                  </Button>
                </>
              )
            }
          />
        );
      })}
    </div>
  );
}

export default defineSettings({
  id: "agents-live",
  title: "Agents",
  icon: Community,
  group: "Agents",
  order: 1,
  entry: "agents",
  requires: ["settings", "agent.directory"],
  keywords: ["agents", "new agent", "create", "live", "prompt", "model", "tools", "extensions", "skills"],
  component: AgentsSettings,
});
