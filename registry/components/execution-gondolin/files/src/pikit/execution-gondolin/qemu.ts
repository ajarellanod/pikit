/**
 * What Gondolin needs from this machine: the QEMU of its architecture on `PATH` (Gondolin runs
 * `qemu-system-aarch64` on arm64, `qemu-system-x86_64` elsewhere), `qemu-img` (each VM's root disk is
 * a throwaway qcow2 overlay it makes) and, on Linux, `/dev/kvm` to
 * accelerate it. Without KVM QEMU falls back to emulation (TCG): it works, many times slower. macOS
 * uses Hypervisor.framework (HVF), which needs nothing more. Read at start and by `doctor.ts`.
 */

import { accessSync, constants } from "node:fs";
import { arch, platform } from "node:os";

/** The QEMU binary Gondolin runs on this machine. */
export function qemuBinary(): string {
  return arch() === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
}

/** How to install QEMU here, for a message. */
export function qemuInstallHint(): string {
  if (platform() === "darwin") return "brew install qemu";
  return arch() === "arm64" ? "apt install qemu-system-arm qemu-utils (Debian, Ubuntu)" : "apt install qemu-system-x86 qemu-utils (Debian, Ubuntu)";
}

/** Why VMs cannot boot here, or `undefined`. */
export function qemuProblem(which: (binary: string) => string | null = Bun.which): string | undefined {
  if (platform() !== "darwin" && platform() !== "linux") return `Gondolin runs on macOS and Linux, not ${platform()}`;
  const missing = [qemuBinary(), "qemu-img"].filter((binary) => which(binary) === null);
  if (missing.length > 0) return `${missing.join(" and ")} not on PATH: install QEMU (${qemuInstallHint()}), or commands cannot run`;
  return undefined;
}

/** Why VMs are slow here, or `undefined`: on Linux, no usable `/dev/kvm`. */
export function kvmWarning(): string | undefined {
  if (platform() !== "linux") return undefined;
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    return undefined;
  } catch {
    return "/dev/kvm is missing or not writable: QEMU emulates the VM (TCG), many times slower. In Docker, run the container with --device /dev/kvm";
  }
}
