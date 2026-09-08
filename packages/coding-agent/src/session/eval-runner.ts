import type { Agent } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { disposeVmContextsByOwner } from "../eval/js/context-manager";
import { namespaceSessionId as namespacePythonSessionId } from "../eval/py";
import {
	disposeKernelSessionsByOwner,
	executePython as executePythonCommand,
	type PythonResult,
} from "../eval/py/executor";
import { defaultEvalSessionId } from "../eval/session-id";
import type { ExtensionRunner } from "../extensibility/extensions";
import { outputMeta } from "../tools/output-meta";
import type { PythonExecutionMessage } from "./messages";
import type { SessionManager } from "./session-manager";

/** Capabilities the eval runner borrows from its owning session. */
export interface EvalRunnerHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	extensionRunner(): ExtensionRunner | undefined;
	isStreaming(): boolean;
	appendSessionMessage(message: PythonExecutionMessage): void;
}

/** Owns user-initiated Python execution and retained eval-kernel lifecycle. */
export class EvalRunner {
	readonly #host: EvalRunnerHost;
	readonly #kernelOwnerId: string;
	readonly #parentSessionId: string | undefined;
	#abortControllers = new Set<AbortController>();
	#pendingMessages: PythonExecutionMessage[] = [];
	#activeExecutions = new Set<Promise<unknown>>();
	#disposing = false;

	constructor(host: EvalRunnerHost, options: { kernelOwnerId: string; parentSessionId: string | undefined }) {
		this.#host = host;
		this.#kernelOwnerId = options.kernelOwnerId;
		this.#parentSessionId = options.parentSessionId;
	}

	/** Executes Python in the session's shared kernel. */
	async executePython(
		code: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean },
	): Promise<PythonResult> {
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.#host.sessionManager.getCwd();
		this.assertExecutionAllowed();
		const abortController = new AbortController();
		const execution = (async (): Promise<PythonResult> => {
			const extensionRunner = this.#host.extensionRunner();
			if (extensionRunner?.hasHandlers("user_python")) {
				const hookResult = await extensionRunner.emitUserPython({
					type: "user_python",
					code,
					excludeFromContext,
					cwd,
				});
				this.assertExecutionAllowed();
				if (hookResult?.result) {
					this.recordPythonResult(code, hookResult.result, options);
					return hookResult.result;
				}
			}
			const sessionId =
				this.getSessionId() ??
				defaultEvalSessionId({
					cwd,
					getSessionFile: () => this.#host.sessionManager.getSessionFile() ?? null,
				});
			const result = await executePythonCommand(code, {
				cwd,
				sessionId: namespacePythonSessionId(sessionId),
				kernelOwnerId: this.#kernelOwnerId,
				kernelMode: this.#host.settings.get("python.kernelMode"),
				interpreter: this.#host.settings.get("python.interpreter")?.trim() || undefined,
				onChunk,
				signal: abortController.signal,
			});
			this.recordPythonResult(code, result, options);
			return result;
		})();
		return await this.trackExecution(execution, abortController);
	}

	/** Rejects new eval work once session disposal begins. */
	assertExecutionAllowed(): void {
		if (this.#disposing) throw new Error("Python execution is unavailable while session disposal is in progress");
	}

	/** Tracks externally started Python work so disposal can await and abort it. */
	trackExecution<T>(execution: Promise<T>, abortController: AbortController): Promise<T> {
		this.#abortControllers.add(abortController);
		this.#activeExecutions.add(execution);
		void execution.then(
			() => {
				this.#abortControllers.delete(abortController);
				this.#activeExecutions.delete(execution);
			},
			() => {
				this.#abortControllers.delete(abortController);
				this.#activeExecutions.delete(execution);
			},
		);
		return execution;
	}

	/** Records a Python execution result in session history. */
	recordPythonResult(code: string, result: PythonResult, options?: { excludeFromContext?: boolean }): void {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		const message: PythonExecutionMessage = {
			role: "pythonExecution",
			code,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};
		if (this.#host.isStreaming()) {
			this.#pendingMessages.push(message);
		} else {
			this.#host.appendSessionMessage(message);
		}
	}

	/** Cancels every running Python execution. */
	abort(): void {
		for (const abortController of this.#abortControllers) abortController.abort();
	}

	/** Whether a Python execution is currently running. */
	get isRunning(): boolean {
		return this.#abortControllers.size > 0;
	}

	/** Whether Python results are waiting for a safe persistence boundary. */
	get hasPendingMessages(): boolean {
		return this.#pendingMessages.length > 0;
	}

	/** Returns the stable owner shared by eval and session-owned tools. */
	getKernelOwnerId(): string {
		return this.#kernelOwnerId;
	}

	/** Returns the eval session shared with the Python backend. */
	getSessionId(): string | null {
		if (this.#parentSessionId !== undefined) return this.#parentSessionId;
		return defaultEvalSessionId({
			cwd: this.#host.sessionManager.getCwd(),
			getSessionFile: () => this.#host.sessionManager.getSessionFile() ?? null,
		});
	}

	/** Flushes deferred Python results into agent state and persistence. */
	flushPending(): void {
		if (this.#pendingMessages.length === 0) return;
		for (const message of this.#pendingMessages) this.#host.appendSessionMessage(message);
		this.#pendingMessages = [];
	}

	/** Prevents new Python executions before asynchronous disposal starts. */
	beginDispose(): void {
		this.#disposing = true;
	}

	/** Waits for active work and disposes every retained eval kernel owned by the session. */
	async disposeKernels(): Promise<void> {
		const settled = await this.#prepareExecutionsForDispose();
		if (!settled) {
			logger.warn("Detaching retained eval-kernel ownership during dispose while eval execution is still active");
		}
		const results = await Promise.allSettled([
			disposeKernelSessionsByOwner(this.#kernelOwnerId),
			disposeVmContextsByOwner(this.#kernelOwnerId),
		]);
		const errors: unknown[] = [];
		for (const result of results) if (result.status === "rejected") errors.push(result.reason);
		if (errors.length > 0) throw new AggregateError(errors, "Failed to dispose one or more eval kernels");
	}

	async #waitForExecutionsToSettle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.#activeExecutions.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) return false;
			const settled = await Promise.race([
				Promise.allSettled(Array.from(this.#activeExecutions)).then(() => true),
				Bun.sleep(remainingMs).then(() => false),
			]);
			if (!settled && this.#activeExecutions.size > 0) return false;
		}
		return true;
	}

	async #prepareExecutionsForDispose(): Promise<boolean> {
		if (!(await this.#waitForExecutionsToSettle(3_000))) {
			logger.warn("Aborting active Python execution during dispose before retained kernel cleanup");
			this.abort();
			if (!(await this.#waitForExecutionsToSettle(1_000))) {
				logger.warn(
					"Python execution is still active after dispose aborted all active runs; retained kernel ownership will still be detached",
				);
				return false;
			}
		}
		return true;
	}
}
