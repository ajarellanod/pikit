/**
 * What a command changed in the project, to put back when a later step fails, so `add` and `remove`
 * never leave it half-done (SPEC P3): a `package.json` that `bun.lock` does not match fails the next
 * frozen install. It keeps each file's content before its first change (or its absence), the
 * directories it created, and the tarballs present in `vendor/`. `node_modules` is not put back.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VENDOR_DIR } from "./vendor.ts";

export class Undo {
  private readonly saved = new Map<string, Buffer | undefined>();
  private readonly createdDirs: string[] = [];
  private readonly vendorBefore: string[] | undefined;
  /** `bun install` ran: `node_modules` is not put back. */
  installed = false;

  constructor(private readonly projectDir: string) {
    const vendor = join(projectDir, VENDOR_DIR);
    this.vendorBefore = existsSync(vendor) ? readdirSync(vendor) : undefined;
  }

  /** Remembers a project-relative file as it is now, the first time it is about to change. */
  keep(file: string): void {
    const path = join(this.projectDir, file);
    if (!this.saved.has(path)) this.saved.set(path, existsSync(path) ? readFileSync(path) : undefined);
  }

  /** Creates the directory of a project-relative file, remembering the outermost one it created; returns the file's path. */
  mkdirFor(file: string): string {
    const path = join(this.projectDir, file);
    let outermost: string | undefined;
    for (let dir = dirname(path); !existsSync(dir); dir = dirname(dir)) outermost = dir;
    mkdirSync(dirname(path), { recursive: true });
    if (outermost !== undefined) this.createdDirs.push(outermost);
    return path;
  }

  /**
   * Deletes a project-relative file, remembered, and the directories that leaves empty, up to the
   * project's root or `src/` (`restore` creates them again with the file).
   */
  delete(file: string): void {
    this.keep(file);
    rmSync(join(this.projectDir, file), { force: true });
    for (let dir = dirname(file); dir !== "." && dir !== "" && dir !== "src"; dir = dirname(dir)) {
      const path = join(this.projectDir, dir);
      if (!existsSync(path) || readdirSync(path).length > 0) return;
      rmdirSync(path);
    }
  }

  restore(): void {
    for (const [path, content] of this.saved) {
      if (content === undefined) rmSync(path, { force: true });
      else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
    }
    for (const dir of this.createdDirs.reverse()) rmSync(dir, { recursive: true, force: true });
    const vendor = join(this.projectDir, VENDOR_DIR);
    if (this.vendorBefore === undefined) rmSync(vendor, { recursive: true, force: true });
    else if (existsSync(vendor)) {
      for (const file of readdirSync(vendor)) if (!this.vendorBefore.includes(file)) rmSync(join(vendor, file), { force: true });
    }
  }
}
