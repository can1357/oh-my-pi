import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// A stream that dies after the reply's text rendered used to end the session
// on the stall error: replay would duplicate the shown text and the stalled
// turn had no tool call to resume from. The session must keep the partial
// turn and continue after it.
describe("AgentSession text-only stream stall", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-text-stall-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("continues after committed text instead of stopping on the stall", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");

		const mock = createMockModel({
			responses: [
				{
					content: ["Here is the first half of the answ"],
					stopReason: "error",
					// The raw transport diagnostic observed from a websocket that
					// dropped mid-response (e.g. Responses `stream_incomplete`).
					errorMessage: "stream_incomplete",
				},
				{ content: ["er, and the second half."], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": true }),
			modelRegistry,
		});
		session.subscribe(() => {});

		await session.prompt("explain it");
		await session.waitForIdle();

		expect(mock.calls.length).toBe(2);
		const resumed = mock.calls[1]!.context.messages;
		const partial = resumed.findLast(message => message.role === "assistant") as AssistantMessage;
		expect(partial.content).toContainEqual({ type: "text", text: "Here is the first half of the answ" });
		expect(resumed.at(-1)?.role).toBe("developer");

		const last = session.agent.state.messages.at(-1) as AssistantMessage;
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "er, and the second half." });
	});

	// Committed-text stream-stall continuations are paced on the real session
	// scheduler (2s, 5s, 15s, 30s, 60s per prompt). These tests drive the real
	// scheduling owner under a fake clock: each continuation fires only after
	// its wait elapses, and abort or conversation reset drops it entirely.
	const STALL_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
	const PUMP_STEP_MS = 25;
	// Preserve an event-loop yield before fake timers replace timer functions.
	const yieldEventLoop = globalThis.setImmediate;

	function streamStallResponse(text: string): MockResponse {
		return { content: [text], stopReason: "error", errorMessage: "stream_incomplete" };
	}

	async function pumpUntil(check: () => boolean, label: string): Promise<void> {
		for (let i = 0; i < 20_000; i++) {
			if (check()) return;
			vi.advanceTimersByTime(PUMP_STEP_MS);
			const { promise, resolve } = Promise.withResolvers<void>();
			yieldEventLoop(resolve);
			await promise;
		}
		throw new Error(`timed out waiting for ${label}`);
	}

	function createTrackedSession(responses: MockResponse[]): { session: AgentSession; callTimes: number[] } {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const mock = createMockModel({ responses });
		const callTimes: number[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (context, options) => {
				callTimes.push(Date.now());
				return mock.stream(context, options);
			},
		});
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": true }),
			modelRegistry,
		});
		created.subscribe(() => {});
		return { session: created, callTimes };
	}

	it("paces successive continuations at 2s, 5s, 15s, 30s, 60s and then stops", async () => {
		vi.useFakeTimers();
		try {
			const { session: created, callTimes } = createTrackedSession([
				streamStallResponse("Here is the first half of the answ"),
				streamStallResponse("Still cut off one"),
				streamStallResponse("Still cut off two"),
				streamStallResponse("Still cut off three"),
				streamStallResponse("Still cut off four"),
				streamStallResponse("Still cut off five"),
			]);
			session = created;

			let settled = false;
			const promptDone = created.prompt("explain it");
			promptDone.then(
				() => (settled = true),
				() => (settled = true),
			);

			await pumpUntil(() => callTimes.length === 1, "first stalled turn");
			for (const [index, delayMs] of STALL_DELAYS_MS.entries()) {
				await pumpUntil(() => callTimes.length === index + 2, `continuation ${index + 2}`);
				const elapsed = callTimes[index + 1]! - callTimes[index]!;
				expect(elapsed).toBeGreaterThanOrEqual(delayMs - PUMP_STEP_MS);
				expect(elapsed).toBeLessThan(delayMs + 2_000);
			}
			// The sixth stall exhausted the per-prompt continuation budget: the
			// turn ends and no seventh attempt is made.
			await pumpUntil(() => settled, "prompt settlement");
			expect(callTimes.length).toBe(6);
		} finally {
			await session?.abort();
			vi.useRealTimers();
		}
	});

	it("does not continue when the run is aborted during the pacing wait", async () => {
		vi.useFakeTimers();
		try {
			const { session: created, callTimes } = createTrackedSession([
				streamStallResponse("Here is the first half of the answ"),
				{ content: ["never reached"], stopReason: "stop" },
			]);
			session = created;

			let settled = false;
			const promptDone = created.prompt("explain it");
			promptDone.then(
				() => (settled = true),
				() => (settled = true),
			);
			await pumpUntil(
				() => callTimes.length === 1 && created.agent.state.messages.some(message => message.role === "developer"),
				"scheduled continuation",
			);

			let aborted = false;
			created.abort().then(
				() => (aborted = true),
				() => (aborted = true),
			);
			await pumpUntil(() => aborted && settled, "abort settlement");
			vi.advanceTimersByTime(600_000);
			for (let tick = 0; tick < 100; tick++) await Promise.resolve();
			expect(callTimes.length).toBe(1);
		} finally {
			await session?.abort();
			vi.useRealTimers();
		}
	});

	it("drops the pending continuation when the conversation resets mid-wait", async () => {
		vi.useFakeTimers();
		try {
			const { session: created, callTimes } = createTrackedSession([
				streamStallResponse("Here is the first half of the answ"),
				{ content: ["never reached"], stopReason: "stop" },
			]);
			session = created;

			let settled = false;
			// Drive the same core consumer without a logical prompt in flight, so
			// the public conversation reset is admitted during the scheduled wait.
			const promptDone = created.agent.prompt("explain it");
			promptDone.then(
				() => (settled = true),
				() => (settled = true),
			);
			await pumpUntil(
				() => settled && created.agent.state.messages.some(message => message.role === "developer"),
				"scheduled continuation",
			);

			let reset = false;
			created.resetSessionContext().then(
				() => (reset = true),
				() => (reset = true),
			);
			await pumpUntil(() => reset, "reset settlement");
			vi.advanceTimersByTime(600_000);
			for (let tick = 0; tick < 100; tick++) await Promise.resolve();
			expect(callTimes.length).toBe(1);
		} finally {
			await session?.abort();
			vi.useRealTimers();
		}
	});

	it("keeps the committed-text sequence across a generic empty-stream retry", async () => {
		vi.useFakeTimers();
		try {
			const { session: created, callTimes } = createTrackedSession([
				streamStallResponse("Committed partial answer"),
				{ content: [], stopReason: "error", errorMessage: "stream_incomplete" },
				streamStallResponse("More committed partial answer"),
				{ content: ["Completed answer"], stopReason: "stop" },
			]);
			session = created;
			let genericRetries = 0;
			created.subscribe(event => {
				if (event.type === "auto_retry_start") genericRetries++;
			});
			let settled = false;
			const promptDone = created.prompt("explain it");
			promptDone.then(() => {
				settled = true;
			});
			await pumpUntil(() => callTimes.length === 4 && settled, "alternating recovery settlement");
			expect(genericRetries).toBe(1);
			expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(2_000 - PUMP_STEP_MS);
			expect(callTimes[3]! - callTimes[2]!).toBeGreaterThanOrEqual(5_000 - PUMP_STEP_MS);
			expect(callTimes[3]! - callTimes[2]!).toBeLessThan(7_000);
		} finally {
			await session?.abort();
			vi.useRealTimers();
		}
	});

	it("recovers committed text from a structured local Responses stream_incomplete event", async () => {
		const requests: string[] = [];
		const requestTimes: number[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				requests.push(await request.text());
				requestTimes.push(Date.now());
				const first = requests.length === 1;
				const events = [
					{ type: "response.created", response: { id: `resp_${requests.length}`, status: "in_progress" } },
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { type: "message", id: "msg_local", role: "assistant", status: "in_progress", content: [] },
					},
					{
						type: "response.output_text.delta",
						output_index: 0,
						item_id: "msg_local",
						delta: first ? "Partial answer" : "Completed answer",
					},
					...(first
						? [{ type: "error", code: "stream_incomplete", message: "Upstream connection ended" }]
						: [
								{
									type: "response.output_item.done",
									output_index: 0,
									item: {
										type: "message",
										id: "msg_local",
										role: "assistant",
										status: "completed",
										content: [{ type: "output_text", text: "Completed answer" }],
									},
								},
								{
									type: "response.completed",
									response: {
										id: "resp_2",
										status: "completed",
										usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
									},
								},
							]),
				];
				return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		vi.useFakeTimers();
		try {
			authStorage.keys.setRuntime("openai", "local-test-key");
			const model = buildModel({
				api: "openai-responses",
				provider: "openai",
				id: "local-responses-test",
				name: "Local Responses Test",
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
				contextWindow: 200_000,
				maxTokens: 8192,
				input: ["text"],
				reasoning: false,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
			const agent = new Agent({
				getApiKey: () => "local-test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			});
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": true }),
				modelRegistry,
			});
			let settled = false;
			const promptDone = session.prompt("explain it");
			promptDone.then(() => {
				settled = true;
			});
			await pumpUntil(() => settled, "local SSE recovery");
			await promptDone;
			expect(requests).toHaveLength(2);
			expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(2_000 - PUMP_STEP_MS);
			const assistants = agent.state.messages.filter(message => message.role === "assistant") as AssistantMessage[];
			expect(assistants[0]?.content).toContainEqual(
				expect.objectContaining({ type: "text", text: "Partial answer" }),
			);
			expect(AIError.retriable(AIError.classifyMessage(assistants[0]!))).toBe(true);
			expect(assistants.at(-1)?.stopReason).toBe("stop");
			expect(requests[1]).toContain("Partial answer");
		} finally {
			await session?.abort();
			vi.useRealTimers();
			server.stop(true);
		}
	});
});
