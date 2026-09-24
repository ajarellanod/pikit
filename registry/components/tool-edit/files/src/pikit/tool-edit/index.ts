/**
 * tool-edit: Pi's own `edit` tool, for the agents that name it (`tools: ["edit"]`). It replaces exact
 * pieces of text in a file, each one unique in it.
 *
 * pikit does not reimplement it (SPEC §6.3). This component adds only what the kit owns:
 * - the environment it works on: `execution`, read when the tool runs. Any `execution` will do,
 *   with or without a shell;
 * - its replay, `"never"`: applying an edit twice is not the same as applying it once, so after a
 *   crash Pi reports the call as interrupted, and the model decides (SPEC §8.4).
 *
 * Targets: `server` and `cloudflare`, wherever an `execution` provider is installed.
 */

import { defineComponent } from "@pikit/core";
import { bindTool, createEditTool } from "@pikit/pi-adapter/tools";

export default defineComponent({
  name: "tool-edit",
  setup(pikit) {
    const environment = pikit.use("execution");
    const tool = bindTool(createEditTool(), { env: () => environment.get(), replay: "never" });
    // Under the name the model calls it by: agents name it, and runtime-pi checks the two match.
    pikit.provideKeyed("agent.tool", "edit", tool);
  },
});
