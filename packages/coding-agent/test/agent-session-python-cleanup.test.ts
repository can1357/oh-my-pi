import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as pythonExecutor from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { PythonKernel as PythonKernelInstance } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import * as pythonKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type ExtensionFactory, type WorkspaceTree } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";

const OK_EXECUTION = { status: "ok", cancelled: false, timedOut: false, stdinRequested: false } as const;

class FakeKernel {
	executeCalls: string[] = [];
	shutdownCalls = 0;
	alive = true;
	blockedCode: string | undefined;
	blockedExecution: Promise<typeof OK_EXECUTION> | undefined;
	blockedExecutionStarted: (() => void) | undefined;
	blockedExecutionReject: ((error: Error) => void) | undefined;
	abortBlockedExecution = true;

	isAlive(): boolean {
		return this.alive;
	}

	async execute(code: string, options?: { signal?: AbortSignal }): Promise<typeof OK_EXECUTION> {
		this.executeCalls.push(code);
		if (code === this.blockedCode && this.blockedExecution) {
			this.blockedExecutionStarted?.();
			if (!this.abortBlockedExecution || !options?.signal) {
				return await this.blockedExecution;
			}
			return await Promise.race([
				this.blockedExecution,
				new Promise<typeof OK_EXECUTION>((_, reject) => {
					const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
					if (options.signal?.aborted) {
						onAbort();
						return;
					}
					options.signal?.addEventListener("abort", onAbort, { once: true });
				}),
			]);
		}
		return OK_EXECUTION;
	}

	async ping(): Promise<boolean> {
		return this.alive;
	}

	shutdown = vi.fn(async () => {
		this.shutdownCalls += 1;
		this.alive = false;
		this.blockedExecutionReject?.(new Error("Kernel shut down during execution"));
		return { confirmed: true };
	});
}

const getModel = () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	return model;
};

const createTempProject = () => {
	const tempDir = TempDir.createSync(`@pi-agent-session-python-cleanup-${Snowflake.next()}-`);
	const cwd = tempDir.join("project");
	fs.mkdirSync(cwd, { recursive: true });
	return { tempDir, cwd };
};

// createAgentSession opens an AuthStorage at <agentDir>/auth.db that is not
// closed when construction fails. Point agentDir at a separate dir so the
// auth.db handle doesn't keep the per-test project temp dir locked on Windows.
const agentDirPool: TempDir[] = [];
const createAgentDir = (): string => {
	const dir = TempDir.createSync("@pi-python-cleanup-agentdir-");
	agentDirPool.push(dir);
	return dir.path();
};
const emptyWorkspaceTree = (cwd: string): WorkspaceTree => ({
	rootPath: cwd,
	rendered: ".",
	truncated: false,
	totalLines: 1,
	agentsMdFiles: [],
});

const mockPositiveSleepsImmediate = () => {
	const realSleep = Bun.sleep.bind(Bun);
	return vi.spyOn(Bun, "sleep").mockImplementation((duration?: number | Date) => {
		if (typeof duration === "number" && duration > 0) {
			return Promise.resolve();
		}
		return realSleep(duration ?? 0);
	});
};

const expectSleepNear = (sleepSpy: Mock<typeof Bun.sleep>, targetMs: number) => {
	const minMs = targetMs - 100;
	expect(
		sleepSpy.mock.calls.some(
			([duration]) => typeof duration === "number" && duration >= minMs && duration <= targetMs,
		),
	).toBe(true);
};
const createSession = async (
	_tempDir: TempDir,
	cwd: string,
	options: { extensions?: ExtensionFactory[]; sessionManager?: SessionManager } = {},
) =>
	(
		await createAgentSession({
			cwd,
			agentDir: createAgentDir(),
			sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd),
			settings: Settings.isolated({ "python.kernelMode": "session" }),
			model: getModel(),
			disableExtensionDiscovery: true,
			extensions: options.extensions,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			workspaceTree: emptyWorkspaceTree(cwd),
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["eval"],
		})
	).session;
const createMockKernel = () => {
	let alive = true;
	return {
		execute: vi.fn(async () => {
			if (!alive) throw new Error("Expected mock kernel to be restarted after shutdown");
			return OK_EXECUTION;
		}),
		ping: vi.fn(async () => alive),
		isAlive: () => alive,
		shutdown: vi.fn(async () => {
			alive = false;
			return { confirmed: true };
		}),
	};
};

describe("AgentSession python cleanup", () => {
	const tempDirs: TempDir[] = [];
	let originalNullPrompt: string | undefined;

	beforeEach(() => {
		originalNullPrompt = Bun.env.NULL_PROMPT;
		Bun.env.NULL_PROMPT = "true";
	});

	afterEach(async () => {
		if (originalNullPrompt === undefined) {
			delete Bun.env.NULL_PROMPT;
		} else {
			Bun.env.NULL_PROMPT = originalNullPrompt;
		}
		originalNullPrompt = undefined;
		vi.restoreAllMocks();
		AgentStorage.close();
		await pythonExecutor.disposeAllKernelSessions();
		await Bun.sleep(0);
		// Best-effort cleanup: createAgentSession opens AuthStorage/AgentStorage
		// inside agentDir that may outlive the test (dispose() doesn't close them).
		// On Windows the leaked SQLite handles keep the dir locked; swallow EBUSY
		// rather than failing the test — the OS temp dir reaper will clean up.
		for (const tempDir of [...tempDirs.splice(0), ...agentDirPool.splice(0)]) {
			await tempDir.remove().catch(() => {});
		}
	});

	it("does not dispose unrelated Python owners when createAgentSession fails before session construction", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const unrelatedKernel = createMockKernel();
		const unrelatedCwd = tempDir.join("unrelated-before");
		const throwingExtension: ExtensionFactory = () => {
			throw new Error("Extension init failed");
		};
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(unrelatedKernel as unknown as PythonKernelInstance);

		await pythonExecutor.executePython("print('unrelated before')", {
			cwd: unrelatedCwd,
			sessionId: "unrelated-before-session",
			kernelMode: "session",
			kernelOwnerId: "other-owner",
		});

		await expect(
			createAgentSession({
				cwd,
				agentDir: createAgentDir(),
				sessionManager: SessionManager.inMemory(cwd),
				settings: Settings.isolated({ "python.kernelMode": "session" }),
				model: getModel(),
				disableExtensionDiscovery: true,
				extensions: [throwingExtension],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["eval"],
				workspaceTree: emptyWorkspaceTree(cwd),
			}),
		).rejects.toThrow("Extension init failed");

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(unrelatedKernel.shutdown).not.toHaveBeenCalled();

		const replacementKernel = createMockKernel();
		startSpy.mockResolvedValueOnce(replacementKernel as unknown as PythonKernelInstance);
		await pythonExecutor.executePython("print('fresh warmup before')", {
			cwd,
			sessionId: `cwd:${cwd}`,
			kernelMode: "session",
			kernelOwnerId: "fresh-owner-before",
		});
		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);

		await pythonExecutor.executePython("print('still alive before')", {
			cwd: unrelatedCwd,
			sessionId: "unrelated-before-session",
			kernelMode: "session",
			kernelOwnerId: "other-owner",
		});

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(unrelatedKernel.execute).toHaveBeenCalledTimes(2);
	});

	it("does not dispose unrelated Python owners when createAgentSession fails after session construction", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const unrelatedKernel = createMockKernel();
		const unrelatedCwd = tempDir.join("unrelated-after");
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(unrelatedKernel as unknown as PythonKernelInstance);
		const throwingRegistry = new AgentRegistry();
		vi.spyOn(throwingRegistry, "register").mockImplementation(() => {
			throw new Error("Agent registry failed");
		});

		await pythonExecutor.executePython("print('unrelated after')", {
			cwd: unrelatedCwd,
			sessionId: "unrelated-after-session",
			kernelMode: "session",
			kernelOwnerId: "other-owner",
		});

		await expect(
			createAgentSession({
				cwd,
				agentDir: createAgentDir(),
				sessionManager: SessionManager.inMemory(cwd),
				settings: Settings.isolated({ "python.kernelMode": "session", "memory.backend": "local" }),
				model: getModel(),
				disableExtensionDiscovery: true,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["eval"],
				workspaceTree: emptyWorkspaceTree(cwd),
				agentRegistry: throwingRegistry,
			}),
		).rejects.toThrow("Agent registry failed");

		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(unrelatedKernel.shutdown).not.toHaveBeenCalled();

		const replacementKernel = createMockKernel();
		startSpy.mockResolvedValueOnce(replacementKernel as unknown as PythonKernelInstance);
		await pythonExecutor.executePython("print('fresh warmup after')", {
			cwd,
			sessionId: `cwd:${cwd}`,
			kernelMode: "session",
			kernelOwnerId: "fresh-owner-after",
		});
		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);
		expect(replacementKernel.execute).toHaveBeenCalledTimes(1);

		await pythonExecutor.executePython("print('still alive after')", {
			cwd: unrelatedCwd,
			sessionId: "unrelated-after-session",
			kernelMode: "session",
			kernelOwnerId: "other-owner",
		});

		expect(startSpy).toHaveBeenCalledTimes(2);
		expect(unrelatedKernel.execute).toHaveBeenCalledTimes(2);
	});

	it("waits for active SDK session Python work before releasing a shared retained kernel", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const kernel = new FakeKernel();
		const blockedExecution = Promise.withResolvers<typeof OK_EXECUTION>();
		const blockedExecutionStarted = Promise.withResolvers<void>();
		let blockedExecutionSettled = false;
		blockedExecution.promise.then(
			() => {
				blockedExecutionSettled = true;
			},
			() => {
				blockedExecutionSettled = true;
			},
		);
		kernel.blockedCode = "print('first')";
		kernel.blockedExecution = blockedExecution.promise;
		kernel.blockedExecutionStarted = () => blockedExecutionStarted.resolve();
		kernel.blockedExecutionReject = error => blockedExecution.reject(error);
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValue(kernel as unknown as PythonKernelInstance);
		const firstSession = await createSession(tempDir, cwd);
		const secondSession = await createSession(tempDir, cwd);
		expect(startSpy).toHaveBeenCalledTimes(0);
		let firstDisposed = false;

		try {
			const firstExecution = firstSession.executePython("print('first')");
			let firstExecutionSettled = false;
			const observedFirstExecution = firstExecution.finally(() => {
				firstExecutionSettled = true;
			});
			await blockedExecutionStarted.promise;

			const disposeFirst = firstSession.dispose().then(() => {
				expect(blockedExecutionSettled).toBe(true);
				expect(firstExecutionSettled).toBe(true);
				firstDisposed = true;
			});
			await Bun.sleep(0);
			expect(firstDisposed).toBe(false);
			expect(blockedExecutionSettled).toBe(false);
			expect(firstExecutionSettled).toBe(false);

			const secondExecution = secondSession.executePython("print('second')");
			await Bun.sleep(0);

			expect(firstDisposed).toBe(false);
			expect(blockedExecutionSettled).toBe(false);
			expect(firstExecutionSettled).toBe(false);
			expect(kernel.shutdownCalls).toBe(0);

			blockedExecution.resolve(OK_EXECUTION);
			await Promise.all([observedFirstExecution, secondExecution, disposeFirst]);

			expect(startSpy).toHaveBeenCalledTimes(1);
			expect(kernel.shutdownCalls).toBe(0);
			expect(kernel.executeCalls).toEqual(["print('first')", "print('second')"]);

			await secondSession.executePython("print('third')");

			expect(startSpy).toHaveBeenCalledTimes(1);
			expect(kernel.executeCalls).toEqual(["print('first')", "print('second')", "print('third')"]);
		} finally {
			if (!firstDisposed) {
				await firstSession.dispose();
			}
			await secondSession.dispose();
		}

		expect(kernel.shutdownCalls).toBe(1);
	});
	it("aborts tracked eval execution during session dispose after warmup completes", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const blockedExecuteStarted = Promise.withResolvers<void>();
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockImplementation(async (_code, options) => {
			const signal = options?.signal;
			if (!signal) {
				throw new Error("Expected abort signal");
			}
			blockedExecuteStarted.resolve();
			return await new Promise(resolve => {
				const onAbort = () =>
					resolve({
						output: "Command aborted",
						exitCode: undefined,
						cancelled: true,
						truncated: false,
						totalLines: 1,
						totalBytes: 15,
						outputLines: 1,
						outputBytes: 15,
						displayOutputs: [],
						stdinRequested: false,
					});
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			});
		});
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });

		const session = await createSession(tempDir, cwd);
		const EvalTool = session.getToolByName("eval");
		expect(EvalTool).toBeDefined();
		let toolExecutionSettled = false;
		const toolExecution = EvalTool!
			.execute("call-id", { language: "py", code: "print('tool')" }, undefined, undefined, undefined)
			.finally(() => {
				toolExecutionSettled = true;
			});
		await blockedExecuteStarted.promise;
		const sleepSpy = mockPositiveSleepsImmediate();

		let disposed = false;
		const disposeSession = session.dispose().then(() => {
			disposed = true;
		});

		const [toolResult] = await Promise.all([toolExecution, disposeSession]);

		expectSleepNear(sleepSpy, 3000);

		expect(disposed).toBe(true);
		expect(toolExecutionSettled).toBe(true);
		expect(executeSpy).toHaveBeenCalledTimes(1);
		expect(toolResult.details?.isError).toBe(true);
		expect(toolResult.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("Command aborted") }),
		);
	});

	it("detaches retained kernel ownership even when dispose times out waiting for Python work", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const kernel = new FakeKernel();
		const blockedExecution = Promise.withResolvers<typeof OK_EXECUTION>();
		const blockedExecutionStarted = Promise.withResolvers<void>();
		kernel.blockedCode = "print('blocked')";
		kernel.blockedExecution = blockedExecution.promise;
		kernel.blockedExecutionStarted = () => blockedExecutionStarted.resolve();
		kernel.abortBlockedExecution = false;

		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const sleepSpy = vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);

		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValue(kernel as unknown as PythonKernelInstance);

		const firstSession = await createSession(tempDir, cwd);
		const secondSession = await createSession(tempDir, cwd);

		await secondSession.executePython("print('owner-b warmup')");
		const firstExecution = firstSession.executePython("print('blocked')");
		await blockedExecutionStarted.promise;
		let firstExecutionSettled = false;
		void firstExecution.finally(() => {
			firstExecutionSettled = true;
		});

		let firstDisposed = false;
		const disposeFirst = firstSession.dispose().then(() => {
			firstDisposed = true;
		});
		await disposeFirst;
		expectSleepNear(sleepSpy, 3000);

		expect(firstDisposed).toBe(true);
		expect(firstExecutionSettled).toBe(false);
		expect(kernel.shutdownCalls).toBe(0);
		expect(startSpy).toHaveBeenCalledTimes(1);

		blockedExecution.resolve(OK_EXECUTION);
		// The dispose abort was requested while the execution was still running;
		// the executor reports such runs as cancelled even when the kernel races
		// to completion. Detachment is proven below: the kernel survives, is not
		// restarted, and keeps serving the surviving session.
		await expect(firstExecution).resolves.toMatchObject({
			cancelled: true,
			stdinRequested: false,
		});
		await secondSession.executePython("print('owner-b after detach')");
		expect(startSpy).toHaveBeenCalledTimes(1);
		expect(kernel.executeCalls).toEqual([
			"print('owner-b warmup')",
			"print('blocked')",
			"print('owner-b after detach')",
		]);
		await secondSession.dispose();

		expect(kernel.shutdownCalls).toBe(1);
	}, 10000);

	it("rejects direct session Python starts once dispose begins", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "late",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 4,
			outputLines: 1,
			outputBytes: 4,
			displayOutputs: [],
			stdinRequested: false,
		});

		const session = await createSession(tempDir, cwd);
		const disposeSession = session.dispose();
		await expect(session.executePython("print('late')")).rejects.toThrow(
			"Python execution is unavailable while session disposal is in progress",
		);
		await disposeSession;
		expect(executeSpy).not.toHaveBeenCalled();
	});

	it("rejects direct session Python starts after an async user_python hook yields during dispose", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const hookStarted = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		const hookExtension: ExtensionFactory = api => {
			api.on("user_python", async () => {
				hookStarted.resolve();
				await releaseHook.promise;
				return undefined;
			});
		};
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "late",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 4,
			outputLines: 1,
			outputBytes: 4,
			displayOutputs: [],
			stdinRequested: false,
		});

		const session = await createSession(tempDir, cwd, { extensions: [hookExtension] });
		const execution = session.executePython("print('late after hook')");
		await hookStarted.promise;
		let disposed = false;
		const disposeSession = session.dispose().then(() => {
			disposed = true;
		});
		await Bun.sleep(0);
		expect(disposed).toBe(false);
		releaseHook.resolve();
		await expect(execution).rejects.toThrow("Python execution is unavailable while session disposal is in progress");
		await disposeSession;
		expect(disposed).toBe(true);
		expect(executeSpy).not.toHaveBeenCalled();
	}, 10000);

	it("rejects async user_python hook results after dispose begins", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const hookStarted = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		const hookExtension: ExtensionFactory = api => {
			api.on("user_python", async () => {
				hookStarted.resolve();
				await releaseHook.promise;
				return {
					result: {
						output: "hooked late",
						exitCode: 0,
						cancelled: false,
						truncated: false,
						totalLines: 1,
						totalBytes: 11,
						outputLines: 1,
						outputBytes: 11,
						displayOutputs: [],
						stdinRequested: false,
					},
				};
			});
		};
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "late",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 4,
			outputLines: 1,
			outputBytes: 4,
			displayOutputs: [],
			stdinRequested: false,
		});

		const session = await createSession(tempDir, cwd, { extensions: [hookExtension] });
		const execution = session.executePython("print('late hook result')");
		await hookStarted.promise;
		let disposed = false;
		const disposeSession = session.dispose().then(() => {
			disposed = true;
		});
		await Bun.sleep(0);
		expect(disposed).toBe(false);
		releaseHook.resolve();
		await expect(execution).rejects.toThrow("Python execution is unavailable while session disposal is in progress");
		await disposeSession;
		expect(disposed).toBe(true);
		expect(executeSpy).not.toHaveBeenCalled();
		expect(session.messages.some(message => message.role === "pythonExecution")).toBe(false);
	}, 10000);

	it("rejects eval starts once dispose begins", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "late",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 4,
			outputLines: 1,
			outputBytes: 4,
			displayOutputs: [],
			stdinRequested: false,
		});

		const session = await createSession(tempDir, cwd);
		const EvalTool = session.getToolByName("eval");
		expect(EvalTool).toBeDefined();
		const disposeSession = session.dispose();
		await expect(
			EvalTool!.execute("call-id", { language: "py", code: "print('late')" }, undefined, undefined, undefined),
		).rejects.toThrow("Python execution is unavailable while session disposal is in progress");
		await disposeSession;
		expect(executeSpy).not.toHaveBeenCalled();
	});

	it("rejects eval starts that reach async preflight after dispose begins", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const executeSpy = vi.spyOn(pythonExecutor, "executePython").mockResolvedValue({
			output: "late",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 4,
			outputLines: 1,
			outputBytes: 4,
			displayOutputs: [],
			stdinRequested: false,
		});
		const artifactStarted = Promise.withResolvers<void>();
		const releaseArtifact = Promise.withResolvers<void>();
		const sessionManager = SessionManager.inMemory(cwd);
		vi.spyOn(sessionManager, "allocateArtifactPath").mockImplementation(async () => {
			artifactStarted.resolve();
			await releaseArtifact.promise;
			return {};
		});

		const session = await createSession(tempDir, cwd, { sessionManager });
		const EvalTool = session.getToolByName("eval");
		expect(EvalTool).toBeDefined();
		const execution = EvalTool!.execute(
			"call-id",
			{ language: "py", code: "print('late after artifact')" },
			undefined,
			undefined,
			undefined,
		);
		await artifactStarted.promise;
		const disposeSession = session.dispose();
		releaseArtifact.resolve();
		await expect(execution).rejects.toThrow("Python execution is unavailable while session disposal is in progress");
		await disposeSession;
		expect(executeSpy).not.toHaveBeenCalled();
	});

	it("aborts every active concurrent Python execution owned by the session during dispose", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const kernel = new FakeKernel();
		const blockedExecution = Promise.withResolvers<typeof OK_EXECUTION>();
		const bothStarted = Promise.withResolvers<void>();
		let starts = 0;
		kernel.blockedCode = "print('blocked')";
		kernel.blockedExecution = blockedExecution.promise;
		kernel.blockedExecutionStarted = () => {
			starts += 1;
			if (starts >= 2) bothStarted.resolve();
		};

		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(pythonKernel.PythonKernel, "start").mockResolvedValue(kernel as unknown as PythonKernelInstance);

		const session = await createSession(tempDir, cwd);

		// Two concurrent blocked executions on the shared kernel session: both must
		// be tracked when dispose runs so abortEval cancels every signal.
		const firstExecution = session.executePython("print('blocked')");
		const secondExecution = session.executePython("print('blocked')");
		await bothStarted.promise;
		const sleepSpy = mockPositiveSleepsImmediate();

		await session.dispose();
		expectSleepNear(sleepSpy, 3000);
		const [firstResult, secondResult] = await Promise.all([firstExecution, secondExecution]);

		expect(firstResult.cancelled).toBe(true);
		expect(secondResult.cancelled).toBe(true);
		expect(kernel.executeCalls).toEqual(["print('blocked')", "print('blocked')"]);
		expect(kernel.shutdownCalls).toBe(1);
	});
});
