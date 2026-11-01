import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { formatKernelReclaimNotice } from "../../src/eval/executor-base";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import { createKernelSessionRegistry, type KernelSession } from "../../src/eval/kernel-session-registry";
import { setSupersededKernelGraceMs } from "../../src/eval/superseded-reclaim";
import { AgentOutputManager } from "../../src/task/output-manager";
import type { ToolSession } from "../../src/tools";

/**
 * A reclaim takes a namespace away from a caller who did not ask for that.
 * Before this, the only output on the path was a `logger.warn` on an
 * unconfirmed exit, so a successful reclaim said nothing at all and the caller
 * met it as an unexplained `NameError` on a variable that existed ten minutes
 * earlier. The contract here is that the owner the kernel was taken from is
 * told by its first cell on that key that runs on another kernel, exactly once,
 * whenever that cell lands — while the old kernel is still exiting, after it
 * is gone, or after an unconfirmed kernel was put back and replaced — and that
 * nobody else is told, nor a caller who asked for a fresh kernel.
 */

const TEST_GRACE_MS = 50;

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
	/** What the cell printed: the notice, when it claimed one, then its own output. */
	value: string;
}

class TestCancelledError extends Error {
	constructor(readonly timedOut: boolean) {
		super(timedOut ? "timed out" : "cancelled");
		this.name = "TestCancelledError";
	}
}

/**
 * What a shutdown reports. `unconfirmed-alive` is a runner the escalation could
 * not prove gone that is in fact still answering; `unconfirmed-dead` is one that
 * is gone without the exit ever being confirmed.
 */
type ShutdownOutcome = "confirmed" | "unconfirmed-alive" | "unconfirmed-dead";

class FakeKernel {
	alive = true;
	outcome: ShutdownOutcome = "confirmed";
	/** When set, a shutdown waits on it before it reports. */
	hold: Promise<void> | undefined;
	/** Resolves when a shutdown begins. */
	readonly entered = Promise.withResolvers<void>();
	/** Resolves when a shutdown has reported. */
	readonly reported = Promise.withResolvers<void>();
	constructor(readonly index: number) {}
	isAlive(): boolean {
		return this.alive;
	}
	hasPendingWork(): boolean {
		return false;
	}
	async shutdown(): Promise<{ confirmed: boolean }> {
		this.entered.resolve();
		if (this.hold) await this.hold;
		if (this.outcome !== "unconfirmed-alive") this.alive = false;
		this.reported.resolve();
		return { confirmed: this.outcome === "confirmed" };
	}
}

/** The slice of the registry these tests drive. */
interface TestRegistry {
	executeOnSession(code: string, cwd: string, options: TestOptions): Promise<TestResult>;
	disposeAll(): Promise<void>;
}

/**
 * A registry whose cells behave like the real executor: the notice is claimed
 * as the cell starts and lands ahead of that cell's own output. `failOn` makes
 * one cell throw after claiming, which is how the notice can reach nobody;
 * `prepare` shapes each kernel as it starts.
 */
function createRegistry(options: { failOn?: string; prepare?: (kernel: FakeKernel) => void } = {}): {
	kernels: FakeKernel[];
	registry: TestRegistry;
} {
	const kernels: FakeKernel[] = [];
	const registry = createKernelSessionRegistry<FakeKernel, TestOptions, TestResult, KernelSession<FakeKernel>>({
		languageLabel: "Test",
		cancelledErrorClass: TestCancelledError,
		buildSessionKey: (sessionId, cwd) => `${sessionId}:${cwd}`,
		createSession: session => session,
		startKernel: async () => {
			const kernel = new FakeKernel(kernels.length);
			options.prepare?.(kernel);
			kernels.push(kernel);
			return kernel;
		},
		executeWithKernel: async (kernel, code, cellOptions) => {
			const notice = cellOptions.claimKernelNotice?.();
			if (code === options.failOn) {
				kernel.alive = false;
				throw new Error("cell blew up");
			}
			return { cancelled: false, value: notice === undefined ? code : `${notice}\n${code}` };
		},
	});
	return { kernels, registry };
}

/** Run `code` at `cwd` for `owner`. */
async function cell(
	registry: TestRegistry,
	code: string,
	cwd: string,
	owner: string,
	options: Partial<TestOptions> = {},
): Promise<string> {
	const result = await registry.executeOnSession(code, cwd, { sessionId: "s", kernelOwnerId: owner, ...options });
	return result.value;
}

function kernel(kernels: FakeKernel[], index: number): FakeKernel {
	const found = kernels[index];
	if (found === undefined) throw new Error(`kernel ${index} was never started (${kernels.length} were)`);
	return found;
}

/** Drain the microtask queue, so whatever a settled shutdown lets run has run. */
async function settleMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
}

function makeSession(cwd: string, sessionFile: string): ToolSession {
	const artifactsDir = sessionFile.slice(0, -6);
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "task.isolation.enabled": false }),
		asyncJobManager: new AsyncJobManager({}),
		taskDepth: 0,
		enableLsp: false,
		agentOutputManager: new AgentOutputManager(() => artifactsDir),
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => "test-session",
		getEvalSessionId: () => "test-eval-session",
	};
}

describe("a reclaimed kernel tells the owner it was taken from", () => {
	afterEach(async () => {
		setSupersededKernelGraceMs();
		await disposeAllVmContexts();
	});

	it("opens the owner's next cell on the key with the notice naming that directory, once", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		const { kernels, registry } = createRegistry();
		const owner = "agent-session:notice";
		try {
			await cell(registry, "first", "/one", owner);
			await cell(registry, "elsewhere", "/two", owner);
			await kernel(kernels, 0).reported.promise;

			const back = await cell(registry, "back", "/one", owner);
			expect(back).toBe(`${formatKernelReclaimNotice("Test kernel", "/one", "process-group")}\nback`);
			// A user working in two directories can tell which namespace went.
			expect(back).toContain("/one");
			expect(back).not.toContain("/two");
			// The namespace is only lost once; the cell after it is ordinary.
			expect(await cell(registry, "again", "/one", owner)).toBe("again");
		} finally {
			await registry.disposeAll();
		}
	}, 30_000);

	it("tells the first cell that returns while the old kernel is still exiting, and not the cell after", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		const exit = Promise.withResolvers<void>();
		const { kernels, registry } = createRegistry({
			prepare: started => {
				if (started.index === 0) started.hold = exit.promise;
			},
		});
		const owner = "agent-session:returns-mid-shutdown";
		try {
			await cell(registry, "first", "/one", owner);
			await cell(registry, "elsewhere", "/two", owner);
			// The reclaim has taken the session and is inside the shutdown; the
			// runner is provably still up, so this is the window, not a guess.
			await kernel(kernels, 0).entered.promise;
			expect(kernel(kernels, 0).alive).toBe(true);

			// This cell runs on a fresh kernel: it is the one whose namespace is
			// empty, so it is the one that must say so.
			expect(await cell(registry, "back", "/one", owner)).toBe(
				`${formatKernelReclaimNotice("Test kernel", "/one", "process-group")}\nback`,
			);

			exit.resolve();
			await kernel(kernels, 0).reported.promise;
			await settleMicrotasks();
			// The shutdown finishing afterwards is old news, and says nothing.
			expect(await cell(registry, "again", "/one", owner)).toBe("again");
		} finally {
			exit.resolve();
			await registry.disposeAll();
		}
	}, 30_000);

	it("says nothing to an owner who reset the key, even while the old kernel was still exiting", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		const exit = Promise.withResolvers<void>();
		const { kernels, registry } = createRegistry({
			prepare: started => {
				if (started.index === 0) started.hold = exit.promise;
			},
		});
		const owner = "agent-session:reset";
		try {
			await cell(registry, "first", "/one", owner);
			await cell(registry, "elsewhere", "/two", owner);
			await kernel(kernels, 0).entered.promise;

			// `reset: true` is a caller who expects an empty namespace, so a
			// notice explaining one is noise — and the shutdown that finishes
			// after it must not save one up for the cell after it either.
			expect(await cell(registry, "fresh", "/one", owner, { reset: true })).toBe("fresh");
			exit.resolve();
			await kernel(kernels, 0).reported.promise;
			await settleMicrotasks();
			expect(await cell(registry, "after", "/one", owner)).toBe("after");
		} finally {
			exit.resolve();
			await registry.disposeAll();
		}
	}, 30_000);

	it("tells nobody after a disposal that landed while the old kernel was still exiting", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		const exit = Promise.withResolvers<void>();
		const { kernels, registry } = createRegistry({
			prepare: started => {
				if (started.index === 0) started.hold = exit.promise;
			},
		});
		const owner = "agent-session:disposed";
		try {
			await cell(registry, "first", "/one", owner);
			await cell(registry, "elsewhere", "/two", owner);
			await kernel(kernels, 0).entered.promise;

			const disposing = registry.disposeAll();
			exit.resolve();
			await disposing;
			// Everyone the notice was for is gone with the disposal.
			expect(await cell(registry, "new", "/one", "agent-session:after-dispose")).toBe("new");
			expect(await cell(registry, "returning", "/one", owner)).toBe("returning");
		} finally {
			exit.resolve();
			await registry.disposeAll();
		}
	}, 30_000);

	it("tells only the owner the kernel was taken from, not another agent arriving at that key first", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		const { kernels, registry } = createRegistry();
		const owner = "agent-session:displaced";
		try {
			await cell(registry, "first", "/one", owner);
			await cell(registry, "elsewhere", "/two", owner);
			await kernel(kernels, 0).reported.promise;

			// This agent never had a namespace here, so it lost nothing.
			expect(await cell(registry, "first visit", "/one", "agent-session:stranger")).toBe("first visit");
			expect(await cell(registry, "back", "/one", owner)).toBe(
				`${formatKernelReclaimNotice("Test kernel", "/one", "process-group")}\nback`,
			);
		} finally {
			await registry.disposeAll();
		}
	}, 30_000);

	it("tells the owner when a kernel the reclaim could not confirm down was put back and then replaced", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		const { kernels, registry } = createRegistry({
			prepare: started => {
				if (started.index === 0) started.outcome = "unconfirmed-dead";
			},
		});
		const owner = "agent-session:unconfirmed-dead";
		try {
			await cell(registry, "first", "/one", owner);
			await cell(registry, "elsewhere", "/two", owner);
			await kernel(kernels, 0).reported.promise;
			await settleMicrotasks();

			// The exit was never confirmed, so the session went back under its
			// key; the runner is gone all the same, and the next cell there
			// replaces it with an empty one.
			expect(await cell(registry, "back", "/one", owner)).toBe(
				`${formatKernelReclaimNotice("Test kernel", "/one", "process-group")}\nback`,
			);
			expect(kernels).toHaveLength(3);
		} finally {
			await registry.disposeAll();
		}
	}, 30_000);

	it("says nothing while the kernel the reclaim could not confirm down is still the one answering", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		const { kernels, registry } = createRegistry({
			prepare: started => {
				if (started.index === 0) started.outcome = "unconfirmed-alive";
			},
		});
		const owner = "agent-session:unconfirmed-alive";
		try {
			await cell(registry, "first", "/one", owner);
			await cell(registry, "elsewhere", "/two", owner);
			await kernel(kernels, 0).reported.promise;
			await settleMicrotasks();

			// Same kernel, same namespace: a notice here would be false.
			expect(await cell(registry, "back", "/one", owner)).toBe("back");
			expect(await cell(registry, "again", "/one", owner)).toBe("again");
			expect(kernels).toHaveLength(2);
		} finally {
			kernel(kernels, 0).outcome = "confirmed";
			await registry.disposeAll();
		}
	}, 30_000);

	it("still owes the notice when the cell that claimed it threw", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		const { kernels, registry } = createRegistry({ failOn: "boom" });
		const owner = "agent-session:throws";
		try {
			await cell(registry, "first", "/one", owner);
			await cell(registry, "elsewhere", "/two", owner);
			await kernel(kernels, 0).reported.promise;

			// A cell that throws returns no output, so its claim reached nobody.
			await expect(cell(registry, "boom", "/one", owner)).rejects.toThrow();
			expect(await cell(registry, "after", "/one", owner)).toBe(
				`${formatKernelReclaimNotice("Test kernel", "/one", "process-group")}\nafter`,
			);
			expect(await cell(registry, "again", "/one", owner)).toBe("again");
		} finally {
			await registry.disposeAll();
		}
	}, 30_000);

	// Delivery only: the worker here is a production worker, but nothing in
	// this case observes it ending. That the reclaimed worker really exits is
	// proved in `js-superseded-context.test.ts`, against threads it watches.
	it("delivers the notice to the next JavaScript cell on the key (delivery only)", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		using firstDir = TempDir.createSync("@js-reclaim-notice-a-");
		using secondDir = TempDir.createSync("@js-reclaim-notice-b-");
		const owner = "agent-session:js-reclaim-notice";
		const run = async (dir: string): Promise<string> => {
			const result = await executeJs('globalThis.__mark ??= 1; console.log("mark " + globalThis.__mark);', {
				cwd: dir,
				sessionId: `js:cwd:${dir}`,
				kernelOwnerId: owner,
				session: makeSession(dir, path.join(dir, "session.jsonl")),
				timeoutMs: 30_000,
			});
			if (result.exitCode !== 0) throw new Error(`cell failed: ${result.output}`);
			return result.output;
		};

		await run(firstDir.path());
		await run(secondDir.path());
		await Bun.sleep(TEST_GRACE_MS * 8);

		const notice = formatKernelReclaimNotice("JS worker", firstDir.path(), "worker");
		const back = await run(firstDir.path());
		expect(back).toContain(notice);
		expect(back.indexOf(notice)).toBeLessThan(back.indexOf("mark 1"));
		// Said once: the worker that answers the next cell is the same one.
		expect(await run(firstDir.path())).not.toContain(notice);
	}, 60_000);
});
