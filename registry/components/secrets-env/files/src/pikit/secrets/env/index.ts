/**
 * secrets-env: secrets from the process environment (SPEC §4.5, §13).
 *
 * It provides `secrets` and reads `process.env` on every `get`, so it sees what the process was
 * started with (systemd `Environment=`, Docker `--env`, an exported variable). An empty variable
 * is not set.
 *
 * It never reads a `.env` file itself, and never writes or logs a value. Bun loads `.env` files
 * from the working directory on its own; that is Bun's behaviour, not this component's.
 *
 * Target: `server` (Cloudflare's secrets are Worker bindings, a different component).
 */

import { defineComponent, type SecretStore } from "@pikit/core";

export interface SecretsEnvOptions {
  /** Where the variables are read from. Default: `process.env`. Tests pass their own. */
  env?: Readonly<Record<string, string | undefined>>;
}

export function createSecretsEnv(options: SecretsEnvOptions = {}) {
  return defineComponent({
    name: "secrets-env",
    setup(pikit) {
      const env = options.env ?? process.env;
      const secrets: SecretStore = {
        // `||`, not `??`: an empty variable is as missing as an unset one.
        get: async (name) => env[name] || undefined,
      };
      pikit.provide("secrets", secrets);
    },
  });
}

export default createSecretsEnv();
