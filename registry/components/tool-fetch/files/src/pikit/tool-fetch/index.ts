/**
 * tool-fetch: the agent tool `fetch`, for the agents that name it (`tools: ["fetch"]`). It makes one
 * HTTP(S) request to a web page or an API and returns what came back, as text the model can read:
 * - HTML as readable text (title, text by blocks, no scripts or styles) and its links, absolute;
 * - JSON pretty-printed; other text as it is;
 * - binary content (images, PDFs, archives) refused, unread.
 *
 * Its limits keep one call cheap on both targets: 20 s for the whole call, at most 2 MB read from the
 * body (the rest is never downloaded), and at most 50,000 characters given back to the model.
 *
 * It carries no credentials: it adds no cookie, token or key of its own, so the agent reaches only
 * what anyone could, plus the headers it writes itself.
 *
 * Its replay is `"unsafe"`: a POST, PUT, PATCH or DELETE may have had its effect before a crash, so a
 * resumed run is told the call was interrupted instead of sending it twice.
 *
 * The tool itself is `createFetchTool` in @pikit/pi-adapter/tools (pi-durable's `defineTool`); this
 * component provides it.
 *
 * Targets: `server` and `durable`: it uses only `fetch`, streams and `HTMLRewriter`, which Workers
 * and Bun both have.
 */

import { defineComponent } from "@pikit/core";
import { createFetchTool } from "@pikit/pi-adapter/tools";

export { createFetchTool, FETCH_MAX_BYTES, FETCH_MAX_OUTPUT, FETCH_METHODS, FETCH_TIMEOUT_MS, type FetchToolOptions } from "@pikit/pi-adapter/tools";

export default defineComponent({
  name: "tool-fetch",
  setup(pikit) {
    // Under the name the model calls it by: agents name it, and runtime-pi checks the two match.
    pikit.provideKeyed("agent.tool", "fetch", createFetchTool());
  },
});
