import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { CaptureRegion, DesktopCapabilities, DesktopScreenState } from "@oh-my-pi/pi-natives";
import * as prompt from "@oh-my-pi/pi-utils/prompt";
import escapeAfterCallMessage from "../../prompts/tools/computer-escape-after-call.md" with { type: "text" };
import escapeRefusedMessage from "../../prompts/tools/computer-escape-refused.md" with { type: "text" };
import escapeStoppedMessage from "../../prompts/tools/computer-escape-stopped.md" with { type: "text" };
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
	/** `computer.backgroundFallback`: what a refused background input call does. */
	backgroundFallback: "takeover" | "refuse";
	/**
	 * The agent turn the run belongs to, if any: once it acts, the display stays awake until that turn's
	 * `release-display` rather than for the native grace period after its last request.
	 */
	displayTurn?: number;
}

/** Reply envelope for a session tool invoked by desktop JavaScript. */
export type ToolReply = { ok: true; value: unknown } | { ok: false; error: RunErrorPayload };

/**
 * The host's answer to a `control.acquire` confirmation: the user, or their `tools.approval["computer.control"]`
 * policy, approved or declined, nobody could be asked because the session has no interactive UI (a subagent,
 * print mode or another headless run), or nobody answered before the confirmation's `timeoutMs` closed it.
 */
export type ControlVerdict = "approved" | "denied" | "no-ui" | "unanswered";

/** Where the native session counts the user's Escape stops, and how many the user's latest message acknowledged. */
export interface ComputerEscapeScope {
	key: string;
	acknowledged: number;
}

/** Commands accepted by the persistent computer worker. */
export type ComputerWorkerInbound =
	| { type: "ping"; id: string }
	| {
			type: "run";
			id: string;
			code: string;
			timeoutMs: number;
			session: ComputerSessionSnapshot;
			escape: ComputerEscapeScope;
	  }
	| { type: "capabilities"; id: string; session: ComputerSessionSnapshot; escape: ComputerEscapeScope }
	| { type: "abort"; id: string }
	| { type: "revoke-control"; id: string }
	/** Agent turn `turn` ended: let the display sleep now, keeping every other piece of session state. */
	| { type: "release-display"; turn: number }
	/**
	 * Turn `from` stopped for a dialog and went on as turn `turn`: the run of turn `from` still active holds the display
	 * again, until turn `turn` ends.
	 */
	| { type: "resume-display"; from: number; turn: number }
	| { type: "tool-reply"; id: string; reply: ToolReply }
	| { type: "close" };

/** Successful computer run output returned to the host supervisor. */
export interface ComputerRunOk {
	displays: Array<TextContent | ImageContent>;
	returnValue: unknown;
	screenshots: ComputerScreenshot[];
	capabilities?: DesktopCapabilities;
}

/** Result of a computer call the user stopped with physical Escape during takeover input. */
export const ESCAPE_STOPPED_MESSAGE = prompt.render(escapeStoppedMessage);

/** Result of a computer call that finished, its input out, before the user's Escape stopped computer use. */
export const ESCAPE_AFTER_CALL_MESSAGE = prompt.render(escapeAfterCallMessage);

/** Refusal of every later computer call until the user's next message acknowledges their Escape stop. */
export const ESCAPE_REFUSED_MESSAGE = prompt.render(escapeRefusedMessage);

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
	| { type: "control-request"; id: string; runId: string; reason: string; timeoutMs: number }
	| { type: "closed" };

/** Transport used by the worker core in Bun workers and tests. */
export interface ComputerWorkerTransport {
	send(message: ComputerWorkerOutbound, transfer?: Bun.Transferable[]): void;
	onMessage(handler: (message: ComputerWorkerInbound) => void): () => void;
	close(): void;
}
