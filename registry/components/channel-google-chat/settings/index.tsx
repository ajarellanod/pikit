// Owner: admission. channel-google-chat's section of the Settings dialog: each Chat app's `conversations` setting.
/**
 * What it edits (instance.ts `settingsSchemaOf`): per instance (`googlechat`, `googlechat:ops`), its
 * `conversations`: `default` (each thread a conversation, or the whole chat one) and `chats`, the spaces
 * that differ (`spaces/AAA` → `"thread"` or `"chat"`). Its defaults are the config's `conversations`;
 * "Use the config's" takes an app's changes away. A change applies to the next message: a conversation
 * already going keeps its key.
 *
 * Each change saves at once (the default, a chat's mode, a chat added or removed), the component's
 * whole value with only the apps that differ from the config (`storedOf`); a refusal is shown.
 */

import { ChatBubble, Plus, Trash } from "iconoir-react";
import { useState } from "react";
import { Button } from "@/components/bui/Button";
import { ErrorNote } from "@/components/pikit/error-note";
import { Segmented, SettingsHeading, SettingsRow, storedOf } from "@/components/pikit/settings";
import { defineSettings, type SettingsValue, useSettings } from "@/lib/settings";

type Mode = "thread" | "chat";
type Conversations = { default: Mode; chats: Record<string, Mode> };

const MODES = [
  { value: "thread" as const, label: "Each thread" },
  { value: "chat" as const, label: "The whole chat" },
];

const input =
  "h-8 w-full min-w-0 rounded-control bg-surface px-2.5 text-[13px] text-ink shadow-btn outline-none transition-shadow duration-100 placeholder:text-ink-3 focus-visible:shadow-[0_0_0_1px_var(--line-strong),0_0_0_3px_var(--accent-tint)]";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** An app's `conversations` in `value`, else `fallback`'s, else each thread a conversation. */
function conversationsIn(value: SettingsValue, instance: string, fallback?: SettingsValue): Conversations {
  const read = (from: SettingsValue | undefined) => (from?.[instance] as { conversations?: Partial<Conversations> } | undefined)?.conversations;
  const found = read(value) ?? read(fallback);
  return { default: found?.default === "chat" ? "chat" : "thread", chats: { ...(found?.chats ?? {}) } };
}

/** `text` as a space's name (`spaces/AAA`, or its id `AAA`), or `undefined` when it is neither. */
function spaceName(text: string): string | undefined {
  const trimmed = text.trim();
  const name = trimmed.startsWith("spaces/") ? trimmed : `spaces/${trimmed}`;
  return /^spaces\/[A-Za-z0-9_-]+$/.test(name) ? name : undefined;
}

function AppConversations({ instance, conversations, defaults, saving, onSave }: { instance: string; conversations: Conversations; defaults: Conversations; saving: boolean; onSave: (next: Conversations) => void }) {
  const [adding, setAdding] = useState("");
  const [addMode, setAddMode] = useState<Mode>("chat");
  const [problem, setProblem] = useState<string>();
  const chats = Object.entries(conversations.chats).sort(([a], [b]) => a.localeCompare(b));

  const add = () => {
    const name = spaceName(adding);
    if (name === undefined) return setProblem("A space's name (spaces/AAA) or its id (AAA).");
    setProblem(undefined);
    setAdding("");
    onSave({ ...conversations, chats: { ...conversations.chats, [name]: addMode } });
  };
  const remove = (name: string) => {
    const { [name]: _removed, ...rest } = conversations.chats;
    onSave({ ...conversations, chats: rest });
  };

  return (
    <>
      <SettingsHeading
        aside={
          !same(conversations, defaults) && (
            <Button size="sm" variant="quiet" disabled={saving} onClick={() => onSave(defaults)}>
              Use the config's
            </Button>
          )
        }
      >
        {instance}
      </SettingsHeading>
      <SettingsRow label="A conversation is" description="Each thread its own conversation, or the whole chat one. Answers go to their message's thread either way.">
        <Segmented label={`${instance}: a conversation is`} value={conversations.default} options={MODES} disabled={saving} onChange={(mode) => onSave({ ...conversations, default: mode })} />
      </SettingsRow>
      {chats.map(([name, mode]) => (
        <SettingsRow key={name} label={<span className="font-mono text-[13px]">{name}</span>} description={mode === "chat" ? "The whole chat is one conversation." : "Each thread is a conversation."}>
          <div className="flex items-center gap-2">
            <Segmented label={`${name}: a conversation is`} value={mode} options={MODES} disabled={saving} onChange={(next) => onSave({ ...conversations, chats: { ...conversations.chats, [name]: next } })} />
            <Button size="xs" variant="quiet" aria-label={`Remove ${name}`} disabled={saving} onClick={() => remove(name)}>
              <Trash width={14} height={14} strokeWidth={1.8} />
            </Button>
          </div>
        </SettingsRow>
      ))}
      <div className="mt-3 flex items-center gap-2">
        <input
          aria-label={`${instance}: a chat that differs`}
          value={adding}
          placeholder="spaces/AAA"
          onChange={(event) => setAdding(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && adding.trim() !== "" && add()}
          className={`${input} max-w-56`}
        />
        <Segmented label="Its conversations" value={addMode} options={MODES} onChange={setAddMode} />
        <Button size="sm" variant="secondary" disabled={saving || adding.trim() === ""} onClick={add}>
          <Plus width={14} height={14} strokeWidth={2} />
          Add a chat
        </Button>
      </div>
      {problem !== undefined && <p className="mt-1.5 text-[13px] text-ink-3">{problem}</p>}
    </>
  );
}

function GoogleChatSettings() {
  const settings = useSettings("channel-google-chat");
  const [failed, setFailed] = useState<Error>();

  if (settings.error !== undefined && settings.section === undefined) return <ErrorNote error={settings.error} title="Google Chat's settings cannot be read" />;
  const section = settings.section;
  if (section === undefined) return <p className="text-[13px] text-ink-3">Loading</p>;
  const instances = Object.keys(section.schema.properties ?? {});

  const save = (instance: string, conversations: Conversations) => {
    setFailed(undefined);
    settings.save(storedOf({ ...section.value, [instance]: { conversations } }, section.defaults)).catch((thrown: unknown) => setFailed(thrown instanceof Error ? thrown : new Error(String(thrown))));
  };

  return (
    <div>
      {failed !== undefined && (
        <div className="mb-4">
          <ErrorNote error={failed} title="Not saved" />
        </div>
      )}
      <p className="mb-4 text-[13px] leading-snug text-ink-3">
        Which messages share a conversation, per Chat app: by default each thread is one, and a chat listed below can be one conversation as a whole. A change applies to the next message: a conversation already going keeps going. A chat
        without threads (a meeting's) is always one conversation.
      </p>
      {instances.map((instance) => (
        <AppConversations
          key={instance}
          instance={instance}
          conversations={conversationsIn(section.value, instance, section.defaults)}
          defaults={conversationsIn(section.defaults, instance)}
          saving={settings.saving}
          onSave={(next) => save(instance, next)}
        />
      ))}
    </div>
  );
}

export default defineSettings({
  id: "channel-google-chat",
  title: "Google Chat",
  icon: ChatBubble,
  order: 20,
  requires: ["settings"],
  keywords: ["google chat", "threads", "conversations", "spaces", "chat"],
  component: GoogleChatSettings,
});
