/**
 * Helpers shared by the per-language eval backend definitions (js/py
 * index modules): session-id namespacing and projection of
 * executor results into the ExecutorBackend result shape.
 */
import type { OutputArtifactError } from "@oh-my-pi/pi-tui/tools/streaming-output";
import type { ExecutorBackendResult } from "./backend";
import type { EvalDisplayOutput } from "./types";

export function namespaceSessionId(sessionId: string, prefix: string): string {
	return sessionId.startsWith(prefix) ? sessionId : `${prefix}${sessionId}`;
}

export function toExecutorBackendResult(result: {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId?: string | undefined;
	artifactError?: OutputArtifactError;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: EvalDisplayOutput[];
}): ExecutorBackendResult {
	return {
		output: result.output,
		exitCode: result.exitCode,
		cancelled: result.cancelled,
		truncated: result.truncated,
		artifactId: result.artifactId,
		artifactError: result.artifactError,
		totalLines: result.totalLines,
		totalBytes: result.totalBytes,
		outputLines: result.outputLines,
		outputBytes: result.outputBytes,
		displayOutputs: result.displayOutputs,
	};
}
