/**
 * expose-cloudflare-tunnel: a public HTTPS URL for a server project, by a Cloudflare Tunnel
 * (features/completed/expose.md). Only the listed paths are public; anything else is Cloudflare's 404.
 *
 * It is not an app component: nothing of it runs in the app, so it is not listed in `pikit.config.ts`.
 * It owns three things:
 * - the command `pikit expose` (`expose.ts`, `component.json`'s `commands`), run on this machine;
 * - the `cloudflared` service beside the app (`compose.yaml`, `component.json`'s `compose`), which
 *   deployment-docker adds to its own;
 * - its step of `pikit doctor` (`doctor.ts`).
 *
 * Target: `server` (deployment-docker). On Cloudflare the Worker is public already.
 */

export { command, expose, quick, remove, status, type CommandIO, type ExposeContext, type QuickOptions } from "./expose.ts";
export { cloudflare, CLOUDFLARE_API, CloudflareError, TOKEN_PERMISSIONS, type Cloudflare, type IngressRule } from "./cloudflare.ts";
export { ingressRules, ORIGIN, pathPattern, readSettings, TUNNEL_TOKEN_FILE, type Settings } from "./project.ts";
