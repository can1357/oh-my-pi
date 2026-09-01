import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { MnemopiSessionState, setMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("AgentSession concurrent disposal", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-dispose-concurrent-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.useRealTimers();
		const current = session;
		session = undefined;
		if (current) await current.dispose();
		authStorage.close();
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	function createSession(
		ownedAsyncJobManager?: AsyncJobManager,
		options?: { agentId?: string; asyncJobManager?: AsyncJobManager },
	): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			ownedAsyncJobManager,
			asyncJobManager: options?.asyncJobManager,
			agentId: options?.agentId ?? "Main",
		});
		return session;
	}

	it("tags an owner's jobs with the shutdown reason before disposing the manager", async () => {
		// Regression: `#disposeOwnedAsyncJobs` pre-cancels the owner's jobs via
		// `#cancelOwnAsyncJobs` BEFORE `manager.dispose()`. If that pre-cancel
		// dropped the shutdown reason, the owned subagent job saw a generic
		// caller signal and was tombstoned instead of parked.
		const owned = new AsyncJobManager({ maxRunningJobs: 1 });
		const started = Promise.withResolvers<void>();
		let abortReason: unknown;
		owned.register(
			"task",
			"running subagent",
			async ({ signal }) => {
				const aborted = Promise.withResolvers<void>();
				signal.addEventListener(
					"abort",
					() => {
						abortReason = signal.reason;
						aborted.resolve();
					},
					{ once: true },
				);
				started.resolve();
				await aborted.promise;
				return "stopped";
			},
			{ ownerId: "Main", agentId: "Sub" },
		);
		const current = createSession(owned);

		await started.promise;
		await current.dispose();
		session = undefined;

		expect(abortReason).toBe(ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
	});

	it("propagates a generic cancellation for a subagent dispose so nested children stay terminal", async () => {
		// A subagent session leaves `ownedAsyncJobManager` undefined and inherits
		// the shared manager. Its dispose (e.g. `release({ tombstone: true })`
		// during an explicit hard kill) must NOT tag its owned jobs as shutdown,
		// or nested children would be rediscovered as parked instead of terminal.
		const shared = new AsyncJobManager({ maxRunningJobs: 1 });
		const started = Promise.withResolvers<void>();
		let abortReason: unknown;
		shared.register(
			"task",
			"nested child",
			async ({ signal }) => {
				const aborted = Promise.withResolvers<void>();
				signal.addEventListener(
					"abort",
					() => {
						abortReason = signal.reason;
						aborted.resolve();
					},
					{ once: true },
				);
				started.resolve();
				await aborted.promise;
				return "stopped";
			},
			{ ownerId: "Sub", agentId: "NestedChild" },
		);
		const current = createSession(undefined, { agentId: "Sub", asyncJobManager: shared });

		await started.promise;
		await current.dispose();
		session = undefined;

		expect(abortReason).not.toBe(ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
		expect(abortReason).toBeInstanceOf(DOMException);
		await shared.dispose({ timeoutMs: 1_000 });
	});

	it("starts independent writers together and closes persistence after their barrier", async () => {
		const owned = new AsyncJobManager({ maxRunningJobs: 1, retentionMs: 1_000, onJobComplete: () => {} });
		const asyncGate = Promise.withResolvers<void>();
		const hindsightGate = Promise.withResolvers<void>();
		const mnemopiGate = Promise.withResolvers<void>();
		const asyncStarted = Promise.withResolvers<void>();
		const order: string[] = [];
		vi.spyOn(owned, "dispose").mockImplementation(async () => {
			order.push("async:start");
			asyncStarted.resolve();
			await asyncGate.promise;
			order.push("async:end");
			return true;
		});

		const current = createSession(owned);
		const hindsight: HindsightSessionState = Object.create(HindsightSessionState.prototype);
		vi.spyOn(hindsight, "flushRetainQueue").mockImplementation(async () => {
			order.push("hindsight:start");
			await hindsightGate.promise;
			order.push("hindsight:end");
		});
		vi.spyOn(hindsight, "dispose").mockImplementation(() => {});
		current.setHindsightSessionState(hindsight);

		const mnemopi: MnemopiSessionState = Object.create(MnemopiSessionState.prototype);
		vi.spyOn(mnemopi, "dispose").mockImplementation(async () => {
			order.push("mnemopi:start");
			await mnemopiGate.promise;
			order.push("mnemopi:end");
		});
		setMnemopiSessionState(current, mnemopi);

		let persistenceClosed = false;
		vi.spyOn(current.sessionManager, "close").mockImplementation(async () => {
			persistenceClosed = true;
			order.push("session:close");
		});

		const dispose = current.dispose();
		try {
			await asyncStarted.promise;
			await Promise.resolve();
			expect(order).toContain("hindsight:start");
			expect(order).toContain("mnemopi:start");
			expect(order).not.toContain("async:end");
			expect(order).not.toContain("hindsight:end");
			expect(order).not.toContain("mnemopi:end");
			expect(persistenceClosed).toBe(false);
		} finally {
			asyncGate.resolve();
			hindsightGate.resolve();
			mnemopiGate.resolve();
		}
		await dispose;
		session = undefined;

		const closeAt = order.indexOf("session:close");
		expect(closeAt).toBeGreaterThan(order.indexOf("async:end"));
		expect(closeAt).toBeGreaterThan(order.indexOf("hindsight:end"));
		expect(closeAt).toBeGreaterThan(order.indexOf("mnemopi:end"));
	});

	it("bounds post-prompt work that ignores abort", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const current = createSession();
		const hangingTask = Promise.withResolvers<void>();
		current.trackPostPromptTaskForTests(hangingTask.promise);

		const dispose = current.dispose();
		await flushMicrotasks();
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		await dispose;
		session = undefined;

		expect(warn).toHaveBeenCalledWith(
			"Post-prompt tasks still draining at dispose deadline",
			expect.objectContaining({ error: "Error: Timed out draining post-prompt tasks during dispose" }),
		);
	});

	it("clears the owned async manager when its dispose rejects", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const owned = new AsyncJobManager({ maxRunningJobs: 1, retentionMs: 1_000, onJobComplete: () => {} });
		vi.spyOn(owned, "dispose").mockRejectedValue(new Error("async dispose failed"));
		AsyncJobManager.setInstance(owned);
		const current = createSession(owned);

		await current.dispose();
		session = undefined;

		expect(AsyncJobManager.instance()).toBeUndefined();
		expect(warn).toHaveBeenCalledWith("Session dispose subsystem failed during parallel teardown", {
			error: "Error: async dispose failed",
		});
	});
});
