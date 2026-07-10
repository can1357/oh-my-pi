import { logger } from "@pk-nerdsaver-ai/pi-utils";

import { type AgentEvent, isCaptureMode } from "./types";

/** A replaying typed channel that lets consumers independently subscribe to {@link AgentEvent}s. */
export class TaskEventChannel {
	readonly #events: AgentEvent[] = [];
	readonly #waiters = new Set<() => void>();
	#closed = false;

	push(event: AgentEvent): void {
		if (this.#closed) return;
		this.#events.push(event);
		this.#wakeWaiters();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#wakeWaiters();
	}

	subscribe(signal?: AbortSignal): AsyncIterable<AgentEvent> {
		const channel = this;
		return {
			async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
				let cursor = 0;
				while (!signal?.aborted) {
					if (cursor < channel.#events.length) {
						yield channel.#events[cursor++];
						continue;
					}
					if (channel.#closed) return;
					await channel.#waitForEvent(signal);
				}
			},
		};
	}

	#waitForEvent(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.resolve();

		const { promise, resolve } = Promise.withResolvers<void>();
		const wake = (): void => {
			this.#waiters.delete(wake);
			signal?.removeEventListener("abort", wake);
			resolve();
		};

		this.#waiters.add(wake);
		signal?.addEventListener("abort", wake, { once: true });
		if (signal?.aborted) wake();
		return promise;
	}

	#wakeWaiters(): void {
		const waiters = [...this.#waiters];
		this.#waiters.clear();
		for (const wake of waiters) wake();
	}
}

/** Backward-compatible name for the task event channel. */
export { TaskEventChannel as AgentEventChannel };

/** Serialize an event for wire transport. */
export function serializeAgentEvent(event: AgentEvent): string {
	return JSON.stringify(event);
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isActionLevel(value: unknown): value is 0 | 1 | 2 | 3 {
	return value === 0 || value === 1 || value === 2 || value === 3;
}

function isImageContent(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		value.type === "image" &&
		typeof value.data === "string" &&
		typeof value.mimeType === "string" &&
		(value.detail === undefined ||
			value.detail === "auto" ||
			value.detail === "low" ||
			value.detail === "high" ||
			value.detail === "original")
	);
}

function isCaptureRegion(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		typeof value.x === "number" &&
		typeof value.y === "number" &&
		typeof value.width === "number" &&
		typeof value.height === "number"
	);
}

function isAnnotation(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const bounds = value.bounds;
	return (
		typeof value.id === "string" &&
		(value.type === "rectangle" || value.type === "point" || value.type === "arrow" || value.type === "blur") &&
		Array.isArray(bounds) &&
		bounds.length === 4 &&
		bounds.every(coordinate => typeof coordinate === "number") &&
		isOptionalString(value.label)
	);
}

function isVisualContext(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		isOptionalString(value.screenshotPath) &&
		(value.screenshotImage === undefined || isImageContent(value.screenshotImage)) &&
		(value.selectedRegion === undefined || isCaptureRegion(value.selectedRegion)) &&
		typeof value.displayScale === "number" &&
		Array.isArray(value.annotations) &&
		value.annotations.every(isAnnotation)
	);
}

function isForegroundAppContext(value: unknown): boolean {
	return (
		isRecord(value) &&
		isOptionalString(value.processName) &&
		isOptionalString(value.windowTitle) &&
		isOptionalString(value.executablePath)
	);
}

function isBrowserContext(value: unknown): boolean {
	return (
		isRecord(value) &&
		isOptionalString(value.url) &&
		isOptionalString(value.title) &&
		isOptionalString(value.tabId) &&
		isOptionalString(value.domSnapshotRef) &&
		isOptionalString(value.accessibilityTreeRef)
	);
}

function isSelectionContext(value: unknown): boolean {
	return isRecord(value) && isOptionalString(value.text) && isOptionalString(value.clipboardText);
}

function isContextPacket(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		typeof value.captureId === "string" &&
		typeof value.timestamp === "string" &&
		typeof value.userRequest === "string" &&
		isCaptureMode(value.captureMode) &&
		isVisualContext(value.visual) &&
		isForegroundAppContext(value.foregroundApp) &&
		isBrowserContext(value.browser) &&
		isSelectionContext(value.selection) &&
		isStringArray(value.availableCapabilities)
	);
}

function isPlanStep(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.executorId === "string" &&
		typeof value.capability === "string" &&
		isRecord(value.arguments) &&
		isActionLevel(value.level) &&
		typeof value.description === "string" &&
		typeof value.requiresApproval === "boolean"
	);
}

function isApprovalRequest(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		typeof value.actionId === "string" &&
		typeof value.stepId === "string" &&
		isActionLevel(value.level) &&
		typeof value.toolName === "string" &&
		isRecord(value.arguments) &&
		typeof value.effects === "string" &&
		(value.scope === undefined ||
			value.scope === "once" ||
			value.scope === "group" ||
			value.scope === "session" ||
			value.scope === "application")
	);
}

function isAgentEvent(value: unknown): value is AgentEvent {
	if (!isRecord(value)) return false;
	switch (value.type) {
		case "task.started":
			return typeof value.taskId === "string";
		case "agent.message.delta":
			return typeof value.text === "string";
		case "plan.updated":
			return Array.isArray(value.steps) && value.steps.every(isPlanStep);
		case "tool.requested":
			return typeof value.callId === "string" && typeof value.toolName === "string" && isRecord(value.arguments);
		case "approval.requested":
			return isApprovalRequest(value.request);
		case "tool.started":
			return typeof value.callId === "string" && typeof value.toolName === "string";
		case "tool.completed":
			return (
				typeof value.callId === "string" && Object.hasOwn(value, "result") && typeof value.isError === "boolean"
			);
		case "observation.updated":
			return (
				isOptionalString(value.screenshotRef) &&
				(value.contextPacket === undefined || isContextPacket(value.contextPacket))
			);
		case "task.blocked":
			return typeof value.taskId === "string" && typeof value.reason === "string";
		case "task.completed":
			return typeof value.taskId === "string" && typeof value.summary === "string";
		case "task.failed":
			return typeof value.taskId === "string" && typeof value.error === "string";
		default:
			return false;
	}
}

/** Parse and validate an event received over the wire. */
export function parseAgentEvent(text: string): AgentEvent | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		return isAgentEvent(parsed) ? parsed : undefined;
	} catch (error) {
		logger.debug("Failed to parse agent event", {
			error: error instanceof Error ? error.message : String(error),
			text,
		});
		return undefined;
	}
}
