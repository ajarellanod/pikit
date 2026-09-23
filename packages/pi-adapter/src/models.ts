/**
 * The models every agent may name, from the `model.provider` components installed. Providers are
 * pi-ai's, imported by subpath in their own components (bundle size on Cloudflare, SPEC §6.2).
 */

import { createModels, type Models, type Provider } from "@earendil-works/pi-ai";

export function modelsFrom(providers: Iterable<Provider>): Models {
  const models = createModels();
  for (const provider of providers) models.setProvider(provider);
  return models;
}
