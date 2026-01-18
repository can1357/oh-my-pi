import stripAnsi from "strip-ansi";
import { sanitizeBinaryOutput } from "../utils/shell";
import { logger } from "./logger";
import {
	checkPythonKernelAvailability,
	type KernelDisplayOutput,
	type KernelExecuteOptions,
	type KernelExecuteResult,
	type PreludeHelper,
	PythonKernel,
} from "./python-kernel";
import { createOutputSink } from "./streaming-output";
import { DEFAULT_MAX_BYTES } from "./tools/truncate";

export type PythonKernelMode = "session" | "per-call";

export interface PythonExecutorOptions {
	/** Working directory for command execution */
	cwd?: string;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Session identifier for kernel reuse */
	sessionId?: string;
	/** Kernel mode (session reuse vs per-call) */
	kernelMode?: PythonKernelMode;
	/** Restart the kernel before executing */
	reset?: boolean;
	/** Use shared gateway across pi instances (default: true) */
	useSharedGateway?: boolean;
}

export interface PythonKernelExecutor {
	execute: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>;
}

export interface PythonResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Execution exit code (0 ok, 1 error, undefined if cancelled) */
	exitCode: number | undefined;
	/** Whether the execution was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
	/** Rich display outputs captured from display_data/execute_result */
	displayOutputs: KernelDisplayOutput[];
	/** Whether stdin was requested */
	stdinRequested: boolean;
}

interface KernelSession {
	id: string;
	kernel: PythonKernel;
	queue: Promise<void>;
	restartCount: number;
	dead: boolean;
	lastUsedAt: number;
	heartbeatTimer?: NodeJS.Timeout;
}

const kernelSessions = new Map<string, KernelSession>();
let cachedPreludeDocs: PreludeHelper[] | null = null;

export async function disposeAllKernelSessions(): Promise<void> {
	const sessions = Array.from(kernelSessions.values());
	await Promise.allSettled(sessions.map((session) => disposeKernelSession(session)));
}

function sanitizeChunk(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, "");
}

async function ensureKernelAvailable(cwd: string): Promise<void> {
	const availability = await checkPythonKernelAvailability(cwd);
	if (!availability.ok) {
		throw new Error(availability.reason ?? "Python kernel unavailable");
	}
}

export async function warmPythonEnvironment(
	cwd: string,
	sessionId?: string,
	useSharedGateway?: boolean,
): Promise<{ ok: boolean; reason?: string; docs: PreludeHelper[] }> {
	try {
		await ensureKernelAvailable(cwd);
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		cachedPreludeDocs = [];
		return { ok: false, reason, docs: [] };
	}
	if (cachedPreludeDocs && cachedPreludeDocs.length > 0) {
		return { ok: true, docs: cachedPreludeDocs };
	}
	const resolvedSessionId = sessionId ?? `session:${cwd}`;
	try {
		const docs = await withKernelSession(
			resolvedSessionId,
			cwd,
			async (kernel) => kernel.introspectPrelude(),
			useSharedGateway,
		);
		cachedPreludeDocs = docs;
		return { ok: true, docs };
	} catch (err: unknown) {
		const reason = err instanceof Error ? err.message : String(err);
		cachedPreludeDocs = [];
		return { ok: false, reason, docs: [] };
	}
}

export function getPreludeDocs(): PreludeHelper[] {
	return cachedPreludeDocs ?? [];
}

async function createKernelSession(sessionId: string, cwd: string, useSharedGateway?: boolean): Promise<KernelSession> {
	const kernel = await PythonKernel.start({ cwd, useSharedGateway });
	const session: KernelSession = {
		id: sessionId,
		kernel,
		queue: Promise.resolve(),
		restartCount: 0,
		dead: false,
		lastUsedAt: Date.now(),
	};

	session.heartbeatTimer = setInterval(async () => {
		if (session.dead) return;
		const ok = await session.kernel.ping().catch(() => false);
		if (!ok) {
			session.dead = true;
		}
	}, 5000);

	return session;
}

async function restartKernelSession(session: KernelSession, cwd: string, useSharedGateway?: boolean): Promise<void> {
	session.restartCount += 1;
	if (session.restartCount > 1) {
		throw new Error("Python kernel restarted too many times in this session");
	}
	try {
		await session.kernel.shutdown();
	} catch (err) {
		logger.warn("Failed to shutdown crashed kernel", { error: err instanceof Error ? err.message : String(err) });
	}
	const kernel = await PythonKernel.start({ cwd, useSharedGateway });
	session.kernel = kernel;
	session.dead = false;
	session.lastUsedAt = Date.now();
}

async function disposeKernelSession(session: KernelSession): Promise<void> {
	if (session.heartbeatTimer) {
		clearInterval(session.heartbeatTimer);
	}
	try {
		await session.kernel.shutdown();
	} catch (err) {
		logger.warn("Failed to shutdown kernel", { error: err instanceof Error ? err.message : String(err) });
	}
	kernelSessions.delete(session.id);
}

async function withKernelSession<T>(
	sessionId: string,
	cwd: string,
	handler: (kernel: PythonKernel) => Promise<T>,
	useSharedGateway?: boolean,
): Promise<T> {
	let session = kernelSessions.get(sessionId);
	if (!session) {
		session = await createKernelSession(sessionId, cwd, useSharedGateway);
		kernelSessions.set(sessionId, session);
	}

	const run = async (): Promise<T> => {
		session!.lastUsedAt = Date.now();
		if (session!.dead || !session!.kernel.isAlive()) {
			await restartKernelSession(session!, cwd, useSharedGateway);
		}
		try {
			const result = await handler(session!.kernel);
			session!.restartCount = 0;
			return result;
		} catch (err) {
			if (!session!.dead && session!.kernel.isAlive()) {
				throw err;
			}
			await restartKernelSession(session!, cwd, useSharedGateway);
			const result = await handler(session!.kernel);
			session!.restartCount = 0;
			return result;
		}
	};

	const task = session.queue.then(run, run);
	session.queue = task.then(
		() => undefined,
		() => undefined,
	);
	return task;
}

async function executeWithKernel(
	kernel: PythonKernelExecutor,
	code: string,
	options: PythonExecutorOptions | undefined,
): Promise<PythonResult> {
	const sink = createOutputSink(DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES * 2, options?.onChunk);
	const writer = sink.getWriter();
	const displayOutputs: KernelDisplayOutput[] = [];

	try {
		const result = await kernel.execute(code, {
			signal: options?.signal,
			timeoutMs: options?.timeout,
			onChunk: async (text) => {
				await writer.write(sanitizeChunk(text));
			},
			onDisplay: async (output) => {
				displayOutputs.push(output);
			},
		});

		if (result.cancelled) {
			const secs = options?.timeout ? Math.round(options.timeout / 1000) : undefined;
			const annotation =
				result.timedOut && secs !== undefined ? `Command timed out after ${secs} seconds` : undefined;
			return {
				exitCode: undefined,
				cancelled: true,
				displayOutputs,
				stdinRequested: result.stdinRequested,
				...sink.dump(annotation),
			};
		}

		if (result.stdinRequested) {
			return {
				exitCode: 1,
				cancelled: false,
				displayOutputs,
				stdinRequested: true,
				...sink.dump("Kernel requested stdin; interactive input is not supported."),
			};
		}

		const exitCode = result.status === "ok" ? 0 : 1;
		return {
			exitCode,
			cancelled: false,
			displayOutputs,
			stdinRequested: false,
			...sink.dump(),
		};
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		logger.error("Python execution failed", { error: error.message });
		throw error;
	} finally {
		await writer.close();
	}
}

export async function executePythonWithKernel(
	kernel: PythonKernelExecutor,
	code: string,
	options?: PythonExecutorOptions,
): Promise<PythonResult> {
	return await executeWithKernel(kernel, code, options);
}

export async function executePython(code: string, options?: PythonExecutorOptions): Promise<PythonResult> {
	const cwd = options?.cwd ?? process.cwd();
	await ensureKernelAvailable(cwd);

	const kernelMode = options?.kernelMode ?? "session";
	const useSharedGateway = options?.useSharedGateway;
	if (kernelMode === "per-call") {
		const kernel = await PythonKernel.start({ cwd, useSharedGateway });
		try {
			return await executeWithKernel(kernel, code, options);
		} finally {
			await kernel.shutdown();
		}
	}

	const sessionId = options?.sessionId ?? `session:${cwd}`;
	if (options?.reset) {
		const existing = kernelSessions.get(sessionId);
		if (existing) {
			await disposeKernelSession(existing);
		}
	}
	return await withKernelSession(
		sessionId,
		cwd,
		async (kernel) => executeWithKernel(kernel, code, options),
		useSharedGateway,
	);
}
