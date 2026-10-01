/**
 * Restores controlled failures: original file contents, created directories and new vendor tarballs.
 * Backups are in memory; operation.ts detects interrupted commands. node_modules is not restored.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { confinedPath } from "./paths.ts";
import { VENDOR_DIR } from "./vendor.ts";

export class Undo {
  private readonly saved = new Map<string, Buffer | undefined>();
  private readonly createdDirs: string[] = [];
  private readonly vendorBefore: string[] | undefined;
  private readonly root: string;
  /** `bun install` ran: `node_modules` is not put back. */
  installed = false;

  constructor(projectDir: string) {
    this.root = realpathSync(projectDir);
    const vendor = confinedPath(this.root, VENDOR_DIR);
    this.vendorBefore = existsSync(vendor) ? readdirSync(vendor) : undefined;
  }

  /** Remembers a project-relative file before its first change. */
  keep(file: string): void {
    const path = confinedPath(this.root, file);
    if (!this.saved.has(path)) this.saved.set(path, existsSync(path) ? readFileSync(path) : undefined);
  }

  /** Creates and remembers a file's missing ancestors; returns its confined path. */
  mkdirFor(file: string): string {
    const path = confinedPath(this.root, file);
    let outermost: string | undefined;
    for (let dir = dirname(path); !existsSync(dir); dir = dirname(dir)) outermost = dir;
    mkdirSync(dirname(path), { recursive: true });
    if (outermost !== undefined) this.createdDirs.push(outermost);
    return path;
  }

  /** Deletes a remembered file and empty ancestors, never the project root or src/. */
  delete(file: string): void {
    this.keep(file);
    const path = confinedPath(this.root, file);
    rmSync(path, { force: true });
    for (let dir = dirname(relative(this.root, path)); dir !== "." && dir !== "" && dir !== "src"; dir = dirname(dir)) {
      const ancestor = confinedPath(this.root, dir);
      if (!existsSync(ancestor) || readdirSync(ancestor).length > 0) return;
      rmdirSync(ancestor);
    }
  }

  restore(): void {
    // A deleted file may live in a directory created earlier by this same operation.
    for (const dir of this.createdDirs.reverse()) {
      rmSync(confinedPath(this.root, relative(this.root, dir)), { recursive: true, force: true });
    }
    for (const [saved, content] of this.saved) {
      const path = confinedPath(this.root, relative(this.root, saved));
      if (content === undefined) rmSync(path, { force: true });
      else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
    }
    const vendor = confinedPath(this.root, VENDOR_DIR);
    if (this.vendorBefore === undefined) rmSync(vendor, { recursive: true, force: true });
    else if (existsSync(vendor)) {
      for (const file of readdirSync(vendor)) {
        if (!this.vendorBefore.includes(file)) rmSync(confinedPath(this.root, `${VENDOR_DIR}/${file}`), { force: true });
      }
    }
  }
}
