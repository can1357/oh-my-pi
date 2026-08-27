import { buildEvalUrlRoots, type LocalProtocolOptions } from "../internal-urls/local-protocol";
import type { ToolSession } from "../tools";
import type { BackendProbeOptions } from "./probe";
import type { EvalDisplayOutput, EvalLanguage, EvalStatusEvent, EvalTermination } from "./types";

/** Per-cell execute() options. */
export interface ExecutorBackendExecOptions {
	cwd: string;
	sessionId: string;
	sessionFile: string | undefined;
	kernelOwnerId: string | undefined;
	signal?: AbortSignal;
	session: ToolSession;
	/**
	 * Runtime-work budget in milliseconds (the cell's `timeout`). Cancellation is
	 * driven entirely by `signal`, which the eval tool arms as a watchdog that
	 * pauses on bridge timeout-control status events and fires a `TimeoutError`
	 * reason only while the Python/JS runtime owns control. Backends use this
	 * value only for timeout-annotation text and as cold-start headroom; undefined
	 * disables the cell timeout. Backends MUST NOT derive a competing wall-clock timer from it.
	 */
	idleTimeoutMs?: number;
	reset: boolean;
	onChunk: (chunk: string) => void;
	/**
	 * Live status events (read/write/agent/…) delivered as they are emitted,
	 * before the cell finishes. The same events are also returned in
	 * `displayOutputs`; this channel exists so callers can stream long-running
	 * progress (e.g. `agent()` subagents) into the UI mid-execution.
	 */
	onStatus?: (event: EvalStatusEvent) => void;
}

/** How a backend cell terminated, if not by ordinary completion. */
export type ExecutorTermination = EvalTermination;

/** Result returned by a backend's execute(). */
export interface ExecutorBackendResult {
	output: string;
	exitCode: number | undefined;
	/**
	 * How the cell terminated abnormally, if not by ordinary completion.
	 * `undefined` means the cell completed normally (exit code 0 or nonzero).
	 * A discriminated union so `{cancelled:false, timedOut:true}` is
	 * unrepresentable — the old optional-booleans bag silently treated it
	 * as ordinary completion.
	 */
	termination: ExecutorTermination | undefined;
	truncated: boolean;
	artifactId: string | undefined;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: EvalDisplayOutput[];
	/**
	 * `OutputSummary.annotation` verbatim: the bracketed synthesized note
	 * (kernel timeout/kill, stdin request) `OutputSink.dump(notice)` baked into
	 * `output` without ever streaming it through `onChunk`, unlike `push()`,
	 * which every other chunk goes through. `eval.ts` declares it on the call's
	 * presentation protocol as its own fact —
	 * `presentation?.fact({ kind: "stop_annotation", text: result.annotation })`
	 * — so the ACP terminal path, which reads only structured facts and never
	 * the model-facing text, doesn't silently drop the reason a cell stopped.
	 * This path no longer mirrors
	 * the note into the legacy `EvalToolDetails.notices` field; that field's
	 * sole remaining writer is an injected `EvalProxyExecutor`, which returns a
	 * whole `EvalToolResult` of its own and never produces an
	 * `ExecutorBackendResult` to read this from.
	 */
	annotation?: string;
}

/** Pluggable language backend for the eval tool. */
export interface ExecutorBackend {
	readonly id: EvalLanguage;
	readonly label: string;
	/** Source language identifier passed to the syntax highlighter (e.g. "python", "javascript"). */
	readonly highlightLang: string;
	/** Cheap availability check. Used by fallback resolution and bounded by the caller's probe options. */
	isAvailable(session: ToolSession, opts?: BackendProbeOptions): Promise<boolean>;
	/** Execute one cell. Caller invokes once per cell and aggregates results. */
	execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult>;
}

/**
 * Resolve the on-disk roots that the eval helpers substitute for internal-URL
 * schemes (currently `local://`). Prefers the session's own
 * {@link LocalProtocolOptions} — the exact mapping `read local://…` uses — so an
 * eval `write("local://x")` and a later `read local://x` agree on the location.
 */
export function resolveEvalUrlRoots(session: ToolSession): Record<string, string> {
	const options: LocalProtocolOptions = session.localProtocolOptions ?? {
		getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
		getSessionId: () => session.getSessionId?.() ?? null,
	};
	return buildEvalUrlRoots(options);
}
