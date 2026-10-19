/**
 * pi-ai's OAuth flows, reachable in a bundle (a Worker's).
 *
 * pi-ai 1.2 reaches a provider's OAuth flow (its `login`, `refresh` and `toAuth`) through
 * `lazyOAuth`, which loads the flow's module with an `import()` of a variable specifier
 * (`auth/oauth/load.ts`): on purpose, so that a bundler leaves the Node-only flow code (a callback
 * server on `node:http`) out of browser bundles. In a Worker that import finds nothing at run time:
 * the bundle has no such module. So a Worker could not refresh a subscription's tokens, nor even
 * turn a stored OAuth credential into a request's auth (`toAuth`).
 *
 * pi-ai has one supported way around it, made for Bun's standalone binaries: `registerBunOAuthFlows`
 * (`@earendil-works/pi-ai/bun-oauth`) imports every flow statically and registers them where the
 * lazy loaders look first. `bundleOAuthFlows` calls it once per isolate. Whoever imports this module
 * carries every flow in its bundle (they import `node:http` and `node:crypto`, which Workers provide
 * with `nodejs_compat`; only a login starts a callback server, and nothing on a Worker logs in).
 *
 * Process-wide and idempotent: the flows registered are the very modules the dynamic import would
 * have loaded, so a server that calls it behaves as before. Called by the components that keep OAuth
 * credentials on `durable` (credentials-do), in their `start`.
 *
 * Upstream: `docs/upstream/pi-ai-oauth-static-load.md`.
 */

import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

let registered = false;

/** Registers pi-ai's OAuth flows statically, once: the lazy loaders then never `import()` them. */
export function bundleOAuthFlows(): void {
  if (registered) return;
  registerBunOAuthFlows();
  registered = true;
}
