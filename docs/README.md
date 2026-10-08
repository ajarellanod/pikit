# pikit docs

pikit runs the [Pi](https://github.com/earendil-works/pi) agent as a durable service. It is a small
kernel (`@pikit/core`: an App made of components that provide and use capabilities, plus pipelines,
events and a lifecycle), a set of contracts (`@pikit/contracts`: the capabilities components agree on,
each with a conformance suite), one adapter that is the only door to Pi (`@pikit/pi-adapter`), and a
registry of components copied into a project as source the user owns. A project runs on one of two
targets: `server` (a long-lived process, Docker) or `durable` (Cloudflare: a Worker plus one Durable
Object per conversation). These pages describe what exists at this commit, read from the code.

## Pages

- [concepts.md](concepts.md): App, component, capability, contract, pipeline, event, feed, context,
  target, the two Apps on Cloudflare, config and secrets, `describe()`.
- [components.md](components.md): what a component is made of (`component.json`, `files/`, tests,
  hooks, views), how `pikit add`, `remove` and `upgrade` install it, kinds and offers.
- [contracts.md](contracts.md): every capability, its interface and guarantees, who provides and uses
  it, and its conformance suite.
- [pipelines.md](pipelines.md): every pipeline and its stages, and every event with its emitters and
  listeners.
- [message-flow.md](message-flow.md): one message end to end, on a server and on Cloudflare, with the
  files that implement each step.
- [targets.md](targets.md): `server` and `durable`, what runs where, wakeups, limits, deployment.
- [cli.md](cli.md): every `pikit` command, its flags, what it changes, and what `doctor` checks.
- [dashboard.md](dashboard.md): `admin-api`, `admin-auth-token`, the dashboard template and its views.

## Elsewhere

- [../SPEC.md](../SPEC.md): what must hold (properties P1…, kernel decisions K1…, Cloudflare decisions
  C1…, §5 the dashboard, §6 self-improvement). These docs cite those names.
- [../features/](../features/README.md): one design note per feature, built (`completed/`) or not.
  Settings, proposals, the CLI features step and self-improvement are design notes only.
- [../features/building-components.md](../features/building-components.md) and
  [../.agents/skills/](../.agents/skills/pikit-component/SKILL.md): how to build a component, a view or
  an agent extension.
- [upstream/](upstream/README.md): proposals made to Pi. [architecture-audit.md](architecture-audit.md):
  an earlier audit. Both are kept as they are; these pages do not replace them.
