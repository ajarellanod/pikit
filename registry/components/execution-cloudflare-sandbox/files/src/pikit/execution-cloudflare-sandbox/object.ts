/**
 * What a `Sandbox` Durable Object does with the project's default App, with no `cloudflare:*` import
 * (`durable-object.ts` hands it the platform's objects, typed here by what is used of them), so it runs
 * under `bun test` as well as in workerd.
 *
 * The object composes `pikit.config.ts`'s default export once, on its first event, inside
 * `blockConcurrencyWhile`, with `WORKERS_HOST` `{ env }` (secrets-workers reads the Worker's secrets
 * from it; storage-blob-s3 reads its keys through it) and `SANDBOX_OBJECT` (its container, its storage,
 * and the hooks its RPC `serve` and its alarm call), which execution-cloudflare-sandbox's default half
 * registers on. A start that fails, or passes `startDeadlineMs`, answers `unavailable` and the next
 * event starts over. The App is never stopped: an object is evicted without warning.
 */

import { type AppDefinition, BACKGROUND_CONTEXT, consoleLogger, defineApp, type Logger, withAbortSignal, withContextValue } from "@pikit/core";
import { WORKERS_HOST, type WorkersHost } from "@pikit/contracts/cloudflare";
import type { SandboxContainer } from "./container.ts";
import { SANDBOX_OBJECT, type SandboxObject } from "./context.ts";
import type { ObjectStorage, SandboxReply, SandboxRequest } from "./sandbox.ts";

/** What is used of a Durable Object's `ctx`. */
export interface SandboxObjectState {
  readonly container?: SandboxContainer;
  readonly storage: ObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

export interface SandboxObjectHost {
  serve(request: SandboxRequest): Promise<SandboxReply>;
  alarm(): Promise<void>;
}

export interface SandboxObjectOptions {
  logger?: Logger;
  /** Longest the App's start may take (inside `blockConcurrencyWhile`, which Cloudflare cuts at 30 s). */
  startDeadlineMs?: number;
}

export function createSandboxObjectHost(definition: AppDefinition, state: SandboxObjectState, env: WorkersHost["env"], options: SandboxObjectOptions = {}): SandboxObjectHost {
  const logger = options.logger ?? consoleLogger;
  let serve: ((request: SandboxRequest) => Promise<SandboxReply>) | undefined;
  let alarm: (() => Promise<void>) | undefined;
  let started: Promise<void> | undefined;

  const start = (): Promise<void> =>
    (started ??= state
      .blockConcurrencyWhile(async () => {
        serve = undefined;
        alarm = undefined;
        const container = state.container;
        if (container === undefined) throw new Error("execution-cloudflare-sandbox: this object has no container: wrangler.jsonc's `containers` must name its class (the README's wrangler.jsonc)");
        const object: SandboxObject = {
          container,
          storage: state.storage,
          onServe(handler) {
            if (serve !== undefined) throw new Error("execution-cloudflare-sandbox: the object's requests already have a handler");
            serve = handler;
          },
          onAlarm(handler) {
            if (alarm !== undefined) throw new Error("execution-cloudflare-sandbox: the object's alarm already has a handler");
            alarm = handler;
          },
        };
        const app = await defineApp({ components: [...definition.components], config: { ...(definition.config ?? {}) }, target: "durable", logger }).create();
        const deadline = AbortSignal.timeout(options.startDeadlineMs ?? 20_000);
        const context = withAbortSignal(deadline, withContextValue(SANDBOX_OBJECT, object, withContextValue(WORKERS_HOST, { env }, BACKGROUND_CONTEXT)));
        try {
          await app.start(context);
        } catch (error) {
          await app.stop(withAbortSignal(AbortSignal.timeout(5_000), BACKGROUND_CONTEXT)).catch(() => {});
          throw error;
        }
        if (serve === undefined) throw new Error("execution-cloudflare-sandbox: the default App of pikit.config.ts has no execution-cloudflare-sandbox (its README's pikit.config.ts)");
      })
      .catch((error: unknown) => {
        started = undefined;
        logger.error("execution-cloudflare-sandbox: the sandbox's App failed to start", { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }));

  return {
    async serve(request) {
      try {
        await start();
      } catch {
        return { ok: false, code: "unavailable", message: "the sandbox's App did not start (the host's log says why)" };
      }
      return await (serve as (request: SandboxRequest) => Promise<SandboxReply>)(request);
    },
    async alarm() {
      await start();
      await alarm?.();
    },
  };
}
