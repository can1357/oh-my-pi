import { type } from "@oh-my-pi/omptype";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { ToolExecutionUpdateEvent } from "../session/agent-session-handle";
import type { AgentSessionEvent } from "../session/agent-session";

export const TASK_SUBAGENT_ATTACH_CHANNEL = "task:subagent:attach";

export interface AgentAttachAvailablePayload {
	id: string;
	ownerSessionId: string;
	generation: number;
	argv: string[];
}

export type AgentAttachErrorCode =
	| "not_found"
	| "ambiguous"
	| "unauthorized"
	| "unsupported_version"
	| "invalid_request"
	| "session_gone"
	| "command_failed"
	| "transport_limit"
	| "lagged";

export interface AgentAttachLookupRequest {
	v: 1;
	op: "lookup";
	token: string;
	ownerSessionId: string;
	agentId: string;
}

export interface AgentAttachAttachRequest {
	v: 1;
	op: "attach";
	token: string;
	ownerSessionId: string;
	agentId: string;
	generation: number;
}

export type AgentAttachHandshakeRequest = AgentAttachLookupRequest | AgentAttachAttachRequest;

export type AgentAttachCommandRequest =
	| { op: "steer"; requestId: number; text: string }
	| { op: "abort"; requestId: number }
	| { op: "detach" };

export type AgentAttachClientRequest = AgentAttachHandshakeRequest | AgentAttachCommandRequest;

export interface AgentAttachSnapshotStart {
	type: "snapshot_start";
	agentId: string;
	ownerSessionId: string;
	generation: number;
	displayName: string;
	status: "running" | "idle";
	cwd: string;
	model: { provider: string; id: string } | null;
	isStreaming: boolean;
	stats: unknown;
}

export interface AgentAttachSnapshotMessage {
	type: "snapshot_message";
	index: number;
	message: AgentMessage;
}

export interface AgentAttachSnapshotEnd {
	type: "snapshot_end";
	streamMessage: AgentMessage | null;
	pendingToolResults: ToolResultMessage[];
	activeToolExecutionUpdates: ToolExecutionUpdateEvent[];
	queue: { steering: string[]; followUp: string[]; liveSteered: number };
}

export type AgentAttachServerFrame =
	| { type: "found"; ownerSessionId: string; agentId: string; generation: number }
	| AgentAttachSnapshotStart
	| AgentAttachSnapshotMessage
	| AgentAttachSnapshotEnd
	| { type: "event"; event: AgentSessionEvent }
	| { type: "run_state"; state: "running" | "idle" }
	| { type: "ack"; requestId: number }
	| { type: "error"; requestId?: number; code: AgentAttachErrorCode; message: string };

const LookupRequestShape = type({
	"+": "delete",
	v: "1",
	op: '"lookup"',
	token: "string >= 1",
	ownerSessionId: "string >= 1",
	agentId: "string >= 1",
});
const AttachRequestShape = type({
	"+": "delete",
	v: "1",
	op: '"attach"',
	token: "string >= 1",
	ownerSessionId: "string >= 1",
	agentId: "string >= 1",
	generation: "number.integer >= 1",
});
const SteerRequestShape = type({
	"+": "delete",
	op: '"steer"',
	requestId: "number.integer >= 1",
	text: "string",
});
const AbortRequestShape = type({ "+": "delete", op: '"abort"', requestId: "number.integer >= 1" });
const DetachRequestShape = type({ "+": "delete", op: '"detach"' });

/** Validate one untrusted JSON line without widening it into a request type. */
export function parseAgentAttachClientRequest(value: unknown): AgentAttachClientRequest | undefined {
	if (!isRecord(value) || typeof value.op !== "string") return undefined;
	switch (value.op) {
		case "lookup": {
			const request = LookupRequestShape(value);
			if (request instanceof type.errors) return undefined;
			return {
				v: 1,
				op: "lookup",
				token: request.token,
				ownerSessionId: request.ownerSessionId,
				agentId: request.agentId,
			};
		}
		case "attach": {
			const request = AttachRequestShape(value);
			if (request instanceof type.errors || !Number.isSafeInteger(request.generation)) return undefined;
			return {
				v: 1,
				op: "attach",
				token: request.token,
				ownerSessionId: request.ownerSessionId,
				agentId: request.agentId,
				generation: request.generation,
			};
		}
		case "steer": {
			const request = SteerRequestShape(value);
			if (request instanceof type.errors || !Number.isSafeInteger(request.requestId)) return undefined;
			return { op: "steer", requestId: request.requestId, text: request.text };
		}
		case "abort": {
			const request = AbortRequestShape(value);
			if (request instanceof type.errors || !Number.isSafeInteger(request.requestId)) return undefined;
			return { op: "abort", requestId: request.requestId };
		}
		case "detach": {
			const request = DetachRequestShape(value);
			if (request instanceof type.errors) return undefined;
			return { op: "detach" };
		}
		default:
			return undefined;
	}
}

const FoundFrameShape = type({
	"+": "delete",
	type: '"found"',
	ownerSessionId: "string >= 1",
	agentId: "string >= 1",
	generation: "number.integer >= 1",
});
const SnapshotStartShape = type({
	"+": "delete",
	type: '"snapshot_start"',
	agentId: "string >= 1",
	ownerSessionId: "string >= 1",
	generation: "number.integer >= 1",
	displayName: "string",
	status: '"running" | "idle"',
	cwd: "string",
	model: type({ "+": "delete", provider: "string", id: "string" }).or("null"),
	isStreaming: "boolean",
	stats: "object",
});
const SnapshotMessageShape = type({
	"+": "delete",
	type: '"snapshot_message"',
	index: "number.integer >= 0",
	message: "object",
});
const SnapshotEndShape = type({
	"+": "delete",
	type: '"snapshot_end"',
	streamMessage: type("object").or("null"),
	pendingToolResults: "object[]",
	activeToolExecutionUpdates: "object[]",
	queue: type({
		"+": "delete",
		steering: "string[]",
		followUp: "string[]",
		liveSteered: "number.integer >= 0",
	}),
});
const EventFrameShape = type({ "+": "delete", type: '"event"', event: "object" });
const RunStateFrameShape = type({ "+": "delete", type: '"run_state"', state: '"running" | "idle"' });
const AckFrameShape = type({ "+": "delete", type: '"ack"', requestId: "number.integer >= 1" });
const ErrorFrameShape = type({
	"+": "delete",
	type: '"error"',
	"requestId?": "number.integer >= 1",
	code: '"not_found" | "ambiguous" | "unauthorized" | "unsupported_version" | "invalid_request" | "session_gone" | "command_failed" | "transport_limit" | "lagged"',
	message: "string",
});

function validAgentMessage(value: unknown): value is AgentMessage {
	return isRecord(value) && typeof value.role === "string";
}

function validSessionEvent(value: unknown): value is AgentSessionEvent {
	return isRecord(value) && typeof value.type === "string";
}

function validToolResult(value: unknown): value is ToolResultMessage {
	return (
		isRecord(value) &&
		value.role === "toolResult" &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string"
	);
}

function validToolUpdate(value: unknown): value is ToolExecutionUpdateEvent {
	return (
		isRecord(value) &&
		value.type === "tool_execution_update" &&
		typeof value.toolCallId === "string" &&
		isRecord(value.partialResult)
	);
}

/** Validate decoded server data before a client applies it to the transcript or UI. */
export function parseAgentAttachServerFrame(value: unknown): AgentAttachServerFrame | undefined {
	if (!isRecord(value) || typeof value.type !== "string") return undefined;
	switch (value.type) {
		case "found": {
			const frame = FoundFrameShape(value);
			return frame instanceof type.errors || !Number.isSafeInteger(frame.generation)
				? undefined
				: {
						type: "found",
						ownerSessionId: frame.ownerSessionId,
						agentId: frame.agentId,
						generation: frame.generation,
					};
		}
		case "snapshot_start": {
			const frame = SnapshotStartShape(value);
			if (frame instanceof type.errors || !Number.isSafeInteger(frame.generation)) return undefined;
			return {
				type: "snapshot_start",
				agentId: frame.agentId,
				ownerSessionId: frame.ownerSessionId,
				generation: frame.generation,
				displayName: frame.displayName,
				status: frame.status,
				cwd: frame.cwd,
				model: frame.model,
				isStreaming: frame.isStreaming,
				stats: frame.stats,
			};
		}
		case "snapshot_message": {
			const frame = SnapshotMessageShape(value);
			if (frame instanceof type.errors || !validAgentMessage(frame.message)) return undefined;
			return { type: "snapshot_message", index: frame.index, message: frame.message };
		}
		case "snapshot_end": {
			const frame = SnapshotEndShape(value);
			if (frame instanceof type.errors) return undefined;
			if (frame.streamMessage !== null && !validAgentMessage(frame.streamMessage)) return undefined;
			if (
				!frame.pendingToolResults.every(validToolResult) ||
				!frame.activeToolExecutionUpdates.every(validToolUpdate)
			)
				return undefined;
			return {
				type: "snapshot_end",
				streamMessage: frame.streamMessage,
				pendingToolResults: frame.pendingToolResults,
				activeToolExecutionUpdates: frame.activeToolExecutionUpdates,
				queue: frame.queue,
			};
		}
		case "event": {
			const frame = EventFrameShape(value);
			return frame instanceof type.errors || !validSessionEvent(frame.event)
				? undefined
				: { type: "event", event: frame.event };
		}
		case "run_state": {
			const frame = RunStateFrameShape(value);
			return frame instanceof type.errors ? undefined : { type: "run_state", state: frame.state };
		}
		case "ack": {
			const frame = AckFrameShape(value);
			return frame instanceof type.errors || !Number.isSafeInteger(frame.requestId)
				? undefined
				: { type: "ack", requestId: frame.requestId };
		}
		case "error": {
			const frame = ErrorFrameShape(value);
			return frame instanceof type.errors ||
				(frame.requestId !== undefined && !Number.isSafeInteger(frame.requestId))
				? undefined
				: { type: "error", requestId: frame.requestId, code: frame.code, message: frame.message };
		}
		default:
			return undefined;
	}
}
