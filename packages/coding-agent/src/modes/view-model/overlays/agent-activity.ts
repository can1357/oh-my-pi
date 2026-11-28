import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentProgress } from "../../../task/task-details";
import { shortenPath } from "../../../utils/render-utils";

export type AgentActivityKind = "response" | "tool" | "irc" | "lifecycle";

export type AgentActivityStatus = "pending" | "success" | "error" | "aborted";

export interface AgentActivityRow {
	id: string;
	agentId: string;
	timestamp: number;
	kind: AgentActivityKind;
	title: string;
	summary: string;
	/** The searchable summary is a tool-call intent, not an argument or response. */
	summaryIsToolIntent?: boolean;
	status?: AgentActivityStatus;
	entryId?: string;
	toolCallId?: string;
	toolName?: string;
	from?: string;
	to?: string;
	replyTo?: string;
	source: "live" | "transcript" | "irc";
}

export interface AgentActivityQuery {
	agentIds?: ReadonlySet<string>;
	kinds?: ReadonlySet<AgentActivityKind>;
	search?: string;
	before?: { timestamp: number; id: string };
	limit?: number;
}

/** Collapse an activity label to one readable terminal line. */
export function activityOneLine(value: string): string {
	return value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function firstString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.trim()) return activityOneLine(candidate);
	}
	return undefined;
}

/** The call's `path` arg, the home directory shown as `~`. */
function pathSummary(args: Record<string, unknown>): string | undefined {
	const path = firstString(args, "path");
	return path === undefined ? undefined : shortenPath(path);
}

function argumentsSummary(toolName: string, args: Record<string, unknown>): string {
	const intent = firstString(args, "intent");
	if (intent) return intent;
	switch (toolName) {
		case "read":
			return pathSummary(args) ?? "Read resource";
		case "grep": {
			const pattern = firstString(args, "pattern");
			return [pattern, pathSummary(args)].filter(Boolean).join(" · ") || "Search text";
		}
		case "glob":
			return pathSummary(args) ?? "Map files";
		case "bash":
			return firstString(args, "command") ?? "Run command";
		case "write":
		case "edit":
			return pathSummary(args) ?? `${toolName === "write" ? "Write" : "Edit"} files`;
		case "wait":
			return "Waiting for background work or a peer";
		default: {
			const common = pathSummary(args) ?? firstString(args, "query", "name", "task", "title");
			if (common) return common;
			try {
				const encoded = activityOneLine(JSON.stringify(args));
				return encoded === "{}" ? toolName : encoded;
			} catch {
				return toolName;
			}
		}
	}
}

/** A tool call's activity summary: its intent (`i`) when it gave one, else a short summary of its args. */
export function toolCallSummary(
	toolName: string,
	args: unknown,
): Pick<AgentActivityRow, "summary" | "summaryIsToolIntent"> {
	const record = isRecord(args) ? args : {};
	const intent = firstString(record, "i");
	return { summary: intent ?? argumentsSummary(toolName, record), summaryIsToolIntent: intent !== undefined };
}

/** Stable timestamp ordering for merged activity rows. */
export function compareActivityRows(a: AgentActivityRow, b: AgentActivityRow): number {
	return a.timestamp - b.timestamp || a.id.localeCompare(b.id);
}

export function activityRowsFromProgress(progress: AgentProgress, lastUpdate = Date.now()): AgentActivityRow[] {
	const rows: AgentActivityRow[] = [];
	const recentTools = progress.recentTools ?? [];
	for (let index = recentTools.length - 1; index >= 0; index--) {
		const tool = recentTools[index]!;
		rows.push({
			id: `live:${progress.id}:tool:${tool.endMs}:${index}`,
			agentId: progress.id,
			timestamp: tool.endMs,
			kind: "tool",
			title: tool.tool,
			summary: tool.args || tool.tool,
			status: "success",
			toolName: tool.tool,
			source: "live",
		});
	}
	if (progress.currentTool) {
		rows.push({
			id: `live:${progress.id}:current-tool`,
			agentId: progress.id,
			timestamp: progress.currentToolStartMs ?? lastUpdate,
			kind: "tool",
			title: progress.currentTool,
			summary: progress.lastIntent ?? progress.currentToolArgs ?? progress.currentTool,
			summaryIsToolIntent: progress.lastIntent !== undefined,
			status: "pending",
			toolName: progress.currentTool,
			source: "live",
		});
	}
	rows.push({
		id: `live:${progress.id}:lifecycle`,
		agentId: progress.id,
		timestamp: lastUpdate,
		kind: "lifecycle",
		title: progress.status ?? "running",
		summary: progress.task ?? progress.description ?? "Agent activity",
		status:
			progress.status === "completed"
				? "success"
				: progress.status === "failed"
					? "error"
					: progress.status === "aborted"
						? "aborted"
						: "pending",
		source: "live",
	});
	const response = activityOneLine((progress.recentOutput ?? []).join(" "));
	if (response) {
		rows.push({
			id: `live:${progress.id}:response`,
			agentId: progress.id,
			timestamp: lastUpdate,
			kind: "response",
			title: "Response",
			summary: response,
			status: progress.status === "failed" ? "error" : progress.status === "aborted" ? "aborted" : "pending",
			source: "live",
		});
	}
	return rows.sort(compareActivityRows);
}
