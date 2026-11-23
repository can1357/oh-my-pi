/**
 * MCP progress values, apart from the MCP renderer in `./mcp` so the MCP
 * transports (which run inside the omp daemon) parse progress without loading
 * the TUI rendering stack.
 */
import { isRecord } from "@oh-my-pi/pi-utils";

/** Server-reported progress of an in-flight MCP request. */
export interface MCPProgress {
	progress: number;
	total?: number;
	message?: string;
}

/**
 * Read MCP progress fields from an untrusted record: `progress` must be a
 * finite number; `total` is kept only when finite and `message` only when a
 * string. Shared by the transports, the Eval bridge, and the status renderer.
 */
export function parseMCPProgress(value: unknown): MCPProgress | undefined {
	if (!isRecord(value) || typeof value.progress !== "number" || !Number.isFinite(value.progress)) return undefined;
	const progress: MCPProgress = { progress: value.progress };
	if (typeof value.total === "number" && Number.isFinite(value.total)) progress.total = value.total;
	if (typeof value.message === "string") progress.message = value.message;
	return progress;
}
