/**
 * tool-write: Pi's own `write` tool, for the agents that name it (`tools: ["write"]`). It creates or
 * overwrites a file, creating its parent directories.
 *
 * pikit does not reimplement it (SPEC §6.3). This component adds only what the kit owns:
 * - the environment it works on: `execution`, read when the tool runs. Any `execution` will do,
 *   with or without a shell;
 * - its replay, `"never"`: it changes files, so after a crash Pi reports the call as interrupted,
 *   and the model decides whether to write again (SPEC §8.4).
 *
 * Targets: `server` and `cloudflare`, wherever an `execution` provider is installed.
 */

import { defineComponent } from "@pikit/core";
import { bindTool, createWriteTool } from "@pikit/pi-adapter/tools";

export default defineComponent({
  name: "tool-write",
  setup(pikit) {
    const environment = pikit.use("execution");
    const tool = bindTool(createWriteTool(), { env: () => environment.get(), replay: "never" });
    // Under the name the model calls it by: agents name it, and runtime-pi checks the two match.
    pikit.provideKeyed("agent.tool", "write", tool);
  },
});
