/**
 * tool-bash: Pi's own `bash` tool, for the agents that name it (`tools: ["bash"]`). It runs a shell
 * command in the working directory and returns its output (the last lines when it is long), with
 * an optional timeout.
 *
 * pikit does not reimplement it (SPEC §6.3). This component adds only what the kit owns:
 * - the environment it works on: `execution.shell`, read when the tool runs. It needs a real shell,
 *   so an environment with `execution` only cannot install it, and `pikit doctor` says so;
 * - its replay, `"never"`: a command can do anything, so after a crash Pi reports the call as
 *   interrupted, and the model decides whether to run it again (SPEC §8.4).
 *
 * A shell can do anything the environment's OS user can, outside the working directory too. Give
 * `bash` only to the agents that need it, and know the limits of the environment it runs in:
 * `execution-local` is not a sandbox.
 *
 * Targets: wherever an `execution.shell` provider is installed (`server` with `execution-local`).
 */

import { defineComponent } from "@pikit/core";
import { bindTool, createBashTool } from "@pikit/pi-adapter/tools";

export default defineComponent({
  name: "tool-bash",
  setup(pikit) {
    const environment = pikit.use("execution.shell");
    const tool = bindTool(createBashTool(), { env: () => environment.get(), replay: "never" });
    // Under the name the model calls it by: agents name it, and runtime-pi checks the two match.
    pikit.provideKeyed("agent.tool", "bash", tool);
  },
});
