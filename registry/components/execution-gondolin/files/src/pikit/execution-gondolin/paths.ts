/**
 * A sandbox's files as the guest names them, served from the host. The guest sees each host directory
 * at a mount (`/workspace`, `/tmp/pikit`); the file tools work on the host directories directly, so a
 * conversation that never runs a command never boots a VM.
 *
 * `toHost` maps a guest path to its host path the way the guest's own kernel would walk it: each
 * symbolic link on the way is read and resolved in the guest's namespace (an absolute target is a
 * guest path, `/workspace/a`, never a host one), so a link the guest made means what it means in the
 * guest. A path, or a link, that leads outside the mounts is refused (`permission_denied`): the host
 * never follows a guest's link to its own `/etc` or to `.pikit/`. The host path it returns has no
 * symbolic link left in the part that exists, so the host's own calls on it stay inside.
 *
 * Checked when called, used right after: a process the guest left running could swap a directory for
 * a link in between. Gondolin's own `RealFSProvider`, which serves the guest the same directories,
 * checks the same way, so the guest gains nothing through the tools it does not have through the mount.
 */

import { realpathSync } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { join, posix } from "node:path";
import { err, FileError, ok, type Result } from "@pikit/pi-adapter/execution";

/** Links followed in one path before it is refused, as Linux's limit. */
const MAX_LINKS = 40;

export interface Mount {
  /** Absolute, normalized guest path (`/workspace`). */
  guest: string;
  /** Absolute host directory. It may not exist yet; links in it (macOS's `/var`) are the host's own. */
  host: string;
}

export class Mounts {
  /** Longest guest path first, so a mount inside another wins. */
  private readonly list: readonly Mount[];

  constructor(mounts: readonly Mount[]) {
    this.list = [...mounts].sort((a, b) => b.guest.length - a.guest.length);
  }

  /** The guest paths, for messages. */
  get guestPaths(): string[] {
    return this.list.map((mount) => mount.guest).sort();
  }

  /** The mount holding guest path `path` (absolute, normalized), or `undefined`. */
  private holding(path: string): Mount | undefined {
    return this.list.find((mount) => path === mount.guest || path.startsWith(`${mount.guest}/`));
  }

  /** Whether guest path `path` (absolute) is in a mount. */
  inside(path: string): boolean {
    return this.holding(posix.normalize(path)) !== undefined;
  }

  /**
   * The host path of guest path `path` (absolute), its links resolved as the guest resolves them;
   * with `follow` false, a link as the last part is the link itself (`lstat`, `unlink`, `rename`).
   * The part that does not exist yet is joined as it is: creating it makes real directories.
   */
  async toHost(path: string, follow: boolean): Promise<Result<string, FileError>> {
    let pending = posix.normalize(path);
    let links = 0;
    walk: for (;;) {
      const mount = this.holding(pending);
      if (mount === undefined) return err(this.outside(path, pending));
      const parts = pending === mount.guest ? [] : pending.slice(mount.guest.length + 1).split("/");
      let host = mount.host;
      let guest = mount.guest;
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index] as string;
        const next = join(host, part);
        const last = index === parts.length - 1;
        let target: string | undefined;
        try {
          target = (await lstat(next)).isSymbolicLink() && (follow || !last) ? await readlink(next) : undefined;
        } catch (error) {
          const code = (error as { code?: string }).code;
          // Missing (or under a file): nothing below can be a link; the host's call reports what it finds.
          if (code === "ENOENT" || code === "ENOTDIR") return ok(join(next, ...parts.slice(index + 1)));
          return err(new FileError(code === "EACCES" || code === "EPERM" ? "permission_denied" : "unknown", this.hideHost(String((error as Error).message)), path));
        }
        if (target !== undefined) {
          if (++links > MAX_LINKS) return err(new FileError("invalid", `Too many symbolic links in ${path}`, path));
          // Read in the guest's namespace: relative to the link's directory, or a guest path.
          pending = posix.resolve(guest, target, ...parts.slice(index + 1));
          continue walk;
        }
        host = next;
        guest = posix.join(guest, part);
      }
      return ok(host);
    }
  }

  /** Each mount's host directory as given and as `realpath` names it (`/var/...`, `/private/var/...`), longest first. */
  private hostForms(): { host: string; guest: string }[] {
    const forms: { host: string; guest: string }[] = [];
    for (const mount of this.list) {
      forms.push(mount);
      try {
        const real = realpathSync(mount.host);
        if (real !== mount.host) forms.push({ host: real, guest: mount.guest });
      } catch {
        // Not there yet: nothing on the host can be named through it.
      }
    }
    return forms.sort((a, b) => b.host.length - a.host.length);
  }

  /** The guest path of host path `path`, or `undefined` when no mount holds it. */
  toGuest(path: string): string | undefined {
    const form = this.hostForms().find((m) => path === m.host || path.startsWith(`${m.host}/`));
    return form === undefined ? undefined : form.guest + path.slice(form.host.length);
  }

  /** `text` with every host directory written as its guest path: errors never show the host's layout. */
  hideHost(text: string): string {
    let out = text;
    for (const form of this.hostForms()) out = out.replaceAll(form.host, form.guest);
    return out;
  }

  private outside(path: string, resolved: string): FileError {
    const via = resolved === posix.normalize(path) ? "" : ` (a symbolic link leads to ${resolved})`;
    return new FileError(
      "permission_denied",
      `${path} is outside this sandbox's files${via}: the file tools reach only ${this.guestPaths.join(" and ")}; a command (bash) sees the whole VM`,
      path,
    );
  }
}
