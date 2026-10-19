/**
 * execution-gondolin's step of `pikit doctor` (which `pikit dev` and `pikit up` run first): this
 * machine can boot its VMs. A problem when QEMU is not on `PATH` (no command could run); a note on
 * Linux without a usable `/dev/kvm` (QEMU then emulates the VM: it works, many times slower). It reaches
 * no network and writes nothing.
 *
 * It checks the machine `pikit` runs on. A Docker deployment runs the app in a container: there the
 * image needs QEMU and the container `--device /dev/kvm` (the README's "Docker").
 *
 * `component.json` declares it (`"hooks": { "doctor": "doctor.ts" }`); the CLI calls `doctor(io)` in the
 * project's directory, in its own process, never in the app.
 */

import { kvmWarning, qemuProblem } from "./qemu.ts";

/** What the CLI gives the check (`component-doctor.ts`). Nothing of it is needed here. */
export interface DoctorIO {
  config: Readonly<Record<string, unknown>>;
  get(name: string): string | undefined;
}

export async function doctor(_io: DoctorIO): Promise<{ problems: string[]; notes: string[] }> {
  const problem = qemuProblem();
  const warning = kvmWarning();
  return { problems: problem === undefined ? [] : [problem], notes: warning === undefined ? [] : [warning] };
}
