import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";

/** Resolves the canonical renderer key while retaining the provider's wire name in message history. */
export function toolRenderName(wireName: string, tool: AgentTool | undefined): string {
	return tool?.name ?? wireName;
}

/** The background job state a tool result reports (`details.async.state`: running, completed, failed, cancelled). */
export function asyncJobState(details: unknown): string | undefined {
	if (!isRecord(details) || !isRecord(details.async)) return undefined;
	return typeof details.async.state === "string" ? details.async.state : undefined;
}

/** Whether a frame is a background job's last one: it completed, failed or was cancelled. */
export function isSettledJobFrame(details: unknown): boolean {
	const state = asyncJobState(details);
	return state === "completed" || state === "failed" || state === "cancelled";
}

/**
 * How a returned call's card follows the background job it started: `always` on every surface,
 * `native` only on Tern, `viewport` on Tern and, on a plain terminal, until the card's first content
 * row enters scrollback (see {@link followsViewportOnly}).
 */
const JOB_CARD_TOOLS: Record<string, "always" | "native" | "viewport"> = {
	task: "always",
	bash: "viewport",
	eval: "native",
};

/**
 * Whether a call that returned with `details.async.state === "running"` keeps its card subscribed
 * to job frames. Shared by the live event path and the rebuild.
 */
export function parksAsBackground(toolName: string, details: unknown, native: boolean): boolean {
	const mode = JOB_CARD_TOOLS[toolName];
	if (mode === undefined || (mode === "native" && !native)) return false;
	return asyncJobState(details) === "running";
}

/**
 * Whether a parked card of `toolName` takes job frames only while none of its content is in plain
 * terminal scrollback. Such a card stays settled (its rows may retire) and draws each frame as a
 * static result, so the rows it leaves in history match what it showed.
 */
export function followsViewportOnly(toolName: string, native: boolean): boolean {
	return !native && JOB_CARD_TOOLS[toolName] === "viewport";
}

/** A tool result frame as the session reports it. */
export interface ToolResultFrame {
	readonly content: readonly {
		readonly type: string;
		readonly text?: string;
		readonly data?: string;
		readonly mimeType?: string;
	}[];
	readonly details?: unknown;
	readonly isError?: boolean;
}

/**
 * Settle a parked card ({@link parksAsBackground}) with its job's last frame
 * ({@link isSettledJobFrame}): a completed or failed job is the call's result; a cancelled one
 * keeps the output it got to and seals the card as cancelled.
 */
export function settleWithJobFrame(
	tool: {
		updateResult(result: ToolResultFrame & { isError: boolean }, partial: boolean, toolCallId: string): void;
		seal(): void;
	},
	frame: ToolResultFrame,
	toolCallId: string,
): void {
	const state = asyncJobState(frame.details);
	if (state === "cancelled") {
		tool.updateResult({ ...frame, isError: frame.isError ?? false }, true, toolCallId);
		tool.seal();
		return;
	}
	tool.updateResult({ ...frame, isError: state === "failed" }, false, toolCallId);
}

/** The disk file a tool result's image was read from (`read` details `mediaPath`), when it has one. */
export function readMediaPath(details: unknown): string | undefined {
	if (!isRecord(details)) return undefined;
	const mediaPath = details.mediaPath;
	return typeof mediaPath === "string" && mediaPath.length > 0 ? mediaPath : undefined;
}
