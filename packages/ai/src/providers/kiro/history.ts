import type {
	AssistantMessage,
	DeveloperMessage,
	Message,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "../../types";

export type KiroOrdinaryMessage = UserMessage | DeveloperMessage;

export interface KiroAssistantGroup {
	messages: AssistantMessage[];
	calls: ToolCall[];
	results: ToolResultMessage[];
}

export interface KiroUserGroup {
	messages: KiroOrdinaryMessage[];
	resultGroup?: KiroAssistantGroup;
}

export type KiroHistorySegment =
	| { kind: "user"; group: KiroUserGroup }
	| { kind: "assistant"; group: KiroAssistantGroup };

export type KiroCurrentSegment = { kind: "user"; group: KiroUserGroup } | { kind: "continuation" };

export interface KiroHistoryPlan {
	history: KiroHistorySegment[];
	current: KiroCurrentSegment;
}

function isAbortedAssistant(message: AssistantMessage): boolean {
	return message.stopReason === "error" || message.stopReason === "aborted";
}

function hasVisibleText(message: AssistantMessage): boolean {
	return message.content.some(part => part.type === "text" && part.text.length > 0);
}

function duplicateIdError(kind: "tool call" | "tool result", id: string): Error {
	return new Error(`Kiro history contains duplicate ${kind} id: ${id}`);
}

function mergeAssistantGroups(previous: KiroAssistantGroup, message: AssistantMessage, calls: ToolCall[]): void {
	previous.messages.push(message);
	previous.calls.push(...calls);
}

function appendOrdinary(group: KiroUserGroup | undefined, message: KiroOrdinaryMessage): KiroUserGroup {
	if (group) {
		group.messages.push(message);
		return group;
	}
	return { messages: [message] };
}

/**
 * Repair local transcript state into truthful Kiro exchanges. Matching is by
 * original local tool-call id; wire-id normalization happens only at encoding.
 * Unmatched calls/results and aborted assistant turns are discarded.
 */
export function prepareKiroHistory(messages: readonly Message[]): KiroHistoryPlan {
	const callsById = new Map<string, ToolCall>();
	const resultsById = new Map<string, ToolResultMessage>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type !== "toolCall") continue;
				if (callsById.has(part.id)) throw duplicateIdError("tool call", part.id);
				callsById.set(part.id, part);
			}
		} else if (message.role === "toolResult") {
			if (resultsById.has(message.toolCallId)) throw duplicateIdError("tool result", message.toolCallId);
			resultsById.set(message.toolCallId, message);
		}
	}

	const assistantGroups = new Map<AssistantMessage, KiroAssistantGroup>();
	const callGroups = new Map<string, KiroAssistantGroup>();
	let activeGroup: KiroAssistantGroup | undefined;
	let activeAssistantIndex = -2;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "assistant") {
			activeGroup = undefined;
			activeAssistantIndex = -2;
			continue;
		}
		if (isAbortedAssistant(message)) {
			activeGroup = undefined;
			activeAssistantIndex = index;
			continue;
		}
		const calls = message.content.filter(
			(part): part is ToolCall => part.type === "toolCall" && callsById.has(part.id) && resultsById.has(part.id),
		);
		if (!hasVisibleText(message) && calls.length === 0) {
			activeAssistantIndex = index;
			continue;
		}
		if (!activeGroup || index - activeAssistantIndex !== 1) {
			activeGroup = { messages: [message], calls: [...calls], results: [] };
		} else {
			mergeAssistantGroups(activeGroup, message, calls);
		}
		assistantGroups.set(message, activeGroup);
		for (const call of calls) callGroups.set(call.id, activeGroup);
		activeAssistantIndex = index;
	}

	const groups = new Set<KiroAssistantGroup>();
	for (const group of assistantGroups.values()) groups.add(group);
	for (const group of groups) {
		const byId = new Map<string, ToolResultMessage>();
		for (const result of resultsById.values()) {
			if (callGroups.get(result.toolCallId) === group) byId.set(result.toolCallId, result);
		}
		group.results = group.calls.flatMap(call => {
			const result = byId.get(call.id);
			return result ? [result] : [];
		});
	}

	const segments: Array<KiroHistorySegment> = [];
	let lastUser: KiroUserGroup | undefined;
	const emittedGroups = new Set<KiroAssistantGroup>();
	for (const message of messages) {
		if (message.role === "user" || message.role === "developer") {
			if (lastUser) appendOrdinary(lastUser, message);
			else {
				lastUser = { messages: [message] };
				segments.push({ kind: "user", group: lastUser });
			}
			continue;
		}
		if (message.role !== "assistant") continue;
		const group = assistantGroups.get(message);
		if (!group || emittedGroups.has(group)) continue;
		const previous = segments.at(-1);
		if (previous?.kind !== "user") continue;
		lastUser = undefined;
		emittedGroups.add(group);
		segments.push({ kind: "assistant", group });
		if (group.results.length > 0) {
			lastUser = { messages: [], resultGroup: group };
			segments.push({ kind: "user", group: lastUser });
		}
	}

	const final = segments.at(-1);
	if (final?.kind === "user") {
		return { history: segments.slice(0, -1), current: { kind: "user", group: final.group } };
	}
	return { history: segments, current: { kind: "continuation" } };
}
