import type { TerminalOutputOptions } from "./terminal-output";

/** Hidden CLI selector for legacy PTY replay outside the client process. */
export const TERMINAL_OUTPUT_WORKER_ARG = "__omp_worker_terminal_output";

export interface TerminalOutputWorkerRequest {
	output: string;
	options: TerminalOutputOptions;
}

export type TerminalOutputWorkerResult = { ok: true; rows: string[] | undefined } | { ok: false; error: string };
