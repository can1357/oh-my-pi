import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { DesktopCapabilities } from "@oh-my-pi/pi-natives";

/** Hidden CLI selector that re-enters the computer worker host. */
export const COMPUTER_WORKER_ARG = "__omp_worker_computer";

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
	| { type: "abort"; id: string }
	| { type: "tool-reply"; id: string; reply: ToolReply }
	| { type: "close" };

/** Successful computer run output returned to the host supervisor. */
export interface ComputerRunOk {
	displays: Array<TextContent | ImageContent>;
	returnValue: unknown;
	screenshots: ComputerScreenshot[];
	capabilities?: DesktopCapabilities;
}

/** Full-resolution screenshot emitted during one computer run. */
export interface ComputerScreenshot {
	path: string;
	width: number;
	height: number;
	sourceWidth?: number;
	sourceHeight?: number;
	target: string;
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
	| { type: "pong"; id: string }
	| { type: "result"; id: string; ok: true; payload: ComputerRunOk }
	| { type: "result"; id: string; ok: false; error: RunErrorPayload }
	| { type: "tool-call"; id: string; runId: string; name: string; args: unknown }
	| { type: "closed" };

/** Transport used by the worker core in Bun workers and tests. */
export interface ComputerWorkerTransport {
	send(message: ComputerWorkerOutbound, transfer?: Bun.Transferable[]): void;
	onMessage(handler: (message: ComputerWorkerInbound) => void): () => void;
	close(): void;
}
