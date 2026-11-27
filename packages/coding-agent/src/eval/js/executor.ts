import {
	type ArtifactAllocator,
	DEFAULT_MAX_BYTES,
	type OutputArtifactError,
	OutputSink,
} from "../../tools/streaming-output";
import type { ToolSession } from "../../tools";
import { formatTimeoutNotice } from "../../tools/details/bash";
import { PAGE_ONLY_GLOBAL_RE } from "../../tools/browser/tab-protocol";
import {
	resolveOutputMaxColumns,
	resolveOutputSinkArtifactMaxBytes,
	resolveOutputSinkHeadBytes,
} from "../../tools/output-meta";
import { isEvalTimeoutControlEvent, withBridgeTimeoutPause } from "../bridge-timeout";
import { DisplayOutputCollector } from "../executor-base";
import type { EvalDisplayOutput } from "../types";
import { executeInVmContext, hasLiveVmContext } from "./context-manager";
import { formatCellError } from "./error-text";
import { installJsPackages } from "./package-installer";
import type { JsPackageEnvironmentMode } from "./package-installer";
import type { JsStatusEvent } from "./shared/types";

import { cfgEvalAutoProvision } from "../settings";

export interface JsExecutorOptions {
	cwd?: string;
	timeoutMs?: number;
	deadlineMs?: number;
	/**
	 * Runtime-work budget (ms). Used for worker cold-start headroom and
	 * timeout-annotation text when the caller drives cancellation via the eval
	 * watchdog `signal` instead of `deadlineMs`/`timeoutMs`. Never arms a timer.
	 */
	idleTimeoutMs?: number;
	onChunk?: (chunk: string) => Promise<void> | void;
	onStatus?: (event: JsStatusEvent) => void;
	/** Shows the user `out://` replies of the cell's bridged tool calls; absent, those calls are refused. */
	onReply?: (text: string) => void;
	signal?: AbortSignal;
	sessionId: string;
	parentToolCallId?: string;
	/** Logical owner identifier; scopes retained-worker cleanup. */
	kernelOwnerId?: string;
	reset?: boolean;
	sessionFile?: string;
	/** Absolute source path for file-backed cells. */
	filename?: string;
	/** Explicit package requirements reconciled before cell execution. */
	packages?: string[];
	/** Package target. Repository mutation requires explicit project selection. */
	environment?: JsPackageEnvironmentMode;
	allocateArtifact?: ArtifactAllocator;
	session: ToolSession;
	/** On-disk roots the helpers substitute for internal-URL schemes (e.g. `local://`). */
	localRoots?: Record<string, string>;
}

export interface JsResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId?: string;
	/** Bytes the artifact cap dropped from the saved file's middle (the artifact is a head/tail sample). */
	artifactElidedBytes?: number;
	artifactError?: OutputArtifactError;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: EvalDisplayOutput[];
}

function getExecutionTimeoutMs(options: Pick<JsExecutorOptions, "deadlineMs" | "timeoutMs">): number | undefined {
	if (options.deadlineMs !== undefined) {
		return Math.max(1, options.deadlineMs - Date.now());
	}
	return options.timeoutMs;
}

function isTimeoutReason(reason: unknown): boolean {
	return (
		(reason instanceof DOMException && reason.name === "TimeoutError") ||
		(reason instanceof Error && reason.name === "TimeoutError")
	);
}

const JS_PACKAGE_INSTALL_TIMEOUT_MS = 10 * 60_000;

function formatJsTimeoutAnnotation(timeoutMs: number | undefined): string {
	// Timeout cancellation force-kills the worker (the only way to interrupt
	// synchronous user code), which discards the persistent VM state. Say so,
	// or the model will keep referencing variables that no longer exist.
	return `${formatTimeoutNotice(timeoutMs)}; JS worker killed, state gone`;
}

function formatPackageInstallTimeoutAnnotation(installDeadlineReached: boolean): string {
	const timing = installDeadlineReached
		? `timed out after ${Math.round(JS_PACKAGE_INSTALL_TIMEOUT_MS / 1000)}s`
		: "cut off by the cell timeout";
	return `package install ${timing}; JS state kept`;
}

export async function executeJs(code: string, options: JsExecutorOptions): Promise<JsResult> {
	const display = new DisplayOutputCollector();
	const displayOutputs = display.outputs;
	const outputSink = new OutputSink({
		allocateArtifact: options.allocateArtifact,
		spillThreshold: DEFAULT_MAX_BYTES,
		headBytes: resolveOutputSinkHeadBytes(options.session.settings),
		artifactMaxBytes: resolveOutputSinkArtifactMaxBytes(options.session.settings),
		maxColumns: resolveOutputMaxColumns(options.session.settings),
		onChunk: chunk => options.onChunk?.(chunk),
	});
	const legacyTimeoutMs = getExecutionTimeoutMs(options);
	let runtimeTimeoutMs = legacyTimeoutMs;
	let timeoutSignal: AbortSignal | undefined;
	let signal: AbortSignal | undefined;
	const packages = options.packages ?? [];
	const packageTimeoutSignal = packages.length > 0 ? AbortSignal.timeout(JS_PACKAGE_INSTALL_TIMEOUT_MS) : undefined;
	const packageSignal = packageTimeoutSignal
		? options.signal
			? AbortSignal.any([options.signal, packageTimeoutSignal])
			: packageTimeoutSignal
		: options.signal;
	let packageWorkComplete = false;
	let runtimeEntered = false;
	const filename = options.filename ?? `js-cell-${crypto.randomUUID()}.js`;
	const cwd = options.cwd ?? options.session.cwd;

	try {
		const installOptions = {
			cwd,
			packages,
			environment: options.environment,
			autoProvision: cfgEvalAutoProvision.get(options.session.settings),
			signal: packageSignal,
		};
		const install =
			packages.length > 0
				? await withBridgeTimeoutPause(options.onStatus, () => installJsPackages(installOptions))
				: await installJsPackages(installOptions);
		packageSignal?.throwIfAborted();
		if (install.summary) outputSink.push(`${install.summary}\n`);
		// Bun's resolver caches node_modules directory listings per process, so a retained
		// worker cannot see packages added after it looked there: restart it to resolve them.
		const restartForInstall = packages.length > 0 && !options.reset && hasLiveVmContext(options.sessionId);
		if (restartForInstall) {
			outputSink.push("[JS worker restarted for new packages; globals cleared]\n");
		}
		packageWorkComplete = true;
		// Start the legacy compute timer only after host-side package work. The
		// eval tool's normal idle watchdog is already paused by the status
		// wrapper above; direct timeoutMs callers need the same semantics.
		runtimeTimeoutMs = options.deadlineMs === undefined ? legacyTimeoutMs : getExecutionTimeoutMs(options);
		timeoutSignal =
			typeof runtimeTimeoutMs === "number" && Number.isFinite(runtimeTimeoutMs) && runtimeTimeoutMs > 0
				? AbortSignal.timeout(runtimeTimeoutMs)
				: undefined;
		signal =
			options.signal && timeoutSignal
				? AbortSignal.any([options.signal, timeoutSignal])
				: (options.signal ?? timeoutSignal);
		signal?.throwIfAborted();
		runtimeEntered = true;
		await executeInVmContext({
			sessionKey: options.sessionId,
			sessionId: options.sessionId,
			ownerId: options.kernelOwnerId,
			cwd,
			session: options.session,
			localRoots: options.localRoots,
			packageRoot: install.environment.packageRoot,
			packageEnvironment: install.environment.description,
			reset: options.reset || restartForInstall,
			code,
			filename,
			timeoutMs: runtimeTimeoutMs ?? options.idleTimeoutMs,
			runState: {
				signal,
				onReply: options.onReply,
				parentToolCallId: options.parentToolCallId,
				onText: chunk => outputSink.push(chunk),
				onDisplay: output => {
					if (output.type === "status") {
						// Timeout-control events drive the eval watchdog only; never
						// store or render them as cell output.
						options.onStatus?.(output.event);
						if (isEvalTimeoutControlEvent(output.event)) return;
					}
					display.push(output);
				},
			},
		});
		const summary = await outputSink.dump();
		return {
			output: summary.output,
			exitCode: 0,
			cancelled: false,
			truncated: summary.truncated,
			artifactId: summary.artifactId,
			artifactElidedBytes: summary.artifactElidedBytes,
			artifactError: summary.artifactError,
			totalLines: summary.totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			displayOutputs,
		};
	} catch (error) {
		const activeSignal = packageWorkComplete ? signal : packageSignal;
		// Every requested cancellation (the caller's signal, the cell timeout, the
		// package-install timeout) aborts `activeSignal`. An error that merely has
		// a cancellation-like name, thrown by the cell's own code, is a failure.
		if (activeSignal?.aborted) {
			const timedOut = packageWorkComplete
				? Boolean(timeoutSignal?.aborted) || isTimeoutReason(options.signal?.reason)
				: isTimeoutReason(packageSignal?.reason);
			if (timedOut) {
				const annotation = runtimeEntered
					? formatJsTimeoutAnnotation(runtimeTimeoutMs ?? options.idleTimeoutMs)
					: packageWorkComplete
						? "timed out before JS ran; JS state kept"
						: formatPackageInstallTimeoutAnnotation(packageTimeoutSignal?.aborted === true);
				outputSink.push(`[${annotation}]`);
			}
			const summary = await outputSink.dump();
			return {
				output: summary.output,
				exitCode: undefined,
				cancelled: true,
				truncated: summary.truncated,
				artifactId: summary.artifactId,
				artifactElidedBytes: summary.artifactElidedBytes,
				artifactError: summary.artifactError,
				totalLines: summary.totalLines,
				totalBytes: summary.totalBytes,
				outputLines: summary.outputLines,
				outputBytes: summary.outputBytes,
				displayOutputs,
			};
		}
		const message =
			error instanceof Error
				? formatCellError(error.stack ?? error.message, {
						filename,
						cwd,
						header: Error.prototype.toString.call(error),
					})
				: String(error);
		// The cell's own code reached for a page global (`document.querySelector(…)` written for the page). Checked by
		// name: the worker's error arrives rebuilt as a plain Error carrying it.
		const pageGlobal =
			error instanceof Error && error.name === "ReferenceError" && PAGE_ONLY_GLOBAL_RE.test(error.message);
		outputSink.push(
			pageGlobal
				? `${message}\nEval code runs in omp's Bun runtime, not in a page; run page code in a browser tab with tab.evaluate(() => …).`
				: message,
		);
		const summary = await outputSink.dump();
		return {
			output: summary.output,
			exitCode: 1,
			cancelled: false,
			truncated: summary.truncated,
			artifactId: summary.artifactId,
			artifactElidedBytes: summary.artifactElidedBytes,
			artifactError: summary.artifactError,
			totalLines: summary.totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			displayOutputs,
		};
	} finally {
		await outputSink.dispose();
	}
}
