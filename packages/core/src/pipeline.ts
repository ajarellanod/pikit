/**
 * Pipelines are ordered transformations (SPEC §4.4). Each stage receives the previous
 * stage's output and returns the next value. A stage may return `halt(reason)` to stop the
 * chain; the registry reports it through `onHalt` (the app emits `pipeline.halted`).
 *
 * Every pipeline has one value type: stages are `Value → Value`. A pipeline that "produces"
 * something (route.resolve → decision) carries it as a field of the value.
 *
 * Order: `priority` descending, then registration order. There are no anchors: a stage that
 * must run next to another reads its priority (`pikit doctor` prints every chain) and picks a
 * neighbouring one. Anchors can be added later without breaking anyone; removing them could not.
 *
 * Unlike events, a stage that throws aborts the run: a transformation that failed has no
 * valid output. A stage that returns `undefined` is an error too (a forgotten `return`).
 */

/**
 * Typed pipeline registry: name → value type. Extended by declaration merging like
 * `AppEvents`. Core-owned pipelines are added by the module that runs them.
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging
export interface AppPipelines {}

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
  /** Higher runs first. Default 0. Equal priorities keep registration order. */
  priority?: number;
}

export interface ResolvedStage {
  id: string;
  priority: number;
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
  /** Resolved stage order, for `doctor`. */
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
  /** Resolved chains, so `run()` does not re-sort per call. Invalidated by `register`. */
  const chains = new Map<string, Entry<Ctx>[]>();

  function entries(name: string): Entry<Ctx>[] {
    return pipelines.get(name) ?? [];
  }

  function resolve(name: string): Entry<Ctx>[] {
    const cached = chains.get(name);
    if (cached) return cached;
    const chain = [...entries(name)].sort((a, b) => b.priority - a.priority || a.index - b.index);
    chains.set(name, chain);
    return chain;
  }

  return {
    register(name, fn, options = {}) {
      const list = entries(name);
      const id = options.id ?? `stage-${list.length + 1}`;
      if (list.some((entry) => entry.id === id)) {
        throw new Error(`pipeline "${name}": duplicate stage id "${id}"`);
      }
      list.push({ id, index: list.length, priority: options.priority ?? 0, fn: fn as Stage<unknown, Ctx> });
      pipelines.set(name, list);
      chains.delete(name);
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
      return resolve(name).map(({ id, priority }) => ({ id, priority }));
    },

    names() {
      return [...pipelines.keys()];
    },
  };
}
