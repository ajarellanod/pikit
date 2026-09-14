/**
 * Pipelines are ordered transformations (SPEC §4.4). Each stage receives the previous
 * stage's output and returns the next value. A stage may return `halt(reason)` to stop the
 * chain; the registry reports it through `onHalt` (the harness emits `pipeline.halted`).
 *
 * Every pipeline has one value type: stages are `Value → Value`. A pipeline that "produces"
 * something (route.resolve → decision) carries it as a field of the value.
 *
 * Order: `priority` descending, then registration order. A stage anchored with
 * `before: id` / `after: id` is placed next to its anchor; stages sharing an anchor keep
 * registration order among themselves.
 *
 * Unlike events, a stage that throws aborts the run: a transformation that failed has no
 * valid output. A stage that returns `undefined` is an error too (a forgotten `return`).
 */

/**
 * Typed pipeline registry: name → value type. Extended by declaration merging like
 * `HarnessEvents`. Core-owned pipelines are added by the module that runs them.
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging
export interface HarnessPipelines {}

export class Halt {
  constructor(
    readonly reason: string,
    /** Id of the stage that halted; filled in by the registry. */
    readonly stage?: string,
  ) {}
}

export function halt(reason: string): Halt {
  return new Halt(reason);
}

export type Stage<Value, Ctx> = (value: Value, ctx: Ctx) => Value | Halt | Promise<Value | Halt>;

export interface StageOptions {
  /** Unique within the pipeline. Defaults to `stage-<n>`. */
  id?: string;
  /** Higher runs first. Default 0. Ignored when `before`/`after` is set. */
  priority?: number;
  /** Place immediately before this stage id. */
  before?: string;
  /** Place immediately after this stage id. */
  after?: string;
}

export interface ResolvedStage {
  id: string;
  priority: number;
  before?: string;
  after?: string;
}

export interface HaltedInfo {
  pipeline: string;
  stage: string;
  reason: string;
}

export interface PipelineRegistry<Pipelines extends object, Ctx> {
  register<K extends keyof Pipelines & string>(
    name: K,
    stage: Stage<Pipelines[K], Ctx>,
    options?: StageOptions,
  ): void;
  run<K extends keyof Pipelines & string>(
    name: K,
    input: Pipelines[K],
    ctx: Ctx,
  ): Promise<Pipelines[K] | Halt>;
  /** Resolved stage order, for `doctor`. Throws if an anchor cannot be placed. */
  chain(name: string): ResolvedStage[];
  /** Every pipeline that has at least one stage. */
  names(): string[];
}

interface Entry<Ctx> extends ResolvedStage {
  index: number;
  fn: Stage<unknown, Ctx>;
}

export function createPipelineRegistry<Pipelines extends object, Ctx>(
  onHalt: (info: HaltedInfo, ctx: Ctx) => void | Promise<void>,
): PipelineRegistry<Pipelines, Ctx> {
  const pipelines = new Map<string, Entry<Ctx>[]>();

  function entries(name: string): Entry<Ctx>[] {
    return pipelines.get(name) ?? [];
  }

  function resolve(name: string): Entry<Ctx>[] {
    const all = entries(name);
    const before = new Map<string, Entry<Ctx>[]>();
    const after = new Map<string, Entry<Ctx>[]>();
    const base: Entry<Ctx>[] = [];
    for (const entry of all) {
      if (entry.before) push(before, entry.before, entry);
      else if (entry.after) push(after, entry.after, entry);
      else base.push(entry);
    }
    base.sort((a, b) => b.priority - a.priority || a.index - b.index);

    const placed = new Set<Entry<Ctx>>();
    const expand = (entry: Entry<Ctx>): Entry<Ctx>[] => {
      placed.add(entry);
      return [
        ...(before.get(entry.id) ?? []).flatMap(expand),
        entry,
        ...(after.get(entry.id) ?? []).flatMap(expand),
      ];
    };
    const chain = base.flatMap(expand);

    const orphan = all.find((entry) => !placed.has(entry));
    if (orphan) {
      throw new Error(
        `pipeline "${name}": stage "${orphan.id}" is anchored to "${orphan.before ?? orphan.after}", which does not exist or is itself unplaced`,
      );
    }
    return chain;
  }

  return {
    register(name, fn, options = {}) {
      const list = entries(name);
      const id = options.id ?? `stage-${list.length + 1}`;
      if (list.some((entry) => entry.id === id)) {
        throw new Error(`pipeline "${name}": duplicate stage id "${id}"`);
      }
      if (options.before !== undefined && options.after !== undefined) {
        throw new Error(`pipeline "${name}": stage "${id}" sets both before and after`);
      }
      const entry: Entry<Ctx> = {
        id,
        index: list.length,
        priority: options.priority ?? 0,
        fn: fn as Stage<unknown, Ctx>,
      };
      if (options.before !== undefined) entry.before = options.before;
      if (options.after !== undefined) entry.after = options.after;
      list.push(entry);
      pipelines.set(name, list);
    },

    async run(name, input, ctx) {
      let value: unknown = input;
      for (const stage of resolve(name)) {
        const next = await stage.fn(value, ctx);
        if (next instanceof Halt) {
          const halted = new Halt(next.reason, stage.id);
          await onHalt({ pipeline: name, stage: stage.id, reason: next.reason }, ctx);
          return halted;
        }
        if (next === undefined) {
          throw new Error(`pipeline "${name}": stage "${stage.id}" returned undefined`);
        }
        value = next;
      }
      return value as Pipelines[typeof name];
    },

    chain(name) {
      return resolve(name).map(({ id, priority, before, after }) => ({
        id,
        priority,
        ...(before !== undefined && { before }),
        ...(after !== undefined && { after }),
      }));
    },

    names() {
      return [...pipelines.keys()];
    },
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
