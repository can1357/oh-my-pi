import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
// The subpath, not the pi-utils barrel: the barrel loads pi_natives, which the worker must not.
import { type DescribedError, describeError, inheritsFrom } from "@oh-my-pi/pi-utils/thrown";
import type { EvalDisplayOutput } from "../types";
import type { RuntimeCallIdentity, ShadowSnapshot } from "./shared/runtime";

export interface EvalPreludeSource {
	name: string;
	exports: string[];
	source: string;
}

export interface SessionSnapshot {
	cwd: string;
	sessionId: string;
	/**
	 * On-disk roots the helpers substitute for internal-URL schemes
	 * (e.g. `{ local: "/…/artifacts/local" }`). Lets `read`/`write`
	 * accept `local://…` paths instead of writing a literal `local:/` directory.
	 */
	localRoots?: Record<string, string>;
	/** Enabled host-capability snippets projected for this JavaScript cell. */
	preludes?: EvalPreludeSource[];
	/** Selected package directory consulted only after the importing file's project. */
	packageRoot?: string;
	/** Model-visible description of the selected package environment. */
	packageEnvironment?: string;
}

/**
 * The wire form of what a run, a tool call or a cell's floating promise failed
 * with. It extends {@link DescribedError}, which only `describeError` makes, so a
 * payload cannot be built from a value read any other way.
 */
export interface RunErrorPayload extends DescribedError {
	readonly isAbort: boolean;
	readonly isToolError: boolean;
}

/**
 * The payload for anything a run, a tool call or a cell's floating promise
 * threw, and never throws: the value is described once ({@link describeError}),
 * and a payload that could not be built would send no result at all, leaving
 * the cell to wait for its timeout.
 */
export function runErrorPayload(error: unknown): RunErrorPayload {
	return describedRunError(describeError(error), inheritsFrom(error, ToolError.prototype));
}

/**
 * The payload for a value already described. `toolError` says the value
 * inherits from `ToolError`; without the value, only the name `ToolError` marks one.
 */
export function describedRunError(described: DescribedError, toolError = false): RunErrorPayload {
	const { name } = described;
	return {
		...described,
		isAbort: name === "AbortError" || name === "ToolAbortError",
		isToolError: toolError || name === "ToolError",
	};
}

export type ToolReply = { ok: true; value: unknown } | { ok: false; error: RunErrorPayload };

/** Request to inspect or invoke the retained JavaScript tool registry. */
export type JsToolRequest =
	| { op: "describe"; names: string[] }
	| { op: "call"; name: string; args: Record<string, unknown> };

export type WorkerInbound =
	| { type: "init"; snapshot: SessionSnapshot }
	| { type: "run"; runId: string; code: string; filename: string; snapshot: SessionSnapshot }
	| ({ type: "tool"; runId: string } & JsToolRequest)
	| { type: "shadow-snapshot"; id: string; snapshot: SessionSnapshot }
	| {
			type: "run-if-snapshot-matches";
			id: string;
			runId: string;
			code: string;
			filename: string;
			snapshot: SessionSnapshot;
			expectedRevision: number;
			expectedDigest: string;
	  }
	| { type: "tool-reply"; id: string; reply: ToolReply }
	| { type: "close" };

export type WorkerOutbound =
	| { type: "ready" }
	| { type: "init-failed"; error: RunErrorPayload }
	| { type: "text"; runId: string; chunk: string }
	| { type: "display"; runId: string; output: EvalDisplayOutput }
	| { type: "tool-call"; id: string; runId: string; name: string; args: unknown; identity?: RuntimeCallIdentity }
	/** `value` carries a tool-bridge envelope (`describe`/`call`); cell runs omit it. */
	| { type: "result"; runId: string; ok: true; value?: unknown }
	| { type: "result"; runId: string; ok: false; error: RunErrorPayload }
	| { type: "log"; level: "debug" | "warn" | "error"; msg: string; meta?: Record<string, unknown> }
	| { type: "shadow-snapshot"; id: string; eligible: boolean; reason?: string; snapshot?: ShadowSnapshot }
	| { type: "shadow-run"; id: string; eligible: boolean; reason?: string }
	| { type: "closed" };

export interface Transport {
	send(msg: WorkerOutbound): void;
	onMessage(handler: (msg: WorkerInbound) => void): () => void;
	close(): void;
}
