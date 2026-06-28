import * as path from "node:path";
import * as timers from "node:timers/promises";
import { logger, ptree, untilAborted } from "@pk-nerdsaver-ai/pi-utils";
import { NON_INTERACTIVE_ENV } from "../exec/non-interactive-env";
import { DapClient } from "./client";
import type {
	DapAttachArguments,
	DapAttachSessionOptions,
	DapBreakpoint,
	DapBreakpointRecord,
	DapCapabilities,
	DapContinueArguments,
	DapContinueOutcome,
	DapContinueResponse,
	DapDataBreakpoint,
	DapDataBreakpointInfoArguments,
	DapDataBreakpointInfoResponse,
	DapDataBreakpointRecord,
	DapDisassembleArguments,
	DapDisassembledInstruction,
	DapDisassembleResponse,
	DapEvaluateArguments,
	DapEvaluateResponse,
	DapExitedEventBody,
	DapFunctionBreakpoint,
	DapFunctionBreakpointRecord,
	DapInitializeArguments,
	DapInstructionBreakpoint,
	DapInstructionBreakpointRecord,
	DapLaunchArguments,
	DapLaunchSessionOptions,
	DapLoadedSourcesResponse,
	DapModule,
	DapModulesArguments,
	DapModulesResponse,
	DapOutputEventBody,
	DapPauseArguments,
	DapReadMemoryArguments,
	DapReadMemoryResponse,
	DapResolvedAdapter,
	DapRunInTerminalArguments,
	DapRunInTerminalResponse,
	DapScopesArguments,
	DapScopesResponse,
	DapSessionStatus,
	DapSessionSummary,
	DapSetDataBreakpointsArguments,
	DapSetInstructionBreakpointsArguments,
	DapSource,
	DapSourceBreakpoint,
	DapStackFrame,
	DapStackTraceArguments,
	DapStackTraceResponse,
	DapStartDebuggingArguments,
	DapStepArguments,
	DapStopLocation,
	DapStoppedEventBody,
	DapThread,
	DapThreadsResponse,
	DapVariablesArguments,
	DapVariablesResponse,
	DapWriteMemoryArguments,
	DapWriteMemoryResponse,
} from "./types";

interface DapSession {
	id: string;
	adapter: DapResolvedAdapter;
	cwd: string;
	program?: string;
	client: DapClient;
	status: DapSessionStatus;
	launchedAt: number;
	lastUsedAt: number;
	breakpoints: Map<string, DapBreakpointRecord[]>;
	functionBreakpoints: DapFunctionBreakpointRecord[];
	instructionBreakpoints: DapInstructionBreakpoint[];
	dataBreakpoints: DapDataBreakpoint[];
	/** Serializes breakpoint mutations — see #serializeBreakpointMutation. */
	breakpointMutationQueue: Promise<void>;
	/** Recent output chunks; trimmed from the front when over MAX_OUTPUT_BYTES. */
	outputChunks: string[];
	/** Cumulative bytes of output ever received (reported in summaries). */
	outputBytes: number;
	/** Bytes currently buffered in outputChunks. */
	outputBufferedBytes: number;
	outputTruncated: boolean;
	stop: DapStopLocation;
	threads: DapThread[];
	lastStackFrames: DapStackFrame[];
	exitCode?: number;
	capabilities?: DapCapabilities;
	initializedSeen: boolean;
	needsConfigurationDone: boolean;
	configurationDoneSent: boolean;
}

export interface DapOutputSnapshot {
	snapshot: DapSessionSummary;
	output: string;
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 1000;
const HEARTBEAT_INTERVAL_MS = 5 * 1000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const STOP_CAPTURE_TIMEOUT_MS = 5_000;

function toErrorMessage(value: unknown): string {
	if (value instanceof Error) return value.message;
	return String(value);
}

interface DapStartRequestFailure {
	rejected: boolean;
	error?: unknown;
	/**
	 * Resolves (never rejects) when the underlying launch/attach request
	 * settles either way. Set by {@link trackDapStartRequest} on each call,
	 * so a single failure object must not be reused across launch attempts.
	 * Consumed by {@link throwPreferredDapStartError} to bound how long to
	 * wait for a delayed adapter-side rejection before falling back to the
	 * cascade error from configurationDone.
	 */
	settled?: Promise<void>;
}

function trackDapStartRequest<T>(promise: Promise<T>, failure: DapStartRequestFailure): Promise<T> {
	const tracked = promise.catch(error => {
		failure.rejected = true;
		failure.error = error;
		throw error;
	});
	failure.settled = tracked.then(
		() => {},
		() => {},
	);
	return tracked;
}

function combineDapStartErrors(command: "launch" | "attach", startError: unknown, configurationError: unknown): Error {
	const startMessage = toErrorMessage(startError);
	const configurationMessage = toErrorMessage(configurationError);
	if (startMessage === configurationMessage) {
		return startError instanceof Error ? startError : new Error(startMessage);
	}
	return new Error(
		`DAP ${command} failed: ${startMessage}\nDAP configurationDone also failed: ${configurationMessage}`,
	);
}

async function throwPreferredDapStartError(
	command: "launch" | "attach",
	startFailure: DapStartRequestFailure,
	configurationError: unknown,
): Promise<never> {
	await Promise.race([startFailure.settled ?? Promise.resolve(), timers.setTimeout(50)]);
	if (startFailure.rejected) {
		throw combineDapStartErrors(command, startFailure.error, configurationError);
	}
	throw configurationError;
}

const DEBUGPY_MISSING_MODULE_RE = /No module named ['"]?debugpy['"]?/;

/**
 * Map a generic adapter-side failure into the targeted `pip install debugpy`
 * hint when the adapter is debugpy and stderr/the wrapping error mentions
 * the missing module. Returns null when the heuristic does not apply, so the
 * caller can rethrow the original error untouched.
 */
function mapDebugpyMissingModule(adapterName: string, error: unknown): Error | null {
	if (adapterName !== "debugpy") return null;
	if (!DEBUGPY_MISSING_MODULE_RE.test(toErrorMessage(error))) return null;
	return new Error("adapter 'debugpy' is not available: install with 'pip install debugpy'");
}

function normalizePath(filePath: string): string {
	return path.resolve(filePath);
}

function truncateOutput(session: DapSession, output: string): void {
	if (!output) return;
	const bytes = Buffer.byteLength(output, "utf-8");
	session.outputChunks.push(output);
	session.outputBytes += bytes;
	session.outputBufferedBytes += bytes;
	// Trim whole chunks from the front, but only while the remainder still
	// holds a full MAX_OUTPUT_BYTES tail — dropping the front chunk whenever
	// the total exceeded the cap could retain far less than the cap (e.g.
	// [120KB, 10KB] would keep only 10KB). Recomputing one big string's byte
	// length per 1KB trim iteration was O(n^2) inside the event dispatch loop.
	while (session.outputChunks.length > 1) {
		const frontBytes = Buffer.byteLength(session.outputChunks[0], "utf-8");
		if (session.outputBufferedBytes - frontBytes < MAX_OUTPUT_BYTES) break;
		session.outputChunks.shift();
		session.outputBufferedBytes -= frontBytes;
		session.outputTruncated = true;
	}
	if (session.outputBufferedBytes > MAX_OUTPUT_BYTES) {
		// Byte-slice the front chunk's head so exactly the cap remains (a torn
		// code point at the cut decodes as U+FFFD, acceptable for log output).
		const front = session.outputChunks[0];
		const frontBytes = Buffer.byteLength(front, "utf-8");
		const excess = session.outputBufferedBytes - MAX_OUTPUT_BYTES;
		const kept = Buffer.from(front, "utf-8").subarray(excess).toString("utf-8");
		session.outputChunks[0] = kept;
		session.outputBufferedBytes += Buffer.byteLength(kept, "utf-8") - frontBytes;
		session.outputTruncated = true;
	}
}

function summarizeBreakpointCount(breakpoints: Map<string, DapBreakpointRecord[]>): number {
	let total = 0;
	for (const entries of breakpoints.values()) {
		total += entries.length;
	}
	return total;
}

function buildSummary(session: DapSession): DapSessionSummary {
	return {
		id: session.id,
		adapter: session.adapter.name,
		cwd: session.cwd,
		program: session.program,
		status: session.status,
		launchedAt: new Date(session.launchedAt).toISOString(),
		lastUsedAt: new Date(session.lastUsedAt).toISOString(),
		threadId: session.stop.threadId,
		frameId: session.stop.frameId,
		stopReason: session.stop.reason,
		stopDescription: session.stop.description ?? session.stop.text,
		frameName: session.stop.frameName,
		instructionPointerReference: session.stop.instructionPointerReference,
		source: session.stop.source,
		line: session.stop.line,
		column: session.stop.column,
		breakpointFiles: session.breakpoints.size,
		breakpointCount: summarizeBreakpointCount(session.breakpoints),
		functionBreakpointCount: session.functionBreakpoints.length,
		outputBytes: session.outputBytes,
		outputTruncated: session.outputTruncated,
		exitCode: session.exitCode,
		needsConfigurationDone: session.needsConfigurationDone && !session.configurationDoneSent,
	};
}

export class DapSessionManager {
	#sessions = new Map<string, DapSession>();
	#activeSessionId: string | null = null;
	#cleanupLoopPromise?: Promise<void>;
	#nextId = 0;

	constructor() {
		this.#startCleanupTimer();
	}

	getActiveSession(): DapSessionSummary | null {
		const session = this.#getActiveSessionOrNull();
		return session ? buildSummary(session) : null;
	}

	listSessions(): DapSessionSummary[] {
		return Array.from(this.#sessions.values()).map(buildSummary);
	}

	getCapabilities(): DapCapabilities | null {
		return this.#getActiveSessionOrNull()?.capabilities ?? null;
	}

	async launch(
		options: DapLaunchSessionOptions,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<DapSessionSummary> {
		await this.#ensureLaunchSlot();
		const client = await DapClient.spawn({ adapter: options.adapter, cwd: options.cwd });
		const session = this.#registerSession(client, options.adapter, options.cwd, options.program);
		try {
			session.capabilities = await client.initialize(
				this.#buildInitializeArguments(options.adapter),
				signal,
				timeoutMs,
			);
			session.needsConfigurationDone = session.capabilities.supportsConfigurationDoneRequest === true;
			const launchArguments: DapLaunchArguments = {
				...options.adapter.launchDefaults,
				...(options.extraLaunchArguments ?? {}),
				program: options.program,
				cwd: options.cwd,
				...(options.args !== undefined ? { args: options.args } : {}),
			};
			// Subscribe to stop events BEFORE launching so we don't miss
			// stopOnEntry events that arrive before we start listening.
			const initialStopPromise = this.#prepareStopOutcome(
				session,
				signal,
				Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS),
			);
			// DAP spec: many adapters do not respond to launch until after
			// configurationDone. Fire launch, complete the config handshake,
			// then await the launch response.
			const launchFailure: DapStartRequestFailure = { rejected: false };
			const launchPromise = trackDapStartRequest(
				client.sendRequest("launch", launchArguments, signal, timeoutMs),
				launchFailure,
			);
			// Mark handled so a fast error response doesn't become an unhandled
			// rejection while we await the config handshake. The actual error
			// still propagates when we await launchPromise below.
			launchPromise.catch(() => {});
			try {
				await this.#completeConfigurationHandshake(session, signal, timeoutMs);
			} catch (error) {
				await throwPreferredDapStartError("launch", launchFailure, error);
			}
			await launchPromise;
			// Try to capture initial stopped state (e.g. stopOnEntry).
			// Timeout is acceptable — the program may simply be running.
			try {
				await untilAborted(signal, initialStopPromise);
				if (session.status === "stopped") {
					await this.#fetchTopFrame(session, signal, Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS));
				}
			} catch {
				if (session.initializedSeen && session.status === "launching") {
					session.status = session.configurationDoneSent ? "running" : "configuring";
				}
			}
			return buildSummary(session);
		} catch (error) {
			await this.#disposeSession(session);
			const mapped = mapDebugpyMissingModule(options.adapter.name, error);
			if (mapped) throw mapped;
			throw error;
		}
	}

	async attach(
		options: DapAttachSessionOptions,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<DapSessionSummary> {
		await this.#ensureLaunchSlot();
		const client = await DapClient.spawn({ adapter: options.adapter, cwd: options.cwd });
		const session = this.#registerSession(client, options.adapter, options.cwd);
		try {
			session.capabilities = await client.initialize(
				this.#buildInitializeArguments(options.adapter),
				signal,
				timeoutMs,
			);
			session.needsConfigurationDone = session.capabilities.supportsConfigurationDoneRequest === true;
			const attachArguments: DapAttachArguments = {
				...options.adapter.attachDefaults,
				cwd: options.cwd,
				...(options.pid !== undefined ? { pid: options.pid, processId: options.pid } : {}),
				...(options.port !== undefined ? { port: options.port } : {}),
				...(options.host ? { host: options.host } : {}),
			};
			const initialStopPromise = this.#prepareStopOutcome(
				session,
				signal,
				Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS),
			);
			const attachFailure: DapStartRequestFailure = { rejected: false };
			const attachPromise = trackDapStartRequest(
				client.sendRequest("attach", attachArguments, signal, timeoutMs),
				attachFailure,
			);
			attachPromise.catch(() => {});
			try {
				await this.#completeConfigurationHandshake(session, signal, timeoutMs);
			} catch (error) {
				await throwPreferredDapStartError("attach", attachFailure, error);
			}
			await attachPromise;
			try {
				await untilAborted(signal, initialStopPromise);
				if (session.status === "stopped") {
					await this.#fetchTopFrame(session, signal, Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS));
				}
			} catch {
				if (session.initializedSeen && session.status === "launching") {
					session.status = session.configurationDoneSent ? "running" : "configuring";
				}
			}
			return buildSummary(session);
		} catch (error) {
			await this.#disposeSession(session);
			const mapped = mapDebugpyMissingModule(options.adapter.name, error);
			if (mapped) throw mapped;
			throw error;
		}
	}

	/**
	 * Serialize breakpoint mutations per session: every mutator does a
	 * read-modify-write of session state around an await, and the adapter-side
	 * set*Breakpoints request replaces the whole list — concurrent mutations
	 * would silently drop each other's breakpoints on both sides.
	 */
	#serializeBreakpointMutation<T>(session: DapSession, mutate: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const run = session.breakpointMutationQueue.then(() => {
			// A mutation can sit behind several queued 30s predecessors; honor a
			// caller abort at dequeue instead of running a request nobody awaits.
			if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
			return mutate();
		});
		session.breakpointMutationQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async setBreakpoint(
		file: string,
		line: number,
		condition?: string,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	) {
		const session = this.#touchActiveSession();
		return this.#serializeBreakpointMutation(
			session,
			async () => {
				const sourcePath = normalizePath(file);
				const current = [...(session.breakpoints.get(sourcePath) ?? [])];
				const deduped = current.filter(entry => entry.line !== line);
				deduped.push({ verified: false, line, condition });
				deduped.sort((left, right) => left.line - right.line);
				const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
					session,
					"setBreakpoints",
					{
						source: { path: sourcePath, name: path.basename(sourcePath) },
						breakpoints: deduped.map<DapSourceBreakpoint>(entry => ({
							line: entry.line,
							...(entry.condition ? { condition: entry.condition } : {}),
						})),
					},
					signal,
					timeoutMs,
				);
				session.breakpoints.set(sourcePath, this.#mapSourceBreakpoints(deduped, response?.breakpoints));
				return {
					snapshot: buildSummary(session),
					breakpoints: session.breakpoints.get(sourcePath) ?? [],
					sourcePath,
				};
			},
			signal,
		);
	}

	async removeBreakpoint(file: string, line: number, signal?: AbortSignal, timeoutMs: number = 30_000) {
		const session = this.#touchActiveSession();
		return this.#serializeBreakpointMutation(
			session,
			async () => {
				const sourcePath = normalizePath(file);
				const current = [...(session.breakpoints.get(sourcePath) ?? [])].filter(entry => entry.line !== line);
				const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
					session,
					"setBreakpoints",
					{
						source: { path: sourcePath, name: path.basename(sourcePath) },
						breakpoints: current.map<DapSourceBreakpoint>(entry => ({
							line: entry.line,
							...(entry.condition ? { condition: entry.condition } : {}),
						})),
					},
					signal,
					timeoutMs,
				);
				if (current.length === 0) {
					session.breakpoints.delete(sourcePath);
				} else {
					session.breakpoints.set(sourcePath, this.#mapSourceBreakpoints(current, response?.breakpoints));
				}
				return {
					snapshot: buildSummary(session),
					breakpoints: session.breakpoints.get(sourcePath) ?? [],
					sourcePath,
				};
			},
			signal,
		);
	}

	async setFunctionBreakpoint(name: string, condition?: string, signal?: AbortSignal, timeoutMs: number = 30_000) {
		const session = this.#touchActiveSession();
		return this.#serializeBreakpointMutation(
			session,
			async () => {
				const current = session.functionBreakpoints.filter(entry => entry.name !== name);
				current.push({ verified: false, name, condition });
				current.sort((left, right) => left.name.localeCompare(right.name));
				const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
					session,
					"setFunctionBreakpoints",
					{
						breakpoints: current.map<DapFunctionBreakpoint>(entry => ({
							name: entry.name,
							...(entry.condition ? { condition: entry.condition } : {}),
						})),
					},
					signal,
					timeoutMs,
				);
				session.functionBreakpoints = this.#mapFunctionBreakpoints(current, response?.breakpoints);
				return { snapshot: buildSummary(session), breakpoints: session.functionBreakpoints };
			},
			signal,
		);
	}

	async removeFunctionBreakpoint(name: string, signal?: AbortSignal, timeoutMs: number = 30_000) {
		const session = this.#touchActiveSession();
		return this.#serializeBreakpointMutation(
			session,
			async () => {
				const current = session.functionBreakpoints.filter(entry => entry.name !== name);
				const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
					session,
					"setFunctionBreakpoints",
					{
						breakpoints: current.map<DapFunctionBreakpoint>(entry => ({
							name: entry.name,
							...(entry.condition ? { condition: entry.condition } : {}),
						})),
					},
					signal,
					timeoutMs,
				);
				session.functionBreakpoints = this.#mapFunctionBreakpoints(current, response?.breakpoints);
				return { snapshot: buildSummary(session), breakpoints: session.functionBreakpoints };
			},
			signal,
		);
	}

	async setInstructionBreakpoint(
		instructionReference: string,
		offset?: number,
		condition?: string,
		hitCondition?: string,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	) {
		const session = this.#touchActiveSession();
		return this.#serializeBreakpointMutation(
			session,
			async () => {
				const current = session.instructionBreakpoints.filter(
					entry => entry.instructionReference !== instructionReference || entry.offset !== offset,
				);
				current.push({ instructionReference, offset, condition, hitCondition });
				current.sort((left, right) => {
					const referenceOrder = left.instructionReference.localeCompare(right.instructionReference);
					if (referenceOrder !== 0) {
						return referenceOrder;
					}
					return (left.offset ?? 0) - (right.offset ?? 0);
				});
				const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
					session,
					"setInstructionBreakpoints",
					{
						breakpoints: current,
					} satisfies DapSetInstructionBreakpointsArguments,
					signal,
					timeoutMs,
				);
				session.instructionBreakpoints = current;
				return {
					snapshot: buildSummary(session),
					breakpoints: this.#mapInstructionBreakpoints(current, response?.breakpoints),
				};
			},
			signal,
		);
	}

	async removeInstructionBreakpoint(
		instructionReference: string,
		offset?: number,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	) {
		const session = this.#touchActiveSession();
		return this.#serializeBreakpointMutation(
			session,
			async () => {
				const current = session.instructionBreakpoints.filter(entry => {
					if (entry.instructionReference !== instructionReference) {
						return true;
					}
					if (offset === undefined) {
						return false;
					}
					return entry.offset !== offset;
				});
				const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
					session,
					"setInstructionBreakpoints",
					{
						breakpoints: current,
					} satisfies DapSetInstructionBreakpointsArguments,
					signal,
					timeoutMs,
				);
				session.instructionBreakpoints = current;
				return {
					snapshot: buildSummary(session),
					breakpoints: this.#mapInstructionBreakpoints(current, response?.breakpoints),
				};
			},
			signal,
		);
	}

	async dataBreakpointInfo(
		name: string,
		variablesReference?: number,
		frameId?: number,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; info: DapDataBreakpointInfoResponse }> {
		const session = this.#touchActiveSession();
		const info = await this.#sendRequestWithConfig<DapDataBreakpointInfoResponse>(
			session,
			"dataBreakpointInfo",
			{
				name,
				...(variablesReference !== undefined ? { variablesReference } : {}),
				...(frameId !== undefined ? { frameId } : {}),
			} satisfies DapDataBreakpointInfoArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), info };
	}

	async setDataBreakpoint(
		dataId: string,
		accessType?: "read" | "write" | "readWrite",
		condition?: string,
		hitCondition?: string,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	) {
		const session = this.#touchActiveSession();
		return this.#serializeBreakpointMutation(
			session,
			async () => {
				const current = session.dataBreakpoints.filter(entry => entry.dataId !== dataId);
				current.push({ dataId, accessType, condition, hitCondition });
				current.sort((left, right) => left.dataId.localeCompare(right.dataId));
				const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
					session,
					"setDataBreakpoints",
					{
						breakpoints: current,
					} satisfies DapSetDataBreakpointsArguments,
					signal,
					timeoutMs,
				);
				session.dataBreakpoints = current;
				return {
					snapshot: buildSummary(session),
					breakpoints: this.#mapDataBreakpoints(current, response?.breakpoints),
				};
			},
			signal,
		);
	}

	async removeDataBreakpoint(dataId: string, signal?: AbortSignal, timeoutMs: number = 30_000) {
		const session = this.#touchActiveSession();
		return this.#serializeBreakpointMutation(
			session,
			async () => {
				const current = session.dataBreakpoints.filter(entry => entry.dataId !== dataId);
				const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
					session,
					"setDataBreakpoints",
					{
						breakpoints: current,
					} satisfies DapSetDataBreakpointsArguments,
					signal,
					timeoutMs,
				);
				session.dataBreakpoints = current;
				return {
					snapshot: buildSummary(session),
					breakpoints: this.#mapDataBreakpoints(current, response?.breakpoints),
				};
			},
			signal,
		);
	}

	async disassemble(
		memoryReference: string,
		instructionCount: number,
		offset?: number,
		instructionOffset?: number,
		resolveSymbols?: boolean,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; instructions: DapDisassembledInstruction[] }> {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapDisassembleResponse>(
			session,
			"disassemble",
			{
				memoryReference,
				instructionCount,
				...(offset !== undefined ? { offset } : {}),
				...(instructionOffset !== undefined ? { instructionOffset } : {}),
				...(resolveSymbols !== undefined ? { resolveSymbols } : {}),
			} satisfies DapDisassembleArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), instructions: response?.instructions ?? [] };
	}

	async readMemory(
		memoryReference: string,
		count: number,
		offset?: number,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; address: string; data?: string; unreadableBytes?: number }> {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapReadMemoryResponse>(
			session,
			"readMemory",
			{
				memoryReference,
				count,
				...(offset !== undefined ? { offset } : {}),
			} satisfies DapReadMemoryArguments,
			signal,
			timeoutMs,
		);
		return {
			snapshot: buildSummary(session),
			address: response?.address ?? memoryReference,
			data: response?.data,
			unreadableBytes: response?.unreadableBytes,
		};
	}

	async writeMemory(
		memoryReference: string,
		data: string,
		offset?: number,
		allowPartial?: boolean,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; offset?: number; bytesWritten?: number }> {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapWriteMemoryResponse>(
			session,
			"writeMemory",
			{
				memoryReference,
				data,
				...(offset !== undefined ? { offset } : {}),
				...(allowPartial !== undefined ? { allowPartial } : {}),
			} satisfies DapWriteMemoryArguments,
			signal,
			timeoutMs,
		);
		return {
			snapshot: buildSummary(session),
			offset: response?.offset,
			bytesWritten: response?.bytesWritten,
		};
	}

	async modules(
		startModule?: number,
		moduleCount?: number,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; modules: DapModule[] }> {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapModulesResponse>(
			session,
			"modules",
			{
				...(startModule !== undefined ? { startModule } : {}),
				...(moduleCount !== undefined ? { moduleCount } : {}),
			} satisfies DapModulesArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), modules: response?.modules ?? [] };
	}

	async loadedSources(
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; sources: DapSource[] }> {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapLoadedSourcesResponse>(
			session,
			"loadedSources",
			{},
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), sources: response?.sources ?? [] };
	}

	async customRequest(
		command: string,
		args?: Record<string, unknown>,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; body: unknown }> {
		const session = this.#touchActiveSession();
		const body = await this.#sendRequestWithConfig<unknown>(session, command, args, signal, timeoutMs);
		return { snapshot: buildSummary(session), body };
	}

	async continue(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapContinueOutcome> {
		const session = this.#touchActiveSession();
		const threadId = await this.#resolveThreadId(session, signal, timeoutMs);
		// Reset state and subscribe BEFORE sending continue to avoid missing
		// events that arrive in the same buffer as the response.
		session.stop = {};
		session.lastStackFrames = [];
		session.status = "running";
		const outcomePromise = this.#prepareStopOutcome(session, signal, timeoutMs);
		await this.#sendRequestWithConfig<DapContinueResponse>(
			session,
			"continue",
			{ threadId } satisfies DapContinueArguments,
			signal,
			timeoutMs,
		);
		return this.#awaitStopOutcome(session, outcomePromise, signal, timeoutMs);
	}

	async pause(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapSessionSummary> {
		const session = this.#touchActiveSession();
		// status is mutated by the event reader between awaits; check through a
		// closure so TS does not carry stale narrowing from the early return.
		const isStopped = () => session.status === "stopped";
		if (isStopped()) {
			return buildSummary(session);
		}
		const threadId = await this.#resolveThreadId(session, signal, timeoutMs);
		// Subscribe BEFORE sending pause: the stopped event can arrive in the
		// same chunk as the response and would otherwise be dispatched before
		// the waiter subscribes, burning the whole timeout.
		const stoppedPromise = session.client.waitForEvent<DapStoppedEventBody>("stopped", undefined, signal, timeoutMs);
		stoppedPromise.catch(() => {});
		await this.#sendRequestWithConfig(session, "pause", { threadId } satisfies DapPauseArguments, signal, timeoutMs);
		if (!isStopped()) {
			try {
				await untilAborted(signal, stoppedPromise);
			} catch {
				// Timeout or abort — report current state regardless
			}
		}
		return buildSummary(session);
	}

	async stepIn(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapContinueOutcome> {
		return this.#step("stepIn", signal, timeoutMs);
	}

	async stepOut(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapContinueOutcome> {
		return this.#step("stepOut", signal, timeoutMs);
	}

	async stepOver(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapContinueOutcome> {
		return this.#step("next", signal, timeoutMs);
	}

	async threads(
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; threads: DapThread[] }> {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapThreadsResponse>(
			session,
			"threads",
			undefined,
			signal,
			timeoutMs,
		);
		session.threads = response?.threads ?? [];
		return { snapshot: buildSummary(session), threads: session.threads };
	}

	async stackTrace(
		frameCount: number | undefined,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<{ snapshot: DapSessionSummary; stackFrames: DapStackFrame[]; totalFrames?: number }> {
		const session = this.#touchActiveSession();
		const threadId = await this.#resolveThreadId(session, signal, timeoutMs);
		const response = await this.#sendRequestWithConfig<DapStackTraceResponse>(
			session,
			"stackTrace",
			{
				threadId,
				...(frameCount !== undefined ? { levels: frameCount } : {}),
			} satisfies DapStackTraceArguments,
			signal,
			timeoutMs,
		);
		session.lastStackFrames = response?.stackFrames ?? [];
		this.#applyTopFrame(session, session.lastStackFrames[0]);
		return {
			snapshot: buildSummary(session),
			stackFrames: session.lastStackFrames,
			totalFrames: response?.totalFrames,
		};
	}

	async scopes(frameId: number | undefined, signal?: AbortSignal, timeoutMs: number = 30_000) {
		const session = this.#touchActiveSession();
		const resolvedFrameId = frameId ?? session.stop.frameId;
		if (resolvedFrameId === undefined) {
			throw new Error("No active stack frame. Run stack_trace first or supply frame_id.");
		}
		const response = await this.#sendRequestWithConfig<DapScopesResponse>(
			session,
			"scopes",
			{ frameId: resolvedFrameId } satisfies DapScopesArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), scopes: response?.scopes ?? [] };
	}

	async variables(variableReference: number, signal?: AbortSignal, timeoutMs: number = 30_000) {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapVariablesResponse>(
			session,
			"variables",
			{ variablesReference: variableReference } satisfies DapVariablesArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), variables: response?.variables ?? [] };
	}

	async evaluate(
		expression: string,
		context: DapEvaluateArguments["context"],
		frameId: number | undefined,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	) {
		const session = this.#touchActiveSession();
		// Default to the top stopped frame so callers don't need to pass
		// frame_id explicitly for the common case.
		const effectiveFrameId = frameId ?? session.stop.frameId;
		const response = await this.#sendRequestWithConfig<DapEvaluateResponse>(
			session,
			"evaluate",
			{
				expression,
				context,
				...(effectiveFrameId !== undefined ? { frameId: effectiveFrameId } : {}),
			} satisfies DapEvaluateArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), evaluation: response };
	}

	getOutput(limitBytes?: number): DapOutputSnapshot {
		const session = this.#touchActiveSession();
		const output = session.outputChunks.join("");
		if (!limitBytes || limitBytes <= 0 || session.outputBufferedBytes <= limitBytes) {
			return { snapshot: buildSummary(session), output };
		}
		// Byte-slice the tail once; a torn code point at the cut decodes as U+FFFD.
		const buffer = Buffer.from(output, "utf-8");
		if (buffer.length <= limitBytes) {
			return { snapshot: buildSummary(session), output };
		}
		return { snapshot: buildSummary(session), output: buffer.subarray(buffer.length - limitBytes).toString("utf-8") };
	}

	async terminate(signal?: AbortSignal, timeoutMs: number = 30_000): Promise<DapSessionSummary | null> {
		const session = this.#getActiveSessionOrNull();
		if (!session) return null;
		session.lastUsedAt = Date.now();
		if (session.status !== "terminated") {
			if (session.capabilities?.supportsTerminateRequest) {
				await untilAborted(
					signal,
					session.client.sendRequest("terminate", undefined, signal, timeoutMs).catch(() => undefined),
				);
			}
			await untilAborted(
				signal,
				session.client
					.sendRequest("disconnect", { terminateDebuggee: true }, signal, timeoutMs)
					.catch(() => undefined),
			);
		}
		session.status = "terminated";
		const summary = buildSummary(session);
		await this.#disposeSession(session);
		return summary;
	}

	#startCleanupTimer(): void {
		if (this.#cleanupLoopPromise) return;
		this.#cleanupLoopPromise = this.#runCleanupLoop();
	}

	async #runCleanupLoop(): Promise<void> {
		for await (const _ of timers.setInterval(CLEANUP_INTERVAL_MS, null, { ref: false })) {
			try {
				this.#cleanupIdleSessions();
			} catch (error) {
				logger.error("DAP idle session cleanup failed", { error: toErrorMessage(error) });
			}
		}
	}

	#cleanupIdleSessions(): void {
		if (this.#sessions.size === 0) return;
		const now = Date.now();
		for (const session of this.#sessions.values()) {
			if (
				session.status === "terminated" ||
				now - session.lastUsedAt > IDLE_TIMEOUT_MS ||
				!session.client.isAlive()
			) {
				this.#disposeSession(session);
			}
		}
	}

	async #ensureLaunchSlot(): Promise<void> {
		const active = this.#getActiveSessionOrNull();
		if (!active) return;
		if (active.status === "terminated" || !active.client.isAlive()) {
			await this.#disposeSession(active);
			return;
		}
		throw new Error(`Debug session ${active.id} is still active. Terminate it before launching another.`);
	}

	#registerSession(client: DapClient, adapter: DapResolvedAdapter, cwd: string, program?: string): DapSession {
		const session: DapSession = {
			id: `debug-${++this.#nextId}`,
			adapter,
			cwd,
			program,
			client,
			status: "launching",
			launchedAt: Date.now(),
			lastUsedAt: Date.now(),
			breakpoints: new Map(),
			functionBreakpoints: [],
			instructionBreakpoints: [],
			dataBreakpoints: [],
			breakpointMutationQueue: Promise.resolve(),
			outputChunks: [],
			outputBytes: 0,
			outputBufferedBytes: 0,
			outputTruncated: false,
			stop: {},
			threads: [],
			lastStackFrames: [],
			initializedSeen: false,
			needsConfigurationDone: false,
			configurationDoneSent: false,
		};
		client.onReverseRequest("runInTerminal", async rawArgs => {
			const args = (rawArgs ?? {}) as DapRunInTerminalArguments;
			if (!Array.isArray(args.args) || args.args.length === 0) {
				throw new Error("runInTerminal request did not include a command");
			}
			const env = Object.fromEntries(
				Object.entries(args.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
			);
			const proc = ptree.spawn(args.args, {
				cwd: args.cwd ?? session.cwd,
				stdin: "pipe",
				env: {
					...Bun.env,
					...NON_INTERACTIVE_ENV,
					...env,
				},
				detached: true,
			});
			return { processId: proc.pid } satisfies DapRunInTerminalResponse;
		});
		client.onReverseRequest("startDebugging", async rawArgs => {
			const startArgs = (rawArgs ?? {}) as Partial<DapStartDebuggingArguments>;
			const request = startArgs.request === "attach" ? "attach" : "launch";
			const configuration =
				startArgs.configuration && typeof startArgs.configuration === "object" ? startArgs.configuration : {};
			logger.debug("Adapter requested child debug session", {
				adapter: session.adapter.name,
				sessionId: session.id,
				request,
				name: typeof configuration.name === "string" ? configuration.name : undefined,
			});
			return {};
		});
		client.onEvent("output", body => {
			truncateOutput(session, (body as DapOutputEventBody | undefined)?.output ?? "");
		});
		client.onEvent("initialized", () => {
			session.initializedSeen = true;
			session.status = session.configurationDoneSent ? session.status : "configuring";
		});
		client.onEvent("stopped", body => {
			this.#handleStoppedEvent(session, body as DapStoppedEventBody);
		});
		client.onEvent("continued", body => {
			const continued = body as { threadId?: number } | undefined;
			session.status = "running";
			session.stop = { threadId: continued?.threadId };
			session.lastStackFrames = [];
		});
		client.onEvent("exited", body => {
			session.exitCode = (body as DapExitedEventBody | undefined)?.exitCode;
		});
		client.onEvent("terminated", () => {
			session.status = "terminated";
		});
		this.#sessions.set(session.id, session);
		this.#activeSessionId = session.id;
		const heartbeat = setInterval(() => {
			if (!client.isAlive()) {
				session.status = "terminated";
			}
		}, HEARTBEAT_INTERVAL_MS);
		heartbeat.unref?.();
		client.proc.exited.finally(() => clearInterval(heartbeat));
		return session;
	}

	#buildInitializeArguments(adapter: DapResolvedAdapter): DapInitializeArguments {
		return {
			clientID: "omp",
			clientName: "Oh My Pi",
			adapterID: adapter.name,
			locale: "en-US",
			linesStartAt1: true,
			columnsStartAt1: true,
			pathFormat: "path",
			supportsRunInTerminalRequest: true,
			supportsStartDebuggingRequest: true,
			supportsMemoryReferences: true,
			supportsVariableType: true,
			supportsInvalidatedEvent: true,
		};
	}

	/**
	 * Wait for the adapter's `initialized` event (if not already received),
	 * then send `configurationDone`. Many adapters block the `launch`/`attach`
	 * response until this handshake completes.
	 */
	async #completeConfigurationHandshake(
		session: DapSession,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<void> {
		if (!session.needsConfigurationDone || session.configurationDoneSent) {
			return;
		}
		// Wait for the initialized event if we haven't seen it yet.
		if (!session.initializedSeen) {
			try {
				await untilAborted(signal, session.client.waitForEvent("initialized", undefined, signal, timeoutMs));
			} catch {
				// Adapter may not send initialized (e.g. it already terminated).
				// Proceed anyway — the launch/attach response will surface any real error.
				return;
			}
		}
		await session.client.sendRequest("configurationDone", {}, signal, timeoutMs);
		session.configurationDoneSent = true;
		if (session.status === "configuring") {
			session.status = "running";
		}
	}

	#handleStoppedEvent(session: DapSession, stopped: DapStoppedEventBody): void {
		session.status = "stopped";
		session.stop = {
			threadId: stopped.threadId,
			reason: stopped.reason,
			description: stopped.description,
			text: stopped.text,
		};
		session.lastStackFrames = [];
	}

	#applyTopFrame(session: DapSession, frame: DapStackFrame | undefined): void {
		if (!frame) return;
		session.stop.frameId = frame.id;
		session.stop.frameName = frame.name;
		session.stop.instructionPointerReference = frame.instructionPointerReference;
		session.stop.source = frame.source;
		session.stop.line = frame.line;
		session.stop.column = frame.column;
	}

	/**
	 * Fetch the top stack frame from the adapter and apply it to the session's
	 * stop location. Called outside the event dispatch loop to avoid deadlocking
	 * the message reader.
	 */
	async #fetchTopFrame(session: DapSession, signal?: AbortSignal, timeoutMs: number = 5_000): Promise<void> {
		if (session.stop.threadId === undefined) return;
		try {
			const response = await session.client.sendRequest<DapStackTraceResponse>(
				"stackTrace",
				{ threadId: session.stop.threadId, levels: 1 } satisfies DapStackTraceArguments,
				signal,
				timeoutMs,
			);
			session.lastStackFrames = response?.stackFrames ?? [];
			this.#applyTopFrame(session, session.lastStackFrames[0]);
		} catch (error) {
			logger.debug("Failed to capture stopped frame", {
				sessionId: session.id,
				error: toErrorMessage(error),
			});
		}
	}

	async #step(command: "stepIn" | "stepOut" | "next", signal?: AbortSignal, timeoutMs: number = 30_000) {
		const session = this.#touchActiveSession();
		const threadId = await this.#resolveThreadId(session, signal, timeoutMs);
		// Reset state and subscribe BEFORE sending the step command to avoid
		// missing events that arrive in the same buffer as the response.
		session.stop = {};
		session.lastStackFrames = [];
		session.status = "running";
		const outcomePromise = this.#prepareStopOutcome(session, signal, timeoutMs);
		await this.#sendRequestWithConfig(session, command, { threadId } satisfies DapStepArguments, signal, timeoutMs);
		return this.#awaitStopOutcome(session, outcomePromise, signal, timeoutMs);
	}

	/**
	 * Create a promise that resolves when the session stops, terminates, or exits.
	 * MUST be called before the command that triggers the event.
	 */
	#prepareStopOutcome(session: DapSession, signal?: AbortSignal, timeoutMs: number = 30_000): Promise<unknown> {
		const promises = [
			session.client.waitForEvent("stopped", undefined, signal, timeoutMs),
			session.client.waitForEvent("terminated", undefined, signal, timeoutMs),
			session.client.waitForEvent("exited", undefined, signal, timeoutMs),
		];
		// Promise.race leaves the losing waiters pending; their timeouts would
		// otherwise surface as unhandled rejections once they fire.
		for (const p of promises) {
			p.catch(() => {});
		}
		const outcome = Promise.race(promises);
		outcome.catch(() => {});
		return outcome;
	}

	/**
	 * Await a pre-subscribed stop outcome, then fetch the top frame if stopped.
	 */
	async #awaitStopOutcome(
		session: DapSession,
		outcomePromise: Promise<unknown>,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<DapContinueOutcome> {
		try {
			await untilAborted(signal, outcomePromise);
			if (session.status === "stopped") {
				await this.#fetchTopFrame(session, signal, Math.min(timeoutMs, 5_000));
			}
			const state =
				session.status === "stopped" ? "stopped" : session.status === "terminated" ? "terminated" : "running";
			return { snapshot: buildSummary(session), state, timedOut: false };
		} catch (error) {
			if (signal?.aborted) {
				throw error;
			}
			return { snapshot: buildSummary(session), state: "running", timedOut: session.status === "running" };
		}
	}

	async #resolveThreadId(session: DapSession, signal?: AbortSignal, timeoutMs: number = 30_000): Promise<number> {
		if (session.stop.threadId !== undefined) {
			return session.stop.threadId;
		}
		if (session.threads.length > 0) {
			return session.threads[0].id;
		}
		const response = await session.client.sendRequest<DapThreadsResponse>("threads", undefined, signal, timeoutMs);
		session.threads = response?.threads ?? [];
		const threadId = session.threads[0]?.id;
		if (threadId === undefined) {
			throw new Error("Debugger reported no threads.");
		}
		return threadId;
	}

	async #sendRequestWithConfig<TBody>(
		session: DapSession,
		command: string,
		args: unknown,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<TBody> {
		await this.#ensureConfigurationDone(session, signal, timeoutMs);
		const body = await session.client.sendRequest<TBody>(command, args, signal, timeoutMs);
		session.lastUsedAt = Date.now();
		return body;
	}

	async #ensureConfigurationDone(
		session: DapSession,
		signal?: AbortSignal,
		timeoutMs: number = 30_000,
	): Promise<void> {
		if (!session.needsConfigurationDone || session.configurationDoneSent) {
			return;
		}
		await session.client.sendRequest("configurationDone", {}, signal, timeoutMs);
		session.configurationDoneSent = true;
		if (session.status === "configuring") {
			session.status = "running";
		}
	}

	#mapSourceBreakpoints(
		input: DapBreakpointRecord[],
		responseBreakpoints: DapBreakpoint[] | undefined,
	): DapBreakpointRecord[] {
		return input.map((entry, index) => ({
			line: entry.line,
			condition: entry.condition,
			id: responseBreakpoints?.[index]?.id,
			verified: responseBreakpoints?.[index]?.verified ?? false,
			message: responseBreakpoints?.[index]?.message,
		}));
	}

	#mapFunctionBreakpoints(
		input: DapFunctionBreakpointRecord[],
		responseBreakpoints: DapBreakpoint[] | undefined,
	): DapFunctionBreakpointRecord[] {
		return input.map((entry, index) => ({
			name: entry.name,
			condition: entry.condition,
			id: responseBreakpoints?.[index]?.id,
			verified: responseBreakpoints?.[index]?.verified ?? false,
			message: responseBreakpoints?.[index]?.message,
		}));
	}

	#mapInstructionBreakpoints(
		input: DapInstructionBreakpoint[],
		responseBreakpoints: DapBreakpoint[] | undefined,
	): DapInstructionBreakpointRecord[] {
		return input.map((entry, index) => ({
			instructionReference: responseBreakpoints?.[index]?.instructionReference ?? entry.instructionReference,
			offset: responseBreakpoints?.[index]?.offset ?? entry.offset,
			condition: entry.condition,
			hitCondition: entry.hitCondition,
			id: responseBreakpoints?.[index]?.id,
			verified: responseBreakpoints?.[index]?.verified ?? false,
			message: responseBreakpoints?.[index]?.message,
		}));
	}

	#mapDataBreakpoints(
		input: DapDataBreakpoint[],
		responseBreakpoints: DapBreakpoint[] | undefined,
	): DapDataBreakpointRecord[] {
		return input.map((entry, index) => ({
			dataId: entry.dataId,
			accessType: entry.accessType,
			condition: entry.condition,
			hitCondition: entry.hitCondition,
			id: responseBreakpoints?.[index]?.id,
			verified: responseBreakpoints?.[index]?.verified ?? false,
			message: responseBreakpoints?.[index]?.message,
		}));
	}

	#touchActiveSession(): DapSession {
		const session = this.#getActiveSessionOrThrow();
		session.lastUsedAt = Date.now();
		if (session.status !== "terminated" && !session.client.isAlive()) {
			session.status = "terminated";
		}
		return session;
	}

	#getActiveSessionOrNull(): DapSession | null {
		if (!this.#activeSessionId) {
			return null;
		}
		const session = this.#sessions.get(this.#activeSessionId) ?? null;
		if (!session) {
			this.#activeSessionId = null;
		}
		return session;
	}

	#getActiveSessionOrThrow(): DapSession {
		const session = this.#getActiveSessionOrNull();
		if (!session) {
			throw new Error("No active debug session. Launch or attach first.");
		}
		return session;
	}

	#disposeSession(session: DapSession) {
		if (this.#activeSessionId === session.id) {
			this.#activeSessionId = null;
		}
		this.#sessions.delete(session.id);
		void session.client.dispose().catch(() => {});
	}
}

export const dapSessionManager = new DapSessionManager();
