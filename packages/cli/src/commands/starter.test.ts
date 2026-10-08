import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_REPOSITORY, PIKIT_ROOT } from "../paths.ts";
import { agent, BUNFIG, introduction, PROJECT_REGISTRY, readme, SKILLS_DIR, skillFiles, starterExtensions, starterTools, tsconfig, upText, withKitLocation } from "./starter.ts";

test("a project is ready for a registry of its own and a dashboard: tsc and bun test leave registry/ and src/dashboard/ out, and its lib has ES2023", () => {
  const config = JSON.parse(tsconfig()) as { compilerOptions: { lib: string[] }; exclude: string[] };
  expect(config.exclude).toContain(PROJECT_REGISTRY);
  // The dashboard is a project of its own (DOM, JSX, its own packages): the project's tsc never reads it.
  expect(config.exclude).toContain("src/dashboard");
  // `Array.prototype.findLast` and `toSorted`, which Bun and workerd have.
  expect(config.compilerOptions.lib).toEqual(["ES2023"]);
  expect(BUNFIG).toContain(`[test]\n`);
  expect(BUNFIG).toContain(`pathIgnorePatterns = ["registry/**", "src/dashboard/**"]`);
});

test("the starter prompt says where the agent is reached: by the channels being installed", () => {
  expect(introduction([{ name: "channel-http" }])).toBe("You are a helpful assistant reached over an HTTP API, by programs and the people behind them.");
  expect(introduction([{ name: "channel-telegram" }])).toBe("You are a helpful assistant that people talk to in Telegram chats.");
  expect(introduction([{ name: "channel-telegram-webhook" }])).toBe(introduction([{ name: "channel-telegram" }]));
  // A channel the starter does not know is named by its title; none at all, by nothing.
  expect(introduction([{ name: "channel-slack", title: "Slack: talk to your agent in a channel" }])).toBe("You are a helpful assistant reached through Slack.");
  expect(introduction([])).toBe("You are a helpful assistant.");
  expect(introduction([{ name: "channel-http" }, { name: "channel-telegram" }])).toContain("HTTP API, by programs and the people behind them, and that people talk to in Telegram chats.");
});

test("the starter agent's file carries that prompt, quoted for TypeScript", () => {
  const file = agent([], "faux/echo", [{ name: "channel-telegram" }]);

  expect(file).toContain(`"You are a helpful assistant that people talk to in Telegram chats. Answer briefly and plainly.",`);
  expect(file).toContain(`model: "faux/echo"`);
  expect(file).not.toContain("HTTP API");
});

test("the starter agent names pikit-self when extension-pikit-self is installed, and no extension otherwise", () => {
  expect(starterExtensions(["runtime-pi", "extension-pikit-self", "extension-house-rules"])).toEqual(["pikit-self"]);
  expect(starterExtensions(["runtime-pi"])).toEqual([]);

  const named = agent(["read"], "faux/echo", [], "server", starterExtensions(["extension-pikit-self"]));
  expect(named).toContain('  tools: ["read"],\n  extensions: ["pikit-self"],\n});');
  expect(agent(["read"], "faux/echo")).not.toContain("extensions:");
});

test("the kit's skills for AI agents are what pikit new copies, by their path in the project", () => {
  const skills = skillFiles();

  for (const name of ["pikit-component", "pikit-extension"]) {
    expect(skills.map((skill) => skill.path)).toContain(`${SKILLS_DIR}/${name}/SKILL.md`);
    expect(skills.find((skill) => skill.path.endsWith(`${name}/SKILL.md`))?.text).toStartWith(`---\nname: ${name}\n`);
  }
  expect(skillFiles("/nonexistent")).toEqual([]);
});

test("the copied skills say where the kit is: this CLI's checkout, and online at the project's kit commit", () => {
  const source = readFileSync(join(PIKIT_ROOT, SKILLS_DIR, "pikit-component", "SKILL.md"), "utf8");
  expect(source).toContain("{{PIKIT_ROOT}}/features/memory.md");
  expect(source).toContain("{{PIKIT_URL}}");

  const skills = skillFiles(PIKIT_ROOT, "abc1234-dirty");
  for (const skill of skills) expect(skill.text).not.toContain("{{PIKIT_");
  const component = skills.find((skill) => skill.path.endsWith("pikit-component/SKILL.md"))?.text ?? "";
  expect(component).toContain(`\`${PIKIT_ROOT}/features/memory.md\``);
  // Pinned at the commit the vendored kit was packed from; uncommitted changes have no URL.
  expect(component).toContain(`${KIT_REPOSITORY}/tree/abc1234.`);
  expect(withKitLocation("{{PIKIT_URL}}", "/kit", undefined)).toBe(KIT_REPOSITORY);

  // Every kit file a skill names exists, so the path it gives a project's agent opens.
  const named = skills.flatMap((skill) => [...skill.text.matchAll(new RegExp(`${PIKIT_ROOT}/([\\w./-]+)`, "g"))].map((m) => m[1] ?? ""));
  expect(named.length).toBeGreaterThan(3);
  for (const path of named.filter((p) => !p.includes("<"))) expect(existsSync(join(PIKIT_ROOT, path.replace(/[.]$/, "")))).toBe(true);
});

test("on a server the starter agent does not name bash, even installed, and says why; on Cloudflare it does", () => {
  const installed = ["read", "write", "edit", "bash"];
  const server = agent(installed, "faux/echo", [], "server");
  expect(server).toContain('tools: ["read","write","edit"],');
  expect(server).toContain("`bash` is installed but not named here: it runs commands as this server's user");
  expect(server).toContain("src/pikit/tool-bash/README.md");
  expect(server).toContain("read, write and edit files there.");
  expect(server).not.toContain("run commands in it");

  const durable = agent(installed, "faux/echo", [], "durable");
  expect(durable).toContain('tools: ["read","write","edit","bash"],');
  expect(durable).toContain("read, write and edit files there, and to run commands in it.");
  expect(durable).not.toContain("installed but not named");
  expect(starterTools(["read"], "server")).toEqual(["read"]);
});

test("the README says what `pikit up` does by the installed deployment, never by the target", () => {
  expect(readme("a", ["channel-http", "deployment-docker"])).toContain("pikit up          # or run it in Docker (deployment-docker): then pikit status, logs, down");
  expect(readme("a", ["deployment-cloudflare"], "durable")).toContain("pikit up          # or deploy it to Cloudflare (deployment-cloudflare): then pikit status, logs");
  expect(readme("a", ["deployment-fly"])).toContain("pikit up          # or deploy it with deployment-fly (deployment-fly)\n");
  const none = readme("a", ["channel-http"]);
  expect(none).not.toContain("Docker");
  expect(none).toContain("there is none");
  expect(upText(["channel-http"])).toBeUndefined();
  expect(upText(["deployment-docker"])).toBe("run it in Docker");
});

test("the README says where pikit comes from and where the kit is, as pikit new writes it", () => {
  const text = withKitLocation(readme("a", []), PIKIT_ROOT, "abc1234");
  expect(text).toContain("## Where pikit is");
  expect(text).toContain(`It runs from the kit's checkout at \`${PIKIT_ROOT}\``);
  expect(text).toContain("installer/install.sh");
  expect(text).toContain(`${KIT_REPOSITORY}/tree/abc1234.`);
  expect(text).not.toContain("{{PIKIT_");
  expect(existsSync(join(PIKIT_ROOT, "installer", "install.sh"))).toBe(true);
});
