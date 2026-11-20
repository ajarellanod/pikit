/**
 * runtime-pi's section of the Settings dialog (features/settings.md): part 1 of the Agents entry, the
 * agents of the project's code (`src/agents/`), each one's system prompt, model, thinking level, tools and skills
 * changed here (an operator's override over the agent's definition, applied from its next run).
 * agents-live's part, the agents made here, follows it. It reads and writes only runtime-pi's settings.
 *
 * The list shows each agent (its model, its tools and skills, "changed here" when overridden); Edit opens
 * the agent's page in place of the list (`useSettingsPage`, the shared `agent-editor`): General (model,
 * thinking level, system prompt), Tools and Skills (searchable switches, by family). Each change saves at once.
 *
 * What runtime-pi's schema says is all it reads: the agents (its properties; with an `agent.directory`
 * installed it accepts other names too, a live agent's, which are agents-live's to show), each one's
 * definition (the `default`s), the models of the providers with credentials (as runtime-pi found them
 * at start: a provider logged in since shows its models after the next start) and the tools and skills
 * the definition names (the options). It stores only what differs from the definition, so "Use default"
 * takes an override away. Each tool and skill says what it does in one line: `GET /admin/api/agents`'
 * `tools` and `skills` (a tool's `summary`, written where its component provides it; a skill's description).
 */

import { Community, EditPencil, GraduationCap, Settings, Tools } from "iconoir-react";
import { useState } from "react";
import { Badge } from "@/components/bui/Badge";
import { Button } from "@/components/bui/Button";
import { AgentPage, AgentRow, countOf, ToggleList, toggleables } from "@/components/pikit/agent-editor";
import { ErrorNote } from "@/components/pikit/error-note";
import { type ApiAgents, useApi } from "@/lib/api";
import { assistantName } from "@/lib/names";
import { PromptEditor, SelectControl, SettingsHeading, SettingsRow } from "@/components/pikit/settings";
import { choicesOf, defineSettings, type JsonSchema, type SettingsValue, useSettings, useSettingsPage } from "@/lib/settings";
import { useShell } from "@/lib/shell";

/** One agent's override (runtime-pi's settings): absent, the definition's. */
type Override = { systemPrompt?: string; model?: string; thinkingLevel?: string; tools?: string[]; skills?: string[] };

/** What an agent's definition says, as the schema's `default`s carry it. */
type Definition = { systemPrompt: string; model: string; thinkingLevel: string; tools: string[]; skills: string[] };

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((each) => b.includes(each));

/** An agent's definition, from its fields' `default`s. */
function definitionOf(fields: Record<string, JsonSchema>): Definition {
  return {
    systemPrompt: typeof fields.systemPrompt?.default === "string" ? fields.systemPrompt.default : "",
    model: typeof fields.model?.default === "string" ? fields.model.default : "",
    thinkingLevel: typeof fields.thinkingLevel?.default === "string" ? fields.thinkingLevel.default : "off",
    tools: Array.isArray(fields.tools?.default) ? (fields.tools.default as string[]) : [],
    skills: Array.isArray(fields.skills?.default) ? (fields.skills.default as string[]) : [],
  };
}

const STEWARD = (
  <span title="The project's steward: it knows what the project is made of, and operators ask it to change it">
    <Badge tone="accent">steward</Badge>
  </span>
);
const CHANGED = (
  <span title="Changed from the dashboard: an override over its definition">
    <Badge>changed here</Badge>
  </span>
);

/** One agent's page: its model, thinking level and prompt, its tools and skills; every change saved at once, through `save`. */
function CodeAgentPage({
  name,
  fields,
  override,
  steward,
  saving,
  failed,
  save,
  onBack,
}: {
  name: string;
  fields: Record<string, JsonSchema>;
  override: Override;
  steward: boolean;
  saving: boolean;
  failed: Error | undefined;
  save: (next: Override) => void;
  onBack: () => void;
}) {
  const catalog = useApi<ApiAgents>("/agents").data;
  const definition = definitionOf(fields);
  const models = choicesOf(fields.model) ?? [definition.model];
  const levels = choicesOf(fields.thinkingLevel) ?? [definition.thinkingLevel];
  const toolOptions = choicesOf(fields.tools?.items) ?? definition.tools;
  const tools = override.tools ?? definition.tools;
  const skillOptions = choicesOf(fields.skills?.items) ?? definition.skills;
  const skills = override.skills ?? definition.skills;
  const changed = Object.keys(override).length > 0;

  return (
    <AgentPage
      name={name}
      onBack={onBack}
      line={<span className="font-mono text-[12px]">{override.model ?? definition.model}</span>}
      badges={
        <>
          {steward && STEWARD}
          {changed && CHANGED}
        </>
      }
      actions={
        changed ? (
          <Button size="sm" variant="secondary" disabled={saving} onClick={() => save({})} title="Drop every change made here: the definition's prompt, model, thinking level, tools and skills">
            Use default
          </Button>
        ) : undefined
      }
      notice={failed === undefined ? undefined : <ErrorNote error={failed} title="Not saved" />}
      tabs={[
        {
          id: "general",
          label: "General",
          icon: Settings,
          content: (
            <>
              <SettingsRow label="Model" description="The model that answers, among those of the providers with credentials." htmlFor="settings-model">
                <SelectControl
                  id="settings-model"
                  label="Model"
                  value={override.model ?? definition.model}
                  disabled={saving}
                  options={models.map((model) => ({ value: model, label: model === definition.model ? `${model} (default)` : model }))}
                  onChange={(model) => save({ ...override, model })}
                />
              </SettingsRow>
              <SettingsRow label="Thinking" description="How much the model thinks before each answer, least to most. Applies from its next run." htmlFor="settings-thinking">
                <SelectControl
                  id="settings-thinking"
                  label="Thinking"
                  value={override.thinkingLevel ?? definition.thinkingLevel}
                  disabled={saving}
                  options={levels.map((level) => ({ value: level, label: level === definition.thinkingLevel ? `${level} (default)` : level }))}
                  onChange={(thinkingLevel) => save({ ...override, thinkingLevel })}
                />
              </SettingsRow>
              <SettingsRow label="System prompt" description="What the agent is told before every conversation. Applies from its next run." stacked htmlFor="settings-system-prompt">
                <PromptEditor
                  id="settings-system-prompt"
                  label="System prompt"
                  placeholder="You are a helpful assistant: answer briefly, ask when unsure."
                  value={override.systemPrompt}
                  fallback={definition.systemPrompt}
                  saving={saving}
                  onSave={(text) => save({ ...override, systemPrompt: text })}
                  onReset={() => save({ ...override, systemPrompt: undefined })}
                />
              </SettingsRow>
            </>
          ),
        },
        {
          id: "tools",
          label: "Tools",
          icon: Tools,
          count: `${tools.length}/${toolOptions.length}`,
          content: (
            <ToggleList
              noun="tool"
              items={toggleables(toolOptions, catalog?.tools)}
              on={tools}
              disabled={saving}
              onChange={(next) => save({ ...override, tools: next })}
              onLine="The agent may call it."
              offLine="Off: the agent does not have it."
              empty="Its definition names no tool."
            />
          ),
        },
        {
          id: "skills",
          label: "Skills",
          icon: GraduationCap,
          count: `${skills.length}/${skillOptions.length}`,
          content: (
            <ToggleList
              noun="skill"
              items={toggleables(skillOptions, catalog?.skills)}
              on={skills}
              disabled={saving}
              onChange={(next) => save({ ...override, skills: next })}
              onLine="The agent knows it, and loads it when a task needs it."
              offLine="Off: the agent does not know it."
              empty="Its definition names no skill."
            />
          ),
        },
      ]}
    />
  );
}

function CodeAgentsSettings() {
  const runtime = useSettings("runtime-pi");
  const { agents: shown } = useShell();
  const page = useSettingsPage();
  const [failed, setFailed] = useState<Error>();

  if (runtime.error !== undefined && runtime.section === undefined) return <ErrorNote error={runtime.error} title="The agents' settings cannot be read" />;
  const section = runtime.section;
  if (section === undefined) return <p className="text-[13px] text-ink-3">Loading</p>;
  // the code's agents only: a live agent's override (the schema's other names) is agents-live's to show
  const agents = Object.entries(section.schema.properties ?? {})
    .filter(([, schema]) => schema.properties?.systemPrompt !== undefined)
    .map(([name, schema]) => ({ name, fields: schema.properties ?? {} }));
  const isSteward = (name: string) => shown?.some((agent) => agent.name === name && agent.steward) === true;

  /** Saves `next` as `name`'s override, without what is the definition's; no key at all when nothing is left. */
  const saveOverride = (name: string, definition: Definition, next: Override) => {
    const kept: Override = {
      ...(next.systemPrompt !== undefined && next.systemPrompt !== definition.systemPrompt && { systemPrompt: next.systemPrompt }),
      ...(next.model !== undefined && next.model !== definition.model && { model: next.model }),
      ...(next.thinkingLevel !== undefined && next.thinkingLevel !== definition.thinkingLevel && { thinkingLevel: next.thinkingLevel }),
      ...(next.tools !== undefined && !sameSet(next.tools, definition.tools) && { tools: next.tools }),
      ...(next.skills !== undefined && !sameSet(next.skills, definition.skills) && { skills: next.skills }),
    };
    const all: SettingsValue = { ...section.value };
    if (Object.keys(kept).length === 0) delete all[name];
    else all[name] = kept;
    setFailed(undefined);
    runtime.save(all).catch((thrown: unknown) => setFailed(thrown instanceof Error ? thrown : new Error(String(thrown))));
  };

  const opened = agents.find((agent) => agent.name === page.page);
  if (opened !== undefined) {
    const definition = definitionOf(opened.fields);
    return (
      <CodeAgentPage
        key={opened.name}
        name={opened.name}
        fields={opened.fields}
        override={(section.value[opened.name] ?? {}) as Override}
        steward={isSteward(opened.name)}
        saving={runtime.saving}
        failed={failed}
        save={(next) => saveOverride(opened.name, definition, next)}
        onBack={page.close}
      />
    );
  }

  return (
    <div>
      {failed !== undefined && (
        <div className="mb-4">
          <ErrorNote error={failed} title="Not saved" />
        </div>
      )}
      <SettingsHeading>In the project's code</SettingsHeading>
      {agents.length === 0 && <p className="py-3 text-[13px] text-ink-3">No agent in src/agents/.</p>}
      {agents.map(({ name, fields }) => {
        const definition = definitionOf(fields);
        const override = (section.value[name] ?? {}) as Override;
        const changed = Object.keys(override).length > 0;
        return (
          <AgentRow
            key={name}
            name={name}
            focus={page.closed === name}
            badges={
              <>
                {isSteward(name) && STEWARD}
                {changed && CHANGED}
              </>
            }
            line={
              <>
                <span className="font-mono text-[12px]">{override.model ?? definition.model}</span>
                {` · ${countOf((override.tools ?? definition.tools).length, "tool")} · ${countOf((override.skills ?? definition.skills).length, "skill")}`}
              </>
            }
            actions={
              <Button
                size="sm"
                variant="quiet"
                aria-label={`Edit ${assistantName(name)}`}
                onClick={() => {
                  setFailed(undefined);
                  page.open(name);
                }}
              >
                <EditPencil width={14} height={14} strokeWidth={1.8} />
                Edit
              </Button>
            }
          />
        );
      })}
    </div>
  );
}

export default defineSettings({
  id: "runtime-pi",
  title: "Agents",
  icon: Community,
  group: "Agents",
  order: 0,
  entry: "agents",
  requires: ["settings"],
  keywords: ["agents", "system prompt", "prompt", "model", "thinking", "reasoning", "tools", "skills", "override", "use default"],
  component: CodeAgentsSettings,
});
