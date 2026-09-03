import { describe, expect, it, vi } from "bun:test";
import { createKernelSessionRegistry, type KernelSession } from "../../src/eval/kernel-session-registry";

interface TestOptions {
	sessionId?: string;
	kernelOwnerId?: string;
	interpreter?: string;
	reset?: boolean;
	signal?: AbortSignal;
	deadlineMs?: number;
}

interface TestResult {
	cancelled: boolean;
	value: string;
}

class TestCancelledError extends Error {
	constructor(readonly timedOut: boolean) {
		super(timedOut ? "timed out" : "cancelled");
		this.name = "TestCancelledError";
	}
}

class FakeKernel {
	alive = true;
	shutdowns = 0;

	constructor(readonly index: number) {}

	isAlive(): boolean {
		return this.alive;
	}

	async shutdown(): Promise<{ confirmed: boolean }> {
		this.alive = false;
		this.shutdowns += 1;
		return { confirmed: true };
	}
}

type ExecuteFakeKernel = (kernel: FakeKernel, code: string, options: TestOptions) => Promise<TestResult>;

type StartFakeKernel = (kernel: FakeKernel, options: TestOptions) => Promise<void>;

function createFakeRegistry(executeWithKernel: ExecuteFakeKernel, onStartKernel?: StartFakeKernel) {
	const kernels: FakeKernel[] = [];
	const registry = createKernelSessionRegistry<FakeKernel, TestOptions, TestResult, KernelSession<FakeKernel>>({
		languageLabel: "Test",
		cancelledErrorClass: TestCancelledError,
		buildSessionKey: sessionId => sessionId,
		createSession: session => session,
		startKernel: async (_cwd, options) => {
			const kernel = new FakeKernel(kernels.length);
			kernels.push(kernel);
			await onStartKernel?.(kernel, options);
			return kernel;
		},
		executeWithKernel,
	});
	return { kernels, registry };
}

describe("kernel session recovery", () => {
	it("replaces a kernel that dies while returning a cancelled result and retries once", async () => {
		const executions: number[] = [];
		const { kernels, registry } = createFakeRegistry(async kernel => {
			executions.push(kernel.index);
			if (kernel.index === 0) {
				kernel.alive = false;
				return { cancelled: true, value: "kernel died" };
			}
			return { cancelled: false, value: "recovered" };
		});

		try {
			const result = await registry.executeOnSession("code", "/tmp", { sessionId: "recovery" });

			expect(result).toEqual({ cancelled: false, value: "recovered" });
			expect(executions).toEqual([0, 1]);
			expect(kernels).toHaveLength(2);
			expect(kernels[0]?.shutdowns).toBe(1);
		} finally {
			await registry.disposeAll();
		}
	});

	it("coalesces concurrent recovery from the same dead kernel", async () => {
		const bothDeadExecutionsStarted = Promise.withResolvers<void>();
		const releaseDeadResults = Promise.withResolvers<void>();
		const replacementStarted = Promise.withResolvers<void>();
		const releaseReplacement = Promise.withResolvers<void>();
		const executions: Array<{ code: string; kernel: number }> = [];
		let deadExecutions = 0;
		const { kernels, registry } = createFakeRegistry(
			async (kernel, code) => {
				executions.push({ code, kernel: kernel.index });
				if (kernel.index === 0) {
					deadExecutions += 1;
					if (deadExecutions === 2) bothDeadExecutionsStarted.resolve();
					await releaseDeadResults.promise;
					kernel.alive = false;
					return { cancelled: true, value: "kernel died" };
				}
				return { cancelled: false, value: `recovered ${code}` };
			},
			async kernel => {
				if (kernel.index !== 1) return;
				replacementStarted.resolve();
				await releaseReplacement.promise;
			},
		);

		try {
			const first = registry.executeOnSession("first", "/tmp", { sessionId: "concurrent-recovery" });
			const second = registry.executeOnSession("second", "/tmp", { sessionId: "concurrent-recovery" });
			await bothDeadExecutionsStarted.promise;
			releaseDeadResults.resolve();
			await replacementStarted.promise;

			expect(kernels).toHaveLength(2);
			releaseReplacement.resolve();
			const results = await Promise.all([first, second]);

			expect(results).toEqual([
				{ cancelled: false, value: "recovered first" },
				{ cancelled: false, value: "recovered second" },
			]);
			expect(
				executions
					.filter(execution => execution.kernel === 0)
					.map(execution => execution.code)
					.sort(),
			).toEqual(["first", "second"]);
			expect(
				executions
					.filter(execution => execution.kernel === 1)
					.map(execution => execution.code)
					.sort(),
			).toEqual(["first", "second"]);
			expect(kernels[0]?.shutdowns).toBe(1);
		} finally {
			releaseDeadResults.resolve();
			releaseReplacement.resolve();
			await registry.disposeAll();
		}
	});

	it("recovers a newer dead kernel for a stale caller that has not retried", async () => {
		const bothOldExecutionsStarted = Promise.withResolvers<void>();
		const releaseSecondOldResult = Promise.withResolvers<void>();
		const executions: Array<{ code: string; kernel: number }> = [];
		let oldExecutions = 0;
		const { kernels, registry } = createFakeRegistry(async (kernel, code) => {
			executions.push({ code, kernel: kernel.index });
			if (kernel.index === 0) {
				oldExecutions += 1;
				if (oldExecutions === 2) bothOldExecutionsStarted.resolve();
				await bothOldExecutionsStarted.promise;
				if (code === "second") await releaseSecondOldResult.promise;
				kernel.alive = false;
				return { cancelled: true, value: "old kernel died" };
			}
			if (kernel.index === 1) {
				kernel.alive = false;
				return { cancelled: true, value: "first replacement died" };
			}
			return { cancelled: false, value: `recovered ${code}` };
		});

		try {
			const first = registry.executeOnSession("first", "/tmp", { sessionId: "stale-caller" });
			const second = registry.executeOnSession("second", "/tmp", { sessionId: "stale-caller" });
			await bothOldExecutionsStarted.promise;

			expect(await first).toEqual({ cancelled: true, value: "first replacement died" });
			releaseSecondOldResult.resolve();
			expect(await second).toEqual({ cancelled: false, value: "recovered second" });
			expect(executions).toEqual([
				{ code: "first", kernel: 0 },
				{ code: "second", kernel: 0 },
				{ code: "first", kernel: 1 },
				{ code: "second", kernel: 2 },
			]);
			expect(kernels).toHaveLength(3);
			expect(kernels[0]?.shutdowns).toBe(1);
			expect(kernels[1]?.shutdowns).toBe(1);
		} finally {
			releaseSecondOldResult.resolve();
			await registry.disposeAll();
		}
	});

	it("keeps a shared replacement alive when its initiating caller aborts", async () => {
		const replacementStarted = Promise.withResolvers<void>();
		const releaseReplacement = Promise.withResolvers<void>();
		const controller = new AbortController();
		const executions: Array<{ code: string; kernel: number }> = [];
		let replacementOptions: TestOptions | undefined;
		const { kernels, registry } = createFakeRegistry(
			async (kernel, code) => {
				executions.push({ code, kernel: kernel.index });
				if (kernel.index === 0) {
					kernel.alive = false;
					return { cancelled: true, value: "kernel died" };
				}
				return { cancelled: false, value: `recovered ${code}` };
			},
			async (kernel, options) => {
				if (kernel.index !== 1) return;
				replacementOptions = options;
				replacementStarted.resolve();
				await releaseReplacement.promise;
			},
		);

		try {
			const first = registry.executeOnSession("first", "/tmp", {
				sessionId: "independent-recovery",
				signal: controller.signal,
				deadlineMs: Date.now() + 60_000,
			});
			await replacementStarted.promise;
			const second = registry.executeOnSession("second", "/tmp", { sessionId: "independent-recovery" });
			await Promise.resolve();
			controller.abort(new Error("cancelled by caller"));

			let rejection: unknown;
			try {
				await first;
			} catch (error) {
				rejection = error;
			}
			expect(rejection).toBeInstanceOf(TestCancelledError);
			expect((rejection as TestCancelledError).timedOut).toBe(false);
			expect(replacementOptions?.signal).toBeUndefined();
			expect(replacementOptions?.deadlineMs).toBeUndefined();

			releaseReplacement.resolve();
			expect(await second).toEqual({ cancelled: false, value: "recovered second" });
			expect(executions).toEqual([
				{ code: "first", kernel: 0 },
				{ code: "second", kernel: 1 },
			]);
			expect(kernels).toHaveLength(2);
			expect(kernels[0]?.shutdowns).toBe(1);
		} finally {
			releaseReplacement.resolve();
			await registry.disposeAll();
		}
	});

	it("does not execute a retry when the caller aborts during replacement", async () => {
		const replacementStarted = Promise.withResolvers<void>();
		const releaseReplacement = Promise.withResolvers<void>();
		const controller = new AbortController();
		const executions: number[] = [];
		const { kernels, registry } = createFakeRegistry(
			async kernel => {
				executions.push(kernel.index);
				if (kernel.index === 0) kernel.alive = false;
				return { cancelled: true, value: "cancelled" };
			},
			async kernel => {
				if (kernel.index !== 1) return;
				replacementStarted.resolve();
				await releaseReplacement.promise;
			},
		);

		try {
			const execution = registry.executeOnSession("code", "/tmp", {
				sessionId: "abort-during-replacement",
				signal: controller.signal,
			});
			await replacementStarted.promise;
			controller.abort(new Error("cancelled by caller"));
			releaseReplacement.resolve();

			let rejection: unknown;
			try {
				await execution;
			} catch (error) {
				rejection = error;
			}
			expect(rejection).toBeInstanceOf(TestCancelledError);
			expect((rejection as TestCancelledError).timedOut).toBe(false);
			expect(executions).toEqual([0]);
			expect(kernels).toHaveLength(2);
		} finally {
			releaseReplacement.resolve();
			await registry.disposeAll();
		}
	});

	it("returns a cancelled replacement result without retrying again", async () => {
		const executions: number[] = [];
		const { kernels, registry } = createFakeRegistry(async kernel => {
			executions.push(kernel.index);
			if (kernel.index === 0) kernel.alive = false;
			return { cancelled: true, value: kernel.index === 0 ? "kernel died" : "replacement cancelled" };
		});

		try {
			const result = await registry.executeOnSession("code", "/tmp", { sessionId: "cancelled-retry" });

			expect(result).toEqual({ cancelled: true, value: "replacement cancelled" });
			expect(executions).toEqual([0, 1]);
			expect(kernels).toHaveLength(2);
		} finally {
			await registry.disposeAll();
		}
	});

	it("does not retry a dead-kernel cancellation after the caller aborts", async () => {
		const controller = new AbortController();
		const executions: number[] = [];
		const { kernels, registry } = createFakeRegistry(async kernel => {
			executions.push(kernel.index);
			kernel.alive = false;
			controller.abort(new Error("cancelled by caller"));
			return { cancelled: true, value: "cancelled" };
		});

		try {
			const result = await registry.executeOnSession("code", "/tmp", {
				sessionId: "abort",
				signal: controller.signal,
			});

			expect(result).toEqual({ cancelled: true, value: "cancelled" });
			expect(executions).toEqual([0]);
			expect(kernels).toHaveLength(1);
		} finally {
			await registry.disposeAll();
		}
	});

	it("preserves a timed-out dead-kernel result without retrying past its deadline", async () => {
		const executions: number[] = [];
		const { kernels, registry } = createFakeRegistry(async kernel => {
			executions.push(kernel.index);
			kernel.alive = false;
			return { cancelled: true, value: "partial output and timeout annotation" };
		});

		try {
			const result = await registry.executeOnSession("code", "/tmp", {
				sessionId: "expired-deadline",
				deadlineMs: Date.now() - 1,
			});

			expect(result).toEqual({ cancelled: true, value: "partial output and timeout annotation" });
			expect(executions).toEqual([0]);
			expect(kernels).toHaveLength(1);
		} finally {
			await registry.disposeAll();
		}
	});

	it("preserves a dead-kernel result when its deadline expires during replacement", async () => {
		vi.useFakeTimers();
		const replacementStarted = Promise.withResolvers<void>();
		const releaseReplacement = Promise.withResolvers<void>();
		const executions: number[] = [];
		const { kernels, registry } = createFakeRegistry(
			async kernel => {
				executions.push(kernel.index);
				kernel.alive = false;
				return { cancelled: true, value: "partial output before replacement timeout" };
			},
			async kernel => {
				if (kernel.index !== 1) return;
				replacementStarted.resolve();
				await releaseReplacement.promise;
			},
		);

		try {
			const execution = registry.executeOnSession("code", "/tmp", {
				sessionId: "deadline-during-replacement",
				deadlineMs: Date.now() + 60_000,
			});
			await replacementStarted.promise;
			vi.advanceTimersByTime(60_000);

			expect(await execution).toEqual({
				cancelled: true,
				value: "partial output before replacement timeout",
			});
			expect(executions).toEqual([0]);
			expect(kernels).toHaveLength(2);
		} finally {
			releaseReplacement.resolve();
			vi.useRealTimers();
			await registry.disposeAll();
		}
	});

	it("preserves a dead-kernel result when the retry reaches its deadline", async () => {
		vi.useFakeTimers();
		const retryStarted = Promise.withResolvers<void>();
		const releaseRetry = Promise.withResolvers<void>();
		const executions: number[] = [];
		const { kernels, registry } = createFakeRegistry(async kernel => {
			executions.push(kernel.index);
			if (kernel.index === 0) {
				kernel.alive = false;
				return { cancelled: true, value: "original partial output" };
			}
			retryStarted.resolve();
			await releaseRetry.promise;
			return { cancelled: true, value: "replacement timeout without original output" };
		});

		try {
			const execution = registry.executeOnSession("code", "/tmp", {
				sessionId: "deadline-during-retry",
				deadlineMs: Date.now() + 60_000,
			});
			await retryStarted.promise;
			vi.advanceTimersByTime(60_000);
			releaseRetry.resolve();

			expect(await execution).toEqual({ cancelled: true, value: "original partial output" });
			expect(executions).toEqual([0, 1]);
			expect(kernels).toHaveLength(2);
		} finally {
			releaseRetry.resolve();
			vi.useRealTimers();
			await registry.disposeAll();
		}
	});

	it("preserves retry for an exception thrown by a dead kernel", async () => {
		const executions: number[] = [];
		const { kernels, registry } = createFakeRegistry(async kernel => {
			executions.push(kernel.index);
			if (kernel.index === 0) {
				kernel.alive = false;
				throw new Error("transport closed");
			}
			return { cancelled: false, value: "recovered" };
		});

		try {
			const result = await registry.executeOnSession("code", "/tmp", { sessionId: "throw" });

			expect(result).toEqual({ cancelled: false, value: "recovered" });
			expect(executions).toEqual([0, 1]);
			expect(kernels).toHaveLength(2);
		} finally {
			await registry.disposeAll();
		}
	});

	it("keeps disposeAll pending until an in-flight replacement shuts down", async () => {
		const replacementStarted = Promise.withResolvers<void>();
		const releaseReplacement = Promise.withResolvers<void>();
		const controller = new AbortController();
		const { kernels, registry } = createFakeRegistry(
			async kernel => {
				if (kernel.index === 0) kernel.alive = false;
				return { cancelled: true, value: "kernel died" };
			},
			async kernel => {
				if (kernel.index !== 1) return;
				replacementStarted.resolve();
				await releaseReplacement.promise;
			},
		);
		let disposal: Promise<void> | undefined;

		try {
			const execution = registry.executeOnSession("code", "/tmp", {
				sessionId: "dispose-all-replacement",
				signal: controller.signal,
			});
			await replacementStarted.promise;
			controller.abort(new Error("caller left"));
			await expect(execution).rejects.toBeInstanceOf(TestCancelledError);

			disposal = registry.disposeAll();
			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			const resolvedBeforeReplacement = await Promise.race([
				disposal.then(() => true),
				nextTurn.promise.then(() => false),
			]);
			expect(resolvedBeforeReplacement).toBe(false);
			expect(kernels[1]?.shutdowns).toBe(0);

			releaseReplacement.resolve();
			await disposal;
			expect(kernels[1]?.shutdowns).toBe(1);
			expect(kernels[1]?.alive).toBe(false);
		} finally {
			controller.abort(new Error("test cleanup"));
			releaseReplacement.resolve();
			if (disposal) await disposal;
			await registry.disposeAll();
		}
	});

	it("keeps last-owner disposal pending for its replacement without awaiting another owner", async () => {
		const targetReplacementStarted = Promise.withResolvers<void>();
		const releaseTargetReplacement = Promise.withResolvers<void>();
		const unrelatedReplacementStarted = Promise.withResolvers<void>();
		const releaseUnrelatedReplacement = Promise.withResolvers<void>();
		const targetController = new AbortController();
		const unrelatedController = new AbortController();
		const { kernels, registry } = createFakeRegistry(
			async kernel => {
				if (kernel.index === 0 || kernel.index === 2) kernel.alive = false;
				return { cancelled: true, value: "kernel died" };
			},
			async kernel => {
				if (kernel.index === 1) {
					targetReplacementStarted.resolve();
					await releaseTargetReplacement.promise;
				}
				if (kernel.index === 3) {
					unrelatedReplacementStarted.resolve();
					await releaseUnrelatedReplacement.promise;
				}
			},
		);
		let disposal: Promise<void> | undefined;

		try {
			const targetExecution = registry.executeOnSession("target", "/tmp", {
				sessionId: "target-session",
				kernelOwnerId: "target-owner",
				signal: targetController.signal,
			});
			await targetReplacementStarted.promise;
			targetController.abort(new Error("target caller left"));
			await expect(targetExecution).rejects.toBeInstanceOf(TestCancelledError);

			const unrelatedExecution = registry.executeOnSession("unrelated", "/tmp", {
				sessionId: "unrelated-session",
				kernelOwnerId: "unrelated-owner",
				signal: unrelatedController.signal,
			});
			await unrelatedReplacementStarted.promise;
			unrelatedController.abort(new Error("unrelated caller left"));
			await expect(unrelatedExecution).rejects.toBeInstanceOf(TestCancelledError);

			disposal = registry.disposeByOwner("target-owner");
			const targetNextTurn = Promise.withResolvers<void>();
			setImmediate(targetNextTurn.resolve);
			const resolvedBeforeTargetReplacement = await Promise.race([
				disposal.then(() => true),
				targetNextTurn.promise.then(() => false),
			]);
			expect(resolvedBeforeTargetReplacement).toBe(false);
			expect(kernels[1]?.shutdowns).toBe(0);
			releaseTargetReplacement.resolve();
			const unrelatedNextTurn = Promise.withResolvers<void>();
			setImmediate(unrelatedNextTurn.resolve);
			const resolvedBeforeUnrelatedReplacement = await Promise.race([
				disposal.then(() => true),
				unrelatedNextTurn.promise.then(() => false),
			]);
			expect(resolvedBeforeUnrelatedReplacement).toBe(true);
			expect(kernels[1]?.shutdowns).toBe(1);
			expect(kernels[1]?.alive).toBe(false);
			expect(kernels[3]?.shutdowns).toBe(0);
			expect(kernels[3]?.alive).toBe(true);
		} finally {
			targetController.abort(new Error("test cleanup"));
			unrelatedController.abort(new Error("test cleanup"));
			releaseTargetReplacement.resolve();
			releaseUnrelatedReplacement.resolve();
			if (disposal) await disposal;
			await registry.disposeAll();
		}
	});
});
