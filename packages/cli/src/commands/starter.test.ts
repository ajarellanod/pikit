import { expect, test } from "bun:test";
import { agent, BUNFIG, introduction, PROJECT_REGISTRY, SKILLS_DIR, skillFiles, tsconfig } from "./starter.ts";

test("a project is ready for a registry of its own: tsc and bun test leave registry/ out, and its lib has ES2023", () => {
  const config = JSON.parse(tsconfig()) as { compilerOptions: { lib: string[] }; exclude: string[] };
  expect(config.exclude).toContain(PROJECT_REGISTRY);
  // `Array.prototype.findLast` and `toSorted`, which Bun and workerd have.
  expect(config.compilerOptions.lib).toEqual(["ES2023"]);
  expect(BUNFIG).toContain(`[test]\n`);
  expect(BUNFIG).toContain(`pathIgnorePatterns = ["registry/**"]`);
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

test("the kit's skills for AI agents are what pikit new copies, by their path in the project", () => {
  const skills = skillFiles();

  for (const name of ["pikit-component", "pikit-extension"]) {
    expect(skills.map((skill) => skill.path)).toContain(`${SKILLS_DIR}/${name}/SKILL.md`);
    expect(skills.find((skill) => skill.path.endsWith(`${name}/SKILL.md`))?.text).toStartWith(`---\nname: ${name}\n`);
  }
  expect(skillFiles("/nonexistent")).toEqual([]);
});
