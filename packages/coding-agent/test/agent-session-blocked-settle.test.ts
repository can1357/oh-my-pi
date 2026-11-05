/**
 * A run that waits for its own background jobs to settle (a subagent past its
 * turn, a print-mode run before exit) cannot message the agents those jobs
 * run, so their idle `wait` must return at once; a settle a user or host can
 * interrupt with a prompt leaves them free to idle.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { holdOwnedJobs } from "@oh-my-pi/pi-coding-agent/registry/agent-awaits";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";

describe("AgentSession.settleAsyncWork and idle waits of the agents it waits on", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		vi.useRealTimers();
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		AsyncJobManager.resetForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	async function lead(): Promise<{ session: AgentSession; manager: AsyncJobManager }> {
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const manager = new AsyncJobManager({});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Lead",
			asyncJobManager: manager,
		});
		cleanups.push(() => authStorage.close());
		cleanups.push(() => session.dispose());
		AgentRegistry.global().register({ id: "Lead", displayName: "Lead", kind: "sub", session, status: "idle" });
		AgentRegistry.global().register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Lead",
			session: { isStreaming: true } as never,
			status: "running",
		});
		return { session, manager };
	}

	/** The worker's tool session, built after the test's registry reset. */
	const workerSession = () =>
		({
			cwd: "/tmp",
			settings: Settings.isolated({ "launch.enabled": false }),
			agentRegistry: AgentRegistry.global(),
			getAgentId: () => "Worker",
		}) as unknown as ToolSession;

	it("refuses an idle wait in an agent a blocked settle waits on", async () => {
		const { session, manager } = await lead();
		const settling = Promise.withResolvers<void>();
		const workerWaits: string[] = [];
		manager.register(
			"task",
			"Worker",
			async () => {
				await settling.promise;
				vi.useFakeTimers();
				try {
					const waiting = new WaitTool(workerSession()).execute("worker-idle", { timeout: 600 });
					// An idling worker would end here, at its deadline, on "Deadline reached".
					vi.advanceTimersByTime(600_000);
					const first = (await waiting).content[0];
					workerWaits.push(first?.type === "text" ? first.text : "");
				} finally {
					vi.useRealTimers();
				}
				return "done";
			},
			{ id: "Worker", agentId: "Worker", ownerId: "Lead" },
		);
		const settled = session.settleAsyncWork({ blocked: true });
		settling.resolve();
		await settled;
		expect(workerWaits).toEqual([expect.stringContaining("Nothing to wait for: `Lead` is waiting on your result")]);
		// The settle no longer blocks the lead once its jobs are done.
		expect(AgentRegistry.global().awaits.waitersOn("Worker")).toEqual([]);
	});

	it("lets an agent idle until a message while a settle the user can interrupt waits on it", async () => {
		const { session, manager } = await lead();
		const settling = Promise.withResolvers<void>();
		const workerWaits: unknown[] = [];
		manager.register(
			"task",
			"Worker",
			async () => {
				await settling.promise;
				const waiting = new WaitTool(workerSession()).execute("worker-idle", { timeout: 600 });
				await IrcBus.global().send({ from: "Peer", to: "Worker", body: "the schema changed" });
				workerWaits.push((await waiting).details?.waited);
				return "done";
			},
			{ id: "Worker", agentId: "Worker", ownerId: "Lead" },
		);
		const settled = session.settleAsyncWork();
		settling.resolve();
		await settled;
		expect(workerWaits).toEqual([[expect.objectContaining({ from: "Peer", body: "the schema changed" })]]);
	});

	it("strands no hold when a later one of the settle's holds fails", async () => {
		// A worker's registry answers each hold over a proxy, and the caller has
		// no release function until the whole set is taken: a failure part-way
		// through must release what it already took, or the agents those holds
		// name are refused their idle wait forever.
		const registry = AgentRegistry.global();
		registry.register({ id: "Lead", displayName: "Lead", kind: "sub", session: null as never, status: "running" });
		const manager = new AsyncJobManager({});
		cleanups.push(async () => {
			await manager.dispose({ timeoutMs: 100 });
		});
		const first = Promise.withResolvers<string>();
		const second = Promise.withResolvers<string>();
		manager.register("task", "First", async () => first.promise, {
			id: "First",
			agentId: "First",
			ownerId: "Lead",
		});
		manager.register("task", "Second", async () => second.promise, {
			id: "Second",
			agentId: "Second",
			ownerId: "Lead",
		});
		const realHold = registry.awaits.hold.bind(registry.awaits);
		let holdCalls = 0;
		vi.spyOn(registry.awaits, "hold").mockImplementation((waiter, awaited, options) => {
			if (++holdCalls === 2) throw new Error("proxy awaits.hold failed");
			return realHold(waiter, awaited, options);
		});
		expect(() => holdOwnedJobs(registry, manager, "Lead")).toThrow("proxy awaits.hold failed");
		expect(holdCalls).toBe(2);
		vi.restoreAllMocks();
		expect(registry.awaits.waitersOn("First")).toEqual([]);
		expect(registry.awaits.waitersOn("Second")).toEqual([]);
		first.resolve("done");
		second.resolve("done");
	});

	it("leaves no job-settle listener behind when the registry subscription fails", async () => {
		// The two subscriptions are taken one at a time, each stored before the
		// next: a job-settle listener that survived a failed call would take new
		// holds whenever a job settles, long after the settle it belonged to
		// ended, and refuse the remaining agent's waits.
		const registry = AgentRegistry.global();
		registry.register({ id: "Lead", displayName: "Lead", kind: "sub", session: null as never, status: "running" });
		const manager = new AsyncJobManager({});
		cleanups.push(async () => {
			await manager.dispose({ timeoutMs: 100 });
		});
		const first = Promise.withResolvers<string>();
		const second = Promise.withResolvers<string>();
		manager.register("task", "First", async () => first.promise, {
			id: "First",
			agentId: "First",
			ownerId: "Lead",
		});
		manager.register("task", "Second", async () => second.promise, {
			id: "Second",
			agentId: "Second",
			ownerId: "Lead",
		});
		vi.spyOn(registry, "onChange").mockImplementation(() => {
			throw new Error("proxy registry subscribe failed");
		});
		expect(() => holdOwnedJobs(registry, manager, "Lead")).toThrow("proxy registry subscribe failed");
		vi.restoreAllMocks();
		expect(registry.awaits.waitersOn("First")).toEqual([]);
		expect(registry.awaits.waitersOn("Second")).toEqual([]);
		// A job settling must not wake a listener the failed call left behind.
		first.resolve("done");
		await manager.getJob("First")?.promise;
		expect(registry.awaits.waitersOn("Second")).toEqual([]);
		second.resolve("done");
	});

	it("releases every hold even when a subscription's detach throws", async () => {
		// Release runs over unrelated resources: a detach that throws must not
		// strand the holds behind it, or the agents they name go on being
		// refused their own waits after the settle ended.
		const registry = AgentRegistry.global();
		registry.register({ id: "Lead", displayName: "Lead", kind: "sub", session: null as never, status: "running" });
		const manager = new AsyncJobManager({});
		cleanups.push(async () => {
			await manager.dispose({ timeoutMs: 100 });
		});
		const first = Promise.withResolvers<string>();
		const second = Promise.withResolvers<string>();
		manager.register("task", "First", async () => first.promise, {
			id: "First",
			agentId: "First",
			ownerId: "Lead",
		});
		manager.register("task", "Second", async () => second.promise, {
			id: "Second",
			agentId: "Second",
			ownerId: "Lead",
		});
		const realOnChange = registry.onChange.bind(registry);
		vi.spyOn(registry, "onChange").mockImplementation(listener => {
			const detach = realOnChange(listener);
			return () => {
				detach();
				throw new Error("injected unsubscribe failure after detach");
			};
		});
		const release = holdOwnedJobs(registry, manager, "Lead");
		vi.restoreAllMocks();
		expect(registry.awaits.waitersOn("First")).toEqual(["Lead"]);
		// The failure still reaches the caller, after every release has run.
		expect(release).toThrow("injected unsubscribe failure after detach");
		expect(registry.awaits.waitersOn("First")).toEqual([]);
		expect(registry.awaits.waitersOn("Second")).toEqual([]);
		first.resolve("done");
		second.resolve("done");
	});
});
