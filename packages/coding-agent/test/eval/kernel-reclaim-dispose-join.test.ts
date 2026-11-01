import { describe, expect, it } from "bun:test";
import { createKernelSessionRegistry, type KernelSession } from "../../src/eval/kernel-session-registry";
import { setSupersededKernelGraceMs } from "../../src/eval/superseded-reclaim";

/**
 * What an owner's disposal promises: when it returns, the runners that owner
 * was using are down.
 *
 * A reclaim removes its session from the registry *before* it awaits the
 * shutdown, so for the length of that shutdown the only handle on a live
 * runner is the reclaim's own stack. A disposal that sweeps the registry finds
 * nothing to shut down and returns while the runner is still alive — measured
 * against a real Python runner as a 153ms return with the old pid still in
 * `S`, where the merge base waited 2,195ms and the pid was gone, and as a
 * runner that survives a `SIGKILL` of its host for the whole observation.
 */

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

/**
 * A kernel whose shutdown is held open by the test, so "is the runner still
 * alive?" has an exact answer at every point rather than a timing guess.
 */
class HeldKernel {
	alive = true;
	/** Resolves when this kernel's shutdown has been entered. */
	readonly entered = Promise.withResolvers<void>();
	/** The test resolves this to let the shutdown finish. */
	readonly release = Promise.withResolvers<void>();

	constructor(
		readonly held: boolean,
		readonly ended: string[],
		readonly label: string,
	) {}

	isAlive(): boolean {
		return this.alive;
	}

	hasPendingWork(): boolean {
		return false;
	}

	async shutdown(): Promise<{ confirmed: boolean }> {
		this.entered.resolve();
		if (this.held) await this.release.promise;
		this.alive = false;
		this.ended.push(this.label);
		return { confirmed: true };
	}
}

function createRegistry() {
	const kernels: HeldKernel[] = [];
	const ended: string[] = [];
	const registry = createKernelSessionRegistry<HeldKernel, TestOptions, TestResult, KernelSession<HeldKernel>>({
		languageLabel: "Test",
		cancelledErrorClass: TestCancelledError,
		buildSessionKey: (sessionId, cwd) => `${sessionId}:${cwd}`,
		createSession: session => session,
		startKernel: async () => {
			// Only the kernel the owner walks away from is held open: it is the
			// one the reaper shuts down while the disposal runs.
			const kernel = new HeldKernel(kernels.length === 0, ended, `kernel-${kernels.length}`);
			kernels.push(kernel);
			return kernel;
		},
		executeWithKernel: async (_kernel, code) => ({ cancelled: false, value: code }),
	});
	return { kernels, ended, registry };
}

/** Drain the microtask queue so a promise that can settle has settled. */
async function settleMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
}

describe("owner disposal and an in-flight reclaim", () => {
	it("does not return while the reclaim it raced is still shutting the kernel down", async () => {
		// The grace is a real timer, which is the behaviour under test; every
		// other wait below is on the event the code itself signals.
		setSupersededKernelGraceMs(5);
		const { kernels, ended, registry } = createRegistry();
		const stranded = (): HeldKernel => {
			const kernel = kernels[0];
			if (!kernel) throw new Error("no kernel was started");
			return kernel;
		};
		try {
			const owner = "agent-session:join";
			await registry.executeOnSession("first", "/one", { sessionId: "s", kernelOwnerId: owner });
			// The owner's next cell lands at another key, which arms the kernel
			// it left behind. Past the grace the reaper enters that kernel's
			// shutdown and stays inside it until this test lets go.
			await registry.executeOnSession("second", "/two", { sessionId: "s", kernelOwnerId: owner });
			await stranded().entered.promise;

			let disposed = false;
			const disposal = registry.disposeByOwner(owner).then(() => {
				disposed = true;
			});
			await settleMicrotasks();
			// The runner is provably still up, so a disposal that has returned
			// has returned a false statement.
			expect(stranded().alive).toBe(true);
			expect(disposed).toBe(false);

			stranded().release.resolve();
			await disposal;
			expect(stranded().alive).toBe(false);
			expect(kernels.every(kernel => !kernel.alive)).toBe(true);
			// The kernel the reclaim owned is down first: the disposal joined it
			// rather than passing it.
			expect(ended[0]).toBe("kernel-0");
		} finally {
			setSupersededKernelGraceMs();
			for (const kernel of kernels) kernel.release.resolve();
			await registry.disposeAll();
		}
	}, 30_000);
});
