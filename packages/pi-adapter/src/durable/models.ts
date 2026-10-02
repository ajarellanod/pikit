/**
 * The models every agent may name, on pi-ai 1.0 (`pi-ai-v1`): the 1.0 twin of `../models.ts`, with
 * the same semantics, for pi-durable's `Harness` (`HarnessOptions.models`). See README.md, "pi-ai 1.0".
 *
 * - Providers come from the `model.provider` components, one per id (`setProvider` replaces).
 * - With a `CredentialStore` (`model.credentials`), a stored credential owns its provider: pi-ai
 *   reads the environment only when nothing is stored, refreshes OAuth tokens inside the store's
 *   `modify` and writes the new ones back through it. Without one, pi-ai keeps credentials in
 *   memory and providers read their environment variables.
 * - An agent names a model `<provider>/<modelId>`: the provider is what comes before the first
 *   slash, so OpenRouter's `openrouter/<vendor>/<model>` is provider `openrouter`, model
 *   `<vendor>/<model>`. pi-durable takes it as a `ModelRef` (`modelRefOf`).
 *
 * `createModels` comes from `pi-ai-v1/models`, the entry point without TypeBox or catalogs (bundle
 * size on Cloudflare, SPEC §4). Neutral: no node-only import.
 */

import type { ModelRef } from "@earendil-works/pi-durable";
import type { AuthContext, CredentialStore } from "pi-ai-v1";
import { createModels, type Models, type Provider } from "pi-ai-v1/models";

export interface ModelsOptions {
  /** Where credentials live (`model.credentials`). */
  credentials?: CredentialStore | undefined;
  /**
   * Where providers read their environment variables (`ANTHROPIC_API_KEY`). pi-ai's default reads
   * `process.env`; tests and hosts without one pass their own.
   */
  authContext?: AuthContext | undefined;
}

export function modelsFrom(providers: Iterable<Provider>, options: ModelsOptions = {}): Models {
  const models = createModels({
    ...(options.credentials !== undefined && { credentials: options.credentials }),
    ...(options.authContext !== undefined && { authContext: options.authContext }),
  });
  for (const provider of providers) models.setProvider(provider);
  return models;
}

/** `<provider>/<modelId>` as pi-durable's `ModelRef`, split at the first slash; `undefined` when it is not one. */
export function parseModelName(name: string): ModelRef | undefined {
  const slash = name.indexOf("/");
  if (slash <= 0 || slash === name.length - 1) return undefined;
  return { provider: name.slice(0, slash), modelId: name.slice(slash + 1) };
}

/**
 * The `ModelRef` of the model an agent names, checked against `models`. Throws, naming the agent,
 * when the name is not `<provider>/<modelId>`, when no installed `model.provider` has that id, or
 * when the provider has no such model.
 */
export function modelRefOf(models: Models, agent: string, name: string): ModelRef {
  const ref = parseModelName(name);
  if (ref === undefined) throw new Error(`agent "${agent}": model "${name}" is not named <provider>/<modelId>`);
  if (models.getProvider(ref.provider) === undefined) {
    const installed = models
      .getProviders()
      .map((provider) => provider.id)
      .sort();
    throw new Error(
      `agent "${agent}": model "${name}" names the provider "${ref.provider}", which no model.provider provides (installed: ${installed.length === 0 ? "none" : installed.join(", ")})`,
    );
  }
  if (models.getModel(ref.provider, ref.modelId) === undefined) {
    throw new Error(`agent "${agent}": model "${name}": the model provider "${ref.provider}" has no model "${ref.modelId}"`);
  }
  return ref;
}
