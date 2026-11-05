/**
 * The boat.dev REST API (v1), with plain `fetch`: only the calls this component makes, each answer
 * checked before it is used (a malformed one is an error, never a guess). The README lists them,
 * with links; the SDK (`@boatdev/sdk`, generated from the same OpenAPI) is not used: 5 MB, a
 * `node:http2` transport, and 120 operations for the 13 here.
 *
 * - **The key** is sent as `Authorization: Bearer <key>` to the API only, never to a signed file URL
 *   (those need none), and never appears in an error: every message that leaves here has it
 *   replaced (`redact`), whatever the API echoed.
 * - **Bounded.** Every call has its own deadline (`timeoutMs`), and the caller's cancellation.
 * - **Errors** are `BoatError`s: `unavailable` (no answer, a timeout, a 5xx, a 429, boat's
 *   `boat_starting`), `not_found` (404), `refused` (another 4xx: boat's own code and message),
 *   `malformed` (an answer not shaped as documented), `aborted` (the caller's cancellation).
 */

export type BoatErrorCode = "unavailable" | "not_found" | "refused" | "malformed" | "aborted";

export class BoatError extends Error {
  constructor(
    readonly code: BoatErrorCode,
    message: string,
    /** boat's own error code (`sandbox_not_ready`), when it gave one. */
    readonly boatCode?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The machine sizes boat has (`type`). */
export const SIZES = ["small", "default", "large", "xlarge"] as const;
export type Size = (typeof SIZES)[number];

/** What this component reads of a sandbox. */
export interface Sandbox {
  id: string;
  /** `init`, `provisioning`, `provisioned`, `cloning`, `ready`, `idle`, `running`, `archiving`, `archived`, `error`, `cancelled`. */
  state: string;
  labels: Record<string, string>;
  /** ms since epoch, or `undefined`. */
  createdAt?: number;
  stoppedAt?: number;
  hydratedAt?: number;
  error?: string;
}

/** States in which commands and files are served. */
export const READY_STATES = new Set(["ready", "idle", "running"]);
/** States that become ready by themselves. */
export const STARTING_STATES = new Set(["init", "provisioning", "provisioned", "cloning"]);

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface CommandStatus {
  running: boolean;
  exitCode: number | null;
  /** `running`, `exited` or `lost` (the sandbox forgot the process). */
  status: string;
  stdout: string;
  stderr: string;
  stdoutNext: number;
  stderrNext: number;
  more: boolean;
}

export interface BoatApiOptions {
  /** `https://boat.dev/api/v1`. */
  baseUrl: string;
  /** The API key, read when the API is first called. */
  key: () => string;
  fetch: typeof fetch;
  /** The deadline of one call, in ms. */
  timeoutMs: number;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const time = (value: unknown): number | undefined => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
};

/** The sandbox in `value`, or a `malformed` error naming `what`. */
export function parseSandbox(value: unknown, what: string): Sandbox {
  if (!isObject(value) || typeof value.id !== "string" || value.id === "" || typeof value.state !== "string") {
    throw new BoatError("malformed", `boat answered ${what} without a sandbox (an id and a state)`);
  }
  const labels: Record<string, string> = {};
  if (isObject(value.labels)) for (const [k, v] of Object.entries(value.labels)) if (typeof v === "string") labels[k] = v;
  const createdAt = time(value.createdAt);
  const stoppedAt = time(value.stoppedAt);
  const hydratedAt = time(value.hydratedAt);
  return {
    id: value.id,
    state: value.state,
    labels,
    ...(createdAt !== undefined && { createdAt }),
    ...(stoppedAt !== undefined && { stoppedAt }),
    ...(hydratedAt !== undefined && { hydratedAt }),
    ...(typeof value.error === "string" && { error: value.error }),
  };
}

const MAX_MESSAGE = 300;

export class BoatApi {
  constructor(private readonly options: BoatApiOptions) {}

  /** `text` with the API key replaced: what every message that leaves this client goes through. */
  redact(text: string): string {
    let key: string;
    try {
      key = this.options.key();
    } catch {
      return text;
    }
    return key === "" ? text : text.split(key).join("[redacted]");
  }

  private signal(signal: AbortSignal | undefined, timeoutMs = this.options.timeoutMs): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  }

  /** One call to the API: its JSON answer, or a `BoatError`. */
  async call(
    method: string,
    path: string,
    options: { body?: unknown; query?: [string, string][]; headers?: Record<string, string>; signal?: AbortSignal; allow404?: boolean; timeoutMs?: number } = {},
  ): Promise<Json | undefined> {
    const url = new URL(this.options.baseUrl.replace(/\/+$/, "") + path);
    for (const [name, value] of options.query ?? []) url.searchParams.append(name, value);
    const what = `${method} ${path.replace(/\/sandboxes\/[^/]+/, "/sandboxes/{id}")}`;
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.options.key()}`,
          accept: "application/json",
          ...(options.body !== undefined && { "content-type": "application/json" }),
          ...options.headers,
        },
        ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
        signal: this.signal(options.signal, options.timeoutMs),
      });
    } catch (error) {
      if (options.signal?.aborted === true) throw new BoatError("aborted", `${what}: cancelled`);
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new BoatError("unavailable", this.redact(`boat API unreachable (${what}): ${timedOut ? `no answer within ${options.timeoutMs ?? this.options.timeoutMs} ms` : error instanceof Error ? error.message : String(error)}`));
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (options.signal?.aborted === true) throw new BoatError("aborted", `${what}: cancelled`);
      throw new BoatError("unavailable", this.redact(`boat API answer cut (${what}): ${error instanceof Error ? error.message : String(error)}`));
    }
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (response.status === 404 && options.allow404 === true) return undefined;
    if (!response.ok) {
      const envelope = isObject(body) ? body : {};
      const inner = isObject(envelope.error) ? envelope.error : {};
      const boatCode = typeof envelope.code === "string" ? envelope.code : typeof inner.code === "string" ? inner.code : undefined;
      const message = typeof envelope.message === "string" ? envelope.message : typeof inner.message === "string" ? inner.message : text.slice(0, MAX_MESSAGE);
      const code: BoatErrorCode =
        response.status >= 500 || response.status === 429 || boatCode === "boat_starting" ? "unavailable" : response.status === 404 ? "not_found" : "refused";
      throw new BoatError(code, this.redact(`boat API ${what}: ${response.status}${boatCode === undefined ? "" : ` ${boatCode}`}: ${message.slice(0, MAX_MESSAGE)}`), boatCode, response.status);
    }
    if (!isObject(body)) throw new BoatError("malformed", `boat API ${what}: the answer (${response.status}) is not a JSON object`);
    return body;
  }

  async create(request: { type: Size; ttlSeconds: number; labels: Record<string, string>; name: string; from?: string; idempotencyKey: string }, signal?: AbortSignal): Promise<Sandbox> {
    const body = await this.call("POST", "/sandboxes", {
      // noEnv: none of the account's secrets, environment variables or credentials reach the sandbox.
      body: { type: request.type, ttlSeconds: request.ttlSeconds, labels: request.labels, name: request.name, noEnv: true, ...(request.from !== undefined && { from: request.from }) },
      headers: { "idempotency-key": request.idempotencyKey },
      ...(signal !== undefined && { signal }),
    });
    return parseSandbox(body?.sandbox, "the create");
  }

  /** The sandbox, or `undefined` when boat has none by that id (deleted, cancelled). */
  async get(id: string, signal?: AbortSignal): Promise<Sandbox | undefined> {
    const body = await this.call("GET", `/sandboxes/${encodeURIComponent(id)}`, { allow404: true, ...(signal !== undefined && { signal }) });
    if (body === undefined) return undefined;
    return parseSandbox(body.sandbox, "a sandbox");
  }

  /** Every sandbox with all of `labels`, page after page (checked here too: a filter boat ignored keeps nothing else). */
  async list(labels: Record<string, string>, signal?: AbortSignal): Promise<Sandbox[]> {
    const out: Sandbox[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const query: [string, string][] = [["limit", "100"], ...Object.entries(labels).map(([k, v]): [string, string] => ["label", `${k}=${v}`])];
      if (cursor !== undefined) query.push(["cursor", cursor]);
      const body = await this.call("GET", "/sandboxes", { query, ...(signal !== undefined && { signal }) });
      if (!Array.isArray(body?.sandboxes)) throw new BoatError("malformed", "boat answered the sandbox list without `sandboxes`");
      for (const item of body.sandboxes) {
        const sandbox = parseSandbox(item, "the sandbox list");
        if (Object.entries(labels).every(([k, v]) => sandbox.labels[k] === v)) out.push(sandbox);
      }
      const info = isObject(body.pageInfo) ? body.pageInfo : undefined;
      if (info?.hasMore !== true || typeof info.nextCursor !== "string") return out;
      cursor = info.nextCursor;
    }
    return out;
  }

  /** Resumes a stopped sandbox (on `type`, or its own size without one). */
  async resume(id: string, request: { type?: Size; ttlSeconds: number }, signal?: AbortSignal): Promise<void> {
    await this.call("POST", `/sandboxes/${encodeURIComponent(id)}/resume`, {
      body: { ...(request.type !== undefined && { type: request.type }), ttlSeconds: request.ttlSeconds, noEnv: true },
      ...(signal !== undefined && { signal }),
    });
  }

  async stop(id: string, signal?: AbortSignal): Promise<void> {
    await this.call("POST", `/sandboxes/${encodeURIComponent(id)}/stop`, { body: {}, ...(signal !== undefined && { signal }) });
  }

  /** Deletes the sandbox and its disk for good; one boat has no more is not an error. */
  async remove(id: string, signal?: AbortSignal): Promise<void> {
    await this.call("DELETE", `/sandboxes/${encodeURIComponent(id)}`, { headers: { "x-ascii-confirm-delete": id }, allow404: true, ...(signal !== undefined && { signal }) });
  }

  /** Moves boat's own auto-stop to now + `ttlSeconds`. */
  async extend(id: string, ttlSeconds: number, signal?: AbortSignal): Promise<void> {
    await this.call("PATCH", `/sandboxes/${encodeURIComponent(id)}`, { body: { ttlSeconds }, ...(signal !== undefined && { signal }) });
  }

  /** Runs `command` to its end (boat's synchronous exec, at most 600 s). */
  async run(id: string, command: string, timeoutSeconds: number, signal?: AbortSignal): Promise<CommandResult> {
    const body = await this.call("POST", `/sandboxes/${encodeURIComponent(id)}/commands`, {
      body: { command, timeoutSeconds: Math.max(1, Math.min(600, Math.ceil(timeoutSeconds))) },
      // The call outlives boat's own deadline for the command by 5 s, so its answer says it timed out.
      timeoutMs: (Math.min(600, Math.ceil(timeoutSeconds)) + 5) * 1000,
      ...(signal !== undefined && { signal }),
    });
    if (body === undefined || typeof body.stdout !== "string" || typeof body.stderr !== "string" || !(body.exitCode === null || Number.isInteger(body.exitCode))) {
      throw new BoatError("malformed", "boat answered a command without its exit code and output");
    }
    return {
      exitCode: body.exitCode as number | null,
      stdout: body.stdout,
      stderr: body.stderr,
      truncated: body.stdoutTruncated === true || body.stderrTruncated === true,
      timedOut: body.timedOut === true,
    };
  }

  /** Starts `command` in the background (`detached`): its process id. */
  async start(id: string, command: string, signal?: AbortSignal): Promise<number> {
    const body = await this.call("POST", `/sandboxes/${encodeURIComponent(id)}/commands`, { body: { command, detached: true }, ...(signal !== undefined && { signal }) });
    if (!Number.isInteger(body?.processId)) throw new BoatError("malformed", "boat answered a detached command without its processId");
    return body?.processId as number;
  }

  /** A detached command's state and its output after the offsets. */
  async status(id: string, processId: number, offsets: { stdout: number; stderr: number }, signal?: AbortSignal): Promise<CommandStatus> {
    const body = await this.call("GET", `/sandboxes/${encodeURIComponent(id)}/commands/${processId}`, {
      query: [
        ["stdoutOffset", String(offsets.stdout)],
        ["stderrOffset", String(offsets.stderr)],
      ],
      ...(signal !== undefined && { signal }),
    });
    if (
      body === undefined ||
      typeof body.running !== "boolean" ||
      typeof body.stdout !== "string" ||
      typeof body.stderr !== "string" ||
      !Number.isInteger(body.stdoutNextOffset) ||
      !Number.isInteger(body.stderrNextOffset) ||
      !(body.exitCode === null || body.exitCode === undefined || Number.isInteger(body.exitCode))
    ) {
      throw new BoatError("malformed", "boat answered a command's status without its state, output and next offsets");
    }
    return {
      running: body.running,
      exitCode: (body.exitCode as number | null | undefined) ?? null,
      status: typeof body.status === "string" ? body.status : body.running ? "running" : "exited",
      stdout: body.stdout,
      stderr: body.stderr,
      stdoutNext: body.stdoutNextOffset as number,
      stderrNext: body.stderrNextOffset as number,
      more: body.more === true,
    };
  }

  /** Stops a detached command and every process it started (SIGTERM, SIGKILL after 5 s). */
  async kill(id: string, processId: number, signal?: AbortSignal): Promise<void> {
    await this.call("DELETE", `/sandboxes/${encodeURIComponent(id)}/commands/${processId}`, { allow404: true, ...(signal !== undefined && { signal }) });
  }

  /** A short-lived URL the sandbox serves `path` at (`download`: GET it; `upload`: PUT the bytes). */
  async fileUrl(id: string, kind: "upload" | "download", path: string, signal?: AbortSignal): Promise<string> {
    const body = await this.call("POST", `/sandboxes/${encodeURIComponent(id)}/files/${kind}-url`, { body: { path, ttlSeconds: 600 }, ...(signal !== undefined && { signal }) });
    if (typeof body?.url !== "string" || !/^https?:\/\//.test(body.url)) throw new BoatError("malformed", `boat answered a ${kind} URL request without a URL`);
    return body.url;
  }

  /** The bytes at a signed download URL (no key sent): at most `maxBytes`. */
  async download(url: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    const response = await this.raw(url, { method: "GET" }, signal, "download");
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel();
      throw new BoatError("refused", `the file is ${length} bytes, more than ${maxBytes}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new BoatError("refused", `the file is ${bytes.length} bytes, more than ${maxBytes}`);
    return bytes;
  }

  /** The body at a signed download URL (no key sent), as it comes: a snapshot's archive, of any size. */
  async downloadStream(url: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const response = await this.raw(url, { method: "GET" }, signal, "download");
    if (response.body === null) throw new BoatError("malformed", "boat file download: no body");
    return response.body;
  }

  /** PUTs `body` (`size` bytes, its Content-Length) to a signed upload URL (no key sent), as it comes. */
  async uploadStream(url: string, body: ReadableStream<Uint8Array>, size: number, signal?: AbortSignal): Promise<void> {
    const response = await this.raw(url, { method: "PUT", body, headers: { "content-type": "application/octet-stream", "content-length": String(size) }, duplex: "half" } as RequestInit, signal, "upload");
    await response.body?.cancel();
  }

  /** PUTs `bytes` to a signed upload URL (no key sent). */
  async upload(url: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    const response = await this.raw(url, { method: "PUT", body: bytes, headers: { "content-type": "application/octet-stream" } }, signal, "upload");
    await response.body?.cancel();
  }

  private async raw(url: string, init: RequestInit, signal: AbortSignal | undefined, what: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.options.fetch(url, { ...init, signal: this.signal(signal) });
    } catch (error) {
      if (signal?.aborted === true) throw new BoatError("aborted", `${what}: cancelled`);
      throw new BoatError("unavailable", this.redact(`boat file ${what} failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new BoatError(response.status >= 500 ? "unavailable" : "refused", `boat file ${what}: ${response.status}`);
    }
    return response;
  }
}
