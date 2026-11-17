/**
 * `space.files` (`@pikit/contracts`' space-files.ts) as the App that calls it sees it: every operation is
 * a call to the space's actor (`space.ts`), and the bytes are read and written here, in the caller's
 * App (a conversation's for the tools, the Worker's for channel-web's upload route), over the
 * component's `storage.blob` namespace. Both halves of the component provide this same object.
 *
 * `save` is the one save path, for the tools and for people's uploads alike:
 * 1. the checks that need no actor: the space, the author (`parseAuthor`), the bytes, the name
 *    (`spaceFileNameProblem`), the description, the type, the id; a credential's shape in the name or
 *    the description (`refused`, never echoed);
 * 2. the actor's `status` of the id: a second save of an id answers the version kept the first time,
 *    before anything is read or written; then the limits (`limit`), before any byte is written;
 * 3. the text: a valid UTF-8 file's content holding a credential's shape is `refused` whatever its
 *    type; a text file's own text (no type, or `isTextType`), else with `document.convert` a document
 *    it accepts, converted (a conversion that fails keeps the file with no text: `text: "none"`), cut to
 *    `CONVERT_TEXT_MAX`; a converted text holding a credential is `refused` too;
 * 4. the bytes, at `<hex SHA-256 of the space>/<id>`;
 * 5. the actor's `save`: the row, its text parts and its log entry in one transaction. Refused there
 *    (a limit passed meanwhile, a credential, a malformed call), the bytes just written are deleted; any
 *    other failure (unreachable, cancelled) keeps them, since the row may have been written: a retry of
 *    the same id finds it.
 *
 * `get` and `download` check the bytes against the size and SHA-256 kept with the row: missing or
 * damaged bytes are `gone`, never served (a download's stream errors at its end).
 */

import type { AppContext } from "@pikit/core";
import {
  ActorCallError,
  type Author,
  type BlobStore,
  type Change,
  ChangeInputError,
  type ChangePage,
  ConvertError,
  createBlobHash,
  cutText,
  type DocumentConverter,
  isTextType,
  type JsonValue,
  type ListedSpaceFile,
  type NewSpaceFile,
  parseAuthor,
  type SpaceFile,
  type SpaceFileMatch,
  type SpaceFiles,
  SpaceFilesError,
  type SpaceFilesErrorCode,
  type SpaceFilesUsage,
  type SpaceFileText,
  spaceFileDescriptionProblem,
  spaceFileNameProblem,
  textOf,
} from "@pikit/contracts";
import {
  actorKey,
  blobKey,
  CALL,
  FILE_ID,
  holdsCredential,
  type Limits,
  limitProblem,
  type Located,
  newFileId,
  SPACE_MAX,
  type SavedFileInput,
  sha256Hex,
  textHoldsCredential,
  typeProblem,
} from "./space.ts";

/** The text the caller reads when a file holds a secret. */
export const SECRET_REFUSAL = "the file looks like it holds a credential (a key, a token, a password): a space never keeps a secret. Remove it and save again.";

/** What `space.files` works with in the App that calls it. */
export type SpaceFilesDeps = {
  /** Calls the space's actor: `actor.mailbox`'s `call`. */
  call(key: string, type: string, message: JsonValue, ctx: AppContext): Promise<JsonValue>;
  /** The component's `storage.blob` namespace. */
  blobs(): BlobStore;
  /** `document.convert`, when the App has it. */
  convert(): DocumentConverter | undefined;
  /** A new version id (random hex) when `save` is given none. */
  newId?: () => string;
};

/** `space.files`, and what the tools also ask: whether a save of an id was kept already. */
export interface SpaceFilesClient extends SpaceFiles {
  /** The version saved under `id`, if any (a replayed tool call's): read before the file is. */
  saved(space: string, id: string, ctx: AppContext): Promise<SpaceFile | undefined>;
}

const CODES: ReadonlySet<string> = new Set<SpaceFilesErrorCode>(["invalid", "not_found", "forbidden", "limit", "refused", "gone"]);
const fail = (code: SpaceFilesErrorCode, message: string): never => {
  throw new SpaceFilesError(code, message);
};

const checkSpace = (space: string) => {
  if (typeof space !== "string" || space === "" || space.length > SPACE_MAX) fail("invalid", `a space is a non-empty string of at most ${SPACE_MAX} characters`);
};
const checkAuthor = (by: Author): Author => {
  try {
    return parseAuthor(by);
  } catch (error) {
    if (error instanceof ChangeInputError) return fail("invalid", error.message);
    throw error;
  }
};

export function spaceFilesOver(deps: SpaceFilesDeps): SpaceFilesClient {
  /** A call to `space`'s actor; its refusals as `SpaceFilesError`s of the same code. */
  const ask = async <T>(space: string, type: string, fields: Record<string, JsonValue>, ctx: AppContext): Promise<T> => {
    checkSpace(space);
    try {
      return (await deps.call(actorKey(space), type, { space, ...fields }, ctx)) as T;
    } catch (error) {
      if (error instanceof ActorCallError && CODES.has(error.code)) throw new SpaceFilesError(error.code as SpaceFilesErrorCode, error.message);
      throw error;
    }
  };
  const versionField = (version: number | undefined): Record<string, JsonValue> => (version === undefined ? {} : { version });
  const located = (space: string, name: string, version: number | undefined, ctx: AppContext) =>
    ask<Located | null>(space, CALL.file, { name, ...versionField(version) }, ctx).then((found) => found ?? undefined);
  const damaged = (file: SpaceFile) => new SpaceFilesError("gone", `the bytes of ${file.name} (version ${file.version}) are missing or damaged in storage`);

  /** The text a save keeps, or `undefined`; `refused` for a credential's shape. */
  const textFor = async (input: NewSpaceFile, ctx: AppContext): Promise<string | undefined> => {
    const own = textOf(input.bytes);
    if (own !== undefined && textHoldsCredential(own)) fail("refused", SECRET_REFUSAL);
    if (own !== undefined && own.trim() !== "" && (input.type === undefined || isTextType(input.type))) return cutText(own);
    const convert = deps.convert();
    if (input.type === undefined || convert === undefined || !convert.accepts(input.type) || input.bytes.byteLength > convert.maxBytes) return undefined;
    let converted: { text: string } | undefined;
    try {
      converted = await convert.convert({ bytes: input.bytes, type: input.type, name: input.name }, ctx);
    } catch (error) {
      // Kept with no text: found by its name and description. The error never holds the document.
      if (error instanceof ConvertError) {
        ctx.logger.warn("tool-space-files: a file's text could not be read", { code: error.code });
        return undefined;
      }
      throw error;
    }
    if (converted === undefined || converted.text.trim() === "") return undefined;
    if (textHoldsCredential(converted.text)) fail("refused", SECRET_REFUSAL);
    return cutText(converted.text);
  };

  return {
    list: (space, query, ctx) => ask<{ files: ListedSpaceFile[]; usage: SpaceFilesUsage }>(space, CALL.list, { limit: query.limit, ...(query.trashed === true && { trashed: true }) }, ctx),

    file: async (space, name, query, ctx) =>
      (await ask<Located | null>(space, CALL.file, { name, ...versionField(query.version), ...(query.trashed === true && { trashed: true }) }, ctx))?.file,

    async get(space, name, query, ctx) {
      const found = await located(space, name, query.version, ctx);
      if (found === undefined) return undefined;
      const value = await deps.blobs().get(await blobKey(space, found.blob));
      if (value === undefined || value.bytes.byteLength !== found.file.size || (await sha256Hex(value.bytes)) !== found.file.sha256) throw damaged(found.file);
      return { file: found.file, bytes: value.bytes };
    },

    async download(space, name, query, ctx) {
      const found = await located(space, name, query.version, ctx);
      if (found === undefined) return undefined;
      const { file } = found;
      const stream = await deps.blobs().getStream(await blobKey(space, found.blob));
      if (stream === undefined || stream.size !== file.size) {
        await stream?.body.cancel();
        throw damaged(file);
      }
      const hash = createBlobHash();
      const body = stream.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            hash.update(chunk);
            controller.enqueue(chunk);
          },
          flush(controller) {
            if (hash.digest() !== file.sha256) controller.error(damaged(file));
          },
        }),
      );
      return { file, body, size: file.size };
    },

    async save(space, input, by, ctx) {
      checkSpace(space);
      const author = checkAuthor(by);
      if (!(input.bytes instanceof Uint8Array)) fail("invalid", "a file's bytes are a Uint8Array");
      const problem =
        (typeof input.name === "string" ? spaceFileNameProblem(input.name) : "a file's name is a string") ??
        (typeof input.description === "string" ? spaceFileDescriptionProblem(input.description) : "a description is a string") ??
        (input.type === undefined ? undefined : typeof input.type === "string" ? typeProblem(input.type) : "a file's type is a string") ??
        (input.id === undefined || (typeof input.id === "string" && FILE_ID.test(input.id)) ? undefined : "a file's id is 16 to 64 lowercase hex");
      if (problem !== undefined) fail("invalid", problem);
      if (holdsCredential(input.name) || holdsCredential(input.description)) fail("refused", "the name or description looks like it holds a credential: a space never keeps a secret");
      const id = input.id ?? (deps.newId ?? newFileId)();

      const status = await ask<{ saved: SpaceFile | null; usage: SpaceFilesUsage; limits: Limits }>(space, CALL.status, { id }, ctx);
      if (status.saved !== null) return status.saved;
      const early = limitProblem(status.usage, input.bytes.byteLength, status.limits);
      if (early !== undefined) fail("limit", early);
      const text = await textFor(input, ctx);

      const file: SavedFileInput = {
        id,
        name: input.name,
        description: input.description,
        size: input.bytes.byteLength,
        sha256: await sha256Hex(input.bytes),
        ...(input.type !== undefined && { type: input.type }),
        ...(text !== undefined && { text }),
      };
      const key = await blobKey(space, id);
      // The bytes first: the index never names bytes that were not written.
      await deps.blobs().put(key, input.bytes, input.type === undefined ? undefined : { contentType: input.type });
      try {
        return await ask<SpaceFile>(space, CALL.save, { file, by: author }, ctx);
      } catch (error) {
        // Refused before anything was written: its bytes go. Any other failure may have kept the row.
        if (error instanceof SpaceFilesError) await deps.blobs().delete(key).catch(() => undefined);
        throw error;
      }
    },

    versions: (space, name, ctx) => ask<SpaceFile[]>(space, CALL.versions, { name }, ctx),

    trash: async (space, name, by, ctx) => (await ask<boolean>(space, CALL.trash, { name, by: checkAuthor(by) }, ctx)) === true,

    search: (space, query, limit, ctx) => ask<SpaceFileMatch[]>(space, CALL.search, { query, limit }, ctx),

    text: async (space, name, query, ctx) => (await ask<SpaceFileText | null>(space, CALL.text, { name, part: query.part, ...versionField(query.version) }, ctx)) ?? undefined,

    changes: (space, page, ctx) => ask<ChangePage>(space, CALL.changes, { page: { limit: page.limit, ...(page.before !== undefined && { before: page.before }) } }, ctx),

    restore: (space, n, by, ctx) => ask<Change>(space, CALL.restore, { n, by: checkAuthor(by) }, ctx),

    redact: async (space, n, by, ctx) => void (await ask<null>(space, CALL.redact, { n, by: checkAuthor(by) }, ctx)),

    purge: async (space, ctx) => void (await ask<null>(space, CALL.purge, {}, ctx)),

    saved: async (space, id, ctx) => (await ask<{ saved: SpaceFile | null }>(space, CALL.status, { id }, ctx)).saved ?? undefined,
  };
}
