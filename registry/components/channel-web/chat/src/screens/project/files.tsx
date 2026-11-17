/**
 * A project's Files (`space.files`): what its people upload and its assistants save, newest first, each
 * with its versions and who saved each. Downloaded (an attachment, never opened in the page), made a
 * document, trashed (30 days, restorable from the trash or History). A name uploaded again is its next
 * version. A text file with a credential's shape is refused by the server, never echoed.
 */

import { Download, Folder, Page as PageIcon, Trash, Undo, Upload } from "iconoir-react";
import { useEffect, useState } from "react";
import { ActionsMenu } from "@/components/bui/ActionsMenu";
import { Button } from "@/components/bui/Button";
import EmptyState from "@/components/bui/EmptyState";
import { Section } from "@/components/bui/Page";
import { Switch } from "@/components/bui/Switch";
import { Dialog } from "@/components/chat/dialog";
import { FormNote, TextField } from "@/components/chat/field";
import { ErrorNote } from "@/components/pikit/error-note";
import { type ChatFiles, type ChatPage, type ChatSpaceFile, MAX_UPLOAD_BYTES } from "@/lib/chat-api";
import { API, post, request, upload, useGet } from "@/lib/client";
import { formatBytes, projectApi } from "@/lib/project";
import { useSession } from "@/lib/session";
import type { TabProps } from "./index";
import { AuthorLine, useAction } from "./parts";

/** A new upload's idempotency key: sent again (a retry), the same version answers. */
const uploadId = (): string => crypto.randomUUID().replace(/-/g, "");

export function FilesTab({ overview, changed }: TabProps) {
  const { me } = useSession();
  const id = overview.project.id;
  const [trashed, setTrashed] = useState(false);
  const read = useGet<ChatFiles>(projectApi(id, `/files${trashed ? "?trashed=1" : ""}`));
  const [uploading, setUploading] = useState(false);
  const [open, setOpen] = useState<string>();
  const action = useAction();
  const files = read.data?.items ?? [];
  const after = () => {
    read.reload();
    changed();
  };
  const fileApi = (name: string, rest = "") => projectApi(id, `/files/${encodeURIComponent(name)}${rest}`);

  return (
    <Section
      title={trashed ? "Trash" : "Files"}
      meta={read.data === undefined ? undefined : `${read.data.usage.names} · ${formatBytes(read.data.usage.bytes)}`}
      tools={
        <>
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
            <Switch checked={trashed} onChange={setTrashed} size="sm" label="Trash" />
            <span aria-hidden>Trash</span>
          </label>
          {!overview.project.archived && (
            <Button size="xs" onClick={() => setUploading(true)}>
              <Upload width={14} height={14} strokeWidth={2} aria-hidden /> Upload
            </Button>
          )}
        </>
      }
    >
      <p className="text-[12.5px] text-ink-3">The project's assistants find files by name and description, and read the text of text files and documents. A binary file cannot be checked for secrets: upload none.</p>
      {action.error !== undefined && <ErrorNote error={action.error} title="That did not work" />}
      {read.error !== undefined && <ErrorNote error={read.error} title="The files cannot be read" />}
      {read.data !== undefined && files.length === 0 && (
        <EmptyState icon={trashed ? <Trash /> : <Folder />} title={trashed ? "The trash is empty" : "No files yet"} hint={trashed ? "A trashed file stays here 30 days." : "Upload one, or ask an assistant to save one here."} />
      )}
      {files.length > 0 && (
        <ul className="records-shell flex flex-col divide-y divide-line">
          {files.map((file) => (
            <li key={file.name} className="flex flex-col">
              <div className="flex items-center gap-3 px-3.5 py-2.5">
                <PageIcon width={16} height={16} strokeWidth={1.8} className="shrink-0 text-ink-3" aria-hidden />
                <button type="button" className="flex min-w-0 flex-1 flex-col items-start text-left" onClick={() => setOpen((now) => (now === file.name ? undefined : file.name))} aria-expanded={open === file.name}>
                  <span className="max-w-full truncate text-[13.5px] text-ink">{file.name}</span>
                  <span className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-3">
                    {formatBytes(file.size)}
                    {(file.versions ?? 1) > 1 && ` · ${file.versions} versions`} · <AuthorLine by={file.by} at={file.createdAt} me={me.user.id} />
                  </span>
                  <span className="max-w-full truncate text-[12px] text-ink-3">{file.description}</span>
                </button>
                {trashed ? (
                  <Button
                    size="xs"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        await post(fileApi(file.name, "/restore"));
                        after();
                      })
                    }
                  >
                    <Undo width={13} height={13} aria-hidden /> Restore
                  </Button>
                ) : (
                  <>
                    <a className="btn btn-ghost btn-icon size-7 text-ink-3 hover:text-ink" href={`${API}${fileApi(file.name)}`} download={file.name} aria-label={`Download ${file.name}`}>
                      <Download width={15} height={15} aria-hidden />
                    </a>
                    {!overview.project.archived && (
                      <ActionsMenu
                        label={`Actions for ${file.name}`}
                        className="btn btn-ghost btn-icon size-7 text-ink-3 hover:text-ink aria-expanded:text-ink"
                        actions={[
                          {
                            key: "document",
                            label: "Make it a document",
                            icon: <PageIcon />,
                            onSelect: () =>
                              void action.run(async () => {
                                await request("POST", projectApi(id, "/documents"), { title: file.name.slice(0, 120), mode: "reference", file: { name: file.name, version: file.version } });
                                changed();
                              }),
                          },
                          {
                            key: "trash",
                            label: "Move to the trash",
                            icon: <Trash />,
                            danger: true,
                            onSelect: () =>
                              void action.run(async () => {
                                await request("DELETE", fileApi(file.name));
                                after();
                              }),
                          },
                        ]}
                      />
                    )}
                  </>
                )}
              </div>
              {open === file.name && <Versions path={fileApi(file.name, "/versions")} download={(version) => `${API}${fileApi(file.name)}?version=${version}`} me={me.user.id} />}
            </li>
          ))}
        </ul>
      )}
      <UploadDialog open={uploading} projectId={id} onClose={() => setUploading(false)} onSaved={after} />
    </Section>
  );
}

function Versions({ path, download, me }: { path: string; download: (version: number) => string; me: string }) {
  const read = useGet<ChatPage<ChatSpaceFile>>(path);
  return (
    <ul className="flex flex-col gap-1 border-t border-line bg-inset px-3.5 py-2">
      {read.error !== undefined && <ErrorNote error={read.error} title="Its versions cannot be read" />}
      {[...(read.data?.items ?? [])].reverse().map((version) => (
        <li key={version.version} className="flex items-center gap-3 text-[12.5px]">
          <span className="w-20 shrink-0 text-ink-2">Version {version.version}</span>
          <AuthorLine by={version.by} at={version.createdAt} me={me} />
          <span className="flex-1" />
          <span className="text-ink-3">{formatBytes(version.size)}</span>
          <a href={download(version.version)} className="text-ink-2 underline decoration-line-strong underline-offset-2 hover:text-ink">
            Download
          </a>
        </li>
      ))}
    </ul>
  );
}

function UploadDialog({ open, projectId, onClose, onSaved }: { open: boolean; projectId: string; onClose: () => void; onSaved: () => void }) {
  const [file, setFile] = useState<File>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [key, setKey] = useState(uploadId);
  const action = useAction();
  useEffect(() => {
    if (!open) return;
    setFile(undefined);
    setName("");
    setDescription("");
    setKey(uploadId());
    action.clear();
  }, [open, action.clear]);

  const save = () =>
    action.run(async () => {
      if (file === undefined) return;
      if (file.size > MAX_UPLOAD_BYTES) throw new Error(`A file is at most ${formatBytes(MAX_UPLOAD_BYTES)}.`);
      const query = new URLSearchParams({ name: name.trim(), description: description.trim(), id: key });
      await upload<ChatSpaceFile>(projectApi(projectId, `/files?${query}`), file);
      onSaved();
      onClose();
    });

  return (
    <Dialog open={open} title="Upload a file" description="Every member and every assistant of the project can read it. The same name again is its next version." onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          <span className="control-label">File</span>
          <input
            type="file"
            className="text-[13px]"
            onChange={(event) => {
              const picked = event.target.files?.[0];
              setFile(picked);
              if (picked !== undefined && name === "") setName(picked.name);
            }}
          />
        </label>
        <TextField label="Name" value={name} onChange={setName} maxLength={255} placeholder="brief-2027.pdf" required />
        <TextField label="Description" value={description} onChange={setDescription} maxLength={500} placeholder="The client's brief for 2027" required />
        {action.error !== undefined && <FormNote>{action.error.message}</FormNote>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={file === undefined || name.trim() === "" || description.trim() === "" || action.busy} aria-busy={action.busy}>
            Upload
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
