/**
 * The sandbox protocol, version 1: how `execution-remote` (the client, in a conversation's App, on a
 * server or in a Durable Object) works on a sandbox that `execution-serve` (the host, a server App)
 * exposes over HTTP. Every pi-durable `ExecutionEnv` operation is one request, and its outcome is a
 * typed result, never a throw.
 *
 * SHARED FILE. execution-remote and execution-serve each carry an identical copy
 * (`src/pikit/<component>/protocol.ts`): a component never imports another's files. Change both
 * together; the registry's test (`execution-remote/app.test.ts`) fails while they differ.
 *
 * **Requests.** `POST <endpoint>/execution/v1/sandboxes/<sandbox>/<operation>`, a JSON body
 * (`REQUESTS[operation]`), `Authorization: Bearer <token>` (the shared token, `PIKIT_SANDBOX_TOKEN`
 * by default, at least 32 characters). Every request is scoped to one sandbox: `<sandbox>` matches
 * `SANDBOX_ID` as it is in the URL (no percent-decoding), and a reader or a command opened in one
 * sandbox is unknown in every other.
 *
 * **Answers.** `200` with `{ ok: true, value }` or `{ ok: false, error }` (`WireError`: the
 * environment's own `FileError` or `ExecutionError`, code and message, and `spillPath` for a command).
 * Anything else is the protocol's own failure (`ProtocolFailure`): `400 invalid_request`,
 * `401 unauthorized`, `404 unknown_operation | unknown_handle | unknown_command`, `413 too_large`,
 * `429 too_many` (a sandbox's commands or readers), `503 unavailable` (the sandbox could not be
 * resolved, or the host is stopping).
 *
 * **Paths** are absolute (`/`-rooted, POSIX): the client resolves a relative path against its own
 * working directory (`open` gives the sandbox's, and its home for `~`) before sending it. Bytes travel
 * as base64 (`{ base64 }`), text as JSON strings (`{ text }`).
 *
 * **Commands never ride one long request.** `execStart` starts a command under an id the client
 * chose and answers what it has so far; `execRead` reads the output after a cursor; `execKill` stops it. Each of the three
 * holds the request at most `wait` ms (`MAX_WAIT_MS`), answering early when the command ends, or once
 * it has output and `linger` ms have passed. Output after a cursor is kept until a later cursor
 * acknowledges it, so a lost answer is read again, never twice. With `window`, the host keeps only the
 * tail the caller keeps and reports what it left out as `skipped` (pi-durable's `ShellOutputSkip`).
 * A command nobody reads for the host's lease is stopped and forgotten.
 *
 * **Credentials.** Nothing secret travels to the sandbox through this protocol: the token
 * authenticates the client to the host and is never passed on; a command's variables are the
 * caller's (`env`), never the client's secrets. Injecting a credential into a sandbox's outbound
 * traffic is the sandbox provider's job, in trusted code outside the sandbox (SPEC C7).
 */

import Type, { type Static } from "typebox";

export const PROTOCOL_VERSION = 1;

/** Where the operations are: `<endpoint><PROTOCOL_PATH>/<sandbox>/<operation>`. */
export const PROTOCOL_PATH = "/execution/v1/sandboxes";

/** The `http.route` key execution-serve serves. */
export const ROUTE_KEY = "POST /execution/v1/sandboxes/:sandbox/:operation";

/**
 * A sandbox's id: kebab-case, lowercase (`o-<object id>`, `k-<hash>`, `shared`). The grammar of an
 * agent's name, so a provider that keys its directories by `ConversationRef.agent` (workspace-local)
 * takes it as it is; no `/`, `.`, `%` or `..` can reach a path. At most 100 characters: the host
 * namespaces it (execution-serve's `conversationId` is `remote-<id>`) within a provider's 128.
 */
export const SANDBOX_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const MAX_SANDBOX_ID_LENGTH = 100;

export function isSandboxId(value: string): boolean {
  return value.length <= MAX_SANDBOX_ID_LENGTH && SANDBOX_ID.test(value);
}

/** The secret holding the shared token, by default, on both sides. */
export const DEFAULT_TOKEN_SECRET = "PIKIT_SANDBOX_TOKEN";
/** Shorter tokens are refused at start, on both sides. */
export const MIN_TOKEN_LENGTH = 32;

/** The longest a request may be held waiting for a command (`wait`). */
export const MAX_WAIT_MS = 30_000;
/** The largest file `openBinaryReader` sends whole with its answer (`prefetch`). */
export const MAX_PREFETCH_BYTES = 1024 * 1024;
/** The most bytes one `readerRead` returns; a longer read is several requests. */
export const MAX_READ_BYTES = 4 * 1024 * 1024;

const AbsolutePath = Type.String({ pattern: "^/", maxLength: 4096 });
const Handle = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9-]+$" });
const NonNegative = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Wait = Type.Integer({ minimum: 0, maximum: MAX_WAIT_MS });
const Content = Type.Union([Type.Object({ text: Type.String() }, { additionalProperties: false }), Type.Object({ base64: Type.String() }, { additionalProperties: false })]);
const strict = { additionalProperties: false } as const;

/** Every operation's request body. The host checks each one; anything else is `400 invalid_request`. */
export const REQUESTS = {
  open: Type.Object({}, strict),
  fileInfo: Type.Object({ path: AbsolutePath }, strict),
  exists: Type.Object({ path: AbsolutePath }, strict),
  canonicalPath: Type.Object({ path: AbsolutePath }, strict),
  readTextFile: Type.Object({ path: AbsolutePath }, strict),
  readTextLines: Type.Object({ path: AbsolutePath, maxLines: Type.Optional(NonNegative) }, strict),
  readBinaryFile: Type.Object({ path: AbsolutePath }, strict),
  writeFile: Type.Object({ path: AbsolutePath, content: Content }, strict),
  appendFile: Type.Object({ path: AbsolutePath, content: Content }, strict),
  truncateFile: Type.Object({ path: AbsolutePath, size: NonNegative }, strict),
  flushFile: Type.Object({ path: AbsolutePath }, strict),
  renameFile: Type.Object({ from: AbsolutePath, to: AbsolutePath }, strict),
  listDir: Type.Object({ path: AbsolutePath }, strict),
  createDir: Type.Object({ path: AbsolutePath, recursive: Type.Optional(Type.Boolean()) }, strict),
  remove: Type.Object({ path: AbsolutePath, recursive: Type.Optional(Type.Boolean()), force: Type.Optional(Type.Boolean()) }, strict),
  createTempDir: Type.Object({ prefix: Type.Optional(Type.String({ maxLength: 255 })) }, strict),
  createTempFile: Type.Object({ prefix: Type.Optional(Type.String({ maxLength: 255 })), suffix: Type.Optional(Type.String({ maxLength: 255 })) }, strict),
  openBinaryReader: Type.Object({ path: AbsolutePath, noFollow: Type.Optional(Type.Boolean()), prefetch: Type.Integer({ minimum: 0, maximum: MAX_PREFETCH_BYTES }) }, strict),
  readerInfo: Type.Object({ handle: Handle }, strict),
  readerRead: Type.Object({ handle: Handle, offset: NonNegative, length: Type.Integer({ minimum: 0, maximum: MAX_READ_BYTES }) }, strict),
  readerScan: Type.Object({ handle: Handle, startLine: Type.Number(), endLine: Type.Optional(Type.Number()) }, strict),
  readerClose: Type.Object({ handle: Handle }, strict),
  openDirReader: Type.Object({ path: AbsolutePath }, strict),
  dirNext: Type.Object({ handle: Handle, maxEntries: Type.Integer({ minimum: 1, maximum: 100_000 }) }, strict),
  dirClose: Type.Object({ handle: Handle }, strict),
  execStart: Type.Object(
    {
      /**
       * The command's id, chosen by the client (a UUID), so it can stop a command whose start it
       * stopped waiting for. One already in use is `invalid_request`.
       */
      command: Handle,
      /** A string runs through the sandbox's shell; an argv runs its program with the arguments unparsed. */
      run: Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })]),
      cwd: AbsolutePath,
      env: Type.Optional(Type.Record(Type.String({ pattern: "^[^=]+$" }), Type.String())),
      inheritEnv: Type.Optional(Type.Boolean()),
      /** Seconds, as `ShellExecOptions.timeout`. */
      timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 2_147_483.647 })),
      spill: Type.Optional(Type.Object({ afterBytes: NonNegative, afterLines: NonNegative }, strict)),
      window: Type.Optional(Type.Object({ maxBytes: NonNegative, maxLines: NonNegative, minIntervalMs: Type.Number({ minimum: 0 }), bytesPerSecond: Type.Number({ minimum: 0 }) }, strict)),
      wait: Wait,
      linger: Wait,
    },
    strict,
  ),
  execRead: Type.Object({ command: Handle, cursor: NonNegative, wait: Wait, linger: Wait }, strict),
  execKill: Type.Object({ command: Handle, cursor: NonNegative, wait: Wait }, strict),
} as const;

export type Operation = keyof typeof REQUESTS;
export type RequestOf<O extends Operation> = Static<(typeof REQUESTS)[O]>;

export function isOperation(name: string): name is Operation {
  return Object.hasOwn(REQUESTS, name);
}

/** What pi-durable's `FileInfo` is on the wire (the same shape). */
export type WireFileInfo = { name: string; path: string; kind: "file" | "directory" | "symlink"; size: number; mtimeMs: number };
/** What pi-durable's `LineScan` is on the wire (the same shape). */
export type WireLineScan = { newlines: number; start: number; end: number; firstLineEnd: number; lastLineStart: number; selectedBytes: number; firstLineBytes: number };
export type WireBytes = { base64: string };

/** One piece of a command's output, in arrival order. `skipped`: what the host left out just before it (only with `window`). */
export type WireChunk = { text: string; stream: "stdout" | "stderr"; skipped?: { bytes: number; newlines: number; endsWithNewline: boolean } };

/** A command's state after a cursor: its output since, the cursor after it, and how it ended once it has and all its output was read. */
export type WireExecState = {
  command: string;
  chunks: WireChunk[];
  next: number;
  done?: { ok: true; value: { exitCode: number; spillPath?: string } } | { ok: false; error: WireError };
};

/** Every operation's value. */
export type Values = {
  open: { cwd: string; home: string };
  fileInfo: WireFileInfo;
  exists: boolean;
  canonicalPath: string;
  readTextFile: string;
  readTextLines: string[];
  readBinaryFile: WireBytes;
  writeFile: null;
  appendFile: null;
  truncateFile: null;
  flushFile: null;
  renameFile: null;
  listDir: WireFileInfo[];
  createDir: null;
  remove: null;
  createTempDir: string;
  createTempFile: string;
  /** A file of at most `prefetch` bytes comes whole (`base64`) and holds nothing on the host; a larger one is a `handle`. */
  openBinaryReader: { info: WireFileInfo; base64: string } | { info: WireFileInfo; handle: string };
  readerInfo: WireFileInfo;
  readerRead: WireBytes;
  readerScan: WireLineScan;
  readerClose: null;
  openDirReader: { handle: string };
  dirNext: { entries: WireFileInfo[]; done: boolean };
  dirClose: null;
  execStart: WireExecState;
  execRead: WireExecState;
  execKill: WireExecState;
};

/** An environment's failure: a `FileError`'s or an `ExecutionError`'s code, message, path and spill file. */
export type WireError = { code: string; message: string; path?: string; spillPath?: string };

/** A `200` answer. */
export type Outcome<O extends Operation> = { ok: true; value: Values[O] } | { ok: false; error: WireError };

export type ProtocolErrorCode = "invalid_request" | "unauthorized" | "unknown_operation" | "unknown_handle" | "unknown_command" | "too_large" | "too_many" | "unavailable";

/** Any answer that is not `200`: the protocol's own failure, never the environment's. */
export type ProtocolFailure = { error: { code: ProtocolErrorCode; message: string } };

export const PROTOCOL_STATUS: Record<ProtocolErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  unknown_operation: 404,
  unknown_handle: 404,
  unknown_command: 404,
  too_large: 413,
  too_many: 429,
  unavailable: 503,
};

export function isProtocolErrorCode(code: string): code is ProtocolErrorCode {
  return Object.hasOwn(PROTOCOL_STATUS, code);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** The bytes of `text`, or `undefined` when it is not base64. */
export function fromBase64(text: string): Uint8Array | undefined {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}
