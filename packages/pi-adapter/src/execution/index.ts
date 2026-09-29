// Public surface of @pikit/pi-adapter/execution: what an `execution` provider needs to implement Pi's
// `ExecutionEnv` without importing Pi (rule 1). An environment never throws: it answers with Pi's
// `Result` (`ok`, `err`) holding a `FileError` or an `ExecutionError`, and bounds a command's output as
// Pi's own environment does (`truncateTail`, `truncateHead`). Neutral: `execution-do` uses it in a
// Cloudflare Durable Object.

export { err, ExecutionError, FileError, ok, truncateHead, truncateTail } from "@earendil-works/pi-agent-core";
export type {
  ExecutionEnv,
  ExecutionErrorCode,
  FileErrorCode,
  FileInfo,
  Result,
  ShellExecOptions,
  ShellExecResult,
  ShellOutputTruncation,
  ShellOutputUpdate,
  TruncationResult,
} from "@earendil-works/pi-agent-core";
