/**
 * `secrets`: the only way a component reads a secret. Environment variables on a
 * server, Worker bindings on Cloudflare, a vault: each is a component providing this contract.
 *
 * A secret never appears in config, in `describe()`, in a log line or in a transcript; a component
 * that reads one keeps it in memory only. Config names a secret at most (`tokenSecret:
 * "GITHUB_TOKEN"`). What shows config (the dashboard's composition, `pikit doctor`) still guards
 * against a secret put there by mistake: `secretLikePaths` finds the values that look like one,
 * `redactSecrets` replaces them.
 */

export interface SecretStore {
  /**
   * The secret called `name`, or `undefined` when it is not set. An empty value is not set: a
   * token that is `""` is as missing as no token.
   */
  get(name: string): Promise<string | undefined>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    secrets: SecretStore;
  }
}

/** What a redacted value is replaced with. */
export const REDACTED = "[redacted]";

/** Words in a key whose string value is a secret (`botToken`, `apiKey`, `clientSecret`, `password`). */
const SECRET_KEY = /token|secret|passw(or)?d|passphrase|credential|api[-_]?key|access[-_]?key|private[-_]?key|signing[-_]?key|authorization|cookie|session[-_]?key/i;
/** A secret's name, which config may hold under such a key (`tokenSecret: "PIKIT_ADMIN_TOKEN"`). */
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
/** Values that are credentials whatever their key. */
const CREDENTIAL = [
  /^sk-[A-Za-z0-9_-]{16,}/, // OpenAI, Anthropic (sk-ant-…), OpenRouter (sk-or-…)
  /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}$/, // GitHub
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^xox[abposr]-[A-Za-z0-9-]{10,}/, // Slack
  /^[0-9]{6,12}:[A-Za-z0-9_-]{30,}$/, // a Telegram bot's token
  /^AKIA[0-9A-Z]{16}$/, // AWS
  /^AIza[0-9A-Za-z_-]{30,}$/, // Google
  /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./, // a JWT
  /^(bearer|basic)\s+\S{8,}$/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i, // a URL with a password in it
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` looks like a credential: a known shape, or 32+ random-looking characters. */
function looksLikeCredential(value: string): boolean {
  if (CREDENTIAL.some((pattern) => pattern.test(value))) return true;
  // A long run of letters and digits with no space, dot or slash (not a path, a model, a name).
  return value.length >= 32 && /^[A-Za-z0-9_+=-]+$/.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value) && !UUID.test(value);
}

/** Whether the string `value` at `key` is a secret. */
function isSecret(key: string | undefined, value: string): boolean {
  if (value === "") return false;
  if (key !== undefined && SECRET_KEY.test(key) && !SECRET_NAME.test(value)) return true;
  return looksLikeCredential(value);
}

/**
 * The paths (`channel-telegram.botToken`, `tool-mcp.servers[0].headers.authorization`) of the values
 * in `value` that look like a secret: a string under a key that names one (`token`, `secret`,
 * `password`, `apiKey`, `credential`…) unless it is a secret's name (`GITHUB_TOKEN`), or any string
 * shaped like a credential (`sk-…`, a bot token, a JWT, a URL with a password).
 */
export function secretLikePaths(value: unknown, path = "", key?: string): string[] {
  if (typeof value === "string") return isSecret(key, value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((each, index) => secretLikePaths(each, `${path}[${index}]`, key));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([name, each]) => secretLikePaths(each, path === "" ? name : `${path}.${name}`, name));
  }
  return [];
}

/** `value` with every value `secretLikePaths` finds replaced by `REDACTED`: a copy, `value` is unchanged. */
export function redactSecrets<T>(value: T, key?: string): T {
  if (typeof value === "string") return (isSecret(key, value) ? REDACTED : value) as T;
  if (Array.isArray(value)) return value.map((each) => redactSecrets(each, key)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([name, each]) => [name, redactSecrets(each, name)])) as T;
  }
  return value;
}
