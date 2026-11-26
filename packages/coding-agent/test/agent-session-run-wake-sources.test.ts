/**
 * A run stays open while a child agent can still wake it, and ends on its own
 * once that child stops without writing back: no idle run state, no `agent_end`
 * in between, and no consumer-side watch needed to notice the child going away.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus, type IrcBusApi } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession run held open by a child agent", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let registry: AgentRegistry;
	let session: AgentSession;
	let runEvents: string[];
	let runStates: string[];
	let modelCalls: number;
	let jobs: AsyncJobManager;
	let bus: IrcBusApi;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-run-wake-sources-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model");
		modelCalls = 0;
		const mock = createMockModel({
			handler: () => {
				modelCalls++;
				return { content: ["Asked the child; waiting for its reply."] };
			},
		});
		registry = new AgentRegistry();
		// The session reads its isolated registry's own bus, so the test parks there too.
		bus = IrcBus.forRegistry(registry);
		jobs = new AsyncJobManager({});
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			agentRegistry: registry,
			asyncJobManager: jobs,
		});
		runEvents = [];
		runStates = [];
		session.subscribe(event => {
			if (event.type === "agent_pause") runEvents.push(`pause:${event.yielded}`);
			if (event.type === "agent_end") runEvents.push("end");
		});
		session.subscribeRunState(state => runStates.push(state));
	});

	afterEach(async () => {
		await session.dispose();
		IrcBus.resetGlobalForTests();
		authStorage.close();
		tempDir.removeSync();
	});

	/** A child of Main whose own run is open (peer-woken: no job tracks it). */
	function registerRunningChild(id = "Child"): void {
		// Only the run-open corroboration `registry.isRunning` reads matters here.
		const childSession = { runStartedAt: Date.now() } as unknown as AgentSessionHandle;
		registry.register({ id, displayName: id, kind: "sub", parentId: "Main", session: childSession });
	}

	/** Texts of the stall guard's notices in Main's transcript. */
	function stallNotices(): string[] {
		return session.messages.flatMap(message => {
			if (message.role !== "developer") return [];
			const texts =
				typeof message.content === "string"
					? [message.content]
					: message.content.flatMap(part => (part.type === "text" ? [part.text] : []));
			return texts.filter(text => text.includes("blocked on you"));
		});
	}

	it("pauses while the child runs and ends once the child stops without replying", async () => {
		registerRunningChild();

		await session.prompt("Ask the child, then wait");
		await session.waitForIdle();
		await Promise.resolve();

		expect(runEvents).toEqual(["pause:true"]);
		expect(runStates).toEqual(["running"]);
		expect(session.isRunActive).toBe(true);
		expect(session.wakeSources?.agents).toEqual(["Child"]);

		// The child's run ends without a message to Main: nothing can wake Main's run any more.
		registry.setStatus("Child", "idle");
		await session.waitForRunEnd();

		expect(runEvents).toEqual(["pause:true", "end"]);
		expect(runStates).toEqual(["running", "idle"]);
		expect(session.isRunActive).toBe(false);
	});

	it("continues the run once with a notice naming a child that waits for Main's next message", async () => {
		registerRunningChild();
		const release = registry.awaits.hold("Child", ["Main"], { interruptible: true, message: true });
		try {
			await session.prompt("Ask the child, then wait");
			await session.waitForRunEnd();

			expect(modelCalls).toBe(2);
			const notices = stallNotices();
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain("`Child`");
			expect(notices[0]).toContain("waiting for your next message");
			expect(runEvents).toEqual(["pause:false", "end"]);
		} finally {
			release();
		}
	});

	it("names a waiting child only once nothing else can wake Main", async () => {
		registerRunningChild();
		registerRunningChild("Runner");
		const release = registry.awaits.hold("Child", ["Main"], { interruptible: true, message: true });
		try {
			await session.prompt("Ask the child, then wait");
			await session.waitForIdle();
			await Promise.resolve();
			expect(modelCalls).toBe(1);
			expect(session.wakeSources?.agents).toEqual(["Runner"]);

			// The other child stops without writing: the paused run now has nothing to wait on.
			registry.setStatus("Runner", "idle");
			await session.waitForRunEnd();

			expect(modelCalls).toBe(2);
			expect(stallNotices()).toHaveLength(1);
			expect(runEvents).toEqual(["pause:true", "end"]);
		} finally {
			release();
		}
	});

	/**
	 * The incident's exchange: `Child` asks Main, Main promises a later answer, and `Child` waits
	 * for it. Recorded on the bus without a delivery: the test drives Main's turns itself.
	 */
	function childAwaitsPromise(): () => void {
		bus.park({ from: "Child", to: "Main", body: "gate please" });
		bus.park({ from: "Main", to: "Child", body: "accepted; it starts once the running gate ends", progress: true });
		return registry.awaits.hold("Child", ["Main"], { interruptible: true, message: true });
	}

	it("does not let Main silently end a turn while a child waits on its promise and nothing wakes it", async () => {
		registerRunningChild();
		// Main's only job is the child's own task, which cannot finish while the child waits on Main.
		const childRun = Promise.withResolvers<string>();
		jobs.register("task", "Child", () => childRun.promise, { id: "Child", agentId: "Child", ownerId: "Main" });
		const release = childAwaitsPromise();
		try {
			await session.prompt("Promise the child its gate run, then stop");
			await session.waitForIdle();
			await Promise.resolve();

			expect(modelCalls).toBe(2);
			const notices = stallNotices();
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain("`Child`");
			expect(notices[0]).toContain('asked "gate please"');
			expect(notices[0]).toContain('you promised "accepted; it starts once the running gate ends"');
			// Ignoring the notice leaves Main paused on the child's job, with nothing that wakes it.
			expect(runEvents).toEqual(["pause:false", "pause:true"]);
			expect(session.hasPendingWake).toBe(false);

			// The same unanswered ask never draws a second notice.
			await session.prompt("Anything else?");
			await session.waitForIdle();
			await Promise.resolve();
			expect(modelCalls).toBe(3);
			expect(stallNotices()).toHaveLength(1);
		} finally {
			release();
			childRun.resolve("done");
		}
	});

	it("names no waiter while a job of Main's own will wake it", async () => {
		registerRunningChild();
		const gate = Promise.withResolvers<string>();
		const gateJob = jobs.register("bash", "run the gate", () => gate.promise, { ownerId: "Main" });
		const release = childAwaitsPromise();
		try {
			await session.prompt("Promise the child its gate run, then stop");
			await session.waitForIdle();
			await Promise.resolve();

			expect(modelCalls).toBe(1);
			expect(stallNotices()).toEqual([]);
			expect(session.wakeSources?.jobs).toEqual([gateJob]);
			expect(session.hasPendingWake).toBe(true);
		} finally {
			release();
			gate.resolve("gate passed");
		}
	});

	it("does not wait for a child that is itself blocked until Main acts", async () => {
		registerRunningChild();
		const release = registry.awaits.hold("Child", ["Main"], { interruptible: true });
		try {
			await session.prompt("Ask the child, then wait");
			await session.waitForRunEnd();

			expect(runEvents).toEqual(["end"]);
			expect(runStates).toEqual(["running", "idle"]);
		} finally {
			release();
		}
	});
});
