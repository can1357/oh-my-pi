import { afterEach, describe, expect, it } from "bun:test";
import { createKernelSessionRegistry, type KernelSession } from "../../src/eval/kernel-session-registry";
import { setSupersededKernelGraceMs } from "../../src/eval/superseded-reclaim";

/**
 * What an owner's disposal promises: when it returns, the runners that owner
 * was using are down, or, where a runner cannot be proved down, still held
 * where the next disposal reaches it.
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
	claimKernelNotice?: () => string | undefined;
}

interface TestResult {
	cancelled: boolean;
	value: string;
	/** The reclaim notice the cell opened with, if any. */
	notice: string | undefined;
}

class TestCancelledError extends Error {
	constructor(readonly timedOut: boolean) {
		super(timedOut ? "timed out" : "cancelled");
		this.name = "TestCancelledError";
	}
}

/**
 * A kernel whose shutdown the test holds open, and which can refuse to confirm
 * its exit, so "is the runner still alive?" has an exact answer at every point
 * rather than a timing guess.
 */
class HeldKernel {
	alive = true;
	shutdowns = 0;
	/** Set by a test: the first shutdown waits on this before it reports. */
	hold: Promise<void> | undefined;
	/** Shutdowns before this one report an unconfirmed exit and leave the kernel up. */
	confirmsOnShutdown = 1;
	/** Resolves when the first shutdown has been entered. */
	readonly entered = Promise.withResolvers<void>();
	/** Resolves when the first shutdown has reported. */
	readonly reported = Promise.withResolvers<void>();

	isAlive(): boolean {
		return this.alive;
	}

	hasPendingWork(): boolean {
		return false;
	}

	async shutdown(): Promise<{ confirmed: boolean }> {
		this.shutdowns += 1;
		const first = this.shutdowns === 1;
		if (first) this.entered.resolve();
		if (first && this.hold) await this.hold;
		const confirmed = this.shutdowns >= this.confirmsOnShutdown;
		if (confirmed) this.alive = false;
		if (first) this.reported.resolve();
		return { confirmed };
	}
}

function createRegistry(prepare: (kernel: HeldKernel, index: number) => void = () => {}) {
	const kernels: HeldKernel[] = [];
	const registry = createKernelSessionRegistry<HeldKernel, TestOptions, TestResult, KernelSession<HeldKernel>>({
		languageLabel: "Test",
		cancelledErrorClass: TestCancelledError,
		buildSessionKey: (sessionId, cwd) => `${sessionId}:${cwd}`,
		createSession: session => session,
		startKernel: async () => {
			const kernel = new HeldKernel();
			prepare(kernel, kernels.length);
			kernels.push(kernel);
			return kernel;
		},
		executeWithKernel: async (_kernel, code, options) => ({
			cancelled: false,
			value: code,
			notice: options.claimKernelNotice?.(),
		}),
	});
	const kernel = (index: number): HeldKernel => {
		const found = kernels[index];
		if (found === undefined) throw new Error(`kernel ${index} was never started (${kernels.length} were)`);
		return found;
	};
	const cell = (cwd: string, owner: string) =>
		registry.executeOnSession(cwd, cwd, { sessionId: "s", kernelOwnerId: owner });
	return { kernels, kernel, cell, registry };
}

/** Drain the microtask queue so a promise that can settle has settled. */
async function settleMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
}

describe("owner disposal and an in-flight reclaim", () => {
	// The grace is a real timer, which is the behaviour under test; every
	// other wait below is on an event the kernel itself signals.
	afterEach(() => setSupersededKernelGraceMs());

	it("shuts its own kernels down while it waits for the reclaim it raced, and returns once both are down", async () => {
		setSupersededKernelGraceMs(5);
		const exit = Promise.withResolvers<void>();
		const { kernels, kernel, cell, registry } = createRegistry((started, index) => {
			// Only the kernel the owner walks away from is held open: it is the
			// one the reaper shuts down while the disposal runs.
			if (index === 0) started.hold = exit.promise;
		});
		try {
			const owner = "agent-session:join";
			await cell("/one", owner);
			// The owner's next cell lands at another key, which arms the kernel
			// it left behind. Past the grace the reaper enters that kernel's
			// shutdown and stays inside it until this test lets go.
			await cell("/two", owner);
			await kernel(0).entered.promise;

			let disposed = false;
			const disposal = registry.disposeByOwner(owner).then(() => {
				disposed = true;
			});
			await settleMicrotasks();
			// The runner is provably still up, so a disposal that has returned
			// has returned a false statement.
			expect(kernel(0).alive).toBe(true);
			expect(disposed).toBe(false);
			// And the wait is spent alongside the owner's own shutdown, not ahead
			// of it: the kernel it was using is already down.
			expect(kernel(1).alive).toBe(false);

			exit.resolve();
			await disposal;
			expect(kernels.every(started => !started.alive)).toBe(true);
		} finally {
			exit.resolve();
			await registry.disposeAll();
		}
	}, 30_000);

	it("does not wait for a reclaim of a kernel another owner left behind", async () => {
		setSupersededKernelGraceMs(5);
		const exit = Promise.withResolvers<void>();
		const { kernel, cell, registry } = createRegistry((started, index) => {
			if (index === 0) started.hold = exit.promise;
		});
		try {
			await cell("/one", "agent-session:walks-away");
			await cell("/two", "agent-session:walks-away");
			await kernel(0).entered.promise;
			await cell("/three", "agent-session:unrelated");

			let disposed = false;
			const disposal = registry.disposeByOwner("agent-session:unrelated").then(() => {
				disposed = true;
			});
			await settleMicrotasks();
			// That runner was never this owner's; the disposal of this one has
			// nothing to wait for but its own kernel.
			expect(disposed).toBe(true);
			expect(kernel(2).alive).toBe(false);
			expect(kernel(0).alive).toBe(true);
			await disposal;
		} finally {
			exit.resolve();
			await registry.disposeAll();
		}
	}, 30_000);

	it("retries a kernel the reclaim could not confirm down after a new kernel took its key, and keeps it for disposeAll", async () => {
		setSupersededKernelGraceMs(5);
		const exit = Promise.withResolvers<void>();
		const { kernel, cell, registry } = createRegistry((started, index) => {
			if (index !== 0) return;
			started.hold = exit.promise;
			// Down only on the third attempt: the reclaim's, the owner disposal's
			// one retry, and then the process-wide disposal's.
			started.confirmsOnShutdown = 3;
		});
		try {
			const owner = "agent-session:unconfirmed";
			await cell("/one", owner);
			await cell("/two", owner);
			await kernel(0).entered.promise;
			// The owner comes back while the old kernel is still exiting, so a
			// fresh one takes the key the unconfirmed one would go back under.
			await cell("/one", owner);
			exit.resolve();
			await kernel(0).reported.promise;
			await settleMicrotasks();
			expect(kernel(0).alive).toBe(true);
			expect(kernel(0).shutdowns).toBe(1);

			await registry.disposeByOwner(owner);
			expect(kernel(0).shutdowns).toBe(2);
			expect(kernel(0).alive).toBe(true);

			await registry.disposeAll();
			expect(kernel(0).shutdowns).toBe(3);
			expect(kernel(0).alive).toBe(false);
		} finally {
			exit.resolve();
			await registry.disposeAll();
		}
	}, 30_000);
});

/**
 * A kernel a disposal could not confirm down is a cleanup debt, not a session:
 * nobody owns it any more and nobody lost anything to it after the disposal.
 * Putting it back where the reaper looks made the reaper treat it as a kernel
 * its owners had walked away from — reclaim it again, and record the loss
 * once more for the very owner the disposal had just forgotten, so that
 * owner's next cell, under the same id, opened with a notice about a kernel
 * it had already been told it lost. The same mechanism was measured on a real
 * Python runner whose thread stayed in uninterruptible I/O.
 *
 * The grace is a real timer here, and the tests wait on it by its own order:
 * a bystander's reclaim, armed on the same grace after anything the disposal
 * could have left armed, has run before its kernel reports — so every reclaim
 * the disposal could have re-armed has run by then too.
 */
describe("a kernel a disposal could not confirm down", () => {
	afterEach(() => setSupersededKernelGraceMs());

	it("stays out of the registry after its owner's disposal, so no reclaim re-arms it and the owner's next cell hears nothing", async () => {
		setSupersededKernelGraceMs(5);
		const { kernel, cell, registry } = createRegistry((started, index) => {
			// Down only on the third attempt: the reclaim's, the owner
			// disposal's, and the process-wide disposal's.
			if (index === 0) started.confirmsOnShutdown = 3;
		});
		try {
			const owner = "agent-session:disposed-unconfirmed";
			await cell("/one", owner);
			await cell("/two", owner);
			await kernel(0).reported.promise;
			await settleMicrotasks();
			await registry.disposeByOwner(owner);
			expect(kernel(0).shutdowns).toBe(2);

			const bystander = "agent-session:bystander";
			await cell("/three", bystander);
			await cell("/four", bystander);
			await kernel(2).reported.promise;
			await settleMicrotasks();

			// The same owner id comes back to the directory it was disposed in.
			expect((await cell("/one", owner)).notice).toBeUndefined();
			expect(kernel(0).shutdowns).toBe(2);
			expect(kernel(0).alive).toBe(true);

			// The debt is still held: the process-wide disposal settles it.
			await registry.disposeAll();
			expect(kernel(0).shutdowns).toBe(3);
			expect(kernel(0).alive).toBe(false);
		} finally {
			await registry.disposeAll();
		}
	}, 30_000);

	it("stays out of the registry after the process-wide disposal, so a later cell cannot re-arm it", async () => {
		setSupersededKernelGraceMs(5);
		const { kernel, cell, registry } = createRegistry((started, index) => {
			if (index === 0) started.confirmsOnShutdown = 3;
		});
		try {
			const owner = "agent-session:all-disposed-unconfirmed";
			await cell("/one", owner);
			await cell("/two", owner);
			await kernel(0).reported.promise;
			await settleMicrotasks();
			await registry.disposeAll();
			expect(kernel(0).shutdowns).toBe(2);

			// Another agent's cells run the reaper's arming pass after the
			// disposal; the disposed kernel must not be among what it finds.
			const bystander = "agent-session:later-bystander";
			await cell("/three", bystander);
			await cell("/four", bystander);
			await kernel(2).reported.promise;
			await settleMicrotasks();

			expect((await cell("/one", owner)).notice).toBeUndefined();
			expect(kernel(0).shutdowns).toBe(2);
			expect(kernel(0).alive).toBe(true);

			await registry.disposeAll();
			expect(kernel(0).shutdowns).toBe(3);
			expect(kernel(0).alive).toBe(false);
		} finally {
			await registry.disposeAll();
		}
	}, 30_000);
});
