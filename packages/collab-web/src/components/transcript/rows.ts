/**
 * Transcript row model: folds session entries into chat turns. Agent text and
 * reasoning stay in the chat flow; consecutive tool calls — across assistant
 * entries — pack into activity units of at most MAX_GROUP_STEPS calls each.
 * Anything else (text, reasoning) ends the current unit.
 */
import type { AssistantMessage, SessionEntry, ToolResultMessage } from "@oh-my-pi/pi-wire";
import type { ActiveTool } from "../../lib/client";
import { type ActivityItem, MAX_GROUP_STEPS } from "./activity";
import { AGENT_TRAFFIC_TYPES, type IrcTraffic, parseIrcTraffic } from "./agent-notices";

/** Spawning subagents is a turn-level event, not a work step: it renders as its own card. */
const SUBAGENT_TOOL = "task";

export type AgentUnit =
	| { type: "text"; key: string; anchor: string; text: string }
	| {
			type: "thinking";
			key: string;
			anchor: string;
			text: string;
			redacted: boolean;
			/** Still streaming: the stream's last block. */
			live: boolean;
			/** Host-stamped thinking time; absent on sessions recorded before it existed. */
			durationMs?: number;
	  }
	| { type: "activity"; key: string; items: ActivityItem[] }
	| { type: "subagents"; key: string; item: ActivityItem }
	| { type: "stop"; key: string; anchor: string; stop: "error" | "aborted"; message?: string };

export interface AgentRowModel {
	kind: "agent";
	key: string;
	timestamp?: string;
	/** Previous turn was also the agent (e.g. across a model-change marker) — no speaker heading. */
	continued: boolean;
	units: AgentUnit[];
}

export interface HumanRowModel {
	kind: "human";
	key: string;
	entry: SessionEntry;
	voice: "host" | "guest";
	/** Guest display name; host prompts resolve the host's name at render time. */
	from: string;
	continued: boolean;
}

/** Dividers, markers, and custom notices — rendered from the entry as-is. */
export interface NoticeRowModel {
	kind: "notice";
	key: string;
	entry: SessionEntry;
}

export interface IrcRowModel {
	kind: "irc";
	key: string;
	traffic: IrcTraffic;
}

export type TranscriptRowModel = AgentRowModel | HumanRowModel | NoticeRowModel | IrcRowModel;

/** Guest display name carried on a `collab-prompt` custom message. */
export function collabPromptFrom(details: unknown): string {
	if (details !== null && typeof details === "object") {
		const from = (details as Record<string, unknown>).from;
		if (typeof from === "string") return from;
	}
	return "guest";
}

export interface TranscriptRowInput {
	visible: readonly SessionEntry[];
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	/** Finished messages awaiting their persisted entries, before the current stream. */
	completedStreams?: readonly AssistantMessage[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	/** Running tools not yet represented by a committed or streamed toolCall block. */
	tailTools: readonly ActiveTool[];
}

export function buildTranscriptRows(input: TranscriptRowInput): TranscriptRowModel[] {
	const { visible, results, active, completedStreams, stream, streamDone, tailTools } = input;
	const rows: TranscriptRowModel[] = [];
	/** Voice of the last speaking row; `""` after a divider, so the next speaker gets a heading. */
	let prevVoice = "";
	/** Agent row still accepting units — closed by any other visible row. */
	let open: AgentRowModel | null = null;

	const agentRow = (timestamp?: string): AgentRowModel => {
		if (open) return open;
		// The preceding transcript boundary identifies the turn across partial → committed handoff.
		const key = `agent:${rows.at(-1)?.key ?? "start"}`;
		const row: AgentRowModel = { kind: "agent", key, timestamp, continued: prevVoice === "agent", units: [] };
		rows.push(row);
		open = row;
		prevVoice = "agent";
		return row;
	};

	const pushActivity = (row: AgentRowModel, item: ActivityItem): void => {
		if (item.name === SUBAGENT_TOOL) {
			row.units.push({ type: "subagents", key: `subagents:${item.id}`, item });
			return;
		}
		const last = row.units.at(-1);
		if (last?.type === "activity" && last.items.length < MAX_GROUP_STEPS) {
			last.items.push(item);
			return;
		}
		row.units.push({ type: "activity", key: `activity:${item.id}`, items: [item] });
	};

	const pushMessage = (
		row: AgentRowModel,
		message: AssistantMessage,
		pending: boolean,
		source = `stream:${message.timestamp}`,
	): void => {
		message.content.forEach((block, i) => {
			switch (block.type) {
				case "text":
					if (block.text.trim().length > 0)
						row.units.push({
							type: "text",
							key: `text:${row.units.length}`,
							anchor: `${source}:${i}`,
							text: block.text,
						});
					break;
				case "thinking":
				case "redactedThinking": {
					const redacted = block.type === "redactedThinking";
					const text = redacted ? "" : block.thinking;
					const live = pending && i === message.content.length - 1;
					if (redacted || live || text.trim().length > 0) {
						row.units.push({
							type: "thinking",
							key: `thinking:${row.units.length}`,
							anchor: `${source}:${i}`,
							text,
							redacted,
							live,
							durationMs: message.thinkingMs?.[i],
						});
					}
					break;
				}
				case "toolCall": {
					const act = active.get(block.id);
					const result = results.get(block.id);
					pushActivity(row, {
						id: block.id,
						name: block.name,
						args: act?.args ?? block.arguments,
						intent: act?.intent ?? block.intent,
						result,
						running: !result && act !== undefined,
						partialResult: act?.partialResult,
					});
					break;
				}
			}
		});
		const stop = message.stopReason;
		if (!pending && (stop === "error" || stop === "aborted")) {
			row.units.push({
				type: "stop",
				key: `stop:${row.units.length}`,
				anchor: `${source}:stop`,
				stop,
				message: message.errorMessage,
			});
		}
	};

	const human = (entry: SessionEntry, voice: "host" | "guest", from: string): void => {
		open = null;
		const key = voice === "host" ? "host" : `guest:${from}`;
		rows.push({ kind: "human", key: entry.id, entry, voice, from, continued: prevVoice === key });
		prevVoice = key;
	};

	const notice = (entry: SessionEntry, breaksTurn: boolean): void => {
		open = null;
		rows.push({ kind: "notice", key: entry.id, entry });
		if (breaksTurn) prevVoice = "";
	};

	for (const entry of visible) {
		const traffic = parseIrcTraffic(entry);
		if (traffic) {
			open = null;
			rows.push({ kind: "irc", key: entry.id, traffic });
			continue;
		}
		switch (entry.type) {
			case "message":
				if (entry.message.role === "user") human(entry, "host", "host");
				else if (entry.message.role === "assistant") {
					pushMessage(agentRow(entry.timestamp), entry.message, false, `entry:${entry.id}`);
				}
				// toolResult entries pair with their calls; developer & unknown roles are skipped
				break;
			case "custom_message":
				if (entry.customType === "collab-prompt") human(entry, "guest", collabPromptFrom(entry.details));
				// Agent traffic (job completions, inter-agent messages) keeps the agent's turn open.
				else if (entry.display) notice(entry, AGENT_TRAFFIC_TYPES[entry.customType] !== true);
				break;
			case "compaction":
			case "branch_summary":
				notice(entry, true);
				break;
			case "model_change":
			case "thinking_level_change":
				// Markers split the row but not the speaker: the agent continues without a new heading.
				notice(entry, false);
				break;
			default:
				// unknown entry types from newer hosts — skip tolerantly
				break;
		}
	}

	if (completedStreams) {
		for (const message of completedStreams) pushMessage(agentRow(), message, false);
	}
	if (stream !== null) pushMessage(agentRow(), stream, !streamDone);
	if (tailTools.length > 0) {
		const row = agentRow();
		for (const tool of tailTools) {
			pushActivity(row, {
				id: tool.toolCallId,
				name: tool.toolName,
				args: tool.args,
				intent: tool.intent,
				running: !results.has(tool.toolCallId),
				result: results.get(tool.toolCallId),
				partialResult: tool.partialResult,
			});
		}
	}
	return rows;
}
