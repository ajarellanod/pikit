/**
 * expose-cloudflare-tunnel's step of `pikit doctor`, which `pikit dev` and `pikit up` run first: the
 * hostname and the paths are well formed, and the Cloudflare API token is not in `.env` (which the
 * app's container gets). Without the tunnel's token yet, a note: `pikit expose` makes it, and
 * `pikit up` cannot start cloudflared before. It writes nothing and reaches no network.
 *
 * `component.json` declares it (`"hooks": { "doctor": "doctor.ts" }`); the CLI calls `doctor(io)` in the
 * project's directory, in its own process, never in the app.
 */

import { dotEnv, hasTunnelToken, readSettings, TUNNEL_TOKEN_FILE } from "./project.ts";

/** What the CLI gives the check (`component-doctor.ts`). */
export interface DoctorIO {
  config: Readonly<Record<string, unknown>>;
  get(name: string): string | undefined;
}

export async function doctor(io: DoctorIO): Promise<{ problems: string[]; notes: string[] }> {
  const cwd = process.cwd();
  // A variable not set is pikit doctor's own problem (`required` in component.json): only a set one is checked here.
  const set = (name: string) => (io.get(name) ?? "").trim() !== "";
  const problems = readSettings((name) => (set(name) ? io.get(name) : name === "PIKIT_EXPOSE_PATHS" ? "/health" : "example.com")).problems;
  if (dotEnv(cwd).CLOUDFLARE_API_TOKEN !== undefined) {
    problems.push("CLOUDFLARE_API_TOKEN is in .env, which the app's container gets: take it out, and give it to `pikit expose` from the shell or when asked");
  }
  const notes = hasTunnelToken(cwd) ? [] : [`no tunnel yet (${TUNNEL_TOKEN_FILE}): \`pikit configure\` or \`pikit expose\` creates it; \`pikit up\` cannot start cloudflared before`];
  return { problems, notes };
}
