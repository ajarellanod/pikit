/**
 * github-token's section of the Settings dialog, GitHub: the project's repository (its setting), and
 * where its token goes (a secret, never here: a setting is shown to every operator, a secret is not).
 * For a project whose GitHub access is a token you made; github-app's section connects one in two
 * clicks instead.
 */

import { Github } from "iconoir-react";
import { SchemaSettings } from "@/components/pikit/settings";
import { defineSettings } from "@/lib/settings";

const Code = ({ children }: { children: string }) => <code className="rounded-[4px] bg-inset px-1 font-mono text-[12px] text-ink">{children}</code>;

function GitHubTokenSettings() {
  return (
    <div>
      <p className="mb-6 text-[13px] leading-relaxed text-ink-2">
        Your agent pushes its proposals as <Code>pikit/self/…</Code> branches of this repository. Its token is the secret <Code>GITHUB_TOKEN</Code>, never typed here: a{" "}
        <a className="underline decoration-line-strong underline-offset-2 hover:text-ink" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
          fine-grained personal access token
        </a>{" "}
        for this repository only (Contents and Pull requests read and write, Checks and Commit statuses read), in <Code>.env</Code> (<Code>pikit configure</Code>) or the
        Worker's secrets.
      </p>
      <SchemaSettings component="github-token" />
    </div>
  );
}

export default defineSettings({
  id: "github-token",
  title: "GitHub",
  icon: Github,
  group: "Agents",
  order: 11,
  requires: ["settings", "github"],
  keywords: ["github", "repository", "token", "self-improvement", "proposals"],
  component: GitHubTokenSettings,
});
