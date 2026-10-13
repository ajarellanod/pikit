/**
 * provider-failover's logic, apart from the component (index.ts) so that its tests need no App:
 * which failures move a request to the next model (`classify`), how long a model that failed is
 * skipped (`createCooldowns`), the model a chain is (`chainModel`), and the provider that answers
 * a chain's request through its models in turn (`failoverProvider`).
 *
 * A request goes to the chain's models in order, those not cooling down first. A model that fails
 * before its answer shows anything is skipped, and the same request goes to the next one; a
 * failure after that is the answer's (it is never replayed elsewhere, so nothing is said twice),
 * and pi-durable's retry decides, the failed model cooling down so that the retry starts on another.
 *
 * Neutral: no node-only import.
 */

import type { Models, Provider } from "@pikit/pi-adapter";
import {
  type Api,
  type ApiKeyAuth,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  isContextOverflow,
  isRetryableAssistantError,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@pikit/pi-adapter/provider";

/** The key agents name the chains under: `failover/<chain>`. */
export const PROVIDER_ID = "failover";
/** The API of a chain's model: it is never sent anywhere, its models' own APIs are. */
const API = "provider-failover";

/**
 * Why a model failed, when another may answer instead:
 * - `rate`: a rate or usage limit (429, 402, 403, a subscription's limit, a quota);
 * - `auth`: its credentials were refused or are missing (401): someone has to log in again;
 * - `unavailable`: the model or its endpoint is not there (404);
 * - `transient`: the provider or the network failed (5xx, a timeout, a cut stream).
 */
export type FailureKind = "rate" | "auth" | "unavailable" | "transient";

/** How long a model is skipped after each kind of failure, in milliseconds. */
export type CooldownDurations = Readonly<Record<FailureKind, number>>;

const AUTH = /\b401\b|unauthori[sz]ed|authentication|invalid.{0,30}(api.?key|token|credential)|incorrect api key|no api key|not configured|oauth refresh failed|log ?in again|reconnect/i;
const RATE = /\b(429|402)\b|rate.?limit|tokens per min|\bTPM\b|too many requests|quota|usage.?limit|overloaded|insufficient_quota|billing|at capacity|high demand/i;
const UNAVAILABLE = /\b404\b|not.?found|no endpoints? found|does not exist|unknown model|model.{0,40}not (available|supported)/i;
/** The request is too big: OpenAI's "Request too large for <model> … tokens per min" is a rate limit instead. */
const TOO_LARGE = /request_too_large|payload too large|request entity too large|request (body )?too large|exceeds the maximum size/i;
const TOKENS_PER_MINUTE = /tokens per min|\bTPM\b|rate.?limit/i;

/**
 * Whether another model may answer `failed`, and why; `undefined` when not: an abort, a request
 * too big for any model (an overflow, which pi-durable compacts for; a 413), or a failure of the
 * request itself (a 400). `status` is the HTTP status the provider answered, when it said.
 */
export function classify(status: number | undefined, failed: AssistantMessage, contextWindow: number): FailureKind | undefined {
  if (failed.stopReason === "aborted") return undefined;
  const text = failed.errorMessage ?? "";
  if (status === 413 || isContextOverflow(failed, contextWindow) || (TOO_LARGE.test(text) && !TOKENS_PER_MINUTE.test(text))) return undefined;
  if (status === 401 || AUTH.test(text)) return "auth";
  if (status === 429 || status === 402 || status === 403 || RATE.test(text)) return "rate";
  if (status === 404 || UNAVAILABLE.test(text)) return "unavailable";
  if ((status !== undefined && status >= 500) || isRetryableAssistantError(failed)) return "transient";
  return undefined;
}

/** One model of a chain: `openai/gpt-5.5`, as its provider has it. */
export interface Candidate {
  /** `<provider>/<modelId>`, as the chain names it. */
  name: string;
  model: Model<Api>;
}

export interface Chain {
  /** Its name: agents name it `failover/<id>`. */
  id: string;
  candidates: readonly Candidate[];
}

/** A model that is skipped until `until`, and why. */
export interface Cooling {
  kind: FailureKind;
  until: number;
}

export interface Cooldowns {
  /** Why `candidate` is skipped now, if it is: its provider's credentials, or the model itself. */
  of(candidate: Candidate): Cooling | undefined;
  failed(candidate: Candidate, kind: FailureKind): void;
  /** It answered: nothing of it, nor of its provider's credentials, is cooling any longer. */
  answered(candidate: Candidate): void;
  /** When the next cooldown ends; `undefined` when none is running. */
  nextEnd(): number | undefined;
}

/**
 * The cooldowns, in memory: a restart forgets them, and on Cloudflare each conversation's object
 * has its own. Refused credentials cool the whole provider (every model of it fails the same way);
 * any other failure, the one model.
 */
export function createCooldowns(durations: CooldownDurations, now: () => number): Cooldowns {
  const cooling = new Map<string, Cooling>();
  const providerKey = (candidate: Candidate) => `provider:${candidate.model.provider}`;
  const modelKey = (candidate: Candidate) => `model:${candidate.model.provider}/${candidate.model.id}`;
  const current = (key: string): Cooling | undefined => {
    const entry = cooling.get(key);
    if (entry === undefined) return undefined;
    if (entry.until > now()) return entry;
    cooling.delete(key);
    return undefined;
  };
  return {
    of: (candidate) => current(providerKey(candidate)) ?? current(modelKey(candidate)),
    failed(candidate, kind) {
      cooling.set(kind === "auth" ? providerKey(candidate) : modelKey(candidate), { kind, until: now() + durations[kind] });
    },
    answered(candidate) {
      cooling.delete(providerKey(candidate));
      cooling.delete(modelKey(candidate));
    },
    nextEnd() {
      const ends = [...cooling.keys()].flatMap((key) => current(key)?.until ?? []);
      return ends.length === 0 ? undefined : Math.min(...ends);
    },
  };
}

/** `candidates` in the order a request tries them: those not cooling down first, each in chain order. */
export function attemptOrder(candidates: readonly Candidate[], cooldowns: Cooldowns): Candidate[] {
  return [...candidates.filter((c) => cooldowns.of(c) === undefined), ...candidates.filter((c) => cooldowns.of(c) !== undefined)];
}

/**
 * The model a chain is: what every one of its models can take. Its context window and output are
 * the smallest of them (pi-durable compacts and sizes summaries by it), its inputs those all take;
 * it reasons when one of them does (each model's own API ignores what it cannot do). Its cost is
 * the first model's: each answer's usage is priced by the model that gave it.
 */
export function chainModel(chain: Chain): Model<Api> {
  const models = chain.candidates.map((candidate) => candidate.model);
  const first = models[0] as Model<Api>;
  return {
    id: chain.id,
    name: `Failover ${chain.id}: ${chain.candidates.map((candidate) => candidate.name).join(" → ")}`,
    api: API,
    provider: PROVIDER_ID,
    baseUrl: "",
    reasoning: models.some((model) => model.reasoning),
    input: first.input.filter((input) => models.every((model) => model.input.includes(input))),
    cost: first.cost,
    contextWindow: Math.min(...models.map((model) => model.contextWindow)),
    maxTokens: Math.min(...models.map((model) => model.maxTokens)),
  };
}

export interface FailoverProviderOptions {
  /** The chains by name; empty until the component starts. */
  chains(): ReadonlyMap<string, Chain>;
  /** The chains' own providers, with the App's credentials; `undefined` until the component starts. */
  models(): Models | undefined;
  cooldowns: Cooldowns;
  now(): number;
  /** Something cooled down or answered: the health report may have changed. */
  changed?(): void;
  /** A model failed and the request moves on (or not): for the logs. Never a message's text. */
  failedOver?(event: { chain: string; from: string; kind: FailureKind; to: string | undefined }): void;
}

/** The provider agents name `failover/<chain>` through. */
export function failoverProvider(options: FailoverProviderOptions): Provider {
  const anyConfigured = async (signal: AbortSignal): Promise<boolean> => {
    const models = options.models();
    if (models === undefined) return false;
    const providers = new Set([...options.chains().values()].flatMap((chain) => chain.candidates.map((candidate) => candidate.model.provider)));
    for (const provider of providers) if ((await models.checkAuth(provider, { signal })) !== undefined) return true;
    return false;
  };
  // A chain needs no credential of its own: each of its models' providers resolves its own at its request.
  const apiKey: ApiKeyAuth = {
    name: "the chains' own providers",
    check: async ({ signal }) => ((await anyConfigured(signal)) ? { type: "api_key", source: "the chains' providers" } : undefined),
    resolve: async () => (options.models() === undefined ? undefined : { auth: {}, source: "the chains' providers" }),
  };
  const answer = (model: Model<Api>, context: TranscriptContext, request: SimpleStreamOptions | undefined, simple: boolean): AssistantMessageEventStream => {
    const out = createAssistantMessageEventStream();
    run(model, context, request, simple, out).catch((error: unknown) => {
      out.push({ type: "error", reason: "error", error: failure(model, `provider-failover: ${error instanceof Error ? error.message : String(error)}`, options.now()) });
    });
    return out;
  };

  const run = async (model: Model<Api>, context: TranscriptContext, request: SimpleStreamOptions | undefined, simple: boolean, out: AssistantMessageEventStream): Promise<void> => {
    const chain = options.chains().get(model.id);
    const models = options.models();
    if (chain === undefined || models === undefined) throw new Error(`no chain named "${model.id}"`);
    const order = attemptOrder(chain.candidates, options.cooldowns);
    const tried: string[] = [];
    for (const [index, candidate] of order.entries()) {
      const last = index === order.length - 1;
      let status: number | undefined;
      // Its own provider's credentials, not the chain's (none); no deferred answer, whose handle would be the model's;
      // no client-side retry of a failed request but on the last model: the next model is the retry.
      const { apiKey: _apiKey, deferred: _deferred, ...rest } = request ?? {};
      const own: SimpleStreamOptions = {
        ...rest,
        ...(!last && { maxRetries: 0 }),
        onResponse: async (response, at) => {
          status = response.status;
          await request?.onResponse?.(response, at);
        },
      };
      const events = simple ? models.streamSimple(candidate.model, context, own) : models.stream(candidate.model, context, own);
      // Held until the answer shows something: until then, another model may give it instead.
      const held: AssistantMessageEvent[] = [];
      let showing = false;
      let failed: AssistantMessage | undefined;
      for await (const event of events) {
        if (!showing) {
          if (event.type === "start") {
            held.push(event);
            continue;
          }
          if (event.type === "error") {
            failed = event.error;
            break;
          }
          showing = true;
          for (const before of held) out.push(before);
        }
        out.push(event);
        if (event.type === "done") options.cooldowns.answered(candidate);
        if (event.type === "error") {
          // Shown already: the answer fails as it is, and its retry starts on another model.
          const kind = classify(status, event.error, candidate.model.contextWindow);
          if (kind !== undefined) options.cooldowns.failed(candidate, kind);
          options.failedOver?.({ chain: chain.id, from: candidate.name, kind: kind ?? "transient", to: undefined });
        }
      }
      if (showing) return options.changed?.();
      failed ??= failure(candidate.model, "the answer ended without a result", options.now());
      const kind = classify(status, failed, candidate.model.contextWindow);
      if (kind !== undefined) options.cooldowns.failed(candidate, kind);
      options.changed?.();
      const next = kind === undefined || last || request?.signal?.aborted === true ? undefined : order[index + 1];
      if (kind !== undefined) options.failedOver?.({ chain: chain.id, from: candidate.name, kind, to: next?.name });
      if (next === undefined) {
        for (const before of held) out.push(before);
        const summary = tried.length === 0 ? "" : ` (provider-failover "${chain.id}" tried ${[...tried, `${candidate.name}: ${kind ?? "not retried elsewhere"}`].join(", ")})`;
        out.push({ type: "error", reason: failed.stopReason === "aborted" ? "aborted" : "error", error: { ...failed, errorMessage: `${failed.errorMessage ?? "failed"}${summary}` } });
        return;
      }
      tried.push(`${candidate.name}: ${kind}`);
    }
  };

  return {
    id: PROVIDER_ID,
    name: "Failover",
    auth: { apiKey },
    getModels: () => [...options.chains().values()].map(chainModel),
    // A chain's API is no real one, so the options it takes are the common ones (pi-durable only streams simple).
    stream: ((model, context, request) => answer(model, context, request as SimpleStreamOptions | undefined, false)) as Provider["stream"],
    streamSimple: (model, context, request) => answer(model, context, request, true),
  };
}

/** A failed answer of `model`, for a failure that has none of its own. */
function failure(model: Model<Api>, errorMessage: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage,
    timestamp,
  };
}
