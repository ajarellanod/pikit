/**
 * `secrets` (SPEC §4.5, §13): the only way a component reads a secret. Environment variables on a
 * server, Worker bindings on Cloudflare, a vault: each is a component providing this contract.
 *
 * A secret never appears in config, in `describe()`, in a log line or in a transcript; a component
 * that reads one keeps it in memory only.
 */

export interface SecretStore {
  /**
   * The secret called `name`, or `undefined` when it is not set. An empty value is not set: a
   * token that is `""` is as missing as no token.
   */
  get(name: string): Promise<string | undefined>;
}

declare module "../capabilities.ts" {
  interface AppCapabilities {
    secrets: SecretStore;
  }
}
