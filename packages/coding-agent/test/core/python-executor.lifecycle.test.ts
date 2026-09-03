import { afterEach, describe, expect, it } from "bun:test";
import {
	disposeAllKernelSessions,
	disposeKernelSessionsByOwner,
	executePython,
} from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import {
	type KernelExecuteOptions,
	type KernelExecuteResult,
	type KernelShutdownResult,
	PythonKernel,
} from "@oh-my-pi/pi-coding-agent/eval/py/kernel";

Bun.env.PI_PYTHON_SKIP_CHECK = "1";

class FakeKernel {
	#result: KernelExecuteResult;
	#onExecute?: (options?: KernelExecuteOptions) => void;
	#alive: boolean;
	readonly executeCalls: string[] = [];
	shutdownCalls = 0;

	constructor(
		result: KernelExecuteResult,
		options: { alive?: boolean; onExecute?: (options?: KernelExecuteOptions) => void } = {},
	) {
		this.#result = result;
		this.#onExecute = options.onExecute;
		this.#alive = options.alive ?? true;
	}

	isAlive(): boolean {
		return this.#alive;
	}

	markDead(): void {
		this.#alive = false;
	}

	async execute(code: string, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		this.executeCalls.push(code);
		this.#onExecute?.(options);
		return this.#result;
	}

	async shutdown(): Promise<KernelShutdownResult> {
		this.shutdownCalls += 1;
		this.#alive = false;
		return { confirmed: true };
	}

	async ping(): Promise<boolean> {
		return this.#alive;
	}
}

const okResult: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("executePython session lifecycle", () => {
	const originalStart = PythonKernel.start;

	afterEach(async () => {
		PythonKernel.start = originalStart;
		await disposeAllKernelSessions();
	});

	it("reuses a session kernel across calls", async () => {
		let startCount = 0;
		const kernel = new FakeKernel(okResult, { onExecute: options => options?.onChunk?.("ok\n") });
		PythonKernel.start = async () => {
			startCount += 1;
			return kernel as unknown as PythonKernel;
		};

		await executePython("print('one')", { sessionId: "session-1" });
		await executePython("print('two')", { sessionId: "session-1" });

		expect(startCount).toBe(1);
		expect(kernel.executeCalls).toEqual(["print('one')", "print('two')"]);
	});

	it("restarts the session kernel when not alive", async () => {
		const deadKernel = new FakeKernel(okResult, { alive: false });
		const liveKernel = new FakeKernel(okResult, { onExecute: options => options?.onChunk?.("live\n") });
		const kernels = [deadKernel, liveKernel];
		let startCount = 0;

		PythonKernel.start = async () => {
			startCount += 1;
			return kernels.shift() as unknown as PythonKernel;
		};

		await executePython("print('restart')", { sessionId: "session-restart" });

		expect(startCount).toBe(2);
		expect(deadKernel.shutdownCalls).toBe(1);
		expect(deadKernel.executeCalls).toEqual([]);
		expect(liveKernel.executeCalls).toEqual(["print('restart')"]);
	});

	it("coalesces concurrent replacement of one dead session generation", async () => {
		const deadKernel = new FakeKernel(okResult);
		const replacementOne = new FakeKernel(okResult);
		const replacementTwo = new FakeKernel(okResult);
		const replacementStarted = Promise.withResolvers<void>();
		const releaseReplacement = Promise.withResolvers<void>();
		const replacements = [replacementOne, replacementTwo];
		let startCount = 0;

		PythonKernel.start = async () => {
			startCount += 1;
			if (startCount === 1) return deadKernel as unknown as PythonKernel;
			replacementStarted.resolve();
			await releaseReplacement.promise;
			return replacements.shift() as unknown as PythonKernel;
		};

		await executePython("print('setup')", { sessionId: "session-concurrent-restart" });
		deadKernel.markDead();

		const first = executePython("print('first')", { sessionId: "session-concurrent-restart" });
		await replacementStarted.promise;
		const second = executePython("print('second')", { sessionId: "session-concurrent-restart" });
		await Promise.resolve();
		await Promise.resolve();

		expect(startCount).toBe(2);

		releaseReplacement.resolve();
		await Promise.all([first, second]);

		expect(replacementOne.executeCalls).toEqual(["print('first')", "print('second')"]);
		expect(replacementTwo.executeCalls).toEqual([]);

		await disposeAllKernelSessions();
		expect(replacementOne.shutdownCalls).toBe(1);
		expect(replacementTwo.shutdownCalls).toBe(0);
	});

	it("keeps a shared replacement alive when one caller cancels", async () => {
		const deadKernel = new FakeKernel(okResult);
		const replacement = new FakeKernel(okResult);
		const replacementStarted = Promise.withResolvers<void>();
		const releaseReplacement = Promise.withResolvers<void>();
		let startCount = 0;

		PythonKernel.start = async () => {
			startCount += 1;
			if (startCount === 1) return deadKernel as unknown as PythonKernel;
			replacementStarted.resolve();
			await releaseReplacement.promise;
			return replacement as unknown as PythonKernel;
		};

		await executePython("print('setup')", { sessionId: "session-cancelled-restart" });
		deadKernel.markDead();

		const abortController = new AbortController();
		const cancelled = executePython("print('cancelled')", {
			sessionId: "session-cancelled-restart",
			signal: abortController.signal,
		});
		await replacementStarted.promise;
		const retained = executePython("print('retained')", { sessionId: "session-cancelled-restart" });
		await flushMicrotasks();
		abortController.abort(Object.assign(new Error("replacement wait cancelled"), { name: "AbortError" }));

		expect((await cancelled).cancelled).toBe(true);
		expect(startCount).toBe(2);

		releaseReplacement.resolve();
		expect((await retained).cancelled).toBe(false);
		expect(replacement.executeCalls).toEqual(["print('retained')"]);
	});

	it("invalidates an in-flight replacement before resetting to a fresh generation", async () => {
		const deadKernel = new FakeKernel(okResult);
		const staleReplacement = new FakeKernel(okResult);
		const freshKernel = new FakeKernel(okResult);
		const replacementStarted = Promise.withResolvers<void>();
		const releaseReplacement = Promise.withResolvers<void>();
		let startCount = 0;

		PythonKernel.start = async () => {
			startCount += 1;
			if (startCount === 1) return deadKernel as unknown as PythonKernel;
			if (startCount === 2) {
				replacementStarted.resolve();
				await releaseReplacement.promise;
				return staleReplacement as unknown as PythonKernel;
			}
			return freshKernel as unknown as PythonKernel;
		};

		await executePython("print('setup')", { sessionId: "session-reset-replacement" });
		deadKernel.markDead();

		const obsolete = executePython("print('obsolete')", { sessionId: "session-reset-replacement" });
		await replacementStarted.promise;
		const reset = executePython("print('reset')", {
			sessionId: "session-reset-replacement",
			reset: true,
		});
		await flushMicrotasks();
		releaseReplacement.resolve();

		expect((await obsolete).cancelled).toBe(true);
		expect((await reset).cancelled).toBe(false);
		expect(staleReplacement.executeCalls).toEqual([]);
		expect(staleReplacement.shutdownCalls).toBe(1);
		expect(freshKernel.executeCalls).toEqual(["print('reset')"]);

		await executePython("print('later')", { sessionId: "session-reset-replacement" });
		expect(startCount).toBe(3);
		expect(freshKernel.executeCalls).toEqual(["print('reset')", "print('later')"]);
	});

	it("drains replacements invalidated by owner and global disposal", async () => {
		const ownerKernel = new FakeKernel(okResult);
		const globalKernel = new FakeKernel(okResult);
		const ownerReplacement = new FakeKernel(okResult);
		const globalReplacement = new FakeKernel(okResult);
		const replacementsStarted = Promise.withResolvers<void>();
		const releaseReplacements = Promise.withResolvers<void>();
		const initialKernels = [ownerKernel, globalKernel];
		const replacementKernels = [ownerReplacement, globalReplacement];
		let replacementStartCount = 0;

		PythonKernel.start = async () => {
			const initial = initialKernels.shift();
			if (initial) return initial as unknown as PythonKernel;
			replacementStartCount += 1;
			if (replacementStartCount === 2) replacementsStarted.resolve();
			await releaseReplacements.promise;
			return replacementKernels.shift() as unknown as PythonKernel;
		};

		await executePython("print('owner setup')", {
			sessionId: "session-owner-disposal-replacement",
			kernelOwnerId: "replacement-owner",
		});
		await executePython("print('global setup')", { sessionId: "session-global-disposal-replacement" });
		ownerKernel.markDead();
		globalKernel.markDead();

		const ownerExecution = executePython("print('owner obsolete')", {
			sessionId: "session-owner-disposal-replacement",
			kernelOwnerId: "replacement-owner",
		});
		const globalExecution = executePython("print('global obsolete')", {
			sessionId: "session-global-disposal-replacement",
		});
		await replacementsStarted.promise;

		const ownerDisposal = disposeKernelSessionsByOwner("replacement-owner");
		await flushMicrotasks();
		const globalDisposal = disposeAllKernelSessions();
		await flushMicrotasks();
		releaseReplacements.resolve();

		expect((await ownerExecution).cancelled).toBe(true);
		expect((await globalExecution).cancelled).toBe(true);
		await Promise.all([ownerDisposal, globalDisposal]);
		expect(ownerReplacement.executeCalls).toEqual([]);
		expect(globalReplacement.executeCalls).toEqual([]);
		expect(ownerReplacement.shutdownCalls).toBe(1);
		expect(globalReplacement.shutdownCalls).toBe(1);
	});

	it("keeps replacement coordination independent across normalized cwd keys", async () => {
		const deadOne = new FakeKernel(okResult);
		const deadTwo = new FakeKernel(okResult);
		const replacementOne = new FakeKernel(okResult);
		const replacementTwo = new FakeKernel(okResult);
		const kernels = [deadOne, deadTwo, replacementOne, replacementTwo];
		let startCount = 0;

		PythonKernel.start = async () => {
			startCount += 1;
			return kernels.shift() as unknown as PythonKernel;
		};

		await executePython("print('setup one')", {
			cwd: "/tmp/replacement-key-one",
			sessionId: "session-independent-replacement",
		});
		await executePython("print('setup two')", {
			cwd: "/tmp/replacement-key-two",
			sessionId: "session-independent-replacement",
		});
		deadOne.markDead();
		deadTwo.markDead();

		await Promise.all([
			executePython("print('one')", {
				cwd: "/tmp/replacement-key-one",
				sessionId: "session-independent-replacement",
			}),
			executePython("print('two')", {
				cwd: "/tmp/replacement-key-two",
				sessionId: "session-independent-replacement",
			}),
		]);

		expect(startCount).toBe(4);
		expect(replacementOne.executeCalls).toEqual(["print('one')"]);
		expect(replacementTwo.executeCalls).toEqual(["print('two')"]);
	});

	it("resets the session kernel when requested", async () => {
		const firstKernel = new FakeKernel(okResult);
		const secondKernel = new FakeKernel(okResult);
		const kernels = [firstKernel, secondKernel];
		let startCount = 0;

		PythonKernel.start = async () => {
			startCount += 1;
			return kernels.shift() as unknown as PythonKernel;
		};

		await executePython("print('one')", { sessionId: "session-reset" });
		await executePython("print('two')", { sessionId: "session-reset", reset: true });

		expect(startCount).toBe(2);
		expect(firstKernel.shutdownCalls).toBe(1);
		expect(secondKernel.executeCalls).toEqual(["print('two')"]);
	});

	it("cancels queued session execution before it reaches the kernel", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const kernel = new FakeKernel(okResult);
		kernel.execute = async (code, options) => {
			kernel.executeCalls.push(code);
			if (kernel.executeCalls.length === 1) {
				options?.onChunk?.("first\n");
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			return okResult;
		};
		let startCount = 0;

		PythonKernel.start = async () => {
			startCount += 1;
			return kernel as unknown as PythonKernel;
		};

		const firstPromise = executePython("print('one')", { sessionId: "session-queue" });
		await firstStarted.promise;

		const abortController = new AbortController();
		const secondPromise = executePython("print('two')", {
			sessionId: "session-queue",
			signal: abortController.signal,
		});
		abortController.abort(Object.assign(new Error("queue wait cancelled"), { name: "AbortError" }));

		const second = await secondPromise;
		expect(second.cancelled).toBe(true);
		expect(second.exitCode).toBeUndefined();
		expect(second.output).toBe("");
		expect(kernel.executeCalls).toEqual(["print('one')"]);

		releaseFirst.resolve();
		const first = await firstPromise;

		expect(first.cancelled).toBe(false);
		expect(first.output).toContain("first");
		expect(startCount).toBe(1);
		expect(kernel.executeCalls).toEqual(["print('one')"]);
	});

	it("uses per-call kernels when configured", async () => {
		const kernelA = new FakeKernel(okResult);
		const kernelB = new FakeKernel(okResult);
		const kernels = [kernelA, kernelB];
		let startCount = 0;
		let shutdownCount = 0;

		PythonKernel.start = async () => {
			startCount += 1;
			return kernels.shift() as unknown as PythonKernel;
		};

		kernelA.shutdown = async (): Promise<KernelShutdownResult> => {
			shutdownCount += 1;
			return { confirmed: true };
		};
		kernelB.shutdown = async (): Promise<KernelShutdownResult> => {
			shutdownCount += 1;
			return { confirmed: true };
		};

		await executePython("print('one')", { kernelMode: "per-call" });
		await executePython("print('two')", { kernelMode: "per-call" });

		expect(startCount).toBe(2);
		expect(shutdownCount).toBe(2);
	});
});
