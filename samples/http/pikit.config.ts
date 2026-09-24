/**
 * The composition root of the `http` sample (SPEC §4.1): talk to an agent over HTTP (§15,
 * scenario 1).
 *
 * A fixture of this repository, not a generated project. It imports the components straight from
 * `registry/` because there is no CLI yet; `pikit add` will copy them to `src/pikit/` and write
 * these same imports.
 */

import { fileURLToPath } from "node:url";
import { defineApp } from "@pikit/core";
import channelHttp from "../../registry/components/channel-http/files/src/pikit/channel-http/index.ts";
import conversationsFile from "../../registry/components/conversations-file/files/src/pikit/conversations-file/index.ts";
import credentialsFile from "../../registry/components/credentials-file/files/src/pikit/credentials-file/index.ts";
import providerAnthropic from "../../registry/components/provider-anthropic/files/src/pikit/provider-anthropic/index.ts";
import routerBasic from "../../registry/components/router-basic/files/src/pikit/router-basic/index.ts";
import logEvents from "../../registry/components/log-events/files/src/pikit/log-events/index.ts";
import executionLocal from "../../registry/components/execution-local/files/src/pikit/execution-local/index.ts";
import { createRuntimePi } from "../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import secretsEnv from "../../registry/components/secrets-env/files/src/pikit/secrets-env/index.ts";
import serverBun from "../../registry/components/server-bun/files/src/pikit/server-bun/index.ts";
import sessionsJsonl from "../../registry/components/sessions-jsonl/files/src/pikit/sessions-jsonl/index.ts";
import toolBash from "../../registry/components/tool-bash/files/src/pikit/tool-bash/index.ts";
import toolEdit from "../../registry/components/tool-edit/files/src/pikit/tool-edit/index.ts";
import toolRead from "../../registry/components/tool-read/files/src/pikit/tool-read/index.ts";
import toolWrite from "../../registry/components/tool-write/files/src/pikit/tool-write/index.ts";
import agents from "./src/extensions/agents.ts";
// Pi's own `permission-gate` example, unmodified (SPEC §6.2b): it blocks `rm -rf`, `sudo` and
// `chmod 777` in `bash`. In a project it sits in `src/extensions/` and imports
// `@earendil-works/pi-coding-agent`, which resolves to `@pikit/pi-extension-shim`. This fixture uses
// the byte-for-byte copy the adapter already keeps, instead of a second one.
import permissionGate from "../../packages/pi-adapter/src/extensions/pi-examples/permission-gate.ts";

/** The sample's state lives in `.pikit/` next to this file, whatever the working directory. */
const state = (name: string): string => fileURLToPath(new URL(`./.pikit/${name}`, import.meta.url));

export const config = {
  "sessions-jsonl": { root: state("sessions") },
  "conversations-file": { path: state("conversations.json") },
  "credentials-file": { path: state("credentials.json") },
  "execution-local": { root: state("workspace") },
  "router-basic": { defaultAgent: "assistant" },
  "server-bun": { port: 3000 },
  "channel-http": { replyTimeoutMs: 120_000 },
};

export default defineApp({
  components: [
    // First, so its lines cover the whole start; it only listens and owns nothing.
    logEvents,
    secretsEnv,
    sessionsJsonl,
    conversationsFile,
    credentialsFile,
    providerAnthropic,
    agents,
    executionLocal,
    toolRead,
    toolWrite,
    toolEdit,
    toolBash,
    createRuntimePi({ extensions: [permissionGate] }),
    routerBasic,
    channelHttp,
    serverBun,
  ],
  config,
});
