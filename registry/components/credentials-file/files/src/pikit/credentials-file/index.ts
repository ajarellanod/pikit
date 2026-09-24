/**
 * credentials-file: the model providers' credentials in one JSON file, mode 0600 (SPEC §4.5).
 *
 * It provides `model.credentials`, pi-ai's `CredentialStore`: one credential per provider id, an
 * API key or OAuth tokens, in the same shape as Pi's own `auth.json`. pi-ai reads a provider's
 * credential from it before each model request, refreshes an expiring OAuth token inside `modify`,
 * and writes the new tokens back here, so a restart keeps them. When a provider has nothing stored,
 * pi-ai falls back to its environment variables (`ANTHROPIC_API_KEY`).
 *
 * Every operation reads the file again, so a login written by another process (the login script)
 * is seen at the next request. Writes run one at a time in this process and replace the file
 * atomically (temporary file created 0600, flushed, renamed).
 *
 * A value from this file is never logged or put in an error message: a broken file is reported by
 * its path only.
 *
 * Target: `server` (it uses the filesystem).
 */

import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { defineComponent } from "@pikit/core";
import type { Credential, CredentialStore } from "@pikit/pi-adapter";
import Type from "typebox";

const Config = Type.Object({
  /** The credentials file, relative to the working directory. */
  path: Type.String({ minLength: 1, default: ".pikit/credentials.json" }),
});

export default defineComponent({
  name: "credentials-file",
  config: Config,
  setup(pikit, config) {
    let path: string | undefined;
    let line: Promise<unknown> = Promise.resolve();
    const serial = <T>(work: () => Promise<T>): Promise<T> => {
      const next = line.then(work);
      line = next.catch(() => {});
      return next;
    };
    const running = (): string => {
      if (path === undefined) throw new Error("credentials-file: model.credentials used while the app is not running");
      return path;
    };

    const credentials: CredentialStore = {
      async read(providerId, options) {
        options?.signal?.throwIfAborted();
        return (await load(running())).get(providerId);
      },
      async list(options) {
        options?.signal?.throwIfAborted();
        return [...(await load(running())).entries()].map(([providerId, credential]) => ({ providerId, type: credential.type }));
      },
      // The only write path. pi-ai refreshes OAuth tokens inside `fn`, so holding the line while it
      // runs is what keeps two requests from refreshing (and rotating) one token twice.
      modify: (providerId, fn, options) =>
        serial(async () => {
          options?.signal?.throwIfAborted();
          const file = running();
          const all = await load(file);
          const current = all.get(providerId);
          const next = await fn(current);
          options?.signal?.throwIfAborted();
          if (next === undefined) return current;
          all.set(providerId, next);
          await writeAtomically(file, serialize(all));
          return next;
        }),
      delete: (providerId, options) =>
        serial(async () => {
          options?.signal?.throwIfAborted();
          const file = running();
          const all = await load(file);
          if (!all.delete(providerId)) return;
          await writeAtomically(file, serialize(all));
        }),
    };
    pikit.provide("model.credentials", credentials);

    return {
      async start(ctx) {
        const file = resolve(config.path);
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const exists = await stat(file).then(
          (stats) => stats,
          (error: { code?: unknown }) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          },
        );
        if (exists === undefined) {
          // Written now, so a directory that cannot hold it fails the start, not a login.
          await writeAtomically(file, serialize(new Map()));
        } else {
          await load(file);
          if ((exists.mode & 0o077) !== 0) {
            ctx.logger.warn("credentials-file: the credentials file is readable by other users; run chmod 600 on it", {
              path: file,
              mode: (exists.mode & 0o777).toString(8),
            });
          }
        }
        path = file;
      },
      async stop(ctx) {
        path = undefined;
        // Let a write in progress (a refreshed token) reach the disk; the stop deadline bounds the wait.
        await untilAborted(line, ctx.abortSignal);
      },
    };
  },
});

/** Every stored credential, by provider id. A `Map`: provider ids are keys, whatever they are. */
async function load(file: string): Promise<Map<string, Credential>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    // Removed while running: nothing is stored, and providers fall back to their environment.
    if ((error as { code?: unknown }).code === "ENOENT") return new Map();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // No `cause`: a parser's message can quote the file, and the file holds secrets.
    throw new Error(`credentials-file: ${file} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`credentials-file: ${file} must hold an object of provider id → credential`);
  }
  const all = new Map<string, Credential>();
  for (const [providerId, credential] of Object.entries(parsed)) {
    if (!isCredential(credential)) {
      throw new Error(`credentials-file: ${file}: the credential of "${providerId}" is not an api_key or oauth credential`);
    }
    all.set(providerId, credential);
  }
  return all;
}

function isCredential(value: unknown): value is Credential {
  if (typeof value !== "object" || value === null) return false;
  const credential = value as Record<string, unknown>;
  if (credential.type === "api_key") return credential.key === undefined || typeof credential.key === "string";
  return (
    credential.type === "oauth" &&
    typeof credential.access === "string" &&
    typeof credential.refresh === "string" &&
    typeof credential.expires === "number"
  );
}

function serialize(all: Map<string, Credential>): string {
  return `${JSON.stringify(Object.fromEntries(all), null, 2)}\n`;
}

let temporaries = 0;

/** Temporary file (0600), flush, rename: never a half-written file of secrets. */
async function writeAtomically(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${++temporaries}.tmp`;
  try {
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function untilAborted(work: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  const settled = work.then(
    () => {},
    () => {},
  );
  if (signal === undefined) return settled;
  return Promise.race([
    settled,
    new Promise<void>((done) => {
      if (signal.aborted) done();
      signal.addEventListener("abort", () => done(), { once: true });
    }),
  ]);
}
