import * as fs from "node:fs/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { FileEntry, SessionMessageEntry } from "../../session/session-entries";
import { parseSessionEntries } from "../../session/session-loader";
import {
	type AgentProgress,
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "../../task";
import type { EventBus } from "../../utils/event-bus";
import type {
	RpcSubagentEventFrame,
	RpcSubagentFrame,
	RpcSubagentMessagesResult,
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

export interface RpcSubagentTranscriptSelector {
	subagentId?: string;
	sessionFile?: string;
	fromByte?: number;
}

type RpcSubagentOutput = (frame: RpcSubagentFrame) => void;

const MAX_RETAINED_TRANSCRIPT_REFERENCES = 256;

function isSessionMessageEntry(entry: FileEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function statusFromLifecycle(status: SubagentLifecyclePayload["status"]): AgentProgress["status"] {
	return status === "started" ? "running" : status;
}

function isTerminalLifecycleStatus(status: SubagentLifecyclePayload["status"]): boolean {
	return status !== "started";
}

function hasSameOwner(
	payload: Pick<SubagentLifecyclePayload | SubagentProgressPayload, "parentToolCallId" | "sessionFile">,
	snapshot: RpcSubagentSnapshot,
): boolean {
	if (payload.parentToolCallId !== undefined && snapshot.parentToolCallId !== undefined) {
		return payload.parentToolCallId === snapshot.parentToolCallId;
	}
	if (payload.sessionFile !== undefined && snapshot.sessionFile !== undefined) {
		return payload.sessionFile === snapshot.sessionFile;
	}
	return true;
}

function addPruned(set: Set<string>, value: string, maxSize: number): void {
	set.delete(value);
	set.add(value);
	while (set.size > maxSize) {
		const oldest = set.keys().next();
		if (oldest.done) break;
		set.delete(oldest.value);
	}
}

export async function readRpcSubagentTranscript(sessionFile: string, fromByte = 0): Promise<RpcSubagentMessagesResult> {
	let startByte = Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0;
	const file = Bun.file(sessionFile);
	let size: number;
	try {
		({ size } = await fs.stat(sessionFile));
	} catch (err) {
		if (!isEnoent(err)) throw err;
		return {
			sessionFile,
			fromByte: startByte,
			nextByte: startByte,
			reset: false,
			entries: [],
			messages: [],
		};
	}
	let reset = false;
	if (startByte > size) {
		startByte = 0;
		reset = true;
	}

	const text = startByte >= size ? "" : await file.slice(startByte).text();
	const lastNewline = text.lastIndexOf("\n");
	const completeText = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
	const entries = completeText.length > 0 ? parseSessionEntries(completeText) : [];
	const nextByte = startByte + Buffer.byteLength(completeText, "utf8");

	return {
		sessionFile,
		fromByte: startByte,
		nextByte,
		reset,
		entries,
		messages: entries.filter(isSessionMessageEntry).map(entry => entry.message),
	};
}

export class RpcSubagentRegistry {
	#subagents = new Map<string, RpcSubagentSnapshot>();
	#transcriptSessionFilesBySubagentId = new Map<string, string>();
	#staleSubagentIds = new Set<string>();
	#unsubscribers: Array<() => void> = [];
	#output: RpcSubagentOutput;
	#subscriptionLevel: RpcSubagentSubscriptionLevel = "off";

	constructor(observabilityBus: EventBus, output: RpcSubagentOutput) {
		this.#output = output;
		this.#unsubscribers.push(
			observabilityBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
				this.handleLifecycle(data as SubagentLifecyclePayload);
			}),
			observabilityBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
				this.handleProgress(data as SubagentProgressPayload);
			}),
			observabilityBus.on(TASK_SUBAGENT_EVENT_CHANNEL, data => {
				this.handleEvent(data as SubagentEventPayload);
			}),
		);
	}

	dispose(): void {
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		this.#unsubscribers = [];
		this.#subagents.clear();
		this.#transcriptSessionFilesBySubagentId.clear();
		this.#staleSubagentIds.clear();
	}

	clear(): void {
		for (const subagentId of this.#subagents.keys()) {
			addPruned(this.#staleSubagentIds, subagentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
		}
		for (const subagentId of this.#transcriptSessionFilesBySubagentId.keys()) {
			addPruned(this.#staleSubagentIds, subagentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
		}
		this.#subagents.clear();
		this.#transcriptSessionFilesBySubagentId.clear();
	}

	setSubscriptionLevel(level: RpcSubagentSubscriptionLevel): void {
		this.#subscriptionLevel = level;
	}

	getSubscriptionLevel(): RpcSubagentSubscriptionLevel {
		return this.#subscriptionLevel;
	}

	getSubagents(): RpcSubagentSnapshot[] {
		return [...this.#subagents.values()].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
	}

	#rememberTranscriptSession(subagentId: string, sessionFile: string | undefined): void {
		if (!sessionFile) return;
		this.#transcriptSessionFilesBySubagentId.delete(subagentId);
		this.#transcriptSessionFilesBySubagentId.set(subagentId, sessionFile);
		while (this.#transcriptSessionFilesBySubagentId.size > MAX_RETAINED_TRANSCRIPT_REFERENCES) {
			const oldest = this.#transcriptSessionFilesBySubagentId.keys().next();
			if (oldest.done) break;
			this.#transcriptSessionFilesBySubagentId.delete(oldest.value);
		}
	}

	#hasTranscriptSessionFile(sessionFile: string): boolean {
		for (const snapshot of this.#subagents.values()) {
			if (snapshot.sessionFile === sessionFile) return true;
		}
		for (const transcriptSessionFile of this.#transcriptSessionFilesBySubagentId.values()) {
			if (transcriptSessionFile === sessionFile) return true;
		}
		return false;
	}

	handleLifecycle(payload: SubagentLifecyclePayload): void {
		const existing = this.#subagents.get(payload.id);
		if (existing && !hasSameOwner(payload, existing)) return;
		if (!existing && payload.status !== "started") return;
		if (payload.status === "started") {
			this.#staleSubagentIds.delete(payload.id);
		}
		const sessionFile = payload.sessionFile ?? existing?.sessionFile;
		const snapshot: RpcSubagentSnapshot = {
			id: payload.id,
			index: payload.index,
			agent: payload.agent,
			agentSource: payload.agentSource,
			description: payload.description ?? existing?.description,
			status: statusFromLifecycle(payload.status),
			task: existing?.task,
			assignment: existing?.assignment,
			sessionFile,
			parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
			lastUpdate: Date.now(),
			progress: existing?.progress,
		};
		this.#rememberTranscriptSession(payload.id, sessionFile);
		if (isTerminalLifecycleStatus(payload.status)) {
			this.#subagents.delete(payload.id);
		} else {
			this.#subagents.set(payload.id, snapshot);
		}
		if (this.#subscriptionLevel !== "off") {
			this.#output({ type: "subagent_lifecycle", payload });
		}
	}

	handleProgress(payload: SubagentProgressPayload): void {
		const progress = payload.progress;
		if (this.#staleSubagentIds.has(progress.id)) return;
		const existing = this.#subagents.get(progress.id);
		if (!existing) return;
		if (!hasSameOwner(payload, existing)) return;
		const sessionFile = payload.sessionFile ?? existing?.sessionFile;
		this.#rememberTranscriptSession(progress.id, sessionFile);
		this.#subagents.set(progress.id, {
			id: progress.id,
			index: payload.index,
			agent: payload.agent,
			agentSource: payload.agentSource,
			description: progress.description ?? existing?.description,
			status: progress.status,
			task: payload.task,
			assignment: payload.assignment,
			sessionFile,
			lastUpdate: Date.now(),
			parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
			progress,
		});
		if (this.#subscriptionLevel !== "off") {
			this.#output({ type: "subagent_progress", payload });
		}
	}

	handleEvent(payload: SubagentEventPayload): void {
		if (this.#staleSubagentIds.has(payload.id)) return;
		if (this.#subscriptionLevel !== "events") return;
		this.#output({ type: "subagent_event", payload } satisfies RpcSubagentEventFrame);
	}

	resolveSessionFile(selector: RpcSubagentTranscriptSelector): string {
		if (selector.subagentId) {
			const snapshot = this.#subagents.get(selector.subagentId);
			const sessionFile = snapshot?.sessionFile ?? this.#transcriptSessionFilesBySubagentId.get(selector.subagentId);
			if (!sessionFile) {
				throw new Error(`Unknown subagent or session file unavailable: ${selector.subagentId}`);
			}
			return sessionFile;
		}

		if (selector.sessionFile) {
			if (this.#hasTranscriptSessionFile(selector.sessionFile)) return selector.sessionFile;
			throw new Error("Unknown subagent session file");
		}

		throw new Error("get_subagent_messages requires subagentId or sessionFile");
	}
}
