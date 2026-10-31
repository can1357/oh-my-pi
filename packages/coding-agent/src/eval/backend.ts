import { buildEvalUrlRoots, LocalProtocolHandler } from "../internal-urls";
import { contextLocalProtocolOptions } from "../internal-urls/context";
import { holdArtifactRoot } from "./artifact-readiness";
import { EVAL_ARTIFACT_ROOT_TOKEN } from "./artifact-wire";
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
	/**
	 * Shows the user what the cell's bridged tool calls send to `out://` (a `write` there, or bash
	 * `> out://`). Throws to refuse a reply; absent, such calls fail instead of replying unseen.
	 */
	onReply?: (text: string) => void;
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

/** What a cell carries when its artifacts directory was there at assignment and could not be held. */
const LOST_ARTIFACT_ROOT = "root-lost";

/**
 * {@link resolveEvalUrlRoots} with the artifacts directory held open for the
 * cell, and the token that reaches the hold.
 *
 * The token comes back with every artifact read the cell makes, so the
 * directory the read is answered from is the one the cell was given rather
 * than whatever its pathname reaches by then. No scheme can be named
 * `__artifactRoot`, so it is invisible to everything that reads these roots as
 * scheme-to-root.
 */
export async function resolveEvalUrlRootsHeld(session: ToolSession): Promise<Record<string, string>> {
	const roots = resolveEvalUrlRoots(session);
	if (roots.artifact) {
		// Three states, decided here and recorded: held, never there, or there
		// and lost. The last one carries a token that reaches no hold, so this
		// cell's artifact reads refuse — the cell itself still runs, because a
		// cell that never reads an artifact has done nothing wrong — while a
		// cell whose directory simply has not arrived keeps the ordinary path.
		const token = await holdArtifactRoot(roots.artifact).catch(() => LOST_ARTIFACT_ROOT);
		if (token) roots[EVAL_ARTIFACT_ROOT_TOKEN] = token;
	}
	return roots;
}
