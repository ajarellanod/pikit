/**
 * The script start, alone: a Worker (`wrangler.script.json`) whose first request imports the
 * project's whole Worker module (`src/pikit/deployment-cloudflare/worker.ts`: `pikit.config.ts`,
 * every component's modules, Pi), which esbuild bundles as a module evaluated on that import, not
 * when workerd loads the script. Nothing is composed or started: no App, no object. The first
 * request's wall time less a warm one's is what evaluating the bundle costs (`wrangler dev` of the
 * real Worker evaluates it before it prints "Ready", where nothing measures it).
 *
 * Copied into the bench project as `src/bench/script-start.ts`.
 */

export default {
  async fetch(): Promise<Response> {
    // @ts-ignore: resolved in the bench project, which has this file at src/bench/.
    await import("../pikit/deployment-cloudflare/worker.ts");
    return new Response("ok");
  },
};
