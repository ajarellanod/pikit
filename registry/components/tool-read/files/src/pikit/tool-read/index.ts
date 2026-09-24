/**
 * tool-read: Pi's own `read` tool, for the agents that name it (`tools: ["read"]`). It reads a text
 * file (from a line, up to a number of lines) or an image, and truncates long files for the model.
 *
 * pikit does not reimplement it (SPEC §6.3). This component adds only what the kit owns:
 * - the environment it works on: `execution`, read when the tool runs. Any `execution` will do,
 *   with or without a shell;
 * - its replay, `"safe"`: it only reads, so a run resumed after a crash reads again (SPEC §8.4).
 *
 * Targets: `server` and `cloudflare`, wherever an `execution` provider is installed.
 */

import { defineComponent } from "@pikit/core";
import { bindTool, createReadTool } from "@pikit/pi-adapter/tools";

export default defineComponent({
  name: "tool-read",
  setup(pikit) {
    const environment = pikit.use("execution");
    const tool = bindTool(createReadTool(), { env: () => environment.get(), replay: "safe" });
    // Under the name the model calls it by: agents name it, and runtime-pi checks the two match.
    pikit.provideKeyed("agent.tool", "read", tool);
  },
});
