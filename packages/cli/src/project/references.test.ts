import { expect, test } from "bun:test";
import type { AgentReferences, ProbeResult } from "./probe.ts";
import type { Manifest } from "../registry/manifest.ts";
import { brokenReferences, manifestProviders } from "./references.ts";

type Composed = Extract<ProbeResult, { ok: true }>;

/** An app with a runtime that uses the two keyed capabilities, and the given keys and agents. */
function app(keys: Record<string, Record<string, string>>, agents: AgentReferences[], runtimeUses = ["agent.tool", "agent.extension", "model.provider"]): Composed {
  return {
    ok: true,
    listed: [],
    description: {
      components: [{ name: "runtime-pi", provides: ["agent.runtime"], requires: [], optional: runtimeUses }],
      capabilities: Object.fromEntries(Object.entries(keys).map(([name, owners]) => [name, { providers: [...new Set(Object.values(owners))], keys: owners }])),
      pipelines: {},
      config: {},
      stagesBy: {},
    },
    agents,
  };
}

const soporte: AgentReferences = { agent: "soporte", component: "agents", model: "anthropic/claude-x", tools: ["read", "bash"], extensions: ["memory"] };
const complete = {
  "agent.tool": { read: "tool-read", bash: "tool-bash" },
  "agent.extension": { memory: "memory-sql" },
  "model.provider": { anthropic: "provider-anthropic" },
};

test("every name an agent gives is an installed key: nothing is broken", () => {
  expect(brokenReferences(app(complete, [soporte]))).toEqual([]);
});

test("a tool or a model provider with no installed key is broken", () => {
  expect(brokenReferences(app({ "agent.tool": { read: "tool-read" } }, [soporte]))).toEqual([
    'agent "soporte" names the tool "bash", which no installed component provides (agent.tool)',
    'agent "soporte" names the extension "memory", which no installed component provides (agent.extension)',
    'agent "soporte" names the model "anthropic/claude-x", whose provider "anthropic" no installed component provides (model.provider)',
  ]);
});

test("removing the only provider of a named key breaks it; agents it provides go with it", () => {
  expect(brokenReferences(app(complete, [soporte]), "tool-bash")).toEqual(['agent "soporte" names the tool "bash", which only tool-bash provides']);
  expect(brokenReferences(app(complete, [soporte]), "provider-anthropic")).toEqual([
    'agent "soporte" names the model "anthropic/claude-x", whose provider "anthropic" only provider-anthropic provides',
  ]);
  expect(brokenReferences(app(complete, [soporte]), "memory-sql")).toEqual(['agent "soporte" names the extension "memory", which only memory-sql provides']);
  expect(brokenReferences(app(complete, [soporte]), "tool-write")).toEqual([]);
  expect(brokenReferences(app(complete, [soporte]), "agents")).toEqual([]);
});

test("with no component that uses the capability, a name resolves nowhere and is not checked", () => {
  expect(brokenReferences(app({}, [soporte], []))).toEqual([]);
  // Removing the runtime removes the only reader of the names.
  expect(brokenReferences(app(complete, [soporte]), "runtime-pi")).toEqual([]);
});

test("with the registry's manifests, a broken tool or model provider names the component to install", () => {
  const manifests = [
    { name: "tool-websearch-brave", replay: { tools: { websearch: "safe" } } },
    { name: "tool-mcp" },
    { name: "provider-anthropic", modelProviders: ["anthropic"] },
  ] as unknown as Manifest[];
  const searcher: AgentReferences = { agent: "soporte", component: "agents", model: "anthropic/claude-x", tools: ["websearch", "wiki_search"], extensions: [] };

  expect(brokenReferences(app({}, [searcher]), undefined, manifestProviders(manifests))).toEqual([
    'agent "soporte" names the tool "websearch", which no installed component provides (agent.tool): install tool-websearch-brave',
    // An MCP tool is named in tool-mcp's config: no manifest records it.
    'agent "soporte" names the tool "wiki_search", which no installed component provides (agent.tool)',
    'agent "soporte" names the model "anthropic/claude-x", whose provider "anthropic" no installed component provides (model.provider): install provider-anthropic',
  ]);
});
