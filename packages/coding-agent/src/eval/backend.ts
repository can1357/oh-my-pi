import { buildEvalUrlRoots, LocalProtocolHandler } from "../internal-urls";
import { contextLocalProtocolOptions } from "../internal-urls/context";
import { whenArtifactCopiesSettle } from "../session/session-manager";
import type { OutputArtifactError } from "@oh-my-pi/pi-tui/tools/streaming-output";
import type { ToolSession } from "../tools";
import type { BackendProbeOptions } from "./probe";
import type { EvalLanguage, EvalStatusEvent } from "@oh-my-pi/pi-tui/tools/eval";
import type { EvalDisplayOutput } from "./types";

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
	/** Absolute filename for file-backed cells; preserves import and traceback locations. */
	filename?: string;
	/** Explicit distribution requirements installed before executing the cell. */
	packages?: string[];
	/** Managed scratch environment by default; project mutations require explicit selection. */
	environment?: "managed" | "project";
	onChunk: (chunk: string) => void;
	/**
	 * Live status events (read/write/agent/…) delivered as they are emitted,
	 * before the cell finishes. The same events are also returned in
	 * `displayOutputs`; this channel exists so callers can stream long-running
	 * progress (e.g. `agent()` subagents) into the UI mid-execution.
	 */
	onStatus?: (event: EvalStatusEvent) => void;
}

/** Result returned by a backend's execute(). */
export interface ExecutorBackendResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId: string | undefined;
	/** Bytes the artifact cap dropped from the saved file's middle (the artifact is a head/tail sample). */
	artifactElidedBytes?: number;
	artifactError?: OutputArtifactError;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: EvalDisplayOutput[];
}

/** Outcome of {@link ExecutorBackend.checkAvailability}. */
export interface BackendAvailability {
	ok: boolean;
	/** Why the backend cannot run (e.g. which interpreters failed to start); surfaced in the eval error. */
	reason?: string;
}

/** Pluggable language backend for the eval tool. */
export interface ExecutorBackend {
	readonly id: EvalLanguage;
	readonly label: string;
	/** Source language identifier passed to the syntax highlighter (e.g. "python", "javascript"). */
	readonly highlightLang: string;
	/** Cheap availability check. Used by backend resolution and bounded by the caller's probe options. */
	checkAvailability(session: ToolSession, opts?: BackendProbeOptions): Promise<BackendAvailability>;
	/** Execute one cell. Caller invokes once per cell and aggregates results. */
	execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult>;
}

/**
 * Hold a cell until any artifact copy into this session's artifacts directory
 * has finished.
 *
 * The helpers that serve `artifact://<n>` inside a cell run where the readiness
 * table cannot be reached — a worker for JavaScript, a subprocess kernel for
 * Python — and both resolve the id by listing the directory. A directory is a
 * snapshot, not a protocol: during a merge it holds some of the inherited
 * artifacts and not the rest, and before the staging tree exists it holds none
 * of them while a copy is already under way. So the question is asked on this
 * side, where the answer is kept, and asked before the cell starts rather than
 * by each reader inside it.
 *
 * It costs the cell the time the copy has left, and only while one is running:
 * a copy announces itself for as long as it is going on and for no longer. The
 * caller's signal cancels the wait, because a pending answer is still not
 * something to make a cancelled cell sit through.
 */
export async function awaitEvalArtifactsSettled(session: ToolSession, signal?: AbortSignal): Promise<void> {
	const dir = contextLocalProtocolOptions(session)?.getArtifactsDir?.();
	if (!dir) return;
	await whenArtifactCopiesSettle(dir, signal);
}

/**
 * Resolve the on-disk roots that the eval helpers substitute for internal-URL
 * schemes from {@link contextLocalProtocolOptions}, resolved the way the
 * protocol handlers do, so an eval `write("local://x")` and a later
 * `read local://x` agree on the location. `local://` maps to its root;
 * `artifact://` maps to the session's artifacts dir, the dir `read artifact://<id>`
 * searches first, so `read("artifact://<id>")` returns the artifact's text.
 * A scheme is absent when its root does not resolve (read would fail the same way).
 */
export function resolveEvalUrlRoots(session: ToolSession): Record<string, string> {
	const protocolOptions = contextLocalProtocolOptions(session);
	const options = LocalProtocolHandler.resolveOptions({ localProtocolOptions: protocolOptions });
	const roots = options ? buildEvalUrlRoots(options) : {};
	const artifactsDir = protocolOptions?.getArtifactsDir?.();
	if (artifactsDir) roots.artifact = artifactsDir;
	return roots;
}
