import { describe, expect, it, vi } from "bun:test";
import { MAX_TIMER_DELAY_MS } from "@oh-my-pi/pi-utils";
import {
	createKernelSessionRegistry,
	type KernelSession,
	type KernelSessionRegistry,
} from "../../src/eval/kernel-session-registry";
import { rejectionWithin } from "../helpers/rejection";
import { collected } from "../helpers/gc";
import { waitUntil } from "../helpers/wait-until";

interface TestOptions {
	sessionId?: string;
	kernelOwnerId?: string;
	interpreter?: string;
	reset?: boolean;
	signal?: AbortSignal;
	deadlineMs?: number;
	kernelIdleShutdownMs?: number;
	claimKernelRestartNotice?: () => boolean;
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

type FakeRegistry = KernelSessionRegistry<FakeKernel, TestOptions, TestResult, KernelSession<FakeKernel>>;

function createFakeRegistry(
	executeWithKernel: ExecuteFakeKernel,
	onStartKernel?: StartFakeKernel,
	canShutdownIdle?: (session: KernelSession<FakeKernel>) => Promise<boolean>,
): { kernels: FakeKernel[]; registry: FakeRegistry } {
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
		canShutdownIdle,
	});
	return { kernels, registry };
}

/** Kept out of the test body so no strong local binding outlives the capture. */
function weakRefToPresentSession(registry: FakeRegistry, options: TestOptions): WeakRef<object> {
	const session = registry.getPresentSession("/tmp", options);
	if (!session) throw new Error("no present session to observe");
	return new WeakRef(session);
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

describe("kernel restart notice claim", () => {
	/** A cell in `failBeforeStart` throws before claiming (as a failing prelude does); one in `failAfterStart` claims, then throws. */
	function claimingRegistry(options?: {
		unconfirmedShutdown?: boolean;
		failBeforeStart?: string[];
		failAfterStart?: string[];
	}) {
		const { kernels, registry } = createFakeRegistry(
			async (_kernel, code, runOptions) => {
				if (options?.failBeforeStart?.includes(code)) throw new Error(`${code}: prelude failed`);
				const restarted = runOptions.claimKernelRestartNotice?.() ?? false;
				if (options?.failAfterStart?.includes(code)) throw new Error(`${code}: failed after start`);
				return { cancelled: false, value: restarted ? "notice" : "none" };
			},
			async kernel => {
				if (!options?.unconfirmedShutdown) return;
				kernel.shutdown = async () => {
					kernel.alive = false;
					kernel.shutdowns += 1;
					return { confirmed: false };
				};
			},
		);
		const cell = async (code: string, extra?: Partial<TestOptions>): Promise<string> =>
			(await registry.executeOnSession(code, "/tmp", { sessionId: "claimed", ...extra })).value;
		return { kernels, registry, cell };
	}

	it("gives the notice to the first cell on a replacement for a kernel that died between cells, once", async () => {
		const { kernels, registry, cell } = claimingRegistry();
		try {
			expect(await cell("first")).toBe("none");
			expect(await cell("second")).toBe("none");
			kernels[0]!.alive = false;
			expect(await cell("after death")).toBe("notice");
			expect(await cell("after notice")).toBe("none");
			expect(kernels).toHaveLength(2);
		} finally {
			await registry.disposeAll();
		}
	});

	it("leaves the notice for the next cell when a cell fails before it starts", async () => {
		const { kernels, registry, cell } = claimingRegistry({ failBeforeStart: ["prelude"] });
		try {
			expect(await cell("first")).toBe("none");
			kernels[0]!.alive = false;
			await expect(cell("prelude")).rejects.toThrow("prelude failed");
			expect(await cell("next")).toBe("notice");
			expect(await cell("after notice")).toBe("none");
		} finally {
			await registry.disposeAll();
		}
	});

	it("does not hand the notice back when the cell that claimed it throws after it starts", async () => {
		const { kernels, registry, cell } = claimingRegistry({ failAfterStart: ["throws"] });
		try {
			expect(await cell("first")).toBe("none");
			kernels[0]!.alive = false;
			await expect(cell("throws")).rejects.toThrow("failed after start");
			expect(await cell("next")).toBe("none");
		} finally {
			await registry.disposeAll();
		}
	});

	for (const disposal of ["disposeAll", "disposeByOwner"] as const) {
		it(`does not give the notice after ${disposal} restores a record whose shutdown was unconfirmed`, async () => {
			const { kernels, registry, cell } = claimingRegistry({ unconfirmedShutdown: true });
			try {
				expect(await cell("first", { kernelOwnerId: "owner" })).toBe("none");
				if (disposal === "disposeAll") await registry.disposeAll();
				else await registry.disposeByOwner("owner");
				expect(kernels[0]?.alive).toBe(false);
				expect(await cell("after disposal", { kernelOwnerId: "owner" })).toBe("none");
				expect(kernels).toHaveLength(2);
			} finally {
				for (const kernel of kernels) kernel.shutdown = FakeKernel.prototype.shutdown;
				await registry.disposeAll();
			}
		});
	}
});

describe("idle kernel shutdown", () => {
	const IDLE_MS = 20;

	function idleRegistry(
		canShutdownIdle?: (session: KernelSession<FakeKernel>) => Promise<boolean>,
		onStartKernel?: StartFakeKernel,
	) {
		const ran: Array<{ code: string; kernel: number; restarted: boolean }> = [];
		const gates = new Map<string, Promise<void>>();
		const { kernels, registry } = createFakeRegistry(
			async (kernel, code, runOptions) => {
				await gates.get(code);
				const restarted = runOptions.claimKernelRestartNotice?.() ?? false;
				ran.push({ code, kernel: kernel.index, restarted });
				return { cancelled: false, value: code };
			},
			onStartKernel,
			canShutdownIdle,
		);
		const cell = (code: string) =>
			registry.executeOnSession(code, "/tmp", { sessionId: "idle", kernelIdleShutdownMs: IDLE_MS });
		return { kernels, registry, ran, gates, cell };
	}

	/** Makes the kernel's next shutdown wait for `finish` after resolving `started`. */
	function gateShutdown(kernel: FakeKernel) {
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		kernel.shutdown = async () => {
			started.resolve();
			await finish.promise;
			kernel.alive = false;
			kernel.shutdowns += 1;
			return { confirmed: true };
		};
		return { started: started.promise, finish: finish.resolve };
	}

	it("shuts an idle kernel down and gives the next cell a fresh kernel with the restart notice", async () => {
		const { kernels, registry, ran, cell } = idleRegistry();
		try {
			await cell("setup");
			await waitUntil(() => kernels[0]?.alive === false);
			await cell("after idle");
			expect(ran).toEqual([
				{ code: "setup", kernel: 0, restarted: false },
				{ code: "after idle", kernel: 1, restarted: true },
			]);
		} finally {
			await registry.disposeAll();
		}
	});

	it("keeps the kernel while a cell runs past the idle window or a hold is open", async () => {
		const { kernels, registry, gates, cell } = idleRegistry();
		const slow = Promise.withResolvers<void>();
		gates.set("slow", slow.promise);
		try {
			const running = cell("slow");
			await Bun.sleep(IDLE_MS * 4);
			expect(kernels[0]?.alive).toBe(true);
			slow.resolve();
			await running;
			const release = await registry.holdSession("/tmp", { sessionId: "idle" });
			await Bun.sleep(IDLE_MS * 4);
			expect(kernels[0]?.alive).toBe(true);
			release();
			await waitUntil(() => kernels[0]?.alive === false);
		} finally {
			slow.resolve();
			await registry.disposeAll();
		}
	});

	it("makes a cell that arrives during the idle shutdown wait for it instead of running on the dying kernel", async () => {
		const { kernels, registry, ran, cell } = idleRegistry();
		let finishShutdown = (): void => {};
		try {
			await cell("setup");
			const shutdown = gateShutdown(kernels[0]!);
			finishShutdown = shutdown.finish;
			await shutdown.started;
			const late = cell("late");
			await Bun.sleep(IDLE_MS);
			expect(ran.map(entry => entry.code)).toEqual(["setup"]);
			finishShutdown();
			await late;
			expect(ran.at(-1)).toEqual({ code: "late", kernel: 1, restarted: true });
		} finally {
			finishShutdown();
			await registry.disposeAll();
		}
	});

	it("lets a caller stop waiting for an idle shutdown without cancelling it", async () => {
		const { kernels, registry, ran, cell } = idleRegistry();
		let finishShutdown = (): void => {};
		try {
			await cell("setup");
			const first = kernels[0]!;
			const shutdown = gateShutdown(first);
			finishShutdown = shutdown.finish;
			await shutdown.started;
			const controller = new AbortController();
			const aborted = registry.executeOnSession("aborted", "/tmp", {
				sessionId: "idle",
				kernelIdleShutdownMs: IDLE_MS,
				signal: controller.signal,
			});
			controller.abort();
			const expired = registry.executeOnSession("expired", "/tmp", {
				sessionId: "idle",
				kernelIdleShutdownMs: IDLE_MS,
				deadlineMs: Date.now() + IDLE_MS,
			});
			const abortError = await rejectionWithin(aborted, 500);
			expect(abortError).toBeInstanceOf(TestCancelledError);
			expect(abortError).toHaveProperty("timedOut", false);
			const deadlineError = await rejectionWithin(expired, 500);
			expect(deadlineError).toBeInstanceOf(TestCancelledError);
			expect(deadlineError).toHaveProperty("timedOut", true);
			expect(first.shutdowns).toBe(0);
			finishShutdown();
			await waitUntil(() => first.shutdowns === 1);
			await cell("after");
			expect(ran).toEqual([
				{ code: "setup", kernel: 0, restarted: false },
				{ code: "after", kernel: 1, restarted: true },
			]);
		} finally {
			finishShutdown();
			await registry.disposeAll();
		}
	});

	it("lets a hold stop waiting for an idle shutdown without leaving the session busy", async () => {
		const { kernels, registry, cell } = idleRegistry();
		let finishShutdown = (): void => {};
		try {
			await cell("setup");
			const first = kernels[0]!;
			const shutdown = gateShutdown(first);
			finishShutdown = shutdown.finish;
			await shutdown.started;
			const controller = new AbortController();
			const hold = registry.holdSession("/tmp", { sessionId: "idle", signal: controller.signal });
			controller.abort();
			const holdError = await rejectionWithin(hold, 500);
			expect(holdError).toBeInstanceOf(TestCancelledError);
			expect(holdError).toHaveProperty("timedOut", false);
			finishShutdown();
			await waitUntil(() => first.shutdowns === 1);
			await cell("after");
			await waitUntil(() => kernels[1]?.alive === false);
		} finally {
			finishShutdown();
			await registry.disposeAll();
		}
	});

	it("lets callers stop waiting for a kernel reset without cancelling it", async () => {
		const { kernels, registry, ran, cell } = idleRegistry();
		let finishShutdown = (): void => {};
		try {
			await cell("setup");
			const first = kernels[0]!;
			const shutdown = gateShutdown(first);
			finishShutdown = shutdown.finish;
			const resetController = new AbortController();
			const resetting = registry.executeOnSession("reset", "/tmp", {
				sessionId: "idle",
				kernelIdleShutdownMs: IDLE_MS,
				reset: true,
				signal: resetController.signal,
			});
			await shutdown.started;
			const waitingController = new AbortController();
			const waiting = registry.executeOnSession("waiting", "/tmp", {
				sessionId: "idle",
				kernelIdleShutdownMs: IDLE_MS,
				signal: waitingController.signal,
			});
			resetController.abort();
			waitingController.abort();
			expect(await rejectionWithin(resetting, 500)).toBeInstanceOf(TestCancelledError);
			expect(await rejectionWithin(waiting, 500)).toBeInstanceOf(TestCancelledError);
			expect(first.shutdowns).toBe(0);
			finishShutdown();
			await waitUntil(() => first.shutdowns === 1);
			await cell("after");
			expect(ran.map(entry => [entry.code, entry.kernel])).toEqual([
				["setup", 0],
				["after", 1],
			]);
		} finally {
			finishShutdown();
			await registry.disposeAll();
		}
	});

	it("arms the idle timer for a replacement kernel that starts after its only caller stopped waiting", async () => {
		const startGate = Promise.withResolvers<void>();
		const { kernels, registry, ran, cell } = idleRegistry(undefined, async kernel => {
			if (kernel.index === 1) await startGate.promise;
		});
		try {
			await cell("setup");
			kernels[0]!.alive = false;
			const controller = new AbortController();
			const aborted = registry.executeOnSession("aborted", "/tmp", {
				sessionId: "idle",
				kernelIdleShutdownMs: IDLE_MS,
				signal: controller.signal,
			});
			await waitUntil(() => kernels.length === 2);
			controller.abort();
			expect(await rejectionWithin(aborted, 500)).toBeInstanceOf(TestCancelledError);
			startGate.resolve();
			await waitUntil(() => kernels[1]?.alive === false);
			expect(kernels[1]?.shutdowns).toBe(1);
			expect(ran.map(entry => entry.code)).toEqual(["setup"]);
		} finally {
			startGate.resolve();
			await registry.disposeAll();
		}
	});

	it("retries an idle shutdown that left the kernel running after another idle window", async () => {
		const { kernels, registry, cell } = idleRegistry();
		try {
			await cell("setup");
			const first = kernels[0]!;
			let attempts = 0;
			first.shutdown = async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("kill failed");
				first.alive = false;
				first.shutdowns += 1;
				return { confirmed: true };
			};
			await waitUntil(() => first.alive === false);
			expect(attempts).toBe(2);
		} finally {
			await registry.disposeAll();
		}
	});

	it("keeps a vetoed kernel and retries after another idle window", async () => {
		let vetoes = 0;
		const { kernels, registry, cell } = idleRegistry(async () => {
			vetoes += 1;
			return vetoes > 1;
		});
		try {
			await cell("setup");
			await waitUntil(() => vetoes === 1);
			expect(kernels[0]?.alive).toBe(true);
			await waitUntil(() => kernels[0]?.alive === false);
			expect(vetoes).toBe(2);
		} finally {
			await registry.disposeAll();
		}
	});

	it("discards an idle-shutdown approval when a cell ran while the probe was pending", async () => {
		const firstProbe = Promise.withResolvers<boolean>();
		let probes = 0;
		const { kernels, registry, ran, cell } = idleRegistry(() => {
			probes += 1;
			return probes === 1 ? firstProbe.promise : Promise.resolve(true);
		});
		try {
			await cell("setup");
			await waitUntil(() => probes === 1);
			await cell("during probe");
			firstProbe.resolve(true);
			await Bun.sleep(0);
			expect(kernels[0]?.alive).toBe(true);
			// Only the idle timer the second cell re-armed may reap, after its own full window.
			await waitUntil(() => kernels[0]?.alive === false);
			expect(probes).toBe(2);
			expect(ran.map(entry => entry.kernel)).toEqual([0, 0]);
		} finally {
			firstProbe.resolve(false);
			await registry.disposeAll();
		}
	});

	it("releases an owner-disposed session without waiting for its idle timer", async () => {
		const { registry } = createFakeRegistry(async (_kernel, code) => ({ cancelled: false, value: code }));
		const options: TestOptions = { sessionId: "owned", kernelOwnerId: "owner", kernelIdleShutdownMs: 60_000 };
		try {
			await registry.executeOnSession("setup", "/tmp", options);
			const sessionRef = weakRefToPresentSession(registry, options);
			await registry.disposeByOwner("owner");
			// Conservative GC roots can pin the startup record for a few seconds; the bound only has to
			// stay well under the 60s idle timer that would otherwise keep the session reachable.
			expect(await collected(sessionRef, 15_000, { intervalMs: 50 })).toBe(true);
		} finally {
			await registry.disposeAll();
		}
	}, 20_000);

	it("keeps a kernel through an idle window longer than the native timer limit", async () => {
		const idleMs = 30 * 24 * 60 * 60 * 1000;
		vi.useFakeTimers();
		const { kernels, registry } = createFakeRegistry(async (_kernel, code) => ({ cancelled: false, value: code }));
		try {
			await registry.executeOnSession("setup", "/tmp", { sessionId: "long", kernelIdleShutdownMs: idleMs });
			vi.advanceTimersByTime(MAX_TIMER_DELAY_MS + 1_000);
			expect(kernels[0]?.alive).toBe(true);
			vi.advanceTimersByTime(idleMs - MAX_TIMER_DELAY_MS - 2_000);
			expect(kernels[0]?.alive).toBe(true);
			vi.advanceTimersByTime(2_000);
			expect(kernels[0]?.alive).toBe(false);
		} finally {
			vi.useRealTimers();
			await registry.disposeAll();
		}
	});
});
