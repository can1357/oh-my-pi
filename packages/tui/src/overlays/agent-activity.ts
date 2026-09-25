import type { AgentProgress } from "../tools/task";

export type AgentActivityKind = "response" | "tool" | "irc" | "lifecycle";
export type AgentActivityStatus = "pending" | "success" | "error" | "aborted";

export interface AgentActivityRow {
	id: string;
	agentId: string;
	timestamp: number;
	kind: AgentActivityKind;
	title: string;
	summary: string;
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

/** Activity index surface rendered by the agent hub. */
export interface AgentActivitySource {
	setLive(agentId: string, rows: AgentActivityRow[]): void;
	sync(agentId: string, sessionFile: string | null): Promise<void>;
	query(query: AgentActivityQuery): AgentActivityRow[];
	recent(agentId: string, limit: number): AgentActivityRow[];
}

/** Collapse an activity label to one readable terminal line. */
export function activityOneLine(value: string): string {
	return value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
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
