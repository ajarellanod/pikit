/**
 * The `Sandbox` Durable Object class, built from an App (`createSandboxClass`): `entrypoint.ts` builds
 * it from `pikit.config.ts`'s default export. This file and `entrypoint.ts` are the only ones of the
 * component that import `cloudflare:workers`, so nothing else of it needs Workers to load (`pikit
 * doctor` composes `pikit.config.ts` under Bun, which never imports these two).
 *
 * `wrangler.jsonc` binds the class (`SANDBOX` by default) and attaches its container (`containers`,
 * `scheduling_policy: "durable_object"`, the named `images`); its RPC interface is `serve()` and
 * `alarm()`, nothing else.
 */

import type { AppDefinition } from "@pikit/core";
import type { WorkersHost } from "@pikit/contracts/cloudflare";
// @ts-ignore: typed by Workers' runtime types (`wrangler types`) where they are installed; under Bun's
// types the class below extends an untyped base, and object.ts types what is used of it.
import { DurableObject } from "cloudflare:workers";
import { createSandboxObjectHost, type SandboxObjectHost, type SandboxObjectOptions, type SandboxObjectState } from "./object.ts";
import type { SandboxReply, SandboxRequest } from "./sandbox.ts";

export function createSandboxClass(definition: AppDefinition, options: SandboxObjectOptions = {}): new (...args: never[]) => unknown {
  class Sandbox extends DurableObject {
    #host: SandboxObjectHost | undefined;

    /** Built on the first event; `#`-private, so RPC does not expose it. */
    #objectHost(): SandboxObjectHost {
      const { ctx, env } = this as unknown as { ctx: SandboxObjectState; env: WorkersHost["env"] };
      return (this.#host ??= createSandboxObjectHost(definition, ctx, env, options));
    }

    /** RPC from the Worker's route: one operation of the protocol, checked already. */
    async serve(request: SandboxRequest): Promise<SandboxReply> {
      return await this.#objectHost().serve(request);
    }

    async alarm(): Promise<void> {
      await this.#objectHost().alarm();
    }
  }
  return Sandbox;
}
