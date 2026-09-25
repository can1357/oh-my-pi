/**
 * Bootstrap-only worker selectors dispatched by the shared CLI entrypoint.
 *
 * Keep these strings independent of each worker's protocol module: the CLI must
 * recognize a worker before importing protocol/runtime graphs whose top-level
 * evaluation is unnecessary in an ordinary interactive process.
 */
/** Blob-broker selector shared by the CLI dispatcher and worker launcher. */
export const BLOB_BROKER_WORKER_ARG = "__omp_worker_blob_broker";
/** Computer-worker selector shared by the CLI dispatcher and worker launcher. */
export const COMPUTER_WORKER_ARG = "__omp_worker_computer";
/** Daemon-broker selector shared by the CLI dispatcher and worker launcher. */
export const DAEMON_BROKER_WORKER_ARG = "__omp_worker_daemon_broker";
/** IDA-host selector shared by the CLI dispatcher and the broker daemon spec. */
export const IDA_HOST_WORKER_ARG = "__omp_worker_ida_host";
/** LSP-multiplexer selector shared by the CLI dispatcher and worker launcher. */
export const LSP_MUX_WORKER_ARG = "__omp_worker_lsp_mux";
/** Activity-worker selector shared by the CLI dispatcher and worker launcher. */
export const STATS_ACTIVITY_WORKER_ARG = "__omp_worker_stats_activity";
/** Terminal-output selector shared by the CLI dispatcher and worker launcher. */
export const TERMINAL_OUTPUT_WORKER_ARG = "__omp_worker_terminal_output";
