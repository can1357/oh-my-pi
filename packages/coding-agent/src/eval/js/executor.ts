import { DEFAULT_MAX_BYTES, type OutputArtifactError, OutputSink } from "@oh-my-pi/pi-tui/tools/streaming-output";
import type { ToolSession } from "../../tools";
import { resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "../../tools/output-meta";
import { isEvalTimeoutControlEvent, withBridgeTimeoutPause } from "../bridge-timeout";
import { DisplayOutputCollector } from "../executor-base";
import { executeInVmContext, type JsDisplayOutput } from "./context-manager";
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
	signal?: AbortSignal;
	sessionId: string;
	/** Logical owner identifier; scopes `reset` on shared contexts and retained-worker cleanup. */
	kernelOwnerId?: string;
	reset?: boolean;
	sessionFile?: string;
	/** Absolute source path for file-backed cells. */
	filename?: string;
	/** Explicit package requirements reconciled before cell execution. */
	packages?: string[];
	/** Package target. Repository mutation requires explicit project selection. */
	environment?: JsPackageEnvironmentMode;
	artifactPath?: string;
	artifactId?: string;
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
	artifactError?: OutputArtifactError;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: JsDisplayOutput[];
}

function getExecutionTimeoutMs(options: Pick<JsExecutorOptions, "deadlineMs" | "timeoutMs">): number | undefined {
	if (options.deadlineMs !== undefined) {
		return Math.max(1, options.deadlineMs - Date.now());
	}
	return options.timeoutMs;
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
	);
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
	const reset = "The JS worker was force-killed and its VM state was reset; variables from earlier cells are gone.";
	if (timeoutMs === undefined) return `Command timed out. ${reset}`;
	const secs = Math.max(1, Math.round(timeoutMs / 1000));
	return `Command timed out after ${secs} seconds. ${reset}`;
}

function formatPackageInstallTimeoutAnnotation(installDeadlineReached: boolean): string {
	const timing = installDeadlineReached
		? `timed out after ${Math.round(JS_PACKAGE_INSTALL_TIMEOUT_MS / 1000)} seconds`
		: "was cancelled by the caller's timeout";
	return (
		`JavaScript package installation ${timing}. ` +
		"Any existing retained JS worker was not restarted; earlier variables, if any, remain available."
	);
}

export async function executeJs(code: string, options: JsExecutorOptions): Promise<JsResult> {
	const display = new DisplayOutputCollector<JsDisplayOutput>();
	const displayOutputs = display.outputs;
	const outputSink = new OutputSink({
		artifactPath: options.artifactPath,
		artifactId: options.artifactId,
		spillThreshold: DEFAULT_MAX_BYTES,
		headBytes: resolveOutputSinkHeadBytes(options.session.settings),
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

	try {
		const cwd = options.cwd ?? options.session.cwd;
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
			reset: options.reset,
			code,
			filename: options.filename ?? `js-cell-${crypto.randomUUID()}.js`,
			timeoutMs: runtimeTimeoutMs ?? options.idleTimeoutMs,
			runState: {
				signal,
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
			artifactError: summary.artifactError,
			totalLines: summary.totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
			displayOutputs,
		};
	} catch (error) {
		const activeSignal = packageWorkComplete ? signal : packageSignal;
		if (activeSignal?.aborted || isAbortError(error)) {
			const timedOut = packageWorkComplete
				? Boolean(timeoutSignal?.aborted) || isTimeoutReason(options.signal?.reason)
				: isTimeoutReason(packageSignal?.reason);
			if (timedOut) {
				const annotation = runtimeEntered
					? formatJsTimeoutAnnotation(runtimeTimeoutMs ?? options.idleTimeoutMs)
					: packageWorkComplete
						? "Command timed out before JavaScript execution began. Any existing retained JS worker remains available."
						: formatPackageInstallTimeoutAnnotation(packageTimeoutSignal?.aborted === true);
				outputSink.push(annotation);
			}
			const summary = await outputSink.dump();
			return {
				output: summary.output,
				exitCode: undefined,
				cancelled: true,
				truncated: summary.truncated,
				artifactId: summary.artifactId,
				artifactError: summary.artifactError,
				totalLines: summary.totalLines,
				totalBytes: summary.totalBytes,
				outputLines: summary.outputLines,
				outputBytes: summary.outputBytes,
				displayOutputs,
			};
		}
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		outputSink.push(message);
		const summary = await outputSink.dump();
		return {
			output: summary.output,
			exitCode: 1,
			cancelled: false,
			truncated: summary.truncated,
			artifactId: summary.artifactId,
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
