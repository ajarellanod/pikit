// Owner: skeleton (shared). Config, instances, secrets, the conversations setting and the key format.
/**
 * The Chat apps this channel runs, and what each one reads. Each app is an instance, with its own
 * endpoint path, secrets and conversations:
 *
 * | App | Instance | Path | Secrets |
 * |---|---|---|---|
 * | the default one | `googlechat` | `/google-chat` | `GOOGLE_CHAT_SERVICE_ACCOUNT`, `GOOGLE_CHAT_PROJECT_NUMBER`, `GOOGLE_CHAT_AUDIENCE`, `GOOGLE_CHAT_ALLOWED_SPACES` |
 * | `ops` (in `instances`) | `googlechat:ops` | `/google-chat/ops` | `GOOGLE_CHAT_OPS_SERVICE_ACCOUNT`, … |
 *
 * **Conversation keys** (`AdmitOptions.key`, the actor's key on Cloudflare): `<instance>:<space>` for a
 * whole chat, `<instance>:<space>:threads/<id>` for a thread: `googlechat:spaces/AAA`,
 * `googlechat:spaces/AAA:threads/BBB`, `googlechat:ops:spaces/AAA`. `conversationKey` builds one and
 * `parseConversationKey` reads one back; `key.ts` decides which one a message gets.
 *
 * **The `conversations` setting** (`settings`, per instance): `default` (`"thread"` or `"chat"`) and
 * `chats`, the spaces that differ (`{ "spaces/AAA": "chat" }`). Its defaults are the config's
 * `conversations`; without `settings` installed the config is the setting.
 */

import type { AppContext, Handle } from "@pikit/core";
import { COMMAND_NAME, type Settings } from "@pikit/contracts";
import Type, { type Static } from "typebox";
import type { ModeOf } from "./types.ts";

/** The component's name: its settings, its `storage.kv` namespace, its wakeups and its log lines. */
export const NAME = "channel-google-chat";
/** The kind of every instance: `googlechat`, `googlechat:<name>`. */
export const KIND = "googlechat";
/** An instance's name: lowercase letters, digits and `-`, starting with a letter. */
export const INSTANCE_NAME = "^[a-z][a-z0-9-]*$";
/** Where the default app's endpoint is; a named one's is `<PATH>/<name>`. */
export const PATH = "/google-chat";

/** How one chat's messages make conversations: one per thread, or the whole chat as one. */
const mode = (options: { title?: string; description?: string; default?: string } = {}) => Type.Union([Type.Literal("thread"), Type.Literal("chat")], options);
export type ConversationMode = "thread" | "chat";
/** A space's name, the key of `chats`. */
const SPACE_NAME = Type.String({ pattern: "^spaces/[^/]+$" });

/** The `conversations` setting: the default, and the spaces that differ. */
export const ConversationsSetting = Type.Object(
  {
    default: mode({ title: "Each conversation is", description: "A thread: each thread is a conversation. A chat: the whole chat is one." }),
    chats: Type.Record(SPACE_NAME, mode(), {
      title: "Chats that differ",
      description: 'By space ("spaces/AAA"): "chat" for a chat that is one conversation, "thread" for one whose threads are.',
    }),
  },
  { additionalProperties: false },
);
export type ConversationsSetting = Static<typeof ConversationsSetting>;

/** What the Worker's half and the default export both read (the Worker's `workerConfig` is these). */
const common = {
  /** The Chat REST API. A value, for a test double. */
  apiBase: Type.String({ minLength: 1, default: "https://chat.googleapis.com" }),
  /**
   * Google's signing keys for ID tokens: the `jwks_uri` of its OpenID discovery document. A value, for
   * a test double.
   */
  jwksUrl: Type.String({ minLength: 1, default: "https://www.googleapis.com/oauth2/v3/certs" }),
  /** More Chat apps, by name, besides the default one: `["ops"]` runs `googlechat:ops` at `/google-chat/ops`. */
  instances: Type.Array(Type.String({ pattern: INSTANCE_NAME }), { default: [], uniqueItems: true }),
  /** The `conversations` setting's defaults, for every instance: each thread a conversation, unless a chat is listed. */
  conversations: Type.Object(
    { default: mode({ default: "thread" }), chats: Type.Record(SPACE_NAME, mode(), { default: {} }) },
    { default: { default: "thread", chats: {} }, additionalProperties: false },
  ),
};

/** The Worker's half's config (`workerConfig`): what it needs to verify, key and hand over. */
export const WorkerConfig = Type.Object(common);
export type WorkerConfig = Static<typeof WorkerConfig>;

/** The default export's config. */
export const Config = Type.Object({
  ...common,
  /** What the placeholder says before the model writes. */
  thinkingText: Type.String({ minLength: 1, default: "Thinking…" }),
  /** How often, in ms, the placeholder shows the answer as it is written; 0 keeps `thinkingText`. A space takes a message write a second. */
  previewEveryMs: Type.Integer({ minimum: 0, default: 3_000 }),
  /**
   * The App's commands (`agent.command`) people may type in a chat (`/name args`): `"all"`, or their
   * names. Only the allowed spaces' people reach them, after the router. Another `/name` goes to the agent as text.
   */
  commands: Type.Union([Type.Literal("all"), Type.Array(Type.String({ pattern: COMMAND_NAME.source }), { uniqueItems: true })], { default: "all" }),
});
export type Config = Static<typeof Config>;

/** One Chat app: its instance, endpoint path and the names of its secrets. */
export interface Instance {
  /** `undefined` for the default app. */
  name: string | undefined;
  /** The channel instance: `googlechat` or `googlechat:<name>`. */
  instance: string;
  /** Its endpoint's path: `/google-chat` or `/google-chat/<name>`. */
  path: string;
  secrets: {
    serviceAccount: string;
    projectNumber: string;
    audience: string;
    allowedSpaces: string;
  };
}

/** The default app, then one per name in `instances`, in order. */
export function instancesOf(names: readonly string[]): Instance[] {
  return [undefined, ...names].map((name) => {
    const infix = name === undefined ? "" : `${name.toUpperCase().replaceAll("-", "_")}_`;
    return {
      name,
      instance: name === undefined ? KIND : `${KIND}:${name}`,
      path: name === undefined ? PATH : `${PATH}/${name}`,
      secrets: {
        serviceAccount: `GOOGLE_CHAT_${infix}SERVICE_ACCOUNT`,
        projectNumber: `GOOGLE_CHAT_${infix}PROJECT_NUMBER`,
        audience: `GOOGLE_CHAT_${infix}AUDIENCE`,
        allowedSpaces: `GOOGLE_CHAT_${infix}ALLOWED_SPACES`,
      },
    };
  });
}

// ---------------------------------------------------------------------------------------------------
// Secrets

/** The service account's JSON key, as far as the channel reads it. */
export interface ServiceAccount {
  client_email: string;
  /** PEM, PKCS #8 (`-----BEGIN PRIVATE KEY-----`). */
  private_key: string;
  private_key_id?: string;
  /** Where its access tokens come from; Google's by default. */
  token_uri: string;
  project_id?: string;
}

/** What one instance's secrets say, parsed. */
export interface Credentials {
  serviceAccount: ServiceAccount;
  projectNumber: string;
  /** The endpoint URL exactly as configured in the Chat API: the ID token's `aud`. */
  audience: string;
  /** The ID token's `email`: `service-<project number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`. */
  tokenEmail: string;
  /** Spaces answered (`spaces/AAA`); every other space is a stranger. */
  allowedSpaces: ReadonlySet<string>;
}

export const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

/** The add-on's service account, which signs every event's ID token. */
export const addOnEmail = (projectNumber: string): string => `service-${projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`;

/** `json` as a service account's key, or an `Error` that says what is wrong (never the key). */
export function parseServiceAccount(json: string): ServiceAccount | Error {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return new Error("is not JSON: paste the service account's whole JSON key");
  }
  if (typeof parsed !== "object" || parsed === null) return new Error("is not a JSON object: paste the service account's whole JSON key");
  const key = parsed as Record<string, unknown>;
  if (key.type !== undefined && key.type !== "service_account") return new Error(`is a key of type "${String(key.type)}", not a service account's`);
  if (typeof key.client_email !== "string" || !key.client_email.includes("@")) return new Error("has no client_email");
  if (typeof key.private_key !== "string" || !key.private_key.includes("BEGIN PRIVATE KEY")) return new Error("has no private_key (PEM, BEGIN PRIVATE KEY)");
  if (key.token_uri !== undefined && (typeof key.token_uri !== "string" || !/^https?:\/\//.test(key.token_uri))) return new Error("has a token_uri that is not a URL");
  return {
    client_email: key.client_email,
    private_key: key.private_key,
    token_uri: typeof key.token_uri === "string" ? key.token_uri : DEFAULT_TOKEN_URI,
    ...(typeof key.private_key_id === "string" && { private_key_id: key.private_key_id }),
    ...(typeof key.project_id === "string" && { project_id: key.project_id }),
  };
}

/**
 * The allowed spaces: names separated by commas or whitespace, each `spaces/<id>` or the bare id
 * (`AAA` is `spaces/AAA`). Empty: none (every space is told it is not allowed, with its id). An
 * `Error` for a name that is neither.
 */
export function parseAllowedSpaces(value: string | undefined): Set<string> | Error {
  const spaces = new Set<string>();
  for (const each of (value ?? "").split(/[\s,]+/).filter((item) => item !== "")) {
    const name = each.startsWith("spaces/") ? each : `spaces/${each}`;
    if (!/^spaces\/[A-Za-z0-9_-]+$/.test(name)) return new Error(`"${each}" is not a space (spaces/<id>, or its id)`);
    spaces.add(name);
  }
  return spaces;
}

/**
 * `instance`'s secrets, read with `read` and parsed. Throws an error that names the secret and what to
 * do when one is missing or unusable (a start fails on it, P5); never shows a secret's value.
 */
export async function readCredentials(instance: Instance, read: (name: string) => Promise<string | undefined>): Promise<Credentials> {
  const { secrets } = instance;
  const required = async (name: string, what: string): Promise<string> => {
    const value = (await read(name))?.trim();
    if (value === undefined || value === "") throw new Error(`channel-google-chat: ${name} is not set: ${what}`);
    return value;
  };
  const serviceAccount = parseServiceAccount(await required(secrets.serviceAccount, "the Chat app's service account JSON key (Google Cloud console, IAM, Service accounts, Keys)"));
  if (serviceAccount instanceof Error) throw new Error(`channel-google-chat: ${secrets.serviceAccount} ${serviceAccount.message}`);
  const projectNumber = await required(secrets.projectNumber, "the number of the Chat app's Google Cloud project (its dashboard shows it)");
  if (!/^\d+$/.test(projectNumber)) throw new Error(`channel-google-chat: ${secrets.projectNumber} is not a project number (digits only)`);
  const audience = await required(secrets.audience, "the endpoint URL exactly as the Chat API's configuration has it (https://…" + instance.path + ")");
  if (!/^https?:\/\//.test(audience)) throw new Error(`channel-google-chat: ${secrets.audience} is not a URL: the endpoint URL as the Chat API's configuration has it`);
  const allowedSpaces = parseAllowedSpaces(await read(secrets.allowedSpaces));
  if (allowedSpaces instanceof Error) throw new Error(`channel-google-chat: ${secrets.allowedSpaces}: ${allowedSpaces.message}`);
  return { serviceAccount, projectNumber, audience, tokenEmail: addOnEmail(projectNumber), allowedSpaces };
}

// ---------------------------------------------------------------------------------------------------
// Conversation keys

/** What a conversation key says: its instance, its space, and its thread when it is a thread's. */
export interface KeyParts {
  instance: string;
  /** `spaces/AAA`. */
  space: string;
  /** `spaces/AAA/threads/BBB`; absent for a whole chat. */
  thread?: string;
}

/** The key of `space`'s conversation (`thread` absent) or of one of its threads (`spaces/AAA/threads/BBB`). */
export function conversationKey(instance: string, space: string, thread?: string): string {
  if (thread === undefined) return `${instance}:${space}`;
  if (!thread.startsWith(`${space}/threads/`)) throw new Error(`channel-google-chat: the thread "${thread}" is not of the space "${space}"`);
  return `${instance}:${space}:${thread.slice(space.length + 1)}`;
}

const KEY = /^(.+?):(spaces\/[^/:]+)(?::(threads\/[^/:]+))?$/;

/** What `key` says, or `undefined` when it is not a key this format makes. */
export function parseConversationKey(key: string): KeyParts | undefined {
  const match = KEY.exec(key);
  if (match === null) return undefined;
  const [, instance = "", space = "", thread] = match;
  return { instance, space, ...(thread !== undefined && { thread: `${space}/${thread}` }) };
}

/** The instance among `instances` whose conversation `key` is, or `undefined` (another channel's, or another app's). */
export function instanceOfKey(instances: readonly Instance[], key: string): Instance | undefined {
  const parts = parseConversationKey(key);
  return parts === undefined ? undefined : instances.find((each) => each.instance === parts.instance);
}

// ---------------------------------------------------------------------------------------------------
// The settings

/** The settings' value: each instance's `conversations`. */
export type GoogleChatSettings = Record<string, { conversations: ConversationsSetting }>;

/** The settings' schema, an object of the instances, each with its `conversations`. */
export function settingsSchemaOf(instances: readonly Instance[]) {
  return Type.Object(
    Object.fromEntries(
      instances.map((each) => [
        each.instance,
        Type.Object({ conversations: ConversationsSetting }, { additionalProperties: false, title: each.instance }),
      ]),
    ),
    { additionalProperties: false },
  );
}

/** The settings' defaults: the config's `conversations`, for every instance. */
export function settingsDefaultsOf(instances: readonly Instance[], conversations: ConversationsSetting): GoogleChatSettings {
  return Object.fromEntries(instances.map((each) => [each.instance, { conversations: { default: conversations.default, chats: { ...conversations.chats } } }]));
}

/** How `space` of `instance` makes conversations, by `settings` (absent: `fallback`, the config's). */
export function conversationModeOf(settings: GoogleChatSettings | undefined, instance: string, space: string, fallback: ConversationsSetting): ConversationMode {
  const conversations = settings?.[instance]?.conversations ?? fallback;
  return conversations.chats[space] ?? conversations.default;
}

/** The `conversations` setting of an App's instances (the default export's, or the Worker's half's). */
export interface ConversationSettings {
  /** Declares the settings, when `settings` is installed: in `start`, once per App. */
  declare(): void;
  /** In `stop`: read the config's from then on. */
  undeclare(): void;
  /** How a space of `instance` makes conversations now: the setting, read at every call, else the config's (logged when it cannot be read). */
  modeOf(instance: string): ModeOf;
}

/** The `conversations` setting over `settings` (optional), its defaults `fallback` (the config's) for every instance. */
export function createConversationSettings(settings: Handle<Settings | undefined>, instances: readonly Instance[], fallback: ConversationsSetting): ConversationSettings {
  let declared = false;
  const read = async (ctx: AppContext): Promise<GoogleChatSettings | undefined> => {
    const store = settings.get();
    if (store === undefined || !declared) return undefined;
    try {
      return await store.get<GoogleChatSettings>(NAME, ctx);
    } catch (error) {
      ctx.logger.warn("channel-google-chat: its settings could not be read; the config's conversations apply", { error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  };
  return {
    declare() {
      const store = settings.get();
      if (store === undefined) return;
      store.declare(NAME, settingsSchemaOf(instances), settingsDefaultsOf(instances, fallback));
      declared = true;
    },
    undeclare() {
      declared = false;
    },
    modeOf: (instance) => async (space, ctx) => conversationModeOf(await read(ctx), instance, space, fallback),
  };
}
