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
import channelHttp from "../../registry/components/channel-http/files/src/pikit/channels/http/index.ts";
import conversationsFile from "../../registry/components/conversations-file/files/src/pikit/conversations-file/index.ts";
import credentialsFile from "../../registry/components/credentials-file/files/src/pikit/credentials-file/index.ts";
import providerAnthropic from "../../registry/components/provider-anthropic/files/src/pikit/providers/anthropic/index.ts";
import routerBasic from "../../registry/components/router-basic/files/src/pikit/router/basic/index.ts";
import runtimePi from "../../registry/components/runtime-pi/files/src/pikit/runtime/pi/index.ts";
import secretsEnv from "../../registry/components/secrets-env/files/src/pikit/secrets-env/index.ts";
import serverBun from "../../registry/components/server-bun/files/src/pikit/server/bun/index.ts";
import sessionsJsonl from "../../registry/components/sessions-jsonl/files/src/pikit/sessions-jsonl/index.ts";
import agents from "./src/extensions/agents.ts";

/** The sample's state lives in `.pikit/` next to this file, whatever the working directory. */
const state = (name: string): string => fileURLToPath(new URL(`./.pikit/${name}`, import.meta.url));

export const config = {
  "sessions-jsonl": { root: state("sessions") },
  "conversations-file": { path: state("conversations.json") },
  "credentials-file": { path: state("credentials.json") },
  "router-basic": { defaultAgent: "assistant" },
  "server-bun": { port: 3000 },
  "channel-http": { replyTimeoutMs: 120_000 },
};

export default defineApp({
  components: [
    secretsEnv,
    sessionsJsonl,
    conversationsFile,
    credentialsFile,
    providerAnthropic,
    agents,
    runtimePi,
    routerBasic,
    channelHttp,
    serverBun,
  ],
  config,
});
