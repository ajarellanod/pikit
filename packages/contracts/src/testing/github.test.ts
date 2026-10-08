/**
 * The `github` suite run against an in-memory double: proof that the suite asks nothing specific to
 * one provider. A real project connects GitHub through a component such as `github-app`.
 */

import { test } from "bun:test";
import { defineComponent } from "@pikit/core";
import { GitHubNotConnectedError } from "../github.ts";
import { createGitHubConformance } from "./github.ts";

for (const c of createGitHubConformance(() => {
  let connected: string | undefined;
  let serial = 0;
  const issued = new Map<string, string>();
  return {
    components: () => [
      defineComponent({
        name: "github-memory",
        setup(pikit) {
          pikit.provide("github", {
            repository: async () => connected,
            async token() {
              if (connected === undefined) throw new GitHubNotConnectedError("connect GitHub from the dashboard's Settings → GitHub");
              const token = `memory-token-${++serial}`;
              issued.set(token, connected);
              return token;
            },
          });
        },
      }),
    ],
    connect: async (repository) => void (connected = repository),
    disconnect: async () => void (connected = undefined),
    accepts: async (token, repository) => issued.get(token) === repository,
  };
})) {
  test(`${c.group}: ${c.name}`, () => c.run());
}
