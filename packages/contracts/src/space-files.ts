/**
 * `space.files`: the files a space keeps, people's uploads and agents' saves alike, with who saved each
 * version, a trash, a change log and restore (features/projects.md, "Files"; features/spaces.md). What
 * tool-space-files' tools already do, as a capability other components call: channel-web's upload and
 * download routes, projects-context's section and `project_search`, projects-sql's purge.
 *
 *   const files = pikit.use("space.files");
 *   const saved = await files.save(space, { name: "brief.pdf", description: "The 2027 brief", bytes, type: "application/pdf" }, { kind: "person", principal }, ctx);
 *
 * Trusted code only: the capability takes a space and an author and checks neither against a person.
 * Who may act on a space is its caller's to decide first (channel-web: `projects.roleOf`; a tool: its
 * conversation's `spaceOf`); the author is set from what that caller authenticated.
 *
 * What every provider guarantees:
 * - **Per space**: nothing is listed, read, searched, trashed or restored across another space.
 * - **One save function** (`save`) for people and agents: the checks (a name of one line, not a path; a
 *   description; the limits; a credential's shape in a name, a description or a text file's content,
 *   refused `refused` and never echoed), the bytes written first, then the row and its log entry in one
 *   transaction. A binary file cannot be checked and is kept. Idempotent by `id` when given (a tool's
 *   call, an upload's request): a second save of an id answers the version kept the first time.
 * - **Versions**: a name saved again is its next version (1, 2, 3...); every version keeps its author
 *   (`by`) and time. `get` gives the newest unless a version is asked.
 * - **Trash**: `trash(name)` hides a name with all its versions (`trashedAt`); it is listed only when
 *   asked (`trashed: true`), restored by `restore` of its entry, and purged with its bytes
 *   `SPACE_FILES_TRASH_DAYS` after (a `removed` entry, not restorable). An agent author may trash only a
 *   name every version of which agents saved (`forbidden` otherwise): an agent never hides a person's
 *   upload.
 * - **A change log** per space (`../change.ts`: item kind `file`, id the name, title the name): every
 *   save (`added` for a new name, `changed` for a new version), trash (`removed`), restore (`restored`)
 *   and purge (`removed`, `restorable: false`). `restore(n)` brings back the state before `n`: a trashed
 *   name back; the version before a save saved again as the newest (its bytes, description and original
 *   author kept on it; the restorer is the entry's author); a first save undone by trashing the name.
 *   `redact(n)` is an operator's only. Checked by `changeLogCases`.
 * - **Text when available**: a text file's content (`isTextType`, valid UTF-8), or with `document.convert`
 *   the converted text of a document it accepts, is kept beside the row (at most `CONVERT_TEXT_MAX`
 *   characters) and searched (`search`: names, descriptions and texts, FTS5 as memory's: all words, then
 *   the phrase, then any; no query is a syntax error) and read in parts (`text`). A file without text is
 *   found by its name and description only, and says `text: "none"`.
 * - **Limits** (the provider's config): bytes per file (at most `storage.blob`'s `maxBytes`), bytes and
 *   files per space (each version counts). Refused `limit`, saying which.
 * - **Committed before each call resolves**; restarts lose nothing. `purge(space)` (a removed project's
 *   space) deletes every row, entry and byte of the space, for good.
 *
 * Errors: `SpaceFilesError` with `code` `invalid`, `not_found`, `forbidden`, `limit`, `refused`, `gone`.
 *
 * Provider: tool-space-files (its index actor per space, `space-files:<space>`, the bytes in
 * `storage.blob`; a Worker half gives it in the Worker's App, where upload and download routes run, so
 * `storage.blob` must be one every App reaches: storage-blob-s3, or an R2 provider). Users: channel-web,
 * projects-context, projects-sql (purge). Its tools (`files_*`, and `project_file_save`,
 * `project_file_get` in a project's space) call the same functions. One provider: `experimental`.
 */

import type { AppContext } from "@pikit/core";
import type { Author, Change, ChangePage, ChangePageRequest } from "./change.ts";

/** One saved version. A type, not an interface: it crosses actors as JSON. */
export type SpaceFile = {
  /** The version's id: its idempotency key (hex), or one the provider made. */
  id: string;
  /** One line, 1 to `SPACE_FILE_NAME_MAX` characters, not a path. */
  name: string;
  version: number;
  /** 1 to `SPACE_FILE_DESCRIPTION_MAX` characters. */
  description: string;
  size: number;
  /** Hex SHA-256 of the bytes. */
  sha256: string;
  /** Its media type, as saved; absent: unknown (`application/octet-stream`). */
  type?: string;
  /** Who saved this version. */
  by: Author;
  createdAt: number;
  /** When its name was trashed; absent: not in the trash. */
  trashedAt?: number;
  /** Whether its text is kept and searched (`indexed`), or it is found by name and description only (`none`). */
  text: "indexed" | "none";
};

/** A name as `list` gives it: its newest version, with how many it has. */
export type ListedSpaceFile = SpaceFile & { versions: number };

/** What a space keeps: its versions (each one a file), its names, its bytes (trashed ones included until purged). */
export type SpaceFilesUsage = { files: number; names: number; bytes: number };

/** What `save` is given. */
export type NewSpaceFile = {
  name: string;
  description: string;
  bytes: Uint8Array;
  type?: string;
  /** An idempotency key (16 to 64 lowercase hex): the same id saved again answers the version kept the first time. */
  id?: string;
};

/** What `search` finds: a file's newest version and the words around the match (the matched words in `[` `]`). */
export type SpaceFileMatch = { file: SpaceFile; snippet: string; part?: number };

/** One part of a file's text, as `text` reads it. */
export type SpaceFileText = { file: SpaceFile; text: string; part: number; parts: number };

/** The longest name, description, and part of a text `text` answers. */
export const SPACE_FILE_NAME_MAX = 255;
export const SPACE_FILE_DESCRIPTION_MAX = 500;
export const SPACE_FILE_TEXT_PART = 20_000;
/** The most rows `list` and `search` answer. */
export const SPACE_FILES_LIST_MAX = 1000;
/** How long a trashed name stays restorable before it is purged with its bytes. */
export const SPACE_FILES_TRASH_DAYS = 30;

/** Why a call rejected: see the header. */
export type SpaceFilesErrorCode = "invalid" | "not_found" | "forbidden" | "limit" | "refused" | "gone";

export class SpaceFilesError extends Error {
  readonly code: SpaceFilesErrorCode;
  constructor(code: SpaceFilesErrorCode, message: string) {
    super(message);
    this.name = "SpaceFilesError";
    this.code = code;
  }
}

/** The `space.files` capability. */
export interface SpaceFiles {
  /** The newest version of each name, newest first; trashed names only with `trashed: true` (then only those). */
  list(space: string, query: { limit: number; trashed?: boolean }, ctx: AppContext): Promise<{ files: ListedSpaceFile[]; usage: SpaceFilesUsage }>;
  /** A version's row (the newest without `version`); `undefined` when none, or trashed unless `trashed: true`. */
  file(space: string, name: string, query: { version?: number; trashed?: boolean }, ctx: AppContext): Promise<SpaceFile | undefined>;
  /** A version's row and its bytes whole (at most the provider's per-file limit). */
  get(space: string, name: string, query: { version?: number }, ctx: AppContext): Promise<{ file: SpaceFile; bytes: Uint8Array } | undefined>;
  /** A version's bytes as a stream, for a download route. */
  download(space: string, name: string, query: { version?: number }, ctx: AppContext): Promise<{ file: SpaceFile; body: ReadableStream<Uint8Array>; size: number } | undefined>;
  /** Saves `file` as its name's next version, by `by`: see the header. */
  save(space: string, file: NewSpaceFile, by: Author, ctx: AppContext): Promise<SpaceFile>;
  /** Every version of `name`, oldest first. */
  versions(space: string, name: string, ctx: AppContext): Promise<SpaceFile[]>;
  /** Moves `name` with its versions to the trash; `false` when no such name is out of the trash. An agent: only names agents alone saved. */
  trash(space: string, name: string, by: Author, ctx: AppContext): Promise<boolean>;
  /** Names, descriptions and texts matching `query`'s words, the best `limit` first; trashed names never. */
  search(space: string, query: string, limit: number, ctx: AppContext): Promise<SpaceFileMatch[]>;
  /** Part `part` (from 1) of a version's text, `SPACE_FILE_TEXT_PART` characters a part; `undefined` when it has none. */
  text(space: string, name: string, query: { version?: number; part: number }, ctx: AppContext): Promise<SpaceFileText | undefined>;
  /** The space's log, newest first. */
  changes(space: string, page: ChangePageRequest, ctx: AppContext): Promise<ChangePage>;
  /** Brings back the state before change `n`, appended as a `restored` change by `by`. */
  restore(space: string, n: number, by: Author, ctx: AppContext): Promise<Change>;
  /** Blanks the stored states of change `n` (an operator's only: `forbidden` for any other author). */
  redact(space: string, n: number, by: Author, ctx: AppContext): Promise<void>;
  /** Deletes everything of `space`, rows, log and bytes, for good: a removed project's purge. */
  purge(space: string, ctx: AppContext): Promise<void>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    "space.files": SpaceFiles;
  }
}

/** Why `name` cannot name a saved file, or `undefined`: one line of 1 to 255 characters, not a path. */
export function spaceFileNameProblem(name: string): string | undefined {
  if (name.length === 0 || name.length > SPACE_FILE_NAME_MAX) return `a file's name is 1 to ${SPACE_FILE_NAME_MAX} characters`;
  if (name.trim() !== name) return "a file's name has no space at either end";
  if (name === "." || name === ".." || /[/\\]/.test(name)) return 'a file\'s name is not a path: no "/" or "\\", not "." or ".."';
  if ([...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return "a file's name has no control characters";
  return undefined;
}

/** Why `description` cannot describe a saved file, or `undefined`. */
export function spaceFileDescriptionProblem(description: string): string | undefined {
  if (description.trim() === "" || description.length > SPACE_FILE_DESCRIPTION_MAX) return `a description is 1 to ${SPACE_FILE_DESCRIPTION_MAX} characters`;
  return undefined;
}

/** Whether `by` may trash a name whose versions were saved by `savers`: anyone but an agent; an agent only when agents saved every version. */
export const mayTrash = (by: Author, savers: readonly Author[]): boolean => by.kind !== "agent" || savers.every((saver) => saver.kind === "agent");
