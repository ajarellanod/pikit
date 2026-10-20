/**
 * One request of the sandbox protocol (`protocol.ts`), over plain `fetch` (a Durable Object has
 * nothing else): what it answered, or why it did not. It never throws.
 */

import { AGENT_HEADER, isProtocolErrorCode, type Operation, type Outcome, PROTOCOL_PATH, type ProtocolErrorCode, type RequestOf } from "./protocol.ts";

export type CallFailure =
  /** The caller's context was cancelled. */
  | { kind: "aborted" }
  /** The host answered, with the protocol's own failure (`unknown`: a status the protocol does not have). */
  | { kind: "protocol"; status: number; code: ProtocolErrorCode | "unknown"; message: string }
  /** No answer: the network, the host down, or the request's own time limit. */
  | { kind: "network"; message: string };

export type CallResult<O extends Operation> = { ok: true; outcome: Outcome<O> } | { ok: false; failure: CallFailure };

export interface CallOptions {
  /** The caller's cancellation. */
  signal?: AbortSignal | undefined;
  /** The request's own time limit. */
  timeoutMs: number;
  /** The agent the sandbox is for, sent as `Pikit-Agent`; none for `execution`'s own sandbox. */
  agent?: string | undefined;
}

export interface Transport {
  /** The endpoint, without a trailing `/`: part of each environment's `id`. */
  readonly endpoint: string;
  call<O extends Operation>(sandbox: string, operation: O, request: RequestOf<O>, options: CallOptions): Promise<CallResult<O>>;
}

export interface TransportOptions {
  endpoint: string;
  /** The shared token, read at start; `undefined` while the App is not running. */
  token(): string | undefined;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
}

export function createTransport(options: TransportOptions): Transport {
  const endpoint = options.endpoint.replace(/\/+$/, "");
  return {
    endpoint,
    async call(sandbox, operation, request, { signal, timeoutMs, agent }) {
      const token = options.token();
      if (token === undefined) return { ok: false, failure: { kind: "protocol", status: 503, code: "unavailable", message: "execution-remote is not running" } };
      if (signal?.aborted === true) return { ok: false, failure: { kind: "aborted" } };
      const limit = AbortSignal.timeout(timeoutMs);
      try {
        const response = await (options.fetch ?? fetch)(`${endpoint}${PROTOCOL_PATH}/${sandbox}/${operation}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(agent !== undefined && { [AGENT_HEADER]: agent }) },
          body: JSON.stringify(request),
          signal: signal === undefined ? limit : AbortSignal.any([signal, limit]),
        });
        const text = await response.text();
        const body = parse(text);
        if (response.status === 200) {
          if (isOutcome(body)) return { ok: true, outcome: body as Outcome<typeof operation> };
          return { ok: false, failure: { kind: "protocol", status: 200, code: "unknown", message: "the host's answer is not the protocol's" } };
        }
        const error = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
        const code = typeof error?.code === "string" && isProtocolErrorCode(error.code) ? error.code : "unknown";
        const message = typeof error?.message === "string" ? error.message : `HTTP ${response.status}`;
        return { ok: false, failure: { kind: "protocol", status: response.status, code, message } };
      } catch (error) {
        if ((signal as AbortSignal | undefined)?.aborted === true) return { ok: false, failure: { kind: "aborted" } };
        const message = limit.aborted ? `no answer within ${timeoutMs} ms` : error instanceof Error ? error.message : String(error);
        return { ok: false, failure: { kind: "network", message } };
      }
    },
  };
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isOutcome(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as { ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown } };
  if (candidate.ok === true) return "value" in candidate;
  return candidate.ok === false && typeof candidate.error?.code === "string" && typeof candidate.error.message === "string";
}
