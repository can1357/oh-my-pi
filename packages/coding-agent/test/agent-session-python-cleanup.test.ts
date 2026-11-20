import { afterAll, afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as pythonExecutor from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { PythonKernel as PythonKernelInstance } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import * as pythonKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type ExtensionFactory, type WorkspaceTree } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const OK_EXECUTION = { status: "ok", cancelled: false, timedOut: false, stdinRequested: false } as const;

class FakeKernel {
	readonly id = Snowflake.next();
	readonly pythonPath = "/fake/python";
	readonly #death = Promise.withResolvers<void>();
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

	whenDead(): Promise<void> {
		return this.#death.promise;
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
		this.#death.resolve();
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

// Inject in-memory auth and a shared model registry: letting createAgentSession
// discover them per call opens <agentDir>/auth.db and rebuilds the model cache
// in every fresh agentDir, which costs ~1s per session locally and pushed the
// two-session tests past their timeout on loaded CI runners. A separate agentDir
// per session still keeps other per-agent SQLite handles from locking the
// per-test project temp dir on Windows.
const authStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
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
			authStorage,
			modelRegistry,
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
		// Best-effort cleanup: createAgentSession opens AgentStorage
		// inside agentDir that may outlive the test (dispose() doesn't close them).
		// On Windows the leaked SQLite handles keep the dir locked; swallow EBUSY
		// rather than failing the test — the OS temp dir reaper will clean up.
		for (const tempDir of [...tempDirs.splice(0), ...agentDirPool.splice(0)]) {
			await tempDir.remove().catch(() => {});
		}
	});

	afterAll(() => {
		authStorage.close();
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
				authStorage,
				modelRegistry,
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
				authStorage,
				modelRegistry,
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

	it("shuts down the previous session's retained kernel when newSession opens a new session file", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const previousKernel = new FakeKernel();
		const nextKernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(previousKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(nextKernel as unknown as PythonKernelInstance);
		const session = await createSession(tempDir, cwd, {
			sessionManager: SessionManager.create(cwd, tempDir.join("sessions")),
		});

		try {
			await session.executePython("print('previous')");
			expect(await session.newSession()).toBe(true);
			await previousKernel.whenDead();
			await session.executePython("print('next')");

			expect(previousKernel.shutdownCalls).toBe(1);
			expect(nextKernel.shutdownCalls).toBe(0);
			expect(nextKernel.executeCalls).toEqual(["print('next')"]);
		} finally {
			await session.dispose();
		}
		expect(nextKernel.shutdownCalls).toBe(1);
	});

	it("keeps the kernel a session_switch hook starts for the new session", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const previousKernel = new FakeKernel();
		const hookKernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(previousKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(hookKernel as unknown as PythonKernelInstance);
		// oxlint-disable-next-line prefer-const -- captured by the hook closure before assignment
		let session!: AgentSession;
		const hookExtension: ExtensionFactory = api => {
			api.on("session_switch", async () => {
				await session.executePython("print('hook')");
			});
		};
		session = await createSession(tempDir, cwd, {
			extensions: [hookExtension],
			sessionManager: SessionManager.create(cwd, tempDir.join("sessions")),
		});

		try {
			await session.executePython("print('previous')");
			expect(await session.newSession()).toBe(true);
			await previousKernel.whenDead();
			await session.executePython("print('next')");

			expect(startSpy).toHaveBeenCalledTimes(2);
			expect(hookKernel.shutdownCalls).toBe(0);
			expect(hookKernel.executeCalls).toEqual(["print('hook')", "print('next')"]);
		} finally {
			await session.dispose();
		}
	});

	it("releases a kernel started for the target of a switch that rolls back, keeping the restored one", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const originalKernel = new FakeKernel();
		const targetKernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValueOnce(originalKernel as unknown as PythonKernelInstance)
			.mockResolvedValueOnce(targetKernel as unknown as PythonKernelInstance);
		const targetManager = SessionManager.create(cwd, tempDir.join("sessions"));
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 1 });
		await targetManager.flush();
		const targetSessionFile = targetManager.getSessionFile()!;
		await targetManager.close();
		// oxlint-disable-next-line prefer-const -- captured by the hook closure before assignment
		let session!: AgentSession;
		const hookExtension: ExtensionFactory = api => {
			api.on("session_switch", async () => {
				await session.executePython("print('target')");
			});
		};
		session = await createSession(tempDir, cwd, {
			extensions: [hookExtension],
			sessionManager: SessionManager.create(cwd, tempDir.join("sessions")),
		});
		// Fail the first step after the hook while the target is adopted, forcing rollback.
		const replaceMessages = session.agent.replaceMessages.bind(session.agent);
		let failed = false;
		vi.spyOn(session.agent, "replaceMessages").mockImplementation(messages => {
			if (!failed && session.sessionFile === targetSessionFile) {
				failed = true;
				throw new Error("replace failed");
			}
			replaceMessages(messages);
		});

		try {
			await session.executePython("print('original')");
			await expect(session.switchSession(targetSessionFile)).rejects.toThrow("replace failed");
			expect(session.sessionFile).not.toBe(targetSessionFile);
			await targetKernel.whenDead();
			await session.executePython("print('after')");

			expect(targetKernel.executeCalls).toEqual(["print('target')"]);
			expect(originalKernel.shutdownCalls).toBe(0);
			expect(originalKernel.executeCalls).toEqual(["print('original')", "print('after')"]);
		} finally {
			await session.dispose();
		}
	});

	it("lets a cell running in the previous session's kernel finish before a fork releases it", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const kernel = new FakeKernel();
		const blockedExecution = Promise.withResolvers<typeof OK_EXECUTION>();
		const started = Promise.withResolvers<void>();
		kernel.blockedCode = "print('blocked')";
		kernel.blockedExecution = blockedExecution.promise;
		kernel.blockedExecutionStarted = () => started.resolve();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(pythonKernel.PythonKernel, "start").mockResolvedValueOnce(kernel as unknown as PythonKernelInstance);
		const session = await createSession(tempDir, cwd, {
			sessionManager: SessionManager.create(cwd, tempDir.join("sessions")),
		});

		try {
			session.sessionManager.appendMessage({ role: "user", content: "before fork", timestamp: 1 });
			const execution = session.executePython("print('blocked')");
			await started.promise;
			expect(await session.fork()).toBe(true);
			await Bun.sleep(0);
			expect(kernel.shutdownCalls).toBe(0);

			blockedExecution.resolve(OK_EXECUTION);
			const result = await execution;
			expect(result.cancelled).toBe(false);
			expect(result.exitCode).toBe(0);
			await kernel.whenDead();
			expect(kernel.shutdownCalls).toBe(1);
		} finally {
			await session.dispose();
		}
	});

	it("keeps the retained kernel when a transition stays on the same session file", async () => {
		const { tempDir, cwd } = createTempProject();
		tempDirs.push(tempDir);
		const kernel = new FakeKernel();
		vi.spyOn(pythonKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		const startSpy = vi
			.spyOn(pythonKernel.PythonKernel, "start")
			.mockResolvedValue(kernel as unknown as PythonKernelInstance);
		const session = await createSession(tempDir, cwd, {
			sessionManager: SessionManager.create(cwd, tempDir.join("sessions")),
		});

		try {
			await session.executePython("x = 1");
			expect(await session.resetSessionContext()).toBeDefined();
			await session.executePython("print(x)");

			expect(startSpy).toHaveBeenCalledTimes(1);
			expect(kernel.shutdownCalls).toBe(0);
			expect(kernel.executeCalls).toEqual(["x = 1", "print(x)"]);
		} finally {
			await session.dispose();
		}
	});
});
