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
		expect(workerWaits).toEqual([expect.objectContaining({ from: "Peer", body: "the schema changed" })]);
	});
});
