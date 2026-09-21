import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import {
	Agent,
	type AgentMessage,
	type AgentTool,
	type AgentTurnEndContext,
	type StreamFn,
} from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { AdvisorLoopGuard } from "../src/advisor/loop-guard";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

/** Advisor-visible tool that fails the same way on every call. */
const failingReadTool: AgentTool = {
	name: "read",
	label: "Read",
	description: "Mock read tool",
	parameters: type({ "path?": "string" }),
	execute: async () => ({
		content: [{ type: "text" as const, text: "ENOENT: no such file or directory" }],
		isError: true,
	}),
};

describe("advisor tool-call loop guard", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-tool-call-loop-guard-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(async () => {
		authStorage.close();
		await tempDir.remove();
	});

	/**
	 * Live advisor agent built through the real `SessionAdvisors` path, driven by
	 * a stream that repeats one identical failing tool call forever.
	 */
	function createAdvisor(
		guardSettings: Record<string, unknown>,
		maxRepeatedTurns = 8,
		advisorConfig?: AdvisorConfig | AdvisorConfig[],
		primaryToolSteps = 0,
		advice?: string,
		adviceSeverity: "nit" | "concern" | "blocker" = "nit",
		advices?: { note: string; severity: "nit" | "concern" | "blocker" }[],
	): { advisor: Agent; contexts: Context[]; reviewStarts: Context[] } {
		const primaryMock = createMockModel({
			provider: "anthropic",
			responses: [
				...Array.from({ length: primaryToolSteps }, (_, index) => ({
					content: [
						{
							type: "toolCall" as const,
							id: `primary-read-${index}`,
							name: "read",
							arguments: { path: "missing.ts" },
						},
					],
				})),
				{ content: ["primary complete"] },
				{ content: ["primary complete"] },
				{ content: ["primary complete"] },
			],
		});
		const advisorMock = createMockModel({ provider: "anthropic" });
		const contexts: Context[] = [];
		// One entry per scheduled review: a drain prompt's first stream call ends
		// on the freshly appended Session-update user message, while continuation
		// calls inside the same review end on tool results or assistant text.
		const reviewStarts: Context[] = [];
		let turn = 0;
		const advisorStreamFn: typeof advisorMock.stream = (_model, context) => {
			contexts.push(context);
			const isReviewStart = context.messages.at(-1)?.role === "user";
			if (isReviewStart) reviewStarts.push(context);
			// Deliberately ignore the corrective. The enabled guard must hard-stop
			// this stream; the finite ceiling keeps the disabled control bounded.
			// `advices` feeds one note per review start, so several advisors (or
			// several reviews) can each raise their own note.
			const queued = isReviewStart ? advices?.shift() : undefined;
			const advising = queued !== undefined || (advice !== undefined && turn === 0);
			const repeating = advising || turn < maxRepeatedTurns;
			turn++;
			const adviceArgs = queued ?? { note: advice, severity: adviceSeverity };
			const message: AssistantMessage = repeating
				? {
						role: "assistant",
						content: [
							advising
								? {
										type: "toolCall",
										id: `tc-${turn}`,
										name: "advise",
										arguments: adviceArgs,
									}
								: { type: "toolCall", id: `tc-${turn}`, name: "read", arguments: { path: "missing.ts" } },
						],
						api: advisorMock.api,
						provider: advisorMock.provider,
						model: advisorMock.id,
						usage: zeroUsage,
						stopReason: "toolUse",
						timestamp: Date.now(),
					}
				: {
						role: "assistant",
						content: [{ type: "text", text: "Stopped repeating." }],
						api: advisorMock.api,
						provider: advisorMock.provider,
						model: advisorMock.id,
						usage: zeroUsage,
						stopReason: "stop",
						timestamp: Date.now(),
					};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: repeating ? "toolUse" : "stop", message });
			});
			return stream;
		};
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": false,
			"todo.enabled": false,
			...guardSettings,
		});
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: primaryMock,
					systemPrompt: [],
					tools: primaryToolSteps > 0 ? [failingReadTool] : [],
				},
				streamFn: primaryMock.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			advisorTools: [failingReadTool],
			advisorStreamFn,
			advisorConfigs:
				advisorConfig === undefined ? undefined : Array.isArray(advisorConfig) ? advisorConfig : [advisorConfig],
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be active");
		advisor.setModel(advisorMock);
		return { advisor, contexts, reviewStarts };
	}

	it("redirects the advisor's own repeated tool call and reaches its next request", async () => {
		const { advisor, contexts } = createAdvisor(
			{
				"model.toolCallLoopGuard.enabled": true,
				"model.toolCallLoopGuard.threshold": 3,
			},
			20,
		);

		if (!session) throw new Error("Expected live session");
		await session.prompt("review the current update");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);

		// First threshold injects one corrective; ignoring it re-arms the
		// detector, and the second threshold aborts. The agent loop observes the
		// abort after one already-scheduled request, bounding twenty repeats at 7.
		expect(contexts).toHaveLength(7);
		const delivered = JSON.stringify(contexts[3]!.messages);
		expect(delivered).toContain("You called `read` 3 consecutive times");
		expect(delivered).toContain("ENOENT: no such file or directory");
		const redirects = advisor.state.messages.filter(
			message => message.role === "user" && JSON.stringify(message.content).includes("tool_call_loop_detected"),
		);
		expect(redirects).toHaveLength(1);
		expect(advisor.state.messages.filter(message => message.role === "custom")).toHaveLength(0);
		expect(advisor.state.error).toBeUndefined();
	});

	it("starts repetition counting fresh after an advisor context reset", () => {
		const settings = Settings.isolated({
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 3,
		});
		const messages: AgentMessage[] = [];
		const guard = new AdvisorLoopGuard({
			settings,
			name: "test",
			liveMessages: () => messages,
			appendMessage: message => messages.push(message),
			abort: () => {},
		});
		const turn = (id: string): AgentTurnEndContext => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id, name: "read", arguments: { path: "missing.ts" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: [{ type: "text", text: "ENOENT" }],
				isError: true,
				timestamp: Date.now(),
			};
			return { message, toolResults: [result], willContinue: true };
		};

		guard.recordTurn(messages, turn("before-1"));
		guard.recordTurn(messages, turn("before-2"));
		guard.reset();
		guard.recordTurn(messages, turn("after-1"));
		guard.recordTurn(messages, turn("after-2"));
		expect(messages).toHaveLength(0);
		guard.recordTurn(messages, turn("after-3"));
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("user");
	});

	it("preserves terminal-boundary notes as cards instead of steering a new turn", async () => {
		const { reviewStarts } = createAdvisor({ "advisor.syncBacklog": "1" }, 0, undefined, 0, "looks fine");
		if (!session) throw new Error("Expected live session");

		await session.prompt("only update");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
		expect(reviewStarts).toHaveLength(1);

		// The nit delivered while the terminal boundary was open is preserved as
		// a visible card: it must not steer an advisor-triggered turn against
		// completed work (stale "keep going" advice causes spurious tool calls).
		const messages = session.agent.state.messages;
		const completions = messages.filter(
			message => message.role === "assistant" && JSON.stringify(message.content).includes("primary complete"),
		);
		expect(completions).toHaveLength(1);
		const cards = messages.filter(
			message => message.role === "custom" && JSON.stringify(message).includes("looks fine"),
		);
		expect(cards).toHaveLength(1);
	});

	it("lets a terminal blocker steer once but schedules no reviews while asleep", async () => {
		const { reviewStarts } = createAdvisor(
			{ "advisor.syncBacklog": "1" },
			0,
			undefined,
			0,
			"broken handoff",
			"blocker",
		);
		if (!session) throw new Error("Expected live session");

		await session.prompt("only update");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
		// The blocker steered exactly one continuation turn; that turn's terminal
		// boundary must not schedule another review, or advisor and primary keep
		// waking each other up.
		const completions = session.agent.state.messages.filter(
			message => message.role === "assistant" && JSON.stringify(message.content).includes("primary complete"),
		);
		expect(completions).toHaveLength(2);
		expect(reviewStarts).toHaveLength(1);

		await session.prompt("second update");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
		expect(reviewStarts).toHaveLength(2);
		const delivered = JSON.stringify(reviewStarts[1]!.messages);
		// The wake-up review receives the delta accumulated during the sleep:
		// the blocker-triggered continuation turn and the fresh input.
		expect(delivered).toContain("primary complete");
		expect(delivered).toContain("second update");
	});

	it("merges simultaneous terminal blockers into one continuation turn", async () => {
		createAdvisor(
			{ "advisor.syncBacklog": "1" },
			0,
			[{ name: "Reviewer A" }, { name: "Reviewer B" }],
			0,
			undefined,
			"nit",
			[
				{ note: "first broken handoff", severity: "blocker" },
				{ note: "second broken handoff", severity: "blocker" },
			],
		);
		if (!session) throw new Error("Expected live session");

		await session.prompt("only update");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);

		// Two blockers at one terminal boundary steer ONE merged continuation,
		// not one turn each (N blockers = N identical "Done" replies bug).
		const completions = session.agent.state.messages.filter(
			message => message.role === "assistant" && JSON.stringify(message.content).includes("primary complete"),
		);
		expect(completions).toHaveLength(2);
		const advisorMessages = session.agent.state.messages.filter(
			message => message.role === "custom" && JSON.stringify(message).includes("broken handoff"),
		);
		expect(advisorMessages).toHaveLength(1);
		const merged = JSON.stringify(advisorMessages[0]);
		expect(merged).toContain("first broken handoff");
		expect(merged).toContain("second broken handoff");
		expect(merged).toContain("Reviewer A");
		expect(merged).toContain("Reviewer B");
		expect(merged).toContain("aggregated review from other models");
	});

	it("steers one continuation turn when an agent-end advisor raises a concern at a terminal boundary", async () => {
		// An agent-end advisor reviews the complete run at the final boundary.
		// A concern means a material issue in finished work — it deserves one
		// steering turn, not a silent preserved card. The sleep latch prevents
		// cascade after that. A turn-mode concern at the same boundary preserves
		// as a card instead (work was reviewed per-turn).
		createAdvisor(
			{ "advisor.syncBacklog": "1" },
			0,
			{ name: "Final reviewer", reviewMode: "agent-end", reviewInterval: 1 },
			0,
			"finished work has a null deref",
			"concern",
		);
		if (!session) throw new Error("Expected live session");

		await session.prompt("only update");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);

		// The agent-end concern steered exactly one continuation turn.
		const completions = session.agent.state.messages.filter(
			message => message.role === "assistant" && JSON.stringify(message.content).includes("primary complete"),
		);
		expect(completions).toHaveLength(2);
	});

	it("accumulates skipped final reviews until cadence interval", async () => {
		const { contexts } = createAdvisor({ "advisor.syncBacklog": "1" }, 0, {
			name: "Final reviewer",
			reviewMode: "agent-end",
			reviewInterval: 2,
		});
		if (!session) throw new Error("Expected live session");

		await session.prompt("first update");
		await session.prompt("second update");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
		expect(contexts).toHaveLength(1);
		const delivered = JSON.stringify(contexts[0]!.messages);
		expect(delivered).toContain("first update");
		expect(delivered).toContain("second update");
	});

	it("defers agent-end review across tool-loop continuation", async () => {
		const { contexts } = createAdvisor(
			{ "advisor.syncBacklog": "1" },
			0,
			{ name: "Final reviewer", reviewMode: "agent-end" },
			1,
		);
		if (!session) throw new Error("Expected live session");

		await session.prompt("inspect missing file");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
		expect(contexts).toHaveLength(1);
		const delivered = JSON.stringify(contexts[0]!.messages);
		expect(delivered).toContain("inspect missing file");
		expect(delivered).toContain("ENOENT: no such file or directory");
	});

	it("expires interruption immunity across tool-loop steps even for an agent-end reviewer", async () => {
		const { advisor } = createAdvisor(
			{ "advisor.syncBacklog": "1", "advisor.immuneTurns": 1 },
			0,
			{ name: "Final reviewer", reviewMode: "agent-end" },
			2,
		);
		if (!session) throw new Error("Expected live session");
		const advise = advisor.state.tools.find(tool => tool.name === "advise");
		if (!advise) throw new Error("Expected advisor delivery tool");
		// Simulate delivery into a live primary before its next two steps.
		session.agent.state.isStreaming = true;
		try {
			await advise.execute("first-note", {
				note: "The first operation loses the selected file.",
				severity: "concern",
			});
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(session.agent.peekSteeringQueue()).toHaveLength(1);
			session.agent.clearSteeringQueue();
		} finally {
			session.agent.state.isStreaming = false;
		}
		await session.prompt("inspect missing file");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
		// Hold a real primary run open so agent_start clears terminal-unwind
		// preservation before the next concern arrives.
		const liveStarted = Promise.withResolvers<void>();
		const releaseLiveRun = Promise.withResolvers<void>();
		session.agent.streamFn = model => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "primary complete" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: zeroUsage,
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				liveStarted.resolve();
				void releaseLiveRun.promise.then(() => stream.push({ type: "done", reason: "stop", message }));
			});
			return stream;
		};
		const livePrompt = session.prompt("continue inspection");
		await liveStarted.promise;
		try {
			await advise.execute("next-note", {
				note: "The next operation overwrites the destination file.",
				severity: "concern",
			});
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(session.agent.peekSteeringQueue()).toHaveLength(1);
		} finally {
			session.agent.clearSteeringQueue();
			releaseLiveRun.resolve();
			await livePrompt;
		}
	});

	it("holds a final-review continuation during the post-interrupt cooldown", async () => {
		// The boundary flush decides steering through the same delivery policy as
		// live routing: inside the post-interrupt immune window a final-review
		// concern must preserve as a visible card, not steer a second consecutive
		// continuation turn.
		const { advisor } = createAdvisor(
			{ "advisor.syncBacklog": "1" },
			0,
			{ name: "Final reviewer", reviewMode: "agent-end" },
			0,
			"finished work drops the audit row",
			"concern",
		);
		if (!session) throw new Error("Expected live session");
		const advise = advisor.state.tools.find(tool => tool.name === "advise");
		if (!advise) throw new Error("Expected advisor delivery tool");
		// Arm the post-interrupt cooldown with a live steered concern first.
		session.agent.state.isStreaming = true;
		try {
			await advise.execute("arm-immune", {
				note: "The running step loses the selected file.",
				severity: "concern",
			});
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(session.agent.peekSteeringQueue()).toHaveLength(1);
			session.agent.clearSteeringQueue();
		} finally {
			session.agent.state.isStreaming = false;
		}

		await session.prompt("only update");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);

		// One turn completed, well inside the 3-turn immune window: the final
		// reviewer's concern preserves as a card instead of forcing a
		// continuation against work the primary already finished.
		const completions = session.agent.state.messages.filter(
			message => message.role === "assistant" && JSON.stringify(message.content).includes("primary complete"),
		);
		expect(completions).toHaveLength(1);
		const cards = session.agent.state.messages.filter(
			message => message.role === "custom" && JSON.stringify(message).includes("drops the audit row"),
		);
		expect(cards).toHaveLength(1);
	});

	it("releases deferred advice at a terminal boundary skipped by cadence", async () => {
		const note = "The missing file still needs a fallback path before this change is safe.";
		createAdvisor({ "advisor.syncBacklog": "strict" }, 0, { name: "Step reviewer", reviewInterval: 2 }, 2, note);
		if (!session) throw new Error("Expected live session");

		await session.prompt("inspect both missing files");
		const delivered = [...session.agent.state.messages, ...session.yieldQueue.drainLazy().map(build => build())];
		expect(
			delivered.some(
				message =>
					message?.role === "custom" &&
					message.customType === "advisor" &&
					JSON.stringify(message.content).includes(note),
			),
		).toBe(true);
	});

	it("resolves catch-up per advisor: a strict final reviewer waits while an off override never parks the boundary", async () => {
		// Global policy is strict, but the turn reviewer overrides to "off": its
		// review is scheduled and starts, yet the boundary never waits for it —
		// a global-only resolution would park prompt() on the parked stream past
		// any test timeout. The final reviewer's own "strict" override IS waited:
		// its note is already delivered when prompt() resolves.
		const primaryMock = createMockModel({
			provider: "anthropic",
			responses: [{ content: ["primary complete"] }],
		});
		let parkedReviewStarted = false;
		const parkedMock = createMockModel({
			provider: "anthropic",
			responses: [
				() => {
					parkedReviewStarted = true;
					return { content: ["parked"], delayMs: 60_000 };
				},
			],
		});
		const finalMock = createMockModel({
			provider: "anthropic",
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "advise",
							arguments: { note: "final review found a stale fixture", severity: "nit" },
						},
					],
				},
				{ content: [], stopReason: "stop" },
			],
		});
		const advisorStreamFn: StreamFn = (streamModel, context, options) =>
			JSON.stringify(context.systemPrompt ?? "").includes("parked-reviewer-marker")
				? parkedMock.stream(streamModel, context, options)
				: finalMock.stream(streamModel, context, options);
		const settings = Settings.isolated({
			"advisor.syncBacklog": "strict",
			"compaction.enabled": false,
			"todo.enabled": false,
		});
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: primaryMock, systemPrompt: [], tools: [] },
				streamFn: primaryMock.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			advisorTools: [],
			advisorStreamFn,
			advisorConfigs: [
				{ name: "Parked reviewer", syncBacklog: "off", instructions: "parked-reviewer-marker" },
				{
					name: "Final reviewer",
					reviewMode: "agent-end",
					syncBacklog: "strict",
					instructions: "final-reviewer-marker",
				},
			],
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);

		await session.prompt("only update");

		// Both reviews were scheduled; only the strict one gated the boundary.
		expect(parkedReviewStarted).toBe(true);
		expect(finalMock.calls.length).toBeGreaterThanOrEqual(2);
		const cards = session.agent.state.messages.filter(
			message => message.role === "custom" && JSON.stringify(message).includes("stale fixture"),
		);
		expect(cards).toHaveLength(1);
		// A preserved nit never steers a continuation turn.
		expect(primaryMock.calls).toHaveLength(1);
	});

	it("wakes review scheduling on a user-attributed custom turn initiator, not only plain user messages", async () => {
		const { reviewStarts } = createAdvisor({ "advisor.syncBacklog": "1" }, 0, undefined, 0, "looks fine");
		if (!session) throw new Error("Expected live session");

		await session.prompt("first update");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
		expect(reviewStarts).toHaveLength(1);
		// Review scheduling is asleep now: advisor/agent-attributed deliveries
		// (like the continuation above's own cards) never wake it.

		const started = await session.promptCustomMessage({
			customType: "collab-prompt",
			content: "peer asks for a review pass",
			display: false,
			attribution: "user",
		});
		expect(started).toBe(true);
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);

		// A user-attributed custom turn initiator is genuine user input: the
		// sleep latch wakes and the reviewer sees the accumulated delta.
		expect(reviewStarts).toHaveLength(2);
	});

	it("leaves the advisor unbounded when the shared loop guard is disabled", async () => {
		const { advisor, contexts } = createAdvisor({ "model.toolCallLoopGuard.enabled": false });

		await advisor.prompt("review the current update");

		expect(contexts.some(context => JSON.stringify(context.messages).includes("tool_call_loop_detected"))).toBe(
			false,
		);
		// Nine requests: eight repeated tool-call turns plus the final stop.
		expect(contexts).toHaveLength(9);
	});
});
