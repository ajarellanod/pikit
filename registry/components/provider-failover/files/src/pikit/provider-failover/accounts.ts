/**
 * provider-failover's accounts: a second (third…) account of an installed provider, as a model
 * provider of its own. `accounts: { "anthropic-2": { provider: "anthropic" } }` provides
 * `model.provider` under `anthropic-2`, with the models of `anthropic` (`anthropic-2/<modelId>`),
 * its API and its logins, and a credential of its own: pi-ai's `CredentialStore` is keyed by provider
 * id, so the account's login or key is stored under `anthropic-2`, beside `anthropic`'s, never over
 * it. A chain, or an agent, names it like any provider.
 *
 * - **Its environment** is its own: it reads no variable but those its `env` maps
 *   (`{ ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY_2" }`: where `anthropic` reads `ANTHROPIC_API_KEY`, the
 *   account reads `ANTHROPIC_API_KEY_2`, through `secrets` first as every provider). Without `env`, it
 *   reads none, so it never answers with the base account's key.
 * - **Its requests** go to the provider it is an account of, as that provider's own: the model and
 *   the transcript are labelled with that provider's id on the way in (pi-ai's APIs tell a ChatGPT
 *   login, Anthropic's federation and their own tool calls by it), and the answer is labelled with
 *   the account's on the way out. In the transcript, what this account answered is the provider's
 *   own and what the base account answered is another provider's, so each account replays only its
 *   own signatures and reasoning.
 * - **Built at setup, resolved later:** the provider it is an account of is read through
 *   `useKeyed("model.provider")` when first needed (any time after setup), so an account is installed
 *   at setup like any provider, whatever the order of starts. provider-failover's start checks that
 *   provider is there, before any component that uses model providers starts.
 *
 * Only chat models: no image or classifier models, no deferred answers. The ambient files a provider
 * may check (`~/.aws/credentials`) are not separated: an account takes a login or a key.
 *
 * Neutral: no node-only import.
 */

import type { Credential, Provider } from "@pikit/pi-adapter";
import {
  type Api,
  type ApiKeyAuth,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type AuthContext,
  createAssistantMessageEventStream,
  type Model,
  type ProviderAuth,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@pikit/pi-adapter/provider";
import Type, { type Static } from "typebox";

/** An account's id: a provider id as the credential stores take it (credentials-do's route). */
export const ACCOUNT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** An environment variable's name. */
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const Account = Type.Object({
  /** The installed provider it is an account of (`anthropic`). */
  provider: Type.String({ minLength: 1, description: "The installed model provider it is an account of." }),
  /** Variable the provider reads → the one the account reads instead; no other is read. */
  env: Type.Optional(Type.Record(Type.String(), Type.String({ pattern: VARIABLE.source }), { description: "The provider's variable → the account's own (ANTHROPIC_API_KEY → ANTHROPIC_API_KEY_2)." })),
});
export type Account = Static<typeof Account>;

/** Account id → what it is. */
export const Accounts = Type.Record(Type.String(), Account, { default: {} });

/**
 * Each account's provider, checked against config alone (its id, its variables): a refusal names
 * the account. `base(id)` returns the installed provider `id`, from start on. `failover` is the
 * chains' own id, which no account may take.
 */
export function accountProviders(accounts: Readonly<Record<string, Account>>, failover: string, base: (id: string) => Provider | undefined): Provider[] {
  return Object.entries(accounts).map(([id, account]) => {
    if (!ACCOUNT_ID.test(id)) throw new Error(`provider-failover: account "${id}" is not a provider id (lowercase letters, digits, ".", "_", "-", at most 64)`);
    if (id === failover) throw new Error(`provider-failover: account "${id}" takes the chains' id: name it otherwise`);
    for (const [from, to] of Object.entries(account.env ?? {})) {
      if (!VARIABLE.test(from) || !VARIABLE.test(to)) throw new Error(`provider-failover: account "${id}": env maps "${from}" to "${to}", which are not both variable names`);
    }
    return accountProvider(id, account, () => base(account.provider));
  });
}

/**
 * At start: each account is of an installed provider, neither the chains nor another account.
 * `installed` is every key of `model.provider`, the accounts' own included.
 */
export function checkAccounts(accounts: Readonly<Record<string, Account>>, failover: string, installed: readonly string[]): void {
  const providers = installed.filter((key) => key !== failover && accounts[key] === undefined);
  for (const [id, account] of Object.entries(accounts)) {
    if (account.provider === failover || accounts[account.provider] !== undefined) {
      throw new Error(`provider-failover: account "${id}" is an account of "${account.provider}", which is ${account.provider === failover ? "the chains" : "another account"}: name the installed provider itself`);
    }
    if (!providers.includes(account.provider)) {
      throw new Error(`provider-failover: account "${id}" is an account of "${account.provider}", which no model.provider provides (installed: ${providers.join(", ") || "none"})`);
    }
  }
}

/** The provider `id`, an account of `base()`'s. Nothing of `base()` is read until it is used. */
export function accountProvider(id: string, account: Account, base: () => Provider | undefined): Provider {
  const env: Readonly<Record<string, string>> = account.env ?? {};
  const need = (): Provider => {
    const found = base();
    if (found === undefined) throw new Error(`provider-failover: account "${id}" is an account of "${account.provider}", which no model.provider provides`);
    return found;
  };
  // Made once per object of the base provider, and per list of its models (a dynamic provider's changes).
  let auth: { of: Provider; auth: ProviderAuth } | undefined;
  let models: { of: readonly Model<Api>[]; models: Model<Api>[] } | undefined;

  const answer = (simple: boolean, model: Model<Api>, context: TranscriptContext, request: SimpleStreamOptions | undefined): AssistantMessageEventStream => {
    const out = createAssistantMessageEventStream();
    const run = async () => {
      const provider = need();
      // No deferred answer: its handle would be the base provider's, fetched through it.
      const { deferred: _deferred, ...rest } = request ?? {};
      const own = { ...model, provider: provider.id };
      const transcript = swapped(context, id, provider.id);
      const events = simple ? provider.streamSimple(own, transcript, rest) : provider.stream(own, transcript, rest);
      for await (const event of events) {
        out.push(labelled(event, id));
        if (event.type === "done" || event.type === "error") return;
      }
      out.push({ type: "error", reason: "error", error: failure(model, "the answer ended without a result") });
    };
    run().catch((error: unknown) => {
      out.push({ type: "error", reason: "error", error: failure(model, `provider-failover: ${error instanceof Error ? error.message : String(error)}`) });
    });
    return out;
  };

  return {
    id,
    get name() {
      return `${need().name} (${id})`;
    },
    // No `baseUrl` or `headers`: the base provider's own requests apply them, and an account refreshes no list.
    get auth() {
      const provider = need();
      if (auth?.of !== provider) auth = { of: provider, auth: ownAuth(provider.auth, env) };
      return auth.auth;
    },
    getModels() {
      const provider = base();
      if (provider === undefined) return [];
      const list = provider.getModels();
      if (models?.of !== list) models = { of: list, models: list.map((model) => ({ ...model, provider: id })) };
      return models.models;
    },
    filterModels(list: readonly Model<Api>[], credential: Credential | undefined) {
      return base()?.filterModels?.(list, credential) ?? list;
    },
    stream: ((model, context, request) => answer(false, model, context, request as SimpleStreamOptions | undefined)) as Provider["stream"],
    streamSimple: (model, context, request) => answer(true, model, context, request),
  };
}

/** The base provider's auth, its OAuth login as it is (stored under the account's id), its keys read from the account's variables. */
function ownAuth(auth: ProviderAuth, env: Readonly<Record<string, string>>): ProviderAuth {
  return {
    ...(auth.oauth !== undefined && { oauth: auth.oauth }),
    ...(auth.apiKey !== undefined && { apiKey: ownApiKey(auth.apiKey, env) }),
  };
}

function ownApiKey(apiKey: ApiKeyAuth, env: Readonly<Record<string, string>>): ApiKeyAuth {
  const view = (ctx: AuthContext): AuthContext => ({
    env: async (name) => {
      const own = env[name];
      return own === undefined ? undefined : await ctx.env(own);
    },
    fileExists: (path) => ctx.fileExists(path),
  });
  // What it says it read (`source`, for status) is the account's variable.
  const said = <T extends { source?: string } | undefined>(result: T): T => {
    const source = result?.source;
    return source === undefined || env[source] === undefined ? result : ({ ...result, source: env[source] } as T);
  };
  const { login, check } = apiKey;
  return {
    name: apiKey.name,
    ...(login !== undefined && { login: (interaction) => login.call(apiKey, interaction) }),
    ...(check !== undefined && { check: async (input) => said(await check.call(apiKey, { ...input, ctx: view(input.ctx) })) }),
    resolve: async (input) => said(await apiKey.resolve({ ...input, ctx: view(input.ctx) })),
  };
}

/** `context` for the base provider: the account's answers are its own (`base`), the base account's another's (`account`). */
function swapped(context: TranscriptContext, account: string, base: string): TranscriptContext {
  if (!context.messages.some((message) => message.role === "assistant" && (message.provider === account || message.provider === base))) return context;
  return {
    ...context,
    messages: context.messages.map((message) =>
      message.role !== "assistant" || (message.provider !== account && message.provider !== base) ? message : { ...message, provider: message.provider === account ? base : account },
    ),
  };
}

/**
 * `event`, its message the account's. `partial` is the stream's one live message, which pi-ai grows
 * in place: it is labelled where it is, not copied.
 */
function labelled(event: AssistantMessageEvent, account: string): AssistantMessageEvent {
  const message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
  message.provider = account;
  return event;
}

/** A failed answer of `model`, for a failure that has none of its own. */
function failure(model: Model<Api>, errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}
