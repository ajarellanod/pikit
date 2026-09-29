/**
 * What a conversation's Durable Object bundles when its agent works in execution-do: the storage and
 * sessions it runs on, the runtime, the workspace and shell, and Pi's file and shell tools. Measured,
 * never run: `bun run --cwd tests/workerd bundle` (README.md, "Bundle size").
 */

import { DurableObject } from "cloudflare:workers";
import executionDo from "../../../registry/components/execution-do/files/src/pikit/execution-do/index.ts";
import runtimePi from "../../../registry/components/runtime-pi/files/src/pikit/runtime-pi/index.ts";
import sessionsSql from "../../../registry/components/sessions-sql/files/src/pikit/sessions-sql/index.ts";
import storageDo from "../../../registry/components/storage-do/files/src/pikit/storage-do/index.ts";
import toolBash from "../../../registry/components/tool-bash/files/src/pikit/tool-bash/index.ts";
import toolEdit from "../../../registry/components/tool-edit/files/src/pikit/tool-edit/index.ts";
import toolRead from "../../../registry/components/tool-read/files/src/pikit/tool-read/index.ts";
import toolWrite from "../../../registry/components/tool-write/files/src/pikit/tool-write/index.ts";

const components = [storageDo, sessionsSql, runtimePi, executionDo, toolBash, toolRead, toolWrite, toolEdit];

export class TestObject extends DurableObject {}

export default {
  fetch: () => new Response(components.map((component) => component.name).join("\n")),
} satisfies ExportedHandler;
