/**
 * Helpers shared by the per-language eval backend definitions (jl/js/py/rb
 * index modules): session-id namespacing, settings access, and projection of
 * executor results into the ExecutorBackend result shape.
 */
import type { ToolSession } from "../tools";
import type { ExecutorBackendResult } from "./backend";
import type { EvalDisplayOutput } from "./types";

export function namespaceSessionId(sessionId: string, prefix: string): string {
	return sessionId.startsWith(prefix) ? sessionId : `${prefix}${sessionId}`;
}

export function readSetting<T>(session: ToolSession, key: string): T | undefined {
	const settings = session.settings as { get?: (key: string) => T | undefined } | undefined;
	return settings?.get?.(key);
}

export function readInterpreterSetting(session: ToolSession, key: string): string | undefined {
	const value = readSetting<unknown>(session, key);
	return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function toExecutorBackendResult(result: {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId?: string | undefined;
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
		totalLines: result.totalLines,
		totalBytes: result.totalBytes,
		outputLines: result.outputLines,
		outputBytes: result.outputBytes,
		displayOutputs: result.displayOutputs,
	};
}
