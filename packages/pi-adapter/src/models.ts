/**
 * The models every agent may name, from the `model.provider` components installed. Providers are
 * pi-ai's, imported by subpath in their own components (bundle size on Cloudflare, SPEC §6.2).
 *
 * Credentials are pi-ai's too. With a `CredentialStore` (`model.credentials`), a stored credential
 * owns its provider: pi-ai reads the environment only when nothing is stored, refreshes OAuth
 * tokens inside the store's `modify`, and writes the new ones back through it. Without one, pi-ai
 * keeps credentials in memory and providers read their environment variables.
 */

import { type CredentialStore, createModels, type Models, type Provider } from "@earendil-works/pi-ai";

export interface ModelsOptions {
  /** Where credentials live (`model.credentials`). */
  credentials?: CredentialStore | undefined;
}

export function modelsFrom(providers: Iterable<Provider>, options: ModelsOptions = {}): Models {
  const models = createModels(options.credentials === undefined ? {} : { credentials: options.credentials });
  for (const provider of providers) models.setProvider(provider);
  return models;
}
