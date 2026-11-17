/**
 * A project's History: every change of its record, members, instructions, documents and links, of its
 * memory and of its files, merged newest first (the server merges the three logs, a page at a time),
 * each with who made it and from where, and Undo (the change's earlier state back, through the store
 * that holds it: itself a change, so it can be undone too). The project's own record and its members
 * are the owner's to undo (the server says so). Filters: people or assistants, and what changed.
 */

import { Clock } from "iconoir-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/bui/Button";
import EmptyState from "@/components/bui/EmptyState";
import { Section } from "@/components/bui/Page";
import { ErrorNote } from "@/components/pikit/error-note";
import type { ChatChange, ChatPage } from "@/lib/chat-api";
import { get } from "@/lib/client";
import { asError } from "@/lib/errors";
import { projectApi } from "@/lib/project";
import { useSession } from "@/lib/session";
import type { TabProps } from "./index";
import { undo } from "./overview";
import { ChangeRow, useAction } from "./parts";

const PAGE = 30;
type Who = "all" | "people" | "agents";
const KINDS = ["all", "instructions", "document", "rule", "note", "file", "link", "member", "project"] as const;
const KIND_NAMES: Record<(typeof KINDS)[number], string> = {
  all: "Everything",
  instructions: "Instructions",
  document: "Documents",
  rule: "Rules",
  note: "Notes",
  file: "Files",
  link: "Links",
  member: "Members",
  project: "The project itself",
};

export function HistoryTab({ overview, changed }: TabProps) {
  const { me } = useSession();
  const id = overview.project.id;
  const [items, setItems] = useState<ChatChange[]>();
  const [next, setNext] = useState<string>();
  const [error, setError] = useState<Error>();
  const [round, setRound] = useState(0);
  const [loading, setLoading] = useState(false);
  const [who, setWho] = useState<Who>("all");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("all");
  const action = useAction();

  useEffect(() => {
    let live = true;
    get<ChatPage<ChatChange>>(projectApi(id, `/history?limit=${PAGE}`)).then(
      (page) => live && (setItems(page.items), setNext(page.next), setError(undefined)),
      (thrown: unknown) => live && setError(asError(thrown)),
    );
    return () => {
      live = false;
    };
  }, [id, round]);

  const more = () => {
    if (next === undefined) return;
    setLoading(true);
    get<ChatPage<ChatChange>>(projectApi(id, `/history?limit=${PAGE}&cursor=${encodeURIComponent(next)}`))
      .then(
        (page) => {
          setItems((now) => [...(now ?? []), ...page.items]);
          setNext(page.next);
        },
        (thrown: unknown) => setError(asError(thrown)),
      )
      .finally(() => setLoading(false));
  };

  const shown = (items ?? []).filter(
    (change) => (who === "all" || (who === "agents" ? change.by.kind === "agent" : change.by.kind === "person")) && (kind === "all" || change.item.kind === kind),
  );

  return (
    <Section
      title="History"
      tools={
        <>
          <select className="control h-8 w-auto py-0 text-[13px]" value={who} onChange={(event) => setWho(event.target.value as Who)} aria-label="Who">
            <option value="all">Everyone</option>
            <option value="people">People</option>
            <option value="agents">Assistants</option>
          </select>
          <select className="control h-8 w-auto py-0 text-[13px]" value={kind} onChange={(event) => setKind(event.target.value as (typeof KINDS)[number])} aria-label="What">
            {KINDS.map((each) => (
              <option key={each} value={each}>
                {KIND_NAMES[each]}
              </option>
            ))}
          </select>
        </>
      }
    >
      <p className="text-[12.5px] text-ink-3">Undo brings back what was there before a change; it is a change of its own, so it can be undone too.</p>
      {error !== undefined && <ErrorNote error={error} title="The history cannot be read" />}
      {action.error !== undefined && <ErrorNote error={action.error} title="That could not be undone" />}
      {items !== undefined && shown.length === 0 && <EmptyState icon={<Clock />} title="Nothing here" hint={items.length === 0 ? "Every change of the project shows here." : "No change of this kind on the pages read."} />}
      {shown.length > 0 && (
        <ul className="flex flex-col divide-y divide-line">
          {shown.map((change) => (
            <ChangeRow
              key={`${change.log}-${change.n}`}
              change={change}
              me={me.user.id}
              onUndo={async (each) => {
                if (await action.run(() => undo(id, each))) {
                  setRound((n) => n + 1);
                  changed();
                }
              }}
            />
          ))}
        </ul>
      )}
      {next !== undefined && (
        <Button size="xs" className="self-center" disabled={loading} aria-busy={loading} onClick={more}>
          {loading ? "Loading" : "Load more"}
        </Button>
      )}
    </Section>
  );
}
