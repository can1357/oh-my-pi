import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * An eval cell awaiting a subagent consumes the subagent's output after the
 * delivery sink parked an async-result for it on the yield queue. Once
 * consumed, that entry is stale and the step-boundary drain drops it, so a
 * peek that skips the staleness check acts on a notice that never arrives.
 */
describe("AgentSession peek at consumed background completions", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let manager: AsyncJobManager;
	let session: AgentSession | undefined;
	let gates: Array<PromiseWithResolvers<string>>;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-consumed-completion-peek-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
		manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);
		gates = [];
	});

	afterEach(async () => {
		for (const gate of gates) gate.resolve("released");
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
		AsyncJobManager.resetForTests();
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
	});

	/** Register a job owned by the session that runs until its gate resolves. */
	function gatedJob(id: string, type: "bash" | "task"): PromiseWithResolvers<string> {
		const gate = Promise.withResolvers<string>();
		gates.push(gate);
		manager.register(type, id, async () => await gate.promise, { id, ownerId: "Main" });
		return gate;
	}

	function createSession(responses: MockHandler[]): AgentSession {
		const mock = createMockModel({ provider: "openai", id: "gpt-test", responses });
		const wait = new WaitTool({
			cwd: tempDir.path(),
			settings: Settings.isolated({ "launch.enabled": false }),
			agentRegistry: AgentRegistry.global(),
			asyncJobManager: manager,
			getAgentId: () => "Main",
		} as unknown as ToolSession);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [wait], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([[wait.name, wait as unknown as AgentTool]]),
			agentId: "Main",
			asyncJobManager: manager,
		});
		return session;
	}

	/** Resolves `queued` when the session's delivery sink parks an async-result on the yield queue. */
	function observeAsyncResultQueued(target: AgentSession, queued: PromiseWithResolvers<void>): void {
		const enqueue = target.yieldQueue.enqueueWithReceipt.bind(target.yieldQueue);
		vi.spyOn(target.yieldQueue, "enqueueWithReceipt").mockImplementation((kind, entry) => {
			const receipt = enqueue(kind, entry);
			if (kind === "async-result") queued.resolve();
			return receipt;
		});
	}

	it("does not interrupt a wait for a completion the eval cell already consumed", async () => {
		const subagent = gatedJob("subagent", "task");
		const cell = gatedJob("cell", "bash");
		const queued = Promise.withResolvers<void>();
		const active = createSession([
			async () => {
				// While the model streams, the cell's subagent finishes and the cell
				// takes its result after the delivery was queued.
				subagent.resolve("subagent report");
				await queued.promise;
				manager.consumeJobResults(["subagent"]);
				return { content: [{ type: "toolCall", name: "wait", arguments: {} }] };
			},
			{ content: ["Done"] },
		]);
		observeAsyncResultQueued(active, queued);
		// Pass-through hook that marks when the run loop has asked whether a
		// completion is queued, so the cell can finish only after that decision.
		const peek = active.agent.hasBackgroundCompletions;
		if (!peek) throw new Error("Expected the session to install a background-completion peek");
		const peeked = Promise.withResolvers<void>();
		active.agent.hasBackgroundCompletions = async () => {
			const pending = await peek();
			peeked.resolve();
			return pending;
		};
		const watch = manager.watchJobs.bind(manager);
		vi.spyOn(manager, "watchJobs").mockImplementation(ids => {
			const watched = watch(ids);
			// The cell finishes once the wait is blocked on it and the loop has peeked.
			if (ids.includes("cell")) void peeked.promise.then(() => cell.resolve("cell finished"));
			return watched;
		});

		await active.prompt("wait for the cell");
		await active.waitForIdle();

		const waitResult = active.agent.state.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "wait",
		);
		expect(JSON.stringify(waitResult?.content)).toContain("cell finished");
	});

	it("reports no pending async work once the only queued result was consumed", async () => {
		const subagent = gatedJob("subagent", "task");
		const active = createSession([{ content: ["Done"] }]);
		const queued = Promise.withResolvers<void>();
		observeAsyncResultQueued(active, queued);

		subagent.resolve("subagent report");
		await queued.promise;
		manager.consumeJobResults(["subagent"]);

		expect(active.hasPendingAsyncWork()).toBe(false);
	});
});
