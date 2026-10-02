/**
 * @pikit/pi-adapter/providers/openrouter: pi-ai 1.0's OpenRouter provider, the 1.0 twin of
 * `../../providers/openrouter.ts`, by subpath so a bundle carries only the providers it installs
 * (Cloudflare's 10 MB, SPEC §4). Same id (`openrouter`), models (`openrouter/<vendor>/<model>`) and
 * credentials as 0.99: an API key stored in `model.credentials` (or from "Sign in with OpenRouter",
 * an OAuth login that yields a non-expiring key), else `OPENROUTER_API_KEY`. Its module imports
 * nothing node-only; the OAuth flow is loaded only when someone logs in.
 *
 * `apiBase` moves every model's address from under OpenRouter's API to under another one (a proxy, a
 * test double), as provider-openrouter's config does today; it now lives here, and moves the image
 * and classifier models (`getAllModels`) too.
 */

import type { Provider } from "@earendil-works/pi-ai/models";
import { openrouterProvider as piOpenrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

/** Where pi-ai's catalogue puts every OpenRouter model: `<API_BASE>/v1`, or `<API_BASE>` itself. */
export const OPENROUTER_API_BASE = "https://openrouter.ai/api";

export interface OpenrouterProviderOptions {
  /** OpenRouter's API, `OPENROUTER_API_BASE` by default. A trailing slash is ignored. */
  apiBase?: string | undefined;
}

export function openrouterProvider(options: OpenrouterProviderOptions = {}): Provider {
  const provider: Provider = piOpenrouterProvider();
  const apiBase = (options.apiBase ?? OPENROUTER_API_BASE).replace(/\/+$/, "");
  if (apiBase === OPENROUTER_API_BASE) return provider;
  const moved = (baseUrl: string) => (baseUrl.startsWith(OPENROUTER_API_BASE) ? `${apiBase}${baseUrl.slice(OPENROUTER_API_BASE.length)}` : baseUrl);
  const getAllModels = provider.getAllModels;
  // pi-ai's providers are plain objects (`createProvider`): spreading keeps every method.
  return {
    ...provider,
    ...(provider.baseUrl !== undefined && { baseUrl: moved(provider.baseUrl) }),
    getModels: () => provider.getModels().map((model) => ({ ...model, baseUrl: moved(model.baseUrl) })),
    ...(getAllModels !== undefined && {
      getAllModels: () => getAllModels.call(provider).map((model) => ({ ...model, baseUrl: moved(model.baseUrl) })),
    }),
  };
}
