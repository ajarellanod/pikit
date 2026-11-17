/**
 * A project's Memory (`memory`, the space's): the rules every assistant of the project follows, active
 * at once, and the notes they keep, each with who added it and from where (an assistant in a chat,
 * answering someone; a member here or by `/rules`); any member adds, rewords (one change: undone in one)
 * and removes them. The summaries of quiet chats, removable. Rules proposed before the space was a
 * project wait for a member: Add or Discard.
 */

import { Check, EditPencil, Plus, Trash, Xmark } from "iconoir-react";
import { useState } from "react";
import { Button } from "@/components/bui/Button";
import { Section } from "@/components/bui/Page";
import { ErrorNote } from "@/components/pikit/error-note";
import { type ChatMemory, type ChatMemoryItem, MEMORY_TEXT_MAX } from "@/lib/chat-api";
import { post, request, useGet } from "@/lib/client";
import { projectApi } from "@/lib/project";
import { useSession } from "@/lib/session";
import type { TabProps } from "./index";
import { AuthorLine, TextArea, useAction } from "./parts";

export function MemoryTab({ overview, changed }: TabProps) {
  const { me } = useSession();
  const id = overview.project.id;
  const read = useGet<ChatMemory>(projectApi(id, "/memory"));
  const action = useAction();
  const after = () => {
    read.reload();
    changed();
  };
  const itemApi = (item: ChatMemoryItem, rest = "") => projectApi(id, `/memory/${encodeURIComponent(item.id)}${rest}`);
  const edit = (item: ChatMemoryItem, text: string) =>
    action.run(async () => {
      await request("PATCH", itemApi(item), { text });
      after();
    });
  const remove = (item: ChatMemoryItem) =>
    void action.run(async () => {
      await request("DELETE", itemApi(item));
      after();
    });
  const add = (kind: "rule" | "note", text: string) =>
    action.run(async () => {
      await request("POST", projectApi(id, "/memory"), { kind, text });
      after();
    });
  const memory = read.data;
  const writable = !overview.project.archived;

  return (
    <div className="flex flex-col gap-10">
      {read.error !== undefined && <ErrorNote error={read.error} title="The memory cannot be read" />}
      {action.error !== undefined && <ErrorNote error={action.error} title="That did not work" />}
      {memory !== undefined && memory.proposed.length > 0 && (
        <Section title="Proposed before this was a project" meta={String(memory.proposed.length)}>
          <p className="text-[12.5px] text-ink-3">An assistant proposed these when this place had no project: nobody saw them yet. Add one to make it a rule for everyone here, or discard it.</p>
          <ul className="records-shell flex flex-col divide-y divide-line">
            {memory.proposed.map((item) => (
              <li key={item.id} className="flex items-start gap-3 px-3.5 py-2.5">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13.5px] text-ink [overflow-wrap:anywhere]">{item.text}</span>
                  <AuthorLine by={item.by} at={item.createdAt} me={me.user.id} />
                </div>
                {writable && (
                  <>
                    <Button
                      size="xs"
                      onClick={() =>
                        void action.run(async () => {
                          await post(itemApi(item, "/approve"));
                          after();
                        })
                      }
                    >
                      <Check width={13} height={13} aria-hidden /> Add
                    </Button>
                    <Button variant="quiet" size="xs" onClick={() => remove(item)}>
                      <Xmark width={13} height={13} aria-hidden /> Discard
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Items
        title="Rules"
        hint="Every assistant of the project follows these, after the instructions. They are active at once, for everyone here."
        kind="rule"
        items={memory?.rules}
        writable={writable}
        onAdd={(text) => add("rule", text)}
        onEdit={edit}
        onRemove={remove}
      />
      <Items
        title="Notes"
        hint="What the assistants noted (data, not instructions): facts about the client, decisions, preferences of the team."
        kind="note"
        items={memory?.notes}
        writable={writable}
        onAdd={(text) => add("note", text)}
        onEdit={edit}
        onRemove={remove}
      />
      {memory !== undefined && memory.summaries.length > 0 && (
        <Items title="Summaries of quiet chats" hint="Written when a chat of the project goes quiet: what the assistants recall of it." kind="summary" items={memory.summaries} writable={writable} onRemove={remove} />
      )}
    </div>
  );
}

function Items({
  title,
  hint,
  kind,
  items,
  writable,
  onAdd,
  onEdit,
  onRemove,
}: {
  title: string;
  hint: string;
  kind: "rule" | "note" | "summary";
  items: ChatMemoryItem[] | undefined;
  writable: boolean;
  onAdd?: (text: string) => Promise<boolean>;
  onEdit?: (item: ChatMemoryItem, text: string) => Promise<boolean>;
  onRemove: (item: ChatMemoryItem) => void;
}) {
  const { me } = useSession();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  return (
    <Section title={title} meta={items === undefined ? undefined : String(items.length)}>
      <p className="text-[12.5px] text-ink-3">{hint}</p>
      {items !== undefined && items.length > 0 && (
        <ul className="records-shell flex flex-col divide-y divide-line">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-3 px-3.5 py-2.5">
              {editing?.id === item.id && onEdit !== undefined ? (
                <form
                  className="flex min-w-0 flex-1 flex-col gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void onEdit(item, editing.text).then((done) => done && setEditing(undefined));
                  }}
                >
                  <TextArea label={`New words of this ${kind}`} value={editing.text} onChange={(text) => setEditing({ id: item.id, text })} rows={3} maxLength={MEMORY_TEXT_MAX} />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="xs" onClick={() => setEditing(undefined)}>
                      Cancel
                    </Button>
                    <Button type="submit" variant="primary" size="xs" disabled={editing.text.trim() === ""}>
                      Save
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[13.5px] whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{item.text}</span>
                    <AuthorLine by={item.by} at={item.updatedAt ?? item.createdAt} me={me.user.id} />
                  </div>
                  {writable && onEdit !== undefined && (
                    <Button variant="quiet" size="xs" aria-label={`Change this ${kind}`} onClick={() => setEditing({ id: item.id, text: item.text })}>
                      <EditPencil width={14} height={14} aria-hidden />
                    </Button>
                  )}
                  {writable && (
                    <Button variant="quiet" size="xs" aria-label={`Remove this ${kind}`} onClick={() => onRemove(item)}>
                      <Trash width={14} height={14} aria-hidden />
                    </Button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {items !== undefined && items.length === 0 && <p className="text-[13px] text-ink-3">None yet.</p>}
      {writable && onAdd !== undefined && (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim() !== "") void onAdd(draft.trim()).then((done) => done && setDraft(""));
          }}
        >
          <div className="min-w-0 flex-1">
            <TextArea label={kind === "rule" ? "A new rule" : "A new note"} value={draft} onChange={setDraft} rows={2} maxLength={MEMORY_TEXT_MAX} placeholder={kind === "rule" ? "Target CPA 18 EUR" : "Juan prefers calls on Tuesdays"} />
          </div>
          <Button type="submit" disabled={draft.trim() === ""}>
            <Plus width={14} height={14} strokeWidth={2} aria-hidden /> Add
          </Button>
        </form>
      )}
    </Section>
  );
}
