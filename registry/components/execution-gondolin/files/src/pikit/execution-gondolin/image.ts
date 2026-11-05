/**
 * The image a machine (the base, an agent's profile) boots, chosen by its `image`:
 * - none: Gondolin's own (Alpine with bash, curl, python3, node), downloaded at the first boot;
 * - a string: an image the operator made, a Gondolin selector (an asset directory, a build id, or a
 *   `name:tag` of Gondolin's local store, `gondolin build --config <file> --tag designer:1`): any
 *   build config Gondolin takes (an OCI image as the base, `postBuild` commands);
 * - `{ packages }`: Gondolin's default build config with those Alpine packages added, built here on
 *   the host by Gondolin's builder (no VM: the packages come from the Alpine mirror, Gondolin's
 *   helpers from its release), into `<imageDir>/build-<digest>/`. The digest is of Gondolin's version
 *   and the whole build config: the same config is built once and found again by every later start;
 *   a changed one is a new image.
 *
 * `prepareImages` runs at start, for every machine: an image that does not exist, or cannot be built,
 * refuses the start with one error naming the machines that use it. So does an image with no build
 * id when the machine adds `packages` (their checkpoint names the build it was made from).
 *
 * A build is written to `build-<digest>.<pid>.partial/` and renamed when complete: a directory named
 * `build-<digest>` is always a whole image. Once one is built, the other `build-*` directories that no
 * machine of this configuration uses are removed, and every partial one of another process (as for
 * checkpoints: two servers sharing a `root` then build again). The checkpoints beside them (`packages`,
 * `gondolin.ts`) are not this file's.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { type BuildConfig, getAssetVersion, getDefaultBuildConfig } from "@earendil-works/gondolin";
import type { GuestImage, GuestLauncher } from "./guest.ts";

/** What a machine's `image` says: a Gondolin selector, or Alpine packages over Gondolin's default build. */
export type ImageSetting = string | { packages: readonly string[] };

/** One machine's image to prepare: who uses it (for messages), and the packages added over it. */
export interface MachineImage {
  /** `the base machine`, `agent "designer"`. */
  whose: string;
  image: ImageSetting | undefined;
  /** The machine's `packages` (a checkpoint over the image, `gondolin.ts`), `git` with proposals included. */
  packages: readonly string[];
}

export interface ImageLog {
  info(message: string, fields?: Record<string, unknown>): void;
}

/** The prefix of a built image's directory, apart from the checkpoints' names (`<hex>-<hex>.qcow2`). */
export const BUILD_PREFIX = "build-";

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** Gondolin's default build config with `packages` added to its rootfs (sorted, each once): what `{ packages }` builds. */
export function buildConfig(packages: readonly string[]): BuildConfig {
  const config = getDefaultBuildConfig();
  const alpine = config.alpine ?? { version: "3.23.0" };
  const base = alpine.rootfsPackages ?? [];
  config.alpine = { ...alpine, rootfsPackages: [...base, ...[...new Set(packages)].sort().filter((name) => !base.includes(name))] };
  return config;
}

/** The directory name of the image `config` builds: `build-<digest of Gondolin's version and the config>`. */
export function buildName(config: BuildConfig): string {
  return `${BUILD_PREFIX}${digest(JSON.stringify({ gondolin: getAssetVersion(), config }))}`;
}

/**
 * The entries of an image directory (`names`) to remove once an image is built: the `build-*`
 * directories not in `keep` (no machine uses them), and every partial build of another process. This
 * process's partial builds (another App building now) and the checkpoints stay.
 */
export function staleBuilds(names: readonly string[], keep: readonly string[], pid = process.pid): string[] {
  return names.filter((name) => name.startsWith(BUILD_PREFIX) && !keep.includes(name) && !name.endsWith(`.${pid}.partial`));
}

/** The build id of the image at `dir`, or `undefined` when it has none (no whole image there). */
function builtId(dir: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { buildId?: unknown };
    return typeof manifest.buildId === "string" ? manifest.buildId : undefined;
  } catch {
    return undefined;
  }
}

/** The builds being made in this process, by their directory: two Apps asking for one build share it. */
const building = new Map<string, Promise<GuestImage>>();

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The machines' names in one phrase: `agent "a"`, `agents "a", "b"`, `the base machine`. */
function whose(machines: readonly MachineImage[]): string {
  const names = [...new Set(machines.map((machine) => machine.whose))];
  const agents = names.filter((name) => name.startsWith("agent ")).map((name) => name.slice("agent ".length));
  const parts = [...(names.includes("the base machine") ? ["the base machine"] : []), ...(agents.length === 0 ? [] : [`${agents.length === 1 ? "agent" : "agents"} ${agents.join(", ")}`])];
  return parts.join(" and ");
}

/**
 * Prepares every machine's image: finds each selector, and builds each `{ packages }` not built yet
 * (one at a time). The image of each machine by its `whose` (`undefined`: Gondolin's default).
 * Throws, naming the machines, when an image cannot be had.
 */
export async function prepareImages(
  imageDir: string,
  machines: readonly MachineImage[],
  launcher: Pick<GuestLauncher, "findImage" | "buildImage">,
  log: ImageLog,
): Promise<Map<string, GuestImage | undefined>> {
  /** By setting: the machines using it, and the build's config and directory name for `{ packages }`. */
  const settings = new Map<string, { image: ImageSetting; users: MachineImage[]; build?: { config: BuildConfig; name: string } }>();
  for (const machine of machines) {
    if (machine.image === undefined) continue;
    let key: string;
    let build: { config: BuildConfig; name: string } | undefined;
    if (typeof machine.image === "string") key = `selector:${machine.image}`;
    else {
      const config = buildConfig(machine.image.packages);
      build = { config, name: buildName(config) };
      key = build.name;
    }
    const found = settings.get(key) ?? { image: machine.image, users: [], ...(build !== undefined && { build }) };
    found.users.push(machine);
    settings.set(key, found);
  }
  const keep = [...settings.values()].flatMap((setting) => (setting.build === undefined ? [] : [setting.build.name]));

  const prepared = new Map<string, GuestImage | undefined>();
  for (const machine of machines) prepared.set(machine.whose, undefined);
  for (const { image, users, build } of settings.values()) {
    let found: GuestImage;
    if (build === undefined) {
      try {
        found = await launcher.findImage(image as string);
      } catch (error) {
        throw new Error(`execution-gondolin: the image of ${whose(users)} (${JSON.stringify(image)}) cannot be used: ${message(error)}`, { cause: error });
      }
    } else {
      const packages = (image as { packages: readonly string[] }).packages;
      try {
        found = await built(imageDir, build, keep, launcher, log, whose(users), packages);
      } catch (error) {
        throw new Error(`execution-gondolin: the image of ${whose(users)} (Gondolin's with ${packages.join(", ")}) could not be built: ${message(error)}`, { cause: error });
      }
    }
    const adding = users.filter((user) => user.packages.length > 0);
    if (found.buildId === undefined && adding.length > 0) {
      throw new Error(
        `execution-gondolin: the image of ${whose(adding)} (${JSON.stringify(image)}) has no build id (its manifest.json), so \`packages\` cannot be added over it: build it with \`gondolin build\`, or put the packages in the image`,
      );
    }
    for (const user of users) prepared.set(user.whose, found);
  }
  return prepared;
}

/** The image `build` names in `imageDir`: found when it is there, else built once (`staleBuilds` removed then). */
async function built(
  imageDir: string,
  build: { config: BuildConfig; name: string },
  keep: readonly string[],
  launcher: Pick<GuestLauncher, "buildImage">,
  log: ImageLog,
  users: string,
  packages: readonly string[],
): Promise<GuestImage> {
  const path = join(imageDir, build.name);
  const id = builtId(path);
  if (id !== undefined) return { path, buildId: id };
  let pending = building.get(path);
  if (pending === undefined) {
    pending = (async () => {
      await mkdir(imageDir, { recursive: true });
      const partial = join(imageDir, `${build.name}.${process.pid}.partial`);
      await rm(partial, { recursive: true, force: true });
      const started = Date.now();
      log.info("execution-gondolin: building an image, once: it is kept, by its content, for every later start", { for: users, packages, image: build.name });
      try {
        await launcher.buildImage(build.config, partial);
        if (builtId(partial) === undefined) throw new Error("the build left no manifest.json with a build id");
        await rm(path, { recursive: true, force: true });
        await rename(partial, path);
      } catch (error) {
        await rm(partial, { recursive: true, force: true });
        throw error;
      }
      log.info("execution-gondolin: image built", { for: users, image: build.name, ms: Date.now() - started });
      for (const stale of staleBuilds(await readdir(imageDir), keep)) await rm(join(imageDir, stale), { recursive: true, force: true });
      return { path, buildId: builtId(path) };
    })();
    building.set(path, pending);
    void pending.finally(() => building.delete(path)).catch(() => undefined);
  }
  return await pending;
}
