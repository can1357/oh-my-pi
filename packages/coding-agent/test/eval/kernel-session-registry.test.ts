import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setSupersededKernelGraceMs } from "../../src/eval/superseded-reclaim";
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
	pendingWork = false;
	readonly executions: string[] = [];

	constructor(readonly index: number) {}

	isAlive(): boolean {
		return this.alive;
	}

	hasPendingWork(): boolean {
		return this.pendingWork;
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
	it("preserves partial output without replaying side effects and recovers on the next call", async () => {
		const effects: string[] = [];
		const { kernels, registry } = createFakeRegistry(async (kernel, code) => {
			effects.push(code);
			if (kernel.index === 0) {
				kernel.alive = false;
				return { cancelled: true, value: "partial output before death" };
			}
			return { cancelled: false, value: "new cell completed" };
		});
		try {
			expect(await registry.executeOnSession("first effect", "/tmp", { sessionId: "recovery" })).toEqual({
				cancelled: true,
				value: "partial output before death",
			});
			expect(effects).toEqual(["first effect"]);
			expect(kernels).toHaveLength(1);
			expect(await registry.executeOnSession("next effect", "/tmp", { sessionId: "recovery" })).toEqual({
				cancelled: false,
				value: "new cell completed",
			});
			expect(effects).toEqual(["first effect", "next effect"]);
			expect(kernels[0]?.shutdowns).toBe(1);
		} finally {
			await registry.disposeAll();
		}
	});

	it("coalesces concurrent recovery before dispatch to a dead kernel", async () => {
		const replacementStarted = Promise.withResolvers<void>();
		const releaseReplacement = Promise.withResolvers<void>();
		const executions: string[] = [];
		const { kernels, registry } = createFakeRegistry(
			async (_kernel, code) => {
				executions.push(code);
				return { cancelled: false, value: code };
			},
			async kernel => {
				if (kernel.index === 0) kernel.alive = false;
				if (kernel.index !== 1) return;
				replacementStarted.resolve();
				await releaseReplacement.promise;
			},
		);
		try {
			const first = registry.executeOnSession("first", "/tmp", { sessionId: "concurrent" });
			await replacementStarted.promise;
			const second = registry.executeOnSession("second", "/tmp", { sessionId: "concurrent" });
			releaseReplacement.resolve();
			expect(await Promise.all([first, second])).toEqual([
				{ cancelled: false, value: "first" },
				{ cancelled: false, value: "second" },
			]);
			expect(executions.sort()).toEqual(["first", "second"]);
			expect(kernels).toHaveLength(2);
			expect(kernels[0]?.shutdowns).toBe(1);
		} finally {
			releaseReplacement.resolve();
			await registry.disposeAll();
		}
	});

	it("does not replay a stale execution after a newer call replaces its dead kernel", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const effects: string[] = [];
		const { registry } = createFakeRegistry(async (kernel, code) => {
			effects.push(code);
			if (code === "old") {
				kernel.alive = false;
				started.resolve();
				await release.promise;
				return { cancelled: true, value: "old partial output" };
			}
			return { cancelled: false, value: "new result" };
		});
		try {
			const old = registry.executeOnSession("old", "/tmp", { sessionId: "stale" });
			await started.promise;
			expect(await registry.executeOnSession("new", "/tmp", { sessionId: "stale" })).toEqual({
				cancelled: false,
				value: "new result",
			});
			release.resolve();
			expect(await old).toEqual({ cancelled: true, value: "old partial output" });
			expect(effects).toEqual(["old", "new"]);
		} finally {
			release.resolve();
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
				if (kernel.index === 0) kernel.alive = false;
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
			expect(executions).toEqual([{ code: "second", kernel: 1 }]);
			expect(kernels).toHaveLength(2);
			expect(kernels[0]?.shutdowns).toBe(1);
		} finally {
			releaseReplacement.resolve();
			await registry.disposeAll();
		}
	});

	it("does not dispatch a cell when the caller aborts during replacement", async () => {
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
				if (kernel.index === 0) kernel.alive = false;
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
			expect(executions).toEqual([]);
			expect(kernels).toHaveLength(2);
		} finally {
			releaseReplacement.resolve();
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

	it("times out while acquiring a replacement without dispatching the cell", async () => {
		const replacementStarted = Promise.withResolvers<void>();
		const releaseReplacement = Promise.withResolvers<void>();
		const executions: string[] = [];
		const { registry } = createFakeRegistry(
			async (_kernel, code) => {
				executions.push(code);
				return { cancelled: false, value: code };
			},
			async kernel => {
				if (kernel.index === 0) kernel.alive = false;
				if (kernel.index !== 1) return;
				replacementStarted.resolve();
				await releaseReplacement.promise;
			},
		);
		try {
			const execution = registry.executeOnSession("expired", "/tmp", {
				sessionId: "deadline",
				deadlineMs: Date.now() + 200,
			});
			await replacementStarted.promise;
			await expect(execution).rejects.toMatchObject({ timedOut: true });
			expect(executions).toEqual([]);
			releaseReplacement.resolve();
			expect(await registry.executeOnSession("next", "/tmp", { sessionId: "deadline" })).toEqual({
				cancelled: false,
				value: "next",
			});
			expect(executions).toEqual(["next"]);
		} finally {
			releaseReplacement.resolve();
			await registry.disposeAll();
		}
	});

	it("surfaces uncertain completion after an exception without replaying effects", async () => {
		const effects: string[] = [];
		const failure = new Error("transport closed");
		const { registry } = createFakeRegistry(async (kernel, code) => {
			effects.push(code);
			if (kernel.index === 0) {
				kernel.alive = false;
				throw failure;
			}
			return { cancelled: false, value: "recovered" };
		});
		try {
			await expect(registry.executeOnSession("first", "/tmp", { sessionId: "throw" })).rejects.toMatchObject({
				cause: failure,
				message: expect.stringContaining("completion is uncertain"),
			});
			expect(effects).toEqual(["first"]);
			expect(await registry.executeOnSession("next", "/tmp", { sessionId: "throw" })).toEqual({
				cancelled: false,
				value: "recovered",
			});
			expect(effects).toEqual(["first", "next"]);
		} finally {
			await registry.disposeAll();
		}
	});

	it("keeps disposeAll pending until an in-flight replacement shuts down", async () => {
		const replacementStarted = Promise.withResolvers<void>();
		const releaseReplacement = Promise.withResolvers<void>();
		const controller = new AbortController();
		const { kernels, registry } = createFakeRegistry(
			async () => {
				return { cancelled: true, value: "kernel died" };
			},
			async kernel => {
				if (kernel.index === 0) kernel.alive = false;
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
			async () => {
				return { cancelled: true, value: "kernel died" };
			},
			async kernel => {
				if (kernel.index === 0 || kernel.index === 2) kernel.alive = false;
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

// The reclaim is deliberately deferred, so these exercise a real timer. The
// grace is shortened to milliseconds and `settleGrace` waits several of them,
// which is the behaviour under test rather than a guess at a race.
const TEST_GRACE_MS = 50;

async function settleGrace(): Promise<void> {
	await Bun.sleep(TEST_GRACE_MS * 8);
}

describe("kernel session reclamation", () => {
	beforeEach(() => setSupersededKernelGraceMs(TEST_GRACE_MS));
	afterEach(() => setSupersededKernelGraceMs());

	it("shuts down the kernel an owner left behind under another session key", async () => {
		const { kernels, registry } = createFakeRegistry(async (_kernel, code) => ({ cancelled: false, value: code }));
		try {
			await registry.executeOnSession("in first dir", "/tmp/a", {
				sessionId: "left-behind:cwd:/tmp/a",
				kernelOwnerId: "agent-session:one",
			});
			await registry.executeOnSession("in second dir", "/tmp/b", {
				sessionId: "left-behind:cwd:/tmp/b",
				kernelOwnerId: "agent-session:one",
			});
			expect(kernels).toHaveLength(2);
			expect(kernels[0]?.alive).toBe(true);
			await settleGrace();
			expect(kernels[0]?.shutdowns).toBe(1);
			expect(kernels[0]?.alive).toBe(false);
			expect(kernels[1]?.alive).toBe(true);
		} finally {
			await registry.disposeAll();
		}
	});

	it("keeps a kernel that is still running a cell for the same owner", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { kernels, registry } = createFakeRegistry(async (kernel, code) => {
			if (kernel.index !== 0) return { cancelled: false, value: code };
			kernel.pendingWork = true;
			started.resolve();
			await release.promise;
			kernel.pendingWork = false;
			return { cancelled: false, value: code };
		});
		try {
			const slow = registry.executeOnSession("slow cell", "/tmp/a", {
				sessionId: "still-busy:cwd:/tmp/a",
				kernelOwnerId: "agent-session:one",
			});
			// Only once the cell is running is the first session registered and
			// its kernel reporting pending work, so the guard is actually asked.
			await started.promise;
			await registry.executeOnSession("next dir", "/tmp/b", {
				sessionId: "still-busy:cwd:/tmp/b",
				kernelOwnerId: "agent-session:one",
			});
			await settleGrace();
			expect(kernels[0]?.shutdowns).toBe(0);
			expect(kernels[0]?.alive).toBe(true);
			release.resolve();
			expect(await slow).toEqual({ cancelled: false, value: "slow cell" });
		} finally {
			release.resolve();
			await registry.disposeAll();
		}
	});

	it("keeps a kernel a borrower holds, and reclaims it once the borrow is released", async () => {
		const { kernels, registry } = createFakeRegistry(async (_kernel, code) => ({ cancelled: false, value: code }));
		try {
			await registry.executeOnSession("first dir", "/tmp/a", {
				sessionId: "borrowed:cwd:/tmp/a",
				kernelOwnerId: "agent-session:one",
			});
			const release = registry.borrowSession("/tmp/a", { sessionId: "borrowed:cwd:/tmp/a" });
			await registry.executeOnSession("second dir", "/tmp/b", {
				sessionId: "borrowed:cwd:/tmp/b",
				kernelOwnerId: "agent-session:one",
			});
			await settleGrace();
			expect(kernels[0]?.shutdowns).toBe(0);
			expect(kernels[0]?.alive).toBe(true);

			release();
			await registry.executeOnSession("third cell", "/tmp/b", {
				sessionId: "borrowed:cwd:/tmp/b",
				kernelOwnerId: "agent-session:one",
			});
			await settleGrace();
			expect(kernels[0]?.shutdowns).toBe(1);
			expect(kernels[0]?.alive).toBe(false);
		} finally {
			await registry.disposeAll();
		}
	});

	it("keeps a superseded kernel and its state when the owner returns inside the grace", async () => {
		setSupersededKernelGraceMs(60_000);
		const { kernels, registry } = createFakeRegistry(async (kernel, code) => {
			kernel.executions.push(code);
			return { cancelled: false, value: code };
		});
		try {
			await registry.executeOnSession("in first dir", "/tmp/a", {
				sessionId: "roundtrip:cwd:/tmp/a",
				kernelOwnerId: "agent-session:one",
			});
			await registry.executeOnSession("in second dir", "/tmp/b", {
				sessionId: "roundtrip:cwd:/tmp/b",
				kernelOwnerId: "agent-session:one",
			});
			await registry.executeOnSession("back in first dir", "/tmp/a", {
				sessionId: "roundtrip:cwd:/tmp/a",
				kernelOwnerId: "agent-session:one",
			});
			// Same kernel, so the namespace the first cell built is still there.
			expect(kernels).toHaveLength(2);
			expect(kernels[0]?.executions).toEqual(["in first dir", "back in first dir"]);
			expect(kernels[0]?.shutdowns).toBe(0);
		} finally {
			await registry.disposeAll();
		}
	});

	it("shuts a superseded kernel down even if its dispose arrives first", async () => {
		setSupersededKernelGraceMs(60_000);
		const { kernels, registry } = createFakeRegistry(async (_kernel, code) => ({ cancelled: false, value: code }));
		await registry.executeOnSession("in first dir", "/tmp/a", {
			sessionId: "disposed:cwd:/tmp/a",
			kernelOwnerId: "agent-session:one",
		});
		await registry.executeOnSession("in second dir", "/tmp/b", {
			sessionId: "disposed:cwd:/tmp/b",
			kernelOwnerId: "agent-session:one",
		});
		expect(kernels[0]?.alive).toBe(true);
		await registry.disposeAll();
		expect(kernels[0]?.alive).toBe(false);
		expect(kernels[1]?.alive).toBe(false);
	});

	it("keeps a kernel a concurrent cell of the same owner is still acquiring", async () => {
		const { kernels, registry } = createFakeRegistry(async (kernel, code) => {
			kernel.executions.push(code);
			return { cancelled: false, value: code };
		});
		try {
			await registry.executeOnSession("warm the first dir", "/tmp/a", {
				sessionId: "racing:cwd:/tmp/a",
				kernelOwnerId: "agent-session:one",
			});
			// Both start in one tick: the first is inside its acquire when the
			// second reclaims, which is exactly the window a hold must cover.
			const inFirstDir = registry.executeOnSession("first dir", "/tmp/a", {
				sessionId: "racing:cwd:/tmp/a",
				kernelOwnerId: "agent-session:one",
			});
			const inSecondDir = registry.executeOnSession("second dir", "/tmp/b", {
				sessionId: "racing:cwd:/tmp/b",
				kernelOwnerId: "agent-session:one",
			});
			// The first cell must run to completion on the kernel it acquired,
			// not come back cancelled because the second reclaimed it mid-flight.
			expect(await inFirstDir).toEqual({ cancelled: false, value: "first dir" });
			expect(await inSecondDir).toEqual({ cancelled: false, value: "second dir" });
			expect(kernels[0]?.executions).toEqual(["warm the first dir", "first dir"]);
		} finally {
			await registry.disposeAll();
		}
	});

	it("reclaims nothing when the caller has no explicit owner id", async () => {
		const { kernels, registry } = createFakeRegistry(async (_kernel, code) => ({ cancelled: false, value: code }));
		try {
			await registry.executeOnSession("first dir", "/tmp/a", { sessionId: "anonymous" });
			await registry.executeOnSession("second dir", "/tmp/b", { sessionId: "anonymous:other" });
			await settleGrace();
			expect(kernels[0]?.shutdowns).toBe(0);
			expect(kernels[0]?.alive).toBe(true);
		} finally {
			await registry.disposeAll();
		}
	});

	it("keeps a kernel a second owner still holds", async () => {
		const { kernels, registry } = createFakeRegistry(async (_kernel, code) => ({ cancelled: false, value: code }));
		try {
			const shared = { sessionId: "co-owned:cwd:/tmp/a" };
			await registry.executeOnSession("first owner", "/tmp/a", {
				...shared,
				kernelOwnerId: "agent-session:one",
			});
			await registry.executeOnSession("second owner", "/tmp/a", {
				...shared,
				kernelOwnerId: "agent-session:two",
			});
			await registry.executeOnSession("first owner moves", "/tmp/b", {
				sessionId: "co-owned:cwd:/tmp/b",
				kernelOwnerId: "agent-session:one",
			});
			await settleGrace();
			expect(kernels).toHaveLength(2);
			expect(kernels[0]?.shutdowns).toBe(0);
			expect(kernels[0]?.alive).toBe(true);
		} finally {
			await registry.disposeAll();
		}
	});
});
