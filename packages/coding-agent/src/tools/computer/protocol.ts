import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { CaptureRegion, DesktopCapabilities, DesktopScreenState } from "@oh-my-pi/pi-natives";
import * as prompt from "@oh-my-pi/pi-utils/prompt";
import screenLockedCaptureNote from "../../prompts/tools/computer-screen-locked-capture.md" with { type: "text" };
import screenStateTemplate from "../../prompts/tools/computer-screen-state.md" with { type: "text" };

export { COMPUTER_WORKER_ARG } from "../../cli/worker-selectors";

/** Frozen run settings transferred from the host session to the worker. */
export interface ComputerSessionSnapshot {
	cwd: string;
	sessionId: string;
	captureMaxWidth: number;
	captureMaxHeight: number;
	display: string;
	readOnly: boolean;
}

/** Reply envelope for a session tool invoked by desktop JavaScript. */
export type ToolReply = { ok: true; value: unknown } | { ok: false; error: RunErrorPayload };

/**
 * Commands accepted by the persistent computer worker. `cell` names the Eval
 * cell a run belongs to: what its input left to report is kept per cell, and
 * a settle reports only its own cell's.
 */
export type ComputerWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "run"; id: string; code: string; timeoutMs: number; session: ComputerSessionSnapshot; cell?: string }
	| { type: "capabilities"; id: string; session: ComputerSessionSnapshot }
	/**
	 * Report what the cell that just ended changed; the result's `returnValue` is a `SettleReport` or undefined.
	 * `output` is what the cell printed: an `ax()` tree it carries counts as seen by the model. `forget`: the
	 * model's context was rewritten since the last settle, so trees it saw before may be gone from it. The
	 * report's reads stop short of `timeoutMs`, so it returns what it has before the request times out.
	 */
	| {
			type: "settle";
			id: string;
			timeoutMs: number;
			session: ComputerSessionSnapshot;
			output: string;
			forget?: boolean;
			cell?: string;
	  }
	/** The cell was cancelled: drop what its input left to report. */
	| { type: "discard"; cell: string }
	| { type: "abort"; id: string }
	| { type: "revoke-control"; id: string }
	| { type: "tool-reply"; id: string; reply: ToolReply }
	| { type: "close" };

/**
 * What a cell's input changed. `text` diffs each window against the model's last tree of it; `whole`, present
 * when it differs, prints every window whole, for a conversation rewritten while the report was made.
 */
export interface SettleReport {
	text: string;
	whole?: string;
}

/** Successful computer run output returned to the host supervisor. */
export interface ComputerRunOk {
	displays: Array<TextContent | ImageContent>;
	returnValue: unknown;
	screenshots: ComputerScreenshot[];
	capabilities?: DesktopCapabilities;
}

/** Appended to a screenshot taken while the macOS lock screen is up. */
export const SCREEN_LOCKED_CAPTURE_NOTE = prompt.render(screenLockedCaptureNote);

/**
 * Tells the model a run ended with the macOS screen locked or the session's
 * display asleep, so lock-screen pixels and failed captures are not taken
 * for the app's state. Input is never refused because of it.
 */
export function screenStateNotice(state: DesktopScreenState | undefined): string | undefined {
	if (!state?.screenLocked && !state?.displayAsleep) return undefined;
	return prompt.render(screenStateTemplate, {
		screenLocked: state.screenLocked,
		displayAsleep: state.displayAsleep,
	});
}

/** Screenshot or zoom emitted during one computer run, with its full input coordinate frame. */
export interface ComputerScreenshot {
	path: string;
	width: number;
	height: number;
	coordinateWidth: number;
	coordinateHeight: number;
	region?: CaptureRegion;
	sourceWidth?: number;
	sourceHeight?: number;
	target: string;
	/** The macOS lock screen was up: a display capture shows it, a window capture shows the window's last frame. */
	screenLocked?: true;
}

/** Clone-safe error metadata returned across the worker boundary. */
export interface RunErrorPayload {
	name: string;
	message: string;
	stack?: string;
	isToolError: boolean;
	isAbort: boolean;
}

/** Events emitted by the persistent computer worker. */
export type ComputerWorkerOutbound =
	| { type: "ready" }
	| { type: "control-revoked"; id: string }
	| { type: "pong"; id: string }
	| { type: "result"; id: string; ok: true; payload: ComputerRunOk }
	| { type: "result"; id: string; ok: false; error: RunErrorPayload }
	| { type: "capabilities"; id: string; ok: true; capabilities: DesktopCapabilities }
	| { type: "capabilities"; id: string; ok: false; error: RunErrorPayload }
	| { type: "tool-call"; id: string; runId: string; name: string; args: unknown }
	| { type: "control-request"; id: string; runId: string; reason: string }
	| { type: "closed" };

/** Transport used by the worker core in Bun workers and tests. */
export interface ComputerWorkerTransport {
	send(message: ComputerWorkerOutbound, transfer?: Bun.Transferable[]): void;
	onMessage(handler: (message: ComputerWorkerInbound) => void): () => void;
	close(): void;
}
