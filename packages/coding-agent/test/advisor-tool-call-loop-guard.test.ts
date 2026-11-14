import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import {
	Agent,
	type AgentMessage,
	type AgentTool,
	type AgentToolContext,
	type AgentTurnEndContext,
	type StreamFn,
	type ToolCallContext,
} from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { finalizeSubagentLifecycle } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { AdvisorLoopGuard } from "../src/advisor/loop-guard";
import { cfgAdvisorReviewInterval } from "../src/advisor/settings";
import { activateTodoTool, createInMemoryAuthStorage, fixedAdvisorTools } from "./helpers/agent-session-setup";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

type AdviceArgs = { note: string; severity: "nit" | "concern" | "blocker" };

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
	// What the primary's tool context store hands the advisor.
	let primaryToolContext = (toolCall?: ToolCallContext) => ({ toolCall }) as AgentToolContext;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-tool-call-loop-guard-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		primaryToolContext = toolCall => ({ toolCall }) as AgentToolContext;
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
		advices?: AdviceArgs[] | ((context: Context) => AdviceArgs | undefined),
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
			// several reviews) can each raise their own note; as a function it picks
			// the note from what the review sees.
			const queued = !isReviewStart
				? undefined
				: typeof advices === "function"
					? advices(context)
					: advices?.shift();
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
			advisorTools: fixedAdvisorTools(failingReadTool),
			advisorStreamFn,
			advisorGetToolContext: toolCall => primaryToolContext(toolCall),
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

	it("lets an advisor read observe an earlier shared writer's final state", async () => {
		const { advisor } = createAdvisor({}, 0);
		const readStarted = Promise.withResolvers<void>();
		let bytes = "old";
		const mock = createMockModel({
			provider: "anthropic",
			responses: [
				{
					content: [
						{ type: "toolCall", id: "writer", name: "bash", arguments: {} },
						{ type: "toolCall", id: "reader", name: "read", arguments: {} },
					],
				},
				{ content: ["done"] },
			],
		});
		advisor.streamFn = mock.stream;
		advisor.setTools([
			{
				name: "bash",
				label: "Bash",
				description: "Changes bytes",
				parameters: type({}),
				approval: "exec",
				async execute() {
					await readStarted.promise;
					for (let turn = 0; turn < 5; turn++) await Promise.resolve();
					bytes = "new";
					return { content: [] };
				},
			},
			{
				name: "read",
				label: "Read",
				description: "Reconciles bytes",
				parameters: type({}),
				approval: "read",
				async execute(_id, _args, _signal, _update, context) {
					let result = bytes;
					readStarted.resolve();
					const call = (context as (AgentToolContext & { toolCall?: ToolCallContext }) | undefined)?.toolCall;
					if (call?.earlierEffectsSettled) {
						await call.earlierEffectsSettled;
						result = bytes;
					}
					return { content: [{ type: "text", text: result }] };
				},
			},
		]);
		await advisor.prompt("run the writer and read");
		const read = advisor.state.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === "reader",
		);
		expect(read?.content).toEqual([{ type: "text", text: "new" }]);
	});

	it("scopes an advisor tool's abort and tool list to the advisor, not the primary", async () => {
		let primaryAborts = 0;
		primaryToolContext = toolCall =>
			({
				toolCall,
				abort: () => {
					primaryAborts++;
				},
				toolNames: ["read", "bash"],
			}) as AgentToolContext;
		const { advisor } = createAdvisor({}, 0);
		const advisorAborts = spyOn(advisor, "abort");
		let seenToolNames: string[] | undefined;
		const mock = createMockModel({
			provider: "anthropic",
			responses: [
				{ content: [{ type: "toolCall", id: "cancel", name: "ask", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		advisor.streamFn = mock.stream;
		advisor.setTools([
			{
				name: "ask",
				label: "Ask",
				description: "Stands in for a dialog the user cancels",
				parameters: type({}),
				approval: "read",
				async execute(_id, _args, _signal, _update, context) {
					seenToolNames = context?.toolNames;
					context?.abort();
					return { content: [{ type: "text", text: "cancelled" }] };
				},
			},
		]);
		await advisor.prompt("ask the user");
		expect(primaryAborts).toBe(0);
		expect(advisorAborts).toHaveBeenCalled();
		expect(seenToolNames).toEqual(["ask"]);
	});

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
		// detector, and the second threshold aborts. The agent loop checks the
		// abort before issuing its next request, bounding twenty repeats at two
		// thresholds' worth (6) with no request after the abort.
		expect(contexts).toHaveLength(6);
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

	it.each([
		{ device: "mcp__peers_wait", exempt: "mcp__peers_wait", redirects: 0 },
		{ device: "mcp__other_tool", exempt: "mcp__peers_wait", redirects: 1 },
		{ device: "mcp__peers_wait", exempt: "write", redirects: 0 },
	])("applies advisor exemption $exempt to writes to $device", ({ device, exempt, redirects }) => {
		const messages: AgentMessage[] = [];
		const guard = new AdvisorLoopGuard({
			settings: Settings.isolated({
				"model.toolCallLoopGuard.enabled": true,
				"model.toolCallLoopGuard.threshold": 2,
				"model.toolCallLoopGuard.exemptTools": [exempt],
			}),
			name: "test",
			liveMessages: () => messages,
			appendMessage: message => messages.push(message),
			abort: () => {
				throw new Error("Unexpected advisor abort");
			},
		});
		for (let index = 0; index < 2; index++) {
			guard.recordTurn(messages, {
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: `call-${index}`,
							name: "write",
							arguments: { path: `xd://${device}`, content: "{}" },
						},
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: zeroUsage,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				toolResults: [],
				willContinue: true,
			});
		}
		expect(messages).toHaveLength(redirects);
		if (redirects > 0) expect(JSON.stringify(messages[0])).toContain("tool_call_loop_detected");
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

	it.each([
		{ severity: "nit", settings: {} },
		{ severity: "concern", settings: { "advisor.continueSeverity": "blocker" } },
	] as const)(
		"preserves terminal-boundary notes below advisor.continueSeverity as cards %j",
		async ({ severity, settings }) => {
			const { reviewStarts } = createAdvisor(
				{ "advisor.syncBacklog": "1", ...settings },
				0,
				undefined,
				0,
				"looks fine",
				severity,
			);
			if (!session) throw new Error("Expected live session");

			await session.prompt("only update");
			expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
			expect(reviewStarts).toHaveLength(1);

			// A note below the continue threshold delivered while the terminal boundary
			// was open is preserved as a visible card: it must not steer an
			// advisor-triggered turn against completed work.
			const messages = session.agent.state.messages;
			const completions = messages.filter(
				message => message.role === "assistant" && JSON.stringify(message.content).includes("primary complete"),
			);
			expect(completions).toHaveLength(1);
			const cards = messages.filter(
				message => message.role === "custom" && JSON.stringify(message).includes("looks fine"),
			);
			expect(cards).toHaveLength(1);
		},
	);

	it("lets a terminal blocker steer one continuation that schedules no review of its own", async () => {
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
		// The next review receives the advisor continuation's captured delta and
		// the fresh input.
		expect(delivered).toContain("primary complete");
		expect(delivered).toContain("second update");
	});

	it("cancels reviews of the handoff a deferred concern continues and reviews the fix instead", async () => {
		// The reported session: a concern deferred during the run steers a
		// continuation at the final boundary while the review of the pre-fix
		// handoff is still queued (catch-up off). That review would re-raise the
		// issue as a blocker against the fix in progress; it is cancelled, and the
		// continuation's final boundary reviews pre- and post-fix work together.
		const completions = (context: Context) => JSON.stringify(context.messages).split("primary complete").length - 1;
		const { reviewStarts } = createAdvisor(
			{ "advisor.syncBacklog": "off" },
			0,
			undefined,
			1,
			undefined,
			"nit",
			context => {
				const seen = completions(context);
				if (seen === 0) return { note: "drop the hash pin", severity: "concern" };
				if (seen === 1) return { note: "hash pin still present", severity: "blocker" };
				return undefined;
			},
		);
		if (!session) throw new Error("Expected live session");

		await session.prompt("only update");
		await session.agent.waitForIdle();
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
		await session.agent.waitForIdle();
		const messages = session.agent.state.messages;
		expect(messages.some(message => JSON.stringify(message).includes("hash pin still present"))).toBe(false);
		expect(
			messages.filter(m => m.role === "assistant" && JSON.stringify(m.content).includes("primary complete")),
		).toHaveLength(2);
		expect(completions(reviewStarts.at(-1)!)).toBe(2);
	});

	it("reviews a todo-reminder continuation after a final review", async () => {
		const { reviewStarts } = createAdvisor(
			{
				"advisor.syncBacklog": "1",
				"todo.enabled": true,
				"todo.reminders": true,
				"todo.remindersMax": 1,
			},
			0,
			{ name: "Final reviewer", reviewMode: "agent-end" },
		);
		if (!session) throw new Error("Expected live session");
		const live = session;
		activateTodoTool(live, tempDir.path());
		live.setTodoPhases([{ name: "Work", tasks: [{ content: "Finish the migration", status: "in_progress" }] }]);
		const reminderRunEnded = Promise.withResolvers<void>();
		let reminded = false;
		live.subscribe(event => {
			if (event.type === "todo_reminder") reminded = true;
			if (event.type === "agent_end" && reminded) reminderRunEnded.resolve();
		});

		await live.prompt("migrate the schema");
		await reminderRunEnded.promise;
		expect(await live.waitForAdvisorCatchup(2_000)).toBe(true);

		// The first final yield was reviewed; the reminder resumed the run, and
		// its own final yield is reviewed too rather than treated like an
		// advisor-started continuation.
		expect(reviewStarts).toHaveLength(2);
		expect(JSON.stringify(reviewStarts[1]!.messages)).toContain("incomplete todo");
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

	it("steers one continuation turn for a terminal-boundary concern at the default advisor.continueSeverity", async () => {
		// A concern means a material issue in finished work — it deserves one
		// steering turn, not a silent preserved card; that continuation schedules
		// no review of its own.
		createAdvisor({ "advisor.syncBacklog": "1" }, 0, undefined, 0, "finished work has a null deref", "concern");
		if (!session) throw new Error("Expected live session");

		await session.prompt("only update");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);

		// The concern steered exactly one continuation turn.
		const completions = session.agent.state.messages.filter(
			message => message.role === "assistant" && JSON.stringify(message.content).includes("primary complete"),
		);
		expect(completions).toHaveLength(2);
	});

	it("steers one continuation for a concern that lands after the boundary with catch-up off", async () => {
		createAdvisor({ "advisor.syncBacklog": "off" }, 0, undefined, 0, "finished work has a null deref", "concern");
		if (!session) throw new Error("Expected live session");
		const live = session;
		const continuationEnded = Promise.withResolvers<void>();
		let agentEnds = 0;
		live.subscribe(event => {
			if (event.type === "agent_end" && ++agentEnds === 2) continuationEnded.resolve();
		});

		// The boundary does not wait for the review, so its concern arrives
		// after the primary already finished and the merge window closed.
		await live.prompt("only update");
		expect(await live.waitForAdvisorCatchup(2_000)).toBe(true);
		// Without the steer the concern is preserved as a card and no second run starts.
		await continuationEnded.promise;

		const completions = live.agent.state.messages.filter(
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

	it("applies an advisor.reviewInterval edit to the running default advisor", async () => {
		const { reviewStarts } = createAdvisor({ "advisor.syncBacklog": "1" }, 0);
		if (!session) throw new Error("Expected live session");
		cfgAdvisorReviewInterval.set(session.settings, 2);

		await session.prompt("first update");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
		expect(reviewStarts).toHaveLength(0);

		await session.prompt("second update");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
		expect(reviewStarts).toHaveLength(1);
		const delivered = JSON.stringify(reviewStarts[0]!.messages);
		expect(delivered).toContain("first update");
		expect(delivered).toContain("second update");
	});

	it("keeps a cadence-skipped update across an advisor roster rebuild", async () => {
		const { reviewStarts } = createAdvisor({ "advisor.syncBacklog": "1" }, 0, {
			name: "Interval reviewer",
			reviewInterval: 2,
		});
		if (!session) throw new Error("Expected live session");

		await session.prompt("first update");
		expect(reviewStarts).toHaveLength(0);
		// Saving an edited roster replaces every live runtime.
		session.applyAdvisorConfigs(
			[{ name: "Interval reviewer", reviewInterval: 2, instructions: "Check retry limits." }],
			undefined,
		);

		await session.prompt("second update");
		expect(await session.waitForAdvisorCatchup(2_000)).toBe(true);
		expect(reviewStarts).toHaveLength(1);
		const delivered = JSON.stringify(reviewStarts[0]!.messages);
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
		// An advise-only turn ends the review: one request, no wrap-up call.
		expect(finalMock.calls).toHaveLength(1);
		const cards = session.agent.state.messages.filter(
			message => message.role === "custom" && JSON.stringify(message).includes("stale fixture"),
		);
		expect(cards).toHaveLength(1);
		// A preserved nit never steers a continuation turn.
		expect(primaryMock.calls).toHaveLength(1);
	});

	/**
	 * Session with one strict `agent-end` reviewer at interval 2 whose review
	 * takes `reviewDelayMs`, after one primary prompt: its only final yield is
	 * held, as in a one-prompt headless run.
	 */
	async function promptStrictFinalReviewer(
		reviewDelayMs: number,
	): Promise<{ live: AgentSession; reviews: Context[] }> {
		const primaryMock = createMockModel({ provider: "anthropic", responses: [{ content: ["primary complete"] }] });
		const advisorMock = createMockModel({
			provider: "anthropic",
			responses: [{ content: ["Reviewed."], delayMs: reviewDelayMs }],
		});
		const reviews: Context[] = [];
		const advisorStreamFn: StreamFn = (streamModel, context, options) => {
			reviews.push(context);
			return advisorMock.stream(streamModel, context, options);
		};
		const settings = Settings.isolated({
			"advisor.syncBacklog": "strict",
			"compaction.enabled": false,
			"todo.enabled": false,
		});
		const live = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: primaryMock, systemPrompt: [], tools: [] },
				streamFn: primaryMock.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			advisorStreamFn,
			advisorConfigs: [{ name: "Final reviewer", reviewMode: "agent-end", reviewInterval: 2 }],
		});
		session = live;
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(live.setAdvisorEnabled(true)).toBe(true);
		await live.prompt("ship the retry change");
		expect(reviews).toHaveLength(0);
		return { live, reviews };
	}

	it("reviews a cadence-skipped final yield in the print-mode drain, past the drain budget when strict", async () => {
		const { live, reviews } = await promptStrictFinalReviewer(200);

		live.prepareForHeadlessAdvisorDrain();
		expect(await live.waitForAdvisorCatchup(50, { waitThroughRecovery: true, strictWithoutDeadline: true })).toBe(
			true,
		);
		expect(reviews).toHaveLength(1);
		expect(JSON.stringify(reviews[0]!.messages)).toContain("ship the retry change");
	});

	it("finishes subagent teardown within its cleanup deadline despite a strict reviewer", async () => {
		const { live, reviews } = await promptStrictFinalReviewer(10_000);

		const started = performance.now();
		await finalizeSubagentLifecycle({
			id: "strict-reviewer-subagent",
			session: live,
			aborted: false,
			keepAlive: false,
			isolated: false,
			agentIdleTtlMs: 0,
			reviveSession: null,
			cleanupDeadlineAt: Date.now() + 200,
		});
		session = undefined;

		// The held final yield was still sent for review before disposal.
		expect(reviews).toHaveLength(1);
		expect(performance.now() - started).toBeLessThan(2_000);
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
