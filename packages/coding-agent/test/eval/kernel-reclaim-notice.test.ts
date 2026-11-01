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
 * earlier. The contract here is that the next cell on a reclaimed key carries
 * the notice, exactly once, and that a caller who asked for a fresh kernel is
 * not told about one.
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

class FakeKernel {
	alive = true;
	constructor(readonly index: number) {}
	isAlive(): boolean {
		return this.alive;
	}
	hasPendingWork(): boolean {
		return false;
	}
	async shutdown(): Promise<{ confirmed: boolean }> {
		this.alive = false;
		return { confirmed: true };
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
 * one cell throw after claiming, which is how the notice can reach nobody.
 */
function createRegistry(failOn?: string): { kernels: FakeKernel[]; registry: TestRegistry } {
	const kernels: FakeKernel[] = [];
	const registry = createKernelSessionRegistry<FakeKernel, TestOptions, TestResult, KernelSession<FakeKernel>>({
		languageLabel: "Test",
		cancelledErrorClass: TestCancelledError,
		buildSessionKey: (sessionId, cwd) => `${sessionId}:${cwd}`,
		createSession: session => session,
		startKernel: async () => {
			const kernel = new FakeKernel(kernels.length);
			kernels.push(kernel);
			return kernel;
		},
		executeWithKernel: async (kernel, code, options) => {
			const notice = options.claimKernelNotice?.();
			if (code === failOn) {
				kernel.alive = false;
				throw new Error("cell blew up");
			}
			return { cancelled: false, value: notice === undefined ? code : `${notice}\n${code}` };
		},
	});
	return { kernels, registry };
}

/** Run `code` at `cwd` for `owner`, after `grace` has had time to fire. */
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

describe("a reclaimed kernel tells the next cell", () => {
	afterEach(async () => {
		setSupersededKernelGraceMs();
		await disposeAllVmContexts();
	});

	it("opens the next cell on the key with the notice, once, and keeps the cell's own output", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		const { kernels, registry } = createRegistry();
		const owner = "agent-session:notice";
		try {
			await cell(registry, "first", "/one", owner);
			await cell(registry, "elsewhere", "/two", owner);
			await Bun.sleep(TEST_GRACE_MS * 8);
			expect(kernels[0]?.alive).toBe(false);

			const notice = formatKernelReclaimNotice("Test kernel");
			const back = await cell(registry, "back", "/one", owner);
			expect(back).toBe(`${notice}\nback`);
			// The namespace is only lost once; the cell after it is ordinary.
			expect(await cell(registry, "again", "/one", owner)).toBe("again");
		} finally {
			await registry.disposeAll();
		}
	}, 30_000);

	it("says nothing when the caller asked for a fresh kernel", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		const { kernels, registry } = createRegistry();
		const owner = "agent-session:reset";
		try {
			await cell(registry, "first", "/one", owner);
			await cell(registry, "elsewhere", "/two", owner);
			await Bun.sleep(TEST_GRACE_MS * 8);
			expect(kernels[0]?.alive).toBe(false);

			// `reset: true` is a caller who expects an empty namespace, so a
			// notice explaining one is noise — and it must not be saved up for
			// the cell after it either.
			expect(await cell(registry, "fresh", "/one", owner, { reset: true })).toBe("fresh");
			expect(await cell(registry, "after", "/one", owner)).toBe("after");
		} finally {
			await registry.disposeAll();
		}
	}, 30_000);

	it("still owes the notice when the cell that claimed it threw", async () => {
		setSupersededKernelGraceMs(TEST_GRACE_MS);
		const { kernels, registry } = createRegistry("boom");
		const owner = "agent-session:throws";
		try {
			await cell(registry, "first", "/one", owner);
			await cell(registry, "elsewhere", "/two", owner);
			await Bun.sleep(TEST_GRACE_MS * 8);
			expect(kernels[0]?.alive).toBe(false);

			// A cell that throws returns no output, so its claim reached nobody.
			await expect(cell(registry, "boom", "/one", owner)).rejects.toThrow();
			expect(await cell(registry, "after", "/one", owner)).toBe(
				`${formatKernelReclaimNotice("Test kernel")}\nafter`,
			);
		} finally {
			await registry.disposeAll();
		}
	}, 30_000);

	it("tells the next JavaScript cell that the worker it would have reused is gone", async () => {
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

		const notice = formatKernelReclaimNotice("JS worker");
		const back = await run(firstDir.path());
		expect(back).toContain(notice);
		expect(back.indexOf(notice)).toBeLessThan(back.indexOf("mark 1"));
		// Said once: the worker that answers the next cell is the same one.
		expect(await run(firstDir.path())).not.toContain(notice);
	}, 60_000);
});
