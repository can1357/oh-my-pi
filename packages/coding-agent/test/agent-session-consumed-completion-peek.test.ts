import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * An eval cell awaiting a subagent consumes the subagent's output after the
 * delivery sink parked an async-result for it on the yield queue. Once
 * consumed, that entry is stale and the step-boundary drain drops it, so a
 * peek that skips the staleness check acts on a notice that never arrives.
 *
 * The cases that drove the built-in `wait` tool through this path were removed
 * with the tool: the capability wait settles on channel records in its own
 * process and never consumes omp's in-process job deliveries.
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
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
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
			toolRegistry: new Map(),
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
