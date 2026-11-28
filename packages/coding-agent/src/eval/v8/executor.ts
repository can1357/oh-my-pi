import type { ToolSession } from "../../tools";
import { formatTimeoutNotice } from "../../tools/details/bash";
import {
	resolveOutputMaxColumns,
	resolveOutputSinkArtifactMaxBytes,
	resolveOutputSinkHeadBytes,
} from "../../tools/output-meta";
import {
	type ArtifactAllocator,
	DEFAULT_MAX_BYTES,
	type OutputArtifactError,
	OutputSink,
} from "../../tools/streaming-output";
import { isEvalTimeoutControlEvent } from "../bridge-timeout";
import { DisplayOutputCollector } from "../executor-base";
import { formatCellError } from "../js/error-text";
import { diagnoseCellSyntaxError, wrapV8CellCode } from "../js/shared/rewrite-imports";
import type { JsStatusEvent } from "../js/shared/types";
import type { EvalDisplayOutput } from "../types";
import { executeInV8Isolate, hasLiveV8Isolate } from "./context-manager";

export interface V8ExecutorOptions {
	cwd?: string;
	timeoutMs?: number;
	deadlineMs?: number;
	idleTimeoutMs?: number;
	onChunk?: (chunk: string) => Promise<void> | void;
	onStatus?: (event: JsStatusEvent) => void;
	onReply?: (text: string) => void;
	signal?: AbortSignal;
	sessionId: string;
	parentToolCallId?: string;
	kernelOwnerId?: string;
	reset?: boolean;
	filename?: string;
	allocateArtifact?: ArtifactAllocator;
	session: ToolSession;
}

export interface V8Result {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId?: string;
	artifactElidedBytes?: number;
	artifactError?: OutputArtifactError;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: EvalDisplayOutput[];
}

function getExecutionTimeoutMs(options: Pick<V8ExecutorOptions, "deadlineMs" | "timeoutMs">): number | undefined {
	if (options.deadlineMs !== undefined) return Math.max(0, options.deadlineMs - Date.now());
	return options.timeoutMs;
}

function isTimeoutReason(reason: unknown): boolean {
	if (!(reason instanceof Error)) return false;
	return reason.name === "TimeoutError" || reason.name === "IdleTimeoutError";
}

function formatV8TimeoutAnnotation(timeoutMs: number | undefined, sessionKey: string): string {
	const prefix = formatTimeoutNotice(timeoutMs);
	return hasLiveV8Isolate(sessionKey) ? `${prefix}; V8 state kept` : `${prefix}; V8 isolate killed, state gone`;
}

export async function executeV8(code: string, options: V8ExecutorOptions): Promise<V8Result> {
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

	const runtimeTimeoutMs = getExecutionTimeoutMs(options);
	const timeoutSignal =
		typeof runtimeTimeoutMs === "number" && Number.isFinite(runtimeTimeoutMs) && runtimeTimeoutMs > 0
			? AbortSignal.timeout(runtimeTimeoutMs)
			: undefined;
	const signal =
		options.signal && timeoutSignal
			? AbortSignal.any([options.signal, timeoutSignal])
			: (options.signal ?? timeoutSignal);

	const filename = options.filename ?? `v8-cell-${crypto.randomUUID()}.js`;
	const cwd = options.cwd ?? options.session.cwd;
	let runtimeEntered = false;

	try {
		signal?.throwIfAborted();
		const wrapped = await wrapV8CellCode(code);
		runtimeEntered = true;
		await executeInV8Isolate({
			sessionKey: options.sessionId,
			sessionId: options.sessionId,
			ownerId: options.kernelOwnerId,
			session: options.session,
			reset: options.reset,
			code: wrapped.source,
			filename,
			finalExprSuppressed: wrapped.finalExpressionSuppressed,
			timeoutMs: runtimeTimeoutMs ?? options.idleTimeoutMs,
			runState: {
				signal,
				onReply: options.onReply,
				parentToolCallId: options.parentToolCallId,
				onText: chunk => outputSink.push(chunk),
				onDisplay: output => {
					if (output.type === "status") {
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
		if (signal?.aborted) {
			const timedOut = Boolean(timeoutSignal?.aborted) || isTimeoutReason(options.signal?.reason);
			if (timedOut) {
				const annotation = runtimeEntered
					? formatV8TimeoutAnnotation(runtimeTimeoutMs ?? options.idleTimeoutMs, options.sessionId)
					: "timed out before V8 ran; V8 state kept";
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

		let effectiveError = error;
		if (error instanceof Error && error.name === "SyntaxError") {
			const diagnosed = await diagnoseCellSyntaxError(code);
			if (diagnosed) effectiveError = diagnosed;
		}
		const message =
			effectiveError instanceof Error
				? formatCellError(effectiveError.stack ?? effectiveError.message, {
						filename,
						cwd,
						header: Error.prototype.toString.call(effectiveError),
					})
				: String(effectiveError);
		outputSink.push(message);
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
