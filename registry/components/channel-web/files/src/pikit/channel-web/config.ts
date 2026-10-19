/**
 * channel-web's config, the same for both halves (`channel-web`, and `channel-web-worker` on
 * Cloudflare): values only. Secrets are read through `secrets` (`secretsOf`): `CHANNEL_WEB_AUTH_SECRET`,
 * and a client id and secret for each provider configured here.
 */

import Type, { type Static } from "typebox";
import { publicUrlOf } from "./accounts/links.ts";

/** A provider's id: better-auth's built-in ones (`google`, `github`…), or an OIDC platform's own. */
const PROVIDER_ID = "^[a-z][a-z0-9-]{0,39}$";

export const SignUpMode = Type.Union([Type.Literal("invite"), Type.Literal("allowlist"), Type.Literal("open")]);

/** Who may have an account (features/completed/channel-web.md, "Who may have an account"); also a live setting. */
export const SignUp = Type.Object(
  {
    /** `invite`: only users an operator invited; `allowlist`: also anyone whose verified email `allow` matches; `open`: anyone. */
    mode: SignUpMode,
    /** `ana@example.com`, or `@example.com` for a whole domain. Read under `allowlist` only. */
    allow: Type.Array(Type.String({ pattern: "^(?:[^@\\s]+)?@[^@\\s]+$", maxLength: 254 }), { maxItems: 1000 }),
  },
  { additionalProperties: false },
);
export type SignUpSettings = Static<typeof SignUp>;

/** What users see of a conversation (`ChatVisibility`, api.ts); also a live setting. */
export const Visibility = Type.Object(
  {
    /** The model's thinking. */
    thinking: Type.Boolean({ title: "Thinking", description: "Show the model's thinking." }),
    /** `none`, `names` (a tool's name, never its arguments or result), or `full`. */
    tools: Type.Union([Type.Literal("none"), Type.Literal("names"), Type.Literal("full")], { title: "Tools", description: "Which of the tools' work users see." }),
    /** The page's Context panel: the images sent, and with `tools: "full"` what searches and fetches found. */
    context: Type.Boolean({ title: "Context", description: "Show the Context panel." }),
  },
  { additionalProperties: false },
);
export type VisibilitySettings = Static<typeof Visibility>;

/** An agent's name, as `defineAgent` checks it. */
const AGENT_NAME = "^[a-z][a-z0-9]*(-[a-z0-9]+)*$";
/** The agents users may pick for a new conversation; also a live setting. */
export const Agents = Type.Array(Type.String({ pattern: AGENT_NAME, maxLength: 64 }), { maxItems: 50, uniqueItems: true });

export const Config = Type.Object({
  /** The assistant's name, as the chat page titles itself. */
  name: Type.String({ minLength: 1, maxLength: 80, default: "Assistant" }),
  signIn: Type.Object(
    {
      /** Email and password. */
      password: Type.Boolean({ default: true }),
      /** A link by email: only when `email.send` is installed (refuses to start otherwise). */
      magicLink: Type.Boolean({ default: false }),
      /** better-auth's built-in providers by id (`google`, `github`, `microsoft`…): each with `CHANNEL_WEB_<ID>_CLIENT_ID` and `_CLIENT_SECRET`. */
      social: Type.Array(Type.String({ pattern: PROVIDER_ID }), { default: [], uniqueItems: true }),
      /** Any other OAuth2/OIDC platform: each with `CHANNEL_WEB_OIDC_<ID>_CLIENT_ID` and `_CLIENT_SECRET`. */
      oidc: Type.Array(
        Type.Object(
          {
            id: Type.String({ pattern: PROVIDER_ID }),
            /** As the sign-in page names it. */
            name: Type.String({ minLength: 1, maxLength: 80 }),
            discoveryUrl: Type.String({ pattern: "^https://\\S+$" }),
            scopes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
          },
          { additionalProperties: false },
        ),
        { default: [] },
      ),
    },
    { default: {} },
  ),
  /** Who may have an account. When `settings` is installed, an operator changes it live (the dashboard's Settings). */
  signUp: Type.Object(
    {
      mode: Type.Union([Type.Literal("invite"), Type.Literal("allowlist"), Type.Literal("open")], { default: "invite" }),
      allow: Type.Array(Type.String({ pattern: "^(?:[^@\\s]+)?@[^@\\s]+$", maxLength: 254 }), { default: [], maxItems: 1000 }),
    },
    { default: {} },
  ),
  /**
   * What users see of a conversation (features/completed/chat-parity.md): the model's thinking, the tools (`none`,
   * `names`: a tool's name only, `full`), the Context panel. A live setting too, read at each request.
   */
  visibility: Type.Object(
    {
      thinking: Type.Boolean({ default: false }),
      tools: Type.Union([Type.Literal("none"), Type.Literal("names"), Type.Literal("full")], { default: "names" }),
      context: Type.Boolean({ default: true }),
    },
    { default: {} },
  ),
  /**
   * The agents users may pick for a new conversation (`agent.definition` names, or live ones of
   * `agent.directory`); empty: no choice, the router decides. A live setting too.
   */
  agents: Type.Array(Type.String({ pattern: AGENT_NAME, maxLength: 64 }), { default: [], maxItems: 50, uniqueItems: true }),
  /**
   * How long a session is trusted from its signed cookie, without reading the database: a ban or a
   * removal takes effect within it.
   */
  sessionCacheSeconds: Type.Integer({ minimum: 0, maximum: 3600, default: 300 }),
  /** How long an operator's invitation link works. */
  inviteTtlHours: Type.Integer({ minimum: 1, maximum: 24 * 30, default: 72 }),
  /** How often an idle event stream gets a comment, so that nothing between closes it. */
  heartbeatMs: Type.Integer({ minimum: 1000, default: 15_000 }),
  /**
   * How many messages one user may send in a minute, every conversation of theirs together: past it,
   * `429 rate_limited` with `retry-after`. Counted in memory: on a server the App's, on Cloudflare the
   * accounts actor's (the default App's config).
   */
  messagesPerMinute: Type.Integer({ minimum: 1, maximum: 10_000, default: 20 }),
  /**
   * Headers a proxy in front of the App sets with the client's address (`x-forwarded-for`,
   * `cf-connecting-ip` behind a Cloudflare tunnel), read for the accounts' rate limits before the
   * address the server saw (`x-pikit-client-address`). Empty by default: a client's own header is
   * never trusted. Name one only when every request comes through a proxy that sets it.
   */
  trustedProxyHeaders: Type.Array(Type.String({ pattern: "^[a-z0-9-]{1,64}$" }), { default: [], maxItems: 8, uniqueItems: true }),
  /**
   * The model that titles a conversation after its first answer (`provider/modelId`, one of the App's
   * providers), through `model.complete` (`titles.ts`). Absent: the conversation's agent's model.
   * Read where runs settle: on Cloudflare the conversations' objects (the default App).
   */
  titleModel: Type.Optional(Type.String({ pattern: "^[^/\\s]+/\\S+$", description: "provider/modelId of the model that titles conversations; absent, each conversation's agent's model" })),
});
export type ChannelWebConfig = Static<typeof Config>;

/** The secret better-auth signs with: at least `MIN_AUTH_SECRET` characters. */
export const AUTH_SECRET = "CHANNEL_WEB_AUTH_SECRET";
export const MIN_AUTH_SECRET = 32;
/**
 * The public origin (optional): every link the accounts make is under it. Without it, a server makes
 * links only for a request to a loopback host (`localhost`, `127.0.0.1`, `[::1]`); on Cloudflare,
 * under the Worker's own host.
 */
export const PUBLIC_URL = "PIKIT_PUBLIC_URL";

/** `google` → `GOOGLE`, `my-sso` → `MY_SSO`: a provider id in a variable's name. */
const upper = (id: string): string => id.toUpperCase().replace(/-/g, "_");

/** The variables of a built-in provider's client. */
export const socialSecrets = (id: string) => ({ clientId: `CHANNEL_WEB_${upper(id)}_CLIENT_ID`, clientSecret: `CHANNEL_WEB_${upper(id)}_CLIENT_SECRET` });
/** The variables of an OIDC platform's client. */
export const oidcSecrets = (id: string) => ({ clientId: `CHANNEL_WEB_OIDC_${upper(id)}_CLIENT_ID`, clientSecret: `CHANNEL_WEB_OIDC_${upper(id)}_CLIENT_SECRET` });

/** How the sign-in page names better-auth's built-in providers; another is its id, capitalized. */
const NAMES: Record<string, string> = {
  apple: "Apple",
  discord: "Discord",
  facebook: "Facebook",
  github: "GitHub",
  gitlab: "GitLab",
  google: "Google",
  linkedin: "LinkedIn",
  microsoft: "Microsoft",
  slack: "Slack",
  twitter: "X",
};
export const providerName = (id: string): string => NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

/** A provider's client, read from `secrets`. */
export type ProviderClient = { id: string; clientId: string; clientSecret: string };
export type OidcClient = ProviderClient & { name: string; discoveryUrl: string; scopes?: string[] };

/** What the accounts are made with: the secrets the config's methods need, all present. */
export type AccountSecrets = {
  secret: string;
  social: ProviderClient[];
  oidc: OidcClient[];
  /** `PIKIT_PUBLIC_URL`, when set: the base URL; else a trusted request's origin (`linkOrigin`). */
  publicUrl?: string;
};

/**
 * Reads the secrets `config` needs through `get`, or throws naming every variable missing (never a
 * value): a configured method whose secrets are missing refuses to start.
 */
export async function secretsOf(config: ChannelWebConfig, get: (name: string) => Promise<string | undefined>): Promise<AccountSecrets> {
  const missing: string[] = [];
  const read = async (name: string): Promise<string> => {
    const value = (await get(name))?.trim();
    if (value === undefined || value === "") missing.push(name);
    return value ?? "";
  };
  const secret = await read(AUTH_SECRET);
  const social: ProviderClient[] = [];
  for (const id of config.signIn.social) {
    const names = socialSecrets(id);
    social.push({ id, clientId: await read(names.clientId), clientSecret: await read(names.clientSecret) });
  }
  const oidc: OidcClient[] = [];
  for (const each of config.signIn.oidc) {
    const names = oidcSecrets(each.id);
    oidc.push({ ...each, clientId: await read(names.clientId), clientSecret: await read(names.clientSecret) });
  }
  if (missing.length > 0) throw new Error(`channel-web: set ${missing.join(", ")} (the sign-in methods in its config need them): pikit configure, or the deployment's secrets`);
  if (secret.length < MIN_AUTH_SECRET) throw new Error(`channel-web: ${AUTH_SECRET} is at least ${MIN_AUTH_SECRET} characters (a random one: openssl rand -base64 48)`);
  const publicUrl = publicUrlOf(await get(PUBLIC_URL));
  return { secret, social, oidc, ...(publicUrl !== undefined && { publicUrl }) };
}

/** Whether the OIDC ids are unique and none is a built-in provider's: two with one id would share a callback. */
export function configProblem(config: ChannelWebConfig): string | undefined {
  const ids = [...config.signIn.social, ...config.signIn.oidc.map((each) => each.id)];
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice !== undefined) return `channel-web: the provider id "${twice}" is configured twice (signIn.social and signIn.oidc share callbacks by id)`;
  if (!config.signIn.password && !config.signIn.magicLink && ids.length === 0) return "channel-web: signIn has no method: turn on password, magicLink, or configure a provider";
  return undefined;
}
