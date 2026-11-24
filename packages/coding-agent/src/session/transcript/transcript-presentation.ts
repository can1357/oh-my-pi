import type { TspText } from "@oh-my-pi/pi-wire";
import type { TranscriptBlock, TranscriptPresentation } from "../../extensibility/extensions/render-types";
import {
	type BashExecutionMessage,
	type CustomMessage,
	type HookMessage,
	type PythonExecutionMessage,
} from "./messages";

type WrappedTranscriptBlock = Exclude<TranscriptBlock, { type: "toolCall" }>;

/** The `message` block of a session message: its id is the decimal `timestamp`. */
export function messageBlock(
	message: CustomMessage | HookMessage | BashExecutionMessage | PythonExecutionMessage,
): WrappedTranscriptBlock {
	// A legacy `hookMessage` is a custom message under its old role name.
	const shown = message.role === "hookMessage" ? { ...message, role: "custom" as const } : message;
	return { type: "message", id: String(message.timestamp), message: shown };
}

const presenterListeners = new Set<() => void>();

/** An extension registered or disposed a presenter; the host installs the set again and refreshes. */
export function notifyTranscriptPresentersChanged(): void {
	for (const listener of presenterListeners) listener();
}

/** Call `listener` on {@link notifyTranscriptPresentersChanged}; returns the unsubscribe. */
export function onTranscriptPresentersChanged(listener: () => void): () => void {
	presenterListeners.add(listener);
	return () => presenterListeners.delete(listener);
}

function isTspText(value: unknown): value is TspText {
	return (
		typeof value === "string" ||
		(Array.isArray(value) &&
			value.every(part => typeof part === "object" && part !== null && typeof part.t === "string"))
	);
}

/** `value` copied to plain data when it is {@link TspText}, else `undefined`. */
function copyTspText(value: unknown): TspText | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	const parts: unknown[] = value.map(part => (typeof part === "object" && part !== null ? { ...part } : part));
	return isTspText(parts) ? parts : undefined;
}

/**
 * A presenter's answer as plain data when it is a {@link TranscriptPresentation}; `null` for
 * anything else (a misspelt mode, the Promise of an async presenter, a `compact` that is not a
 * plain object), which draws the block in full. It reads every field the transcript uses once,
 * so a throwing getter or Proxy in the answer throws here, inside the caller's guard, and never
 * while drawing. Labels and rows that are not `TspText` are dropped.
 */
export function readTranscriptPresentation(answer: unknown): TranscriptPresentation | null {
	if (answer === undefined || answer === "full" || answer === "hidden" || answer === "compact") return answer;
	if (typeof answer !== "object" || answer === null || !("compact" in answer)) return null;
	const { compact } = answer;
	if (typeof compact !== "object" || compact === null) return null;
	const prototype = Object.getPrototypeOf(compact);
	if (prototype !== Object.prototype && prototype !== null) return null;
	const label = "label" in compact ? compact.label : undefined;
	const rows = "rows" in compact ? compact.rows : undefined;
	return {
		compact: {
			label: copyTspText(label),
			rows: Array.isArray(rows) ? rows.map(copyTspText).filter(row => row !== undefined) : undefined,
		},
	};
}
