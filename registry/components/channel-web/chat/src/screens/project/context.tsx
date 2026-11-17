/**
 * A project's Context: what its assistants know before the first word of a chat.
 *
 * - **Instructions**, always whole: written over the version read (`ifVersion`); when another member
 *   saved meanwhile the server says `409`, and the page says so and shows theirs, never overwriting it.
 *   Each version is kept: one is brought back by saving it again (a new version, itself undoable).
 * - **Documents**: core ones are in every request, whole, within a budget (the meter; the server
 *   refuses one past it, saying what is left), reference ones are searched and read when needed. Added
 *   from text, or from a file: text and Markdown as they are, a PDF or an Office file converted when the
 *   App can (`ChatConfig.projects.convert`). Read a part at a time; made core or reference; removed.
 * - **Links** the project keeps (a folder, a sheet), with who added each.
 */

import { Link as LinkIcon, Page as PageIcon, Plus, Trash } from "iconoir-react";
import { useEffect, useState } from "react";
import { ActionsMenu } from "@/components/bui/ActionsMenu";
import { Badge } from "@/components/bui/Badge";
import { Button } from "@/components/bui/Button";
import EmptyState from "@/components/bui/EmptyState";
import { Section } from "@/components/bui/Page";
import { Dialog } from "@/components/chat/dialog";
import { FormNote, TextField } from "@/components/chat/field";
import { ErrorNote } from "@/components/pikit/error-note";
import {
  type ChatDocument,
  type ChatDocumentRead,
  type ChatDocuments,
  type ChatInstructions,
  type ChatInstructionsRead,
  type ChatLink,
  type ChatPage,
  type ChatVersion,
  INSTRUCTIONS_MAX,
  MAX_UPLOAD_BYTES,
} from "@/lib/chat-api";
import { get, request, upload, useGet } from "@/lib/client";
import { ChatFailure } from "@/lib/errors";
import { formatBytes, projectApi, tokensOf } from "@/lib/project";
import { useSession } from "@/lib/session";
import type { TabProps } from "./index";
import { AuthorLine, Card, TextArea, TokenMeter, useAction } from "./parts";

export function ContextTab(props: TabProps) {
  return (
    <div className="flex flex-col gap-10">
      <Instructions {...props} />
      <Documents {...props} />
      <Links {...props} />
    </div>
  );
}

function Instructions({ overview, changed }: TabProps) {
  const { me } = useSession();
  const id = overview.project.id;
  const read = useGet<ChatInstructionsRead>(projectApi(id, "/instructions"));
  const versions = useGet<ChatPage<ChatVersion>>(projectApi(id, "/instructions/versions"));
  const current = read.data?.instructions;
  const [text, setText] = useState("");
  const [base, setBase] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const action = useAction();

  // What was read becomes the text being written, unless something is being written.
  useEffect(() => {
    if (read.data === undefined) return;
    setText(read.data.instructions?.text ?? "");
    setBase(read.data.instructions?.version ?? 0);
  }, [read.data]);

  const dirty = text !== (current?.text ?? "");
  const save = (value: string, over: number) =>
    action.run(async () => {
      try {
        const saved = await request<ChatInstructions>("PUT", projectApi(id, "/instructions"), { text: value, ifVersion: over });
        setText(saved.text);
        setBase(saved.version);
        setConflict(false);
        read.reload();
        versions.reload();
        changed();
      } catch (error) {
        if (error instanceof ChatFailure && error.status === 409) {
          setConflict(true);
          read.reload();
          versions.reload();
        }
        throw error;
      }
    });

  return (
    <Section title="Instructions" meta={current === undefined ? "none yet" : `version ${current.version}`}>
      <Card className="flex flex-col gap-3">
        <TextArea
          label="What every assistant of this project follows"
          value={text}
          onChange={setText}
          rows={8}
          maxLength={INSTRUCTIONS_MAX}
          placeholder="Who the project is for, its goals, how to answer…"
          hint={`${text.length.toLocaleString()} of ${INSTRUCTIONS_MAX.toLocaleString()} characters. Always in context, whole; rules and notes come after them.`}
          disabled={overview.project.archived}
        />
        {conflict && <FormNote>Someone changed the instructions meanwhile: theirs are shown now. Write yours again over them.</FormNote>}
        {action.error !== undefined && !conflict && <ErrorNote error={action.error} title="The instructions were not saved" />}
        <div className="flex flex-wrap items-center gap-2">
          {current !== undefined && <AuthorLine by={current.by} at={current.at} me={me.user.id} />}
          <span className="flex-1" />
          <Button variant="ghost" size="xs" onClick={() => setShowVersions((now) => !now)}>
            {showVersions ? "Hide versions" : "Versions"}
          </Button>
          <Button variant="primary" size="xs" disabled={!dirty || action.busy || overview.project.archived} aria-busy={action.busy} onClick={() => void save(text, base)}>
            Save
          </Button>
        </div>
        {showVersions && (
          <ul className="flex flex-col divide-y divide-line border-t border-line">
            {[...(versions.data?.items ?? [])].reverse().map((version) => (
              <li key={version.version} className="flex items-center gap-3 py-2 text-[13px]">
                <span className="w-20 shrink-0 text-ink">Version {version.version}</span>
                <AuthorLine by={version.by} at={version.at} me={me.user.id} />
                <span className="flex-1" />
                <span className="text-[12px] text-ink-3">{version.chars.toLocaleString()} characters</span>
                {version.version !== current?.version && (
                  <Button
                    variant="quiet"
                    size="xs"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        const old = await get<ChatInstructionsRead>(projectApi(id, `/instructions?version=${version.version}`));
                        if (old.instructions !== undefined) await save(old.instructions.text, current?.version ?? 0);
                      })
                    }
                  >
                    Bring back
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Section>
  );
}

function Documents({ overview, changed }: TabProps) {
  const { me, config } = useSession();
  const id = overview.project.id;
  const read = useGet<ChatDocuments>(projectApi(id, "/documents"));
  const [adding, setAdding] = useState(false);
  const [reading, setReading] = useState<ChatDocument>();
  const action = useAction();
  const documents = read.data?.items ?? [];
  const after = () => {
    read.reload();
    changed();
  };
  const setMode = (document: ChatDocument, mode: "core" | "reference") =>
    void action.run(async () => {
      await request("PATCH", projectApi(id, `/documents/${encodeURIComponent(document.id)}`), { mode, ifVersion: document.version });
      after();
    });

  return (
    <Section
      title="Documents"
      meta={String(documents.length)}
      tools={
        !overview.project.archived && (
          <Button size="xs" onClick={() => setAdding(true)}>
            <Plus width={14} height={14} strokeWidth={2} aria-hidden /> Add a document
          </Button>
        )
      }
    >
      {read.data !== undefined && <TokenMeter used={read.data.coreTokens} budget={read.data.coreBudget} />}
      {action.error !== undefined && <ErrorNote error={action.error} title="That did not work" />}
      {read.error !== undefined && <ErrorNote error={read.error} title="The documents cannot be read" />}
      {read.data !== undefined && documents.length === 0 && (
        <EmptyState icon={<PageIcon />} title="No documents yet" hint="A brief, a plan, a price list: core ones are always in context, reference ones are searched when needed." />
      )}
      {documents.length > 0 && (
        <ul className="records-shell flex flex-col divide-y divide-line">
          {documents.map((document) => (
            <li key={document.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <PageIcon width={16} height={16} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
              <button type="button" className="flex min-w-0 flex-1 flex-col items-start text-left" onClick={() => setReading(document)}>
                <span className="flex max-w-full items-center gap-2 text-[13.5px] text-ink">
                  <span className="truncate">{document.title}</span>
                  <Badge tone={document.mode === "core" ? "accent" : "neutral"}>{document.mode === "core" ? "Core" : "Reference"}</Badge>
                </span>
                <span className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-3">
                  about {document.tokens.toLocaleString()} tokens · version {document.version}
                  {document.source !== undefined && ` · from ${document.source.file}`} ·
                  <AuthorLine by={document.by} at={document.at} me={me.user.id} />
                </span>
              </button>
              {!overview.project.archived && (
                <ActionsMenu
                  label={`Actions for ${document.title}`}
                  className="btn btn-ghost btn-icon size-7 text-ink-3 hover:text-ink aria-expanded:text-ink"
                  actions={[
                    document.mode === "core"
                      ? { key: "reference", label: "Make it reference (searched)", icon: <PageIcon />, onSelect: () => setMode(document, "reference") }
                      : { key: "core", label: "Make it core (always in context)", icon: <PageIcon />, onSelect: () => setMode(document, "core") },
                    {
                      key: "remove",
                      label: "Remove",
                      icon: <Trash />,
                      danger: true,
                      onSelect: () =>
                        void action.run(async () => {
                          await request("DELETE", projectApi(id, `/documents/${encodeURIComponent(document.id)}`));
                          after();
                        }),
                    },
                  ]}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <AddDocument
        open={adding}
        projectId={id}
        convert={config.projects?.convert === true}
        coreTokens={read.data?.coreTokens ?? 0}
        coreBudget={read.data?.coreBudget ?? 0}
        onClose={() => setAdding(false)}
        onAdded={after}
      />
      <ReadDocument projectId={id} document={reading} onClose={() => setReading(undefined)} />
    </Section>
  );
}

/** Text and Markdown are read as they are; with a converter, PDFs and Office files too. */
const TEXT_ACCEPT = ".txt,.md,.markdown,.csv,.json,.xml,.yaml,.yml,.html,text/*";
const CONVERT_ACCEPT = `${TEXT_ACCEPT},.pdf,.docx,.xlsx,.pptx,.odt,.ods,.odp`;

function AddDocument({
  open,
  projectId,
  convert,
  coreTokens,
  coreBudget,
  onClose,
  onAdded,
}: {
  open: boolean;
  projectId: string;
  convert: boolean;
  coreTokens: number;
  coreBudget: number;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"core" | "reference">("reference");
  const [from, setFrom] = useState<"text" | "file">("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File>();
  const action = useAction();
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setText("");
    setFile(undefined);
    setMode("reference");
    setFrom("text");
    action.clear();
  }, [open, action.clear]);

  const ready = title.trim() !== "" && (from === "text" ? text.trim() !== "" : file !== undefined);
  const add = () =>
    action.run(async () => {
      if (from === "text") await request<ChatDocument>("POST", projectApi(projectId, "/documents"), { title: title.trim(), mode, text });
      else if (file !== undefined) {
        if (file.size > MAX_UPLOAD_BYTES) throw new Error(`A file is at most ${formatBytes(MAX_UPLOAD_BYTES)}.`);
        await upload<ChatDocument>(projectApi(projectId, `/documents/upload?title=${encodeURIComponent(title.trim())}&mode=${mode}`), file);
      }
      onAdded();
      onClose();
    });

  return (
    <Dialog open={open} title="Add a document" description="Its assistants read it as data, never as instructions; they name it when they rely on it." onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <TextField label="Title" value={title} onChange={setTitle} maxLength={120} placeholder="Brief 2027" required autoFocus />
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="How it is read">
          {(["reference", "core"] as const).map((each) => (
            <button key={each} type="button" role="radio" aria-checked={mode === each} onClick={() => setMode(each)} className={`btn btn-xs ${mode === each ? "btn-primary" : "btn-outline"}`}>
              {each === "core" ? "Core: always in context" : "Reference: searched"}
            </button>
          ))}
        </div>
        <div className="flex gap-2" role="radiogroup" aria-label="From">
          {(["text", "file"] as const).map((each) => (
            <button key={each} type="button" role="radio" aria-checked={from === each} onClick={() => setFrom(each)} className={`btn btn-xs ${from === each ? "btn-primary" : "btn-ghost"}`}>
              {each === "text" ? "Write or paste" : "From a file"}
            </button>
          ))}
        </div>
        {from === "text" ? (
          <TextArea label="Text" value={text} onChange={setText} rows={8} placeholder="Paste the document" hint={`About ${tokensOf(text).toLocaleString()} tokens.`} />
        ) : (
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            <span className="control-label">File</span>
            <input type="file" accept={convert ? CONVERT_ACCEPT : TEXT_ACCEPT} onChange={(event) => setFile(event.target.files?.[0])} className="text-[13px]" />
            <span className="text-[12px] text-ink-3">{convert ? "Text, Markdown, CSV, a PDF or an Office file." : "Text, Markdown or CSV."}</span>
          </label>
        )}
        {mode === "core" && <TokenMeter used={coreTokens} budget={coreBudget} adding={from === "text" ? tokensOf(text) : 0} />}
        {action.error !== undefined && <FormNote>{action.error.message}</FormNote>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!ready || action.busy} aria-busy={action.busy}>
            Add it
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ReadDocument({ projectId, document, onClose }: { projectId: string; document: ChatDocument | undefined; onClose: () => void }) {
  const [part, setPart] = useState(1);
  useEffect(() => setPart(1), [document?.id]);
  const read = useGet<ChatDocumentRead>(document === undefined ? null : projectApi(projectId, `/documents/${encodeURIComponent(document.id)}?part=${part}`));
  const shown = read.data?.document.id === document?.id ? read.data : undefined;
  return (
    <Dialog open={document !== undefined} title={document?.title ?? ""} description={shown === undefined ? undefined : `Part ${shown.part} of ${shown.parts} · version ${shown.document.version}`} onClose={onClose}>
      {read.error !== undefined && <ErrorNote error={read.error} title="It cannot be read" />}
      <pre className="max-h-[50vh] overflow-auto rounded-control bg-inset p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink-2 shadow-hairline">{shown?.text ?? "…"}</pre>
      <div className="flex justify-end gap-2">
        {shown !== undefined && shown.parts > 1 && (
          <>
            <Button variant="ghost" size="xs" disabled={part <= 1} onClick={() => setPart((now) => now - 1)}>
              Previous part
            </Button>
            <Button variant="ghost" size="xs" disabled={part >= shown.parts} onClick={() => setPart((now) => now + 1)}>
              Next part
            </Button>
          </>
        )}
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}

function Links({ overview, changed }: TabProps) {
  const { me } = useSession();
  const id = overview.project.id;
  const read = useGet<ChatPage<ChatLink>>(projectApi(id, "/links"));
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const action = useAction();
  const links = read.data?.items ?? [];
  const add = () =>
    action.run(async () => {
      await request<ChatLink>("POST", projectApi(id, "/links"), { url: url.trim(), title: title.trim() || url.trim() });
      setUrl("");
      setTitle("");
      read.reload();
      changed();
    });
  return (
    <Section title="Links" meta={String(links.length)}>
      {links.length > 0 && (
        <ul className="records-shell flex flex-col divide-y divide-line">
          {links.map((link) => (
            <li key={link.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <LinkIcon width={15} height={15} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
              <span className="flex min-w-0 flex-1 flex-col">
                <a href={link.url} target="_blank" rel="noopener noreferrer" className="truncate text-[13.5px] text-ink underline decoration-line-strong underline-offset-2">
                  {link.title}
                </a>
                <AuthorLine by={link.by} at={link.at} me={me.user.id} />
              </span>
              {!overview.project.archived && (
                <Button
                  variant="quiet"
                  size="xs"
                  aria-label={`Remove ${link.title}`}
                  onClick={() =>
                    void action.run(async () => {
                      await request("DELETE", projectApi(id, `/links/${encodeURIComponent(link.id)}`));
                      read.reload();
                      changed();
                    })
                  }
                >
                  <Trash width={14} height={14} aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!overview.project.archived && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim() !== "") void add();
          }}
        >
          <div className="min-w-[220px] flex-[2]">
            <TextField label="Link" value={url} onChange={setUrl} placeholder="https://drive.google.com/…" />
          </div>
          <div className="min-w-[160px] flex-1">
            <TextField label="Title" value={title} onChange={setTitle} maxLength={120} placeholder="The 2027 folder" required={false} />
          </div>
          <Button type="submit" disabled={url.trim() === "" || action.busy}>
            Add
          </Button>
        </form>
      )}
      {action.error !== undefined && <ErrorNote error={action.error} title="That did not work" />}
    </Section>
  );
}
