import { afterEach, describe, expect, it, jest } from "bun:test";
import { bindEffects } from "../../src/config/registry";
import { Settings } from "../../src/config/settings";
import { createKernelSessionRegistry, type KernelSession } from "../../src/eval/kernel-session-registry";
import { cfgEvalKernelReclaimGraceMs } from "../../src/eval/settings";
import { setSupersededKernelGraceMs } from "../../src/eval/superseded-reclaim";

/**
 * `eval.kernelReclaimGraceMs` is how long a person's variables outlive their
 * attention once every session using a kernel has moved on, so the setting —
 * not a constant — must be what the reaper waits, and `0` must keep the
 * kernel until its session ends.
 */

interface TestOptions {
	sessionId?: string;
	kernelOwnerId?: string;
	interpreter?: string;
	reset?: boolean;
	signal?: AbortSignal;
	deadlineMs?: number;
}

class TestCancelledError extends Error {
	constructor(readonly timedOut: boolean) {
		super(timedOut ? "timed out" : "cancelled");
		this.name = "TestCancelledError";
	}
}

class FakeKernel {
	alive = true;
	readonly down = Promise.withResolvers<void>();
	isAlive(): boolean {
		return this.alive;
	}
	hasPendingWork(): boolean {
		return false;
	}
	async shutdown(): Promise<{ confirmed: boolean }> {
		this.alive = false;
		this.down.resolve();
		return { confirmed: true };
	}
}

/** Long enough for a grace that was armed to have fired several times over. */
const PAST_GRACE_MS = 400;

function createRegistry() {
	const kernels: FakeKernel[] = [];
	const registry = createKernelSessionRegistry<
		FakeKernel,
		TestOptions,
		{ cancelled: boolean },
		KernelSession<FakeKernel>
	>({
		languageLabel: "Test",
		cancelledErrorClass: TestCancelledError,
		buildSessionKey: (sessionId, cwd) => `${sessionId}:${cwd}`,
		createSession: session => session,
		startKernel: async () => {
			const kernel = new FakeKernel();
			kernels.push(kernel);
			return kernel;
		},
		executeWithKernel: async () => ({ cancelled: false }),
	});
	const cell = (cwd: string) =>
		registry.executeOnSession("", cwd, { sessionId: "s", kernelOwnerId: "agent-session:grace" });
	return { kernels, registry, cell };
}

/** Drain the microtask queue so a promise that can settle has settled. */
async function settleMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
}

describe("eval.kernelReclaimGraceMs", () => {
	afterEach(() => {
		jest.useRealTimers();
		setSupersededKernelGraceMs();
	});

	it("keeps a left-behind kernel while it is 0, and reclaims it on the grace it is set to", async () => {
		const settings = Settings.isolated({ "eval.kernelReclaimGraceMs": 0 });
		const release = bindEffects(settings);
		const { kernels, registry, cell } = createRegistry();
		try {
			await cell("/one");
			await cell("/two");
			// A real wait, because the claim is that no timer exists to fire.
			await Bun.sleep(PAST_GRACE_MS);
			expect(kernels[0]?.alive).toBe(true);

			// The setting changes for the whole process; the next cell boundary
			// arms the kernel the owner left, on the grace now configured.
			cfgEvalKernelReclaimGraceMs.override(settings, 20);
			await cell("/two");
			await kernels[0]?.down.promise;
			expect(kernels[0]?.alive).toBe(false);
		} finally {
			release();
			await registry.disposeAll();
		}
	}, 30_000);

	it("holds a left-behind kernel for a grace longer than one platform timer can, and reclaims it once that grace has run", async () => {
		// One past the longest delay a platform timer holds. Handed to a timer
		// as it is, it fires after 1 ms, which turned a request to keep the
		// namespace for 25 days into its immediate destruction. Bun's fake
		// timers reproduce that overflow, so the clock below is the platform's
		// rule, advanced without waiting.
		const graceMs = 2 ** 31;
		const settings = Settings.isolated({ "eval.kernelReclaimGraceMs": graceMs });
		const release = bindEffects(settings);
		const { kernels, registry, cell } = createRegistry();
		jest.useFakeTimers();
		try {
			await cell("/one");
			await cell("/two");
			jest.advanceTimersByTime(graceMs - 1);
			await settleMicrotasks();
			expect(kernels[0]?.alive).toBe(true);

			jest.advanceTimersByTime(1);
			await settleMicrotasks();
			expect(kernels[0]?.alive).toBe(false);
		} finally {
			jest.useRealTimers();
			release();
			await registry.disposeAll();
		}
	}, 30_000);
});
