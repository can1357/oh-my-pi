import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, ChoiceQuestion, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import * as connectionPrewarm from "@oh-my-pi/pi-ai/providers/connection-prewarm";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { attemptEditAutoRepair } from "@oh-my-pi/pi-coding-agent/edit/auto-repair";
import { ChainJudge } from "@oh-my-pi/pi-coding-agent/judgment";
import { startMemoryStartupTask } from "@oh-my-pi/pi-coding-agent/memories";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CacheWarmer, type CacheWarmStream } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";
import { assistantMsg, userMsg } from "./utilities";

/** One macrotask turn: every continuation queued before it has run. */
function tick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/**
 * Give an unheld request every chance to reach the wire: run turns until
 * `sent` is non-empty or a generous bound passes. A held request leaves it
 * empty however long this runs.
 */
async function untilSentOrIdle(sent: readonly unknown[], turns = 200): Promise<void> {
	for (let i = 0; i < turns && sent.length === 0; i++) await tick();
}

/** The provider layer's contract: await the request's hold, then put it on the wire. */
function heldCompletion(sent: boolean[], text: string) {
	return async (model: Model<Api>, _context: unknown, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
		await options?.beforeDispatch?.();
		sent.push(agentPauseGate.paused);
		return reply(model, text);
	};
}

function reply(model: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 3,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 4,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

afterEach(() => {
	agentPauseGate.resume();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// `AgentSession.compact()` routed its summary requests through the session's
// side stream with no hold: with `/pause` engaged it made three transport
// calls, each seeing `{ paused: true, hasHold: false }`, and completed.
describe("session compaction under /pause", () => {
	test("sends nothing until resume, and every request carries the hold", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled openai/gpt-4o-mini");
		const auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime("openai", "fake");
		const sent: { paused: boolean; hasHold: boolean }[] = [];
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.methodOrder": ["soft"] }),
			modelRegistry: new ModelRegistry(auth),
			sideStreamFn: (m, c, o) =>
				streamSimple(m, c, {
					...o,
					fetch: async () => {
						sent.push({ paused: agentPauseGate.paused, hasHold: !!o?.beforeDispatch });
						const frames = [
							{ type: "response.created", response: { id: "compact" } },
							{
								type: "response.output_item.added",
								item: { type: "message", id: "summary", role: "assistant", status: "in_progress", content: [] },
							},
							{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
							{ type: "response.output_text.delta", delta: "A useful compacted summary." },
							{
								type: "response.output_item.done",
								item: {
									type: "message",
									id: "summary",
									role: "assistant",
									status: "completed",
									content: [{ type: "output_text", text: "A useful compacted summary." }],
								},
							},
							{
								type: "response.completed",
								response: {
									id: "compact",
									status: "completed",
									usage: {
										input_tokens: 5,
										output_tokens: 2,
										total_tokens: 7,
										input_tokens_details: { cached_tokens: 0 },
									},
								},
							},
						];
						return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
							headers: { "content-type": "text/event-stream" },
						});
					},
				}),
		});
		session.subscribe(() => {});
		for (const text of ["first", "second", "third"]) {
			for (const message of [userMsg(text), assistantMsg(`${text} answer`)]) {
				session.agent.appendMessage(message);
				session.sessionManager.appendMessage(message);
			}
		}
		try {
			agentPauseGate.pause();
			const pending = session.compact();
			await untilSentOrIdle(sent);
			expect(sent).toEqual([]);

			agentPauseGate.resume();
			const result = await pending;
			expect(result.summary).toContain("A useful compacted summary.");
			expect(sent.length).toBeGreaterThan(0);
			expect(sent.every(request => !request.paused && request.hasHold)).toBe(true);
		} finally {
			agentPauseGate.resume();
			await session.dispose();
			auth.close();
		}
	});
});

// Memory startup extracts each old rollout and consolidates the results with
// `completeSimple`, beside the agent loop; neither request carried a hold, so
// both went out while `/pause` was engaged.
describe("memory extraction and consolidation under /pause", () => {
	let tempDir: string;
	let savedXdgData: string | undefined;
	let savedXdgState: string | undefined;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pause-memories-${Snowflake.next()}`);
		await fs.mkdir(tempDir, { recursive: true });
		savedXdgData = process.env.XDG_DATA_HOME;
		savedXdgState = process.env.XDG_STATE_HOME;
		process.env.XDG_DATA_HOME = "/nonexistent-xdg-data";
		process.env.XDG_STATE_HOME = "/nonexistent-xdg-state";
	});

	afterEach(async () => {
		if (savedXdgData === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = savedXdgData;
		if (savedXdgState === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = savedXdgState;
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("holds stage one and the consolidation until resume", async () => {
		const agentDir = tempDir;
		const sessionDir = path.join(agentDir, "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sessionFile = path.join(sessionDir, "current-session.jsonl");
		await fs.writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "current-thread", cwd: agentDir })}\n`);
		const rolloutRows = [
			{ type: "session", id: "thread-a", cwd: agentDir },
			{ type: "message", message: { role: "user", content: "summarize this rollout" } },
		];
		await fs.writeFile(
			path.join(sessionDir, "thread-a.jsonl"),
			`${rolloutRows.map(row => JSON.stringify(row)).join("\n")}\n`,
		);
		const settings = Settings.isolated({
			"memories.enabled": true,
			"memories.minRolloutIdleHours": 0,
			"memories.maxRolloutsPerStartup": 16,
			"memories.threadScanLimit": 64,
			"memories.phase2HeartbeatSeconds": 1,
		});
		const model = { provider: "openai", id: "test-model", name: "test-model", contextWindow: 32_000 } as Model;
		const modelRegistry = {
			find: () => model,
			getAll: () => [model],
			getApiKey: async () => "test-api-key",
			resolver: () => async () => "test-api-key",
		};
		const settled = Promise.withResolvers<void>();
		const session = {
			sessionManager: {
				getSessionFile: () => sessionFile,
				getSessionDir: () => sessionDir,
				getSessionId: () => "current-thread",
				getCwd: () => agentDir,
			},
			settings,
			model,
			modelRegistry,
			refreshBaseSystemPrompt: async () => settled.resolve(),
		};
		const sent: boolean[] = [];
		const stageOne = JSON.stringify({
			rollout_summary: "Rollout summary A",
			rollout_slug: "thread-a-rollout",
			raw_memory: "Raw memory A",
		});
		const consolidation = JSON.stringify({
			memory_md: "# Memory\n\nConsolidated body",
			memory_summary: "Consolidated summary",
			skills: [],
		});
		vi.spyOn(ai, "completeSimple")
			.mockImplementationOnce(heldCompletion(sent, stageOne) as typeof ai.completeSimple)
			.mockImplementationOnce(heldCompletion(sent, consolidation) as typeof ai.completeSimple);

		agentPauseGate.pause();
		startMemoryStartupTask({
			session: session as never,
			settings,
			modelRegistry: modelRegistry as never,
			agentDir,
			taskDepth: 0,
		});
		await untilSentOrIdle(sent);
		expect(sent).toEqual([]);

		agentPauseGate.resume();
		await settled.promise;
		expect(sent).toEqual([false, false]);
	});
});

// The edit tool's auto-repair asks the `smol` model to fix a parse regression
// it just committed. The tool started before `/pause`, but the repair is a new
// request, and it went out while the gate was engaged.
describe("edit auto-repair under /pause", () => {
	test("sends no repair request until resume", async () => {
		const dir = path.join(os.tmpdir(), `pause-repair-${Snowflake.next()}`);
		await fs.mkdir(dir, { recursive: true });
		try {
			const filePath = path.join(dir, "edited.ts");
			const prev = "function f() {\n\treturn compute(1);\n}\n";
			const next = "function f() {\n\treturn computeNext(1;\n}\n";
			await Bun.write(filePath, next);
			const model = getBundledModel("openai", "gpt-4o-mini");
			if (!model) throw new Error("Expected bundled openai/gpt-4o-mini");
			const session = {
				settings: Settings.isolated({
					"edit.autoRepair.enabled": true,
					modelRoles: { smol: `${model.provider}/${model.id}` },
				}),
				modelRegistry: {
					getAvailable: () => [model],
					getApiKey: async () => "test-key",
					resolver: () => async () => "test-key",
				},
				getSessionId: () => "repair-session",
			} as unknown as ToolSession;
			const sent: boolean[] = [];
			vi.spyOn(ai, "completeSimple").mockImplementation(
				heldCompletion(sent, "\treturn computeNext(1);") as typeof ai.completeSimple,
			);

			agentPauseGate.pause();
			const pending = attemptEditAutoRepair({
				session,
				snapshot: { path: filePath, prev, next },
				writethrough: async () => undefined,
			} as never);
			await untilSentOrIdle(sent);
			expect(sent).toEqual([]);

			agentPauseGate.resume();
			await pending;
			expect(sent.length).toBeGreaterThan(0);
			expect(sent.every(paused => !paused)).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

const TIER_QUESTION: ChoiceQuestion<"low" | "high"> = {
	type: "choice",
	instructions: "Choose the reasoning tier.",
	criteria: { low: "simple", high: "complex" },
};

const JEV_PREVIEW = {
	id: "jev-preview",
	name: "JEV Preview",
	api: "typesafe",
	provider: "typesafe",
	baseUrl: "https://judge.example.test/",
	kind: "judge",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as Model<Api>;

function judgeRegistry(models: Model<Api>[], keys: Record<string, string>): ModelRegistry {
	const authStorage = createInMemoryAuthStorage();
	for (const provider in keys) authStorage.keys.setRuntime(provider, keys[provider]!);
	const registry = new ModelRegistry(authStorage, "/nonexistent/pause-judge-models.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue(models);
	return registry;
}

// Judge questions — the unexpected-stop check, prewalk, TTSR, auto thinking —
// run beside the agent loop, and neither the native judgment client nor the
// chat backend forwarded a hold, so each sent while `/pause` was engaged.
describe("judge candidates under /pause", () => {
	test("a native judgment request waits for resume", async () => {
		const settings = Settings.isolated({ modelRoles: { judge: "typesafe/jev-preview" } });
		const registry = judgeRegistry([JEV_PREVIEW], { typesafe: "ts-key" });
		const sent: boolean[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async () => {
				sent.push(agentPauseGate.paused);
				return Response.json({
					model: "jev-1.13.0",
					answers: {
						level: { type: "choice", choice: "high", probabilities: { low: 0.1, high: 0.9 }, confidence: 0.8 },
					},
					usage: { input_tokens: 8, output_tokens: 2 },
				});
			}),
		);

		agentPauseGate.pause();
		const pending = new ChainJudge({ settings, registry, purpose: "test" }).judge({
			state: "redesign the scheduler",
			questions: { level: TIER_QUESTION },
		});
		await untilSentOrIdle(sent);
		expect(sent).toEqual([]);

		agentPauseGate.resume();
		expect((await pending).answers.level.choice).toBe("high");
		expect(sent).toEqual([false]);
	});

	test("a chat-model judgment carries the hold to the provider", async () => {
		const online = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!online) throw new Error("Expected bundled anthropic/claude-sonnet-4-6");
		const settings = Settings.isolated({ modelRoles: { judge: `${online.provider}/${online.id}` } });
		const registry = judgeRegistry([online], { [online.provider]: "online-key" });
		const sent: boolean[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(heldCompletion(sent, "high") as typeof ai.completeSimple);

		agentPauseGate.pause();
		const pending = new ChainJudge({ settings, registry, purpose: "test" }).judge({
			state: "redesign the scheduler",
			questions: { level: TIER_QUESTION },
		});
		await untilSentOrIdle(sent);
		expect(sent).toEqual([]);

		agentPauseGate.resume();
		expect((await pending).answers.level.choice).toBe("high");
		expect(sent).toEqual([false]);
	});
});

// The interactive mode prewarms the model connection on startup, on model
// change and while the user types; a paused session opened that connection.
describe("connection prewarm under /pause", () => {
	test("a paused session does not prewarm, and a resumed one does", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5");
		const prewarm = vi.spyOn(connectionPrewarm, "prewarmModelConnection").mockResolvedValue(undefined);
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(createInMemoryAuthStorage()),
		});
		try {
			agentPauseGate.pause();
			session.prewarmModelConnection();
			expect(prewarm).not.toHaveBeenCalled();

			agentPauseGate.resume();
			session.prewarmModelConnection();
			expect(prewarm).toHaveBeenCalledTimes(1);
		} finally {
			await session.dispose();
		}
	});
});

// A cache-warm refresh replayed the main turn's own request options, hold
// included: a hook bound to a turn that had ended, reporting its pause state.
describe("cache warming under /pause", () => {
	test("a refresh carries a hold of its own that parks at the gate", async () => {
		vi.useFakeTimers();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5");
		const warmModel = { ...model, promptCache: { short: 300, long: 3600 } } as Model;
		const replays: SimpleStreamOptions[] = [];
		const message = reply(warmModel, "");
		message.usage = { ...message.usage, cacheRead: 100_000, totalTokens: 100_004 };
		const warmer = new CacheWarmer({
			stream: (_model, _context, options): CacheWarmStream => {
				replays.push(options ?? {});
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "done", reason: "stop", message };
					},
					result: () => Promise.resolve(message),
				};
			},
			getPromptTokens: () => 100_000,
			getMode: () => "idle",
		});
		let loopHoldCalls = 0;
		const loopHold = () => {
			loopHoldCalls++;
		};
		warmer.start({ model: warmModel, context: { messages: [] }, options: { beforeDispatch: loopHold } }, () => true);
		vi.advanceTimersByTime(4.5 * 60_000);
		for (let i = 0; i < 100; i++) await Promise.resolve();
		expect(replays).toHaveLength(1);
		const replayHold = replays[0]?.beforeDispatch;
		expect(replayHold).toBeDefined();
		expect(replayHold).not.toBe(loopHold);

		agentPauseGate.pause();
		let released = false;
		const held = Promise.resolve(replayHold?.()).then(() => {
			released = true;
		});
		for (let i = 0; i < 100; i++) await Promise.resolve();
		expect(released).toBe(false);
		agentPauseGate.resume();
		await held;
		expect(released).toBe(true);
		expect(loopHoldCalls).toBe(0);

		// The hold ends with the warmer's own lifetime: a refresh held when the
		// warmer stops fails instead of sending on resume.
		agentPauseGate.pause();
		const cancelled = Promise.resolve(replayHold?.());
		warmer.cancel();
		await expect(cancelled).rejects.toThrow();
	});
});
