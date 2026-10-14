/**
 * agents-folders' step of `pikit doctor`, which `pikit dev` and `pikit up` run first: the folders'
 * problems, or src/extensions/agents.ts not being what they say. It writes nothing: `pikit agents` does,
 * and the result is committed, so what an operator approved in a diff is what deploys (SPEC §6).
 *
 * `component.json` declares it (`"hooks": { "doctor": "doctor.ts" }`); the CLI calls `doctor(io)` in the
 * project's directory, in its own process, never in the app.
 */

import { stale } from "./generate.ts";

/** What the CLI gives the check (`component-doctor.ts`); this one needs neither. */
export interface DoctorIO {
  config: Readonly<Record<string, unknown>>;
  get(name: string): string | undefined;
}

export async function doctor(_io: DoctorIO): Promise<string[]> {
  return stale(process.cwd());
}
