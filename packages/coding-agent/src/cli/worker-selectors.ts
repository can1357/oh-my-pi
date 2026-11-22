/**
 * Bootstrap-only worker selectors dispatched by the shared CLI entrypoint.
 *
 * Keep these strings independent of each worker's protocol module: the CLI must
 * recognize a worker before importing protocol/runtime graphs whose top-level
 * evaluation is unnecessary in an ordinary interactive process.
 */
/** Background self-update selector shared by the CLI dispatcher and `cli/auto-update.ts`. */
export const AUTO_UPDATE_WORKER_ARG = "__omp_worker_auto_update";
/** Computer-worker selector shared by the CLI dispatcher and worker launcher. */
export const COMPUTER_WORKER_ARG = "__omp_worker_computer";
/** Parent-death watchdog thread selector shared by the CLI dispatcher and `startParentWatchdog`. */
export const PARENT_WATCHDOG_WORKER_ARG = "__omp_worker_parent_watchdog";
/** Subagent host worker selector shared by the CLI dispatcher and `SubagentWorker`. */
export const SUBAGENT_WORKER_ARG = "__omp_worker_subagent";
/** Activity-worker selector shared by the CLI dispatcher and worker launcher. */
export const STATS_ACTIVITY_WORKER_ARG = "__omp_worker_stats_activity";
/** Transcript-index worker selector shared by the CLI dispatcher and `transcript-index-client.ts`. */
export const TRANSCRIPT_INDEX_WORKER_ARG = "__omp_worker_transcript_index";
/** Sandboxed JS eval subprocess selector (stdio-framed transport) shared by the CLI dispatcher and the JS context manager. */
export const JS_EVAL_STDIO_WORKER_ARG = "__omp_worker_js_eval_stdio";
/** In-sandbox shell host selector shared by the CLI dispatcher and `sandbox/shell-client.ts`. */
export const SANDBOX_HOST_ARG = "__omp_sandbox_host";
