import type { TerminalOutputOptions } from "./terminal-output";

export { TERMINAL_OUTPUT_WORKER_ARG } from "../cli/worker-selectors";

export interface TerminalOutputWorkerRequest {
	output: string;
	options: TerminalOutputOptions;
}

export type TerminalOutputWorkerResult = { ok: true; rows: string[] | undefined } | { ok: false; error: string };
