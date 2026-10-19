/**
 * Vitest in workerd, through Cloudflare's Workers integration (`@cloudflare/vitest-plugin`): every test
 * file runs inside the Worker of `wrangler.jsonc`, locally, with no Cloudflare account.
 *
 * Test files end in `.workerd.ts`, not `.test.ts`, so the repository's `bun test` never runs them.
 */

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { mcpOutbound } from "./test/mcp-outbound.ts";
import { isSandboxRequest, sandboxOutbound } from "./test/sandbox-outbound.ts";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The Worker's real `fetch` reaches only the fake MCP servers of tool-mcp.workerd.ts (test/mcp-outbound.ts)
      // and execution-remote's sandbox host (test/sandbox-outbound.ts).
      miniflare: { outboundService: (request: Request) => (isSandboxRequest(request) ? sandboxOutbound(request) : mcpOutbound(request)) },
    }),
  ],
  test: {
    include: ["test/**/*.workerd.ts"],
    // The conformance suites start several apps per case; workerd is fast, a cold start is not.
    testTimeout: 30_000,
  },
});
