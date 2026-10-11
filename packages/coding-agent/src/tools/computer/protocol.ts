import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { CaptureRegion, DesktopCapabilities, DesktopScreenState } from "@oh-my-pi/pi-natives";
import { prompt } from "@oh-my-pi/pi-utils";
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

/** Commands accepted by the persistent computer worker. */
export type ComputerWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "run"; id: string; code: string; timeoutMs: number; session: ComputerSessionSnapshot }
	| { type: "capabilities"; id: string; session: ComputerSessionSnapshot }
	| { type: "abort"; id: string }
	| { type: "revoke-control"; id: string }
	| { type: "tool-reply"; id: string; reply: ToolReply }
	| { type: "close" };

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
