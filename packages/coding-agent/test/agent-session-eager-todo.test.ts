import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionConfig } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as titleDriftClassifier from "@oh-my-pi/pi-coding-agent/session/title-drift-classifier";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools";
import { setInteractiveHost, TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

type ObservedPromptCall = {
	toolChoice: string | undefined;
	toolNames: string[];
	messageRoles: AgentMessage["role"][];
	messageTexts: string[];
	lastMessageRole: AgentMessage["role"];
	lastMessageText: string;
};

function isTextContentBlock(value: unknown): value is TextContent {
	if (!value || typeof value !== "object") return false;
	return (value as TextContent).type === "text" && typeof (value as TextContent).text === "string";
}

function getToolChoiceName(choice: unknown): string | undefined {
	if (!choice) return undefined;
	if (typeof choice === "string") return choice;
	if (typeof choice !== "object" || !("type" in choice)) return undefined;
	const toolChoice = choice as { type?: string; name?: string; function?: { name?: string } };
	if (toolChoice.type === "tool") return toolChoice.name;
	if (toolChoice.type === "function") return toolChoice.name ?? toolChoice.function?.name;
	return undefined;
}

function createToolCallAssistantMessage(name: string, args: Record<string, unknown>): AssistantMessage {
	const toolCall: ToolCall = {
		type: "toolCall",
		id: `call_${name}`,
		name,
		arguments: args,
	};
	return {
		role: "assistant",
		content: [toolCall],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createAssistantMessageWithThinking(text: string, thinking: string): AssistantMessage {
	return {
		...createAssistantMessage(text),
		content: [
			{ type: "thinking", thinking },
			{ type: "text", text },
		],
	};
}

function getMessageText(message: AgentMessage): string {
	if (!("content" in message)) {
		return "";
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	if (!Array.isArray(message.content)) {
		return "";
	}
	const text: string[] = [];
	for (const content of message.content) {
		if (isTextContentBlock(content)) text.push(content.text);
	}
	return text.join("\n");
}

describe("AgentSession eager todo enforcement", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let streamCallCount = 0;
	let scriptedResponses: AssistantMessage[] = [];
	/** Stream a `toolcall_start` for each scripted tool call, as a provider does; it starts the first title. */
	let announceToolCalls = false;
	let sharedDir: TempDir;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;
	let previousNoTitle: string | undefined;
	const observedCalls: ObservedPromptCall[] = [];

	async function createSession(
		settingsOverride: Record<string, unknown> = {},
		sessionOverride: Partial<AgentSessionConfig> = {},
	): Promise<void> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const modelRegistry = sharedModelRegistry;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": true,
			"todo.eager": "always",
			"todo.reminders": false,
			"title.refreshOnReplan": false,
			...settingsOverride,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		const toolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			settings,
			// Mirrors sdk.ts wiring: TodoTool commits phases during execute (#6148 removed the message_end replay).
			setTodoPhases: phases => session?.setTodoPhases(phases),
		};
		const todoTool = new TodoTool(toolSession);
		const mockBashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [todoTool, mockBashTool],
				messages: [],
			},
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
			streamFn: (_model, context, options) => {
				streamCallCount++;
				const lastMessage = context.messages.at(-1);
				if (!lastMessage) {
					throw new Error("Expected prompt context to include a message");
				}
				observedCalls.push({
					toolChoice: getToolChoiceName(options?.toolChoice),
					toolNames: (context.tools ?? []).map(tool => tool.name),
					messageRoles: context.messages.map(message => message.role),
					messageTexts: context.messages.map(message => getMessageText(message)),
					lastMessageRole: lastMessage.role,
					lastMessageText: getMessageText(lastMessage),
				});
				const response = scriptedResponses.shift() ?? createAssistantMessage("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					if (announceToolCalls) {
						response.content.forEach((block, contentIndex) => {
							if (block.type === "toolCall")
								stream.push({ type: "toolcall_start", contentIndex, partial: response });
						});
					}
					const reason =
						response.stopReason === "toolUse" || response.stopReason === "length" ? response.stopReason : "stop";
					stream.push({ type: "done", reason, message: response });
				});
				return stream;
			},
		});

		const toolRegistry = new Map<string, AgentTool>([
			[todoTool.name, todoTool as unknown as AgentTool],
			[mockBashTool.name, mockBashTool],
		]);

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry,
			...sessionOverride,
		});
	}

	async function recreateSession(
		settingsOverride: Record<string, unknown> = {},
		sessionOverride: Partial<AgentSessionConfig> = {},
	): Promise<void> {
		await session.dispose();
		streamCallCount = 0;
		scriptedResponses = [];
		announceToolCalls = false;
		observedCalls.length = 0;
		await createSession(settingsOverride, sessionOverride);
	}

	function waitForSessionName(expected: string): Promise<void> {
		if (session.sessionManager.getSessionName() === expected) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = session.sessionManager.onSessionNameChanged(() => {
			if (session.sessionManager.getSessionName() !== expected) return;
			unsubscribe();
			resolve();
		});
		return promise;
	}

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-agent-session-eager-todo-shared-");
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		sharedAuthStorage.keys.setRuntime("anthropic", "test-key");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(async () => {
		previousNoTitle = Bun.env.PI_NO_TITLE;
		delete Bun.env.PI_NO_TITLE;
		tempDir = TempDir.createSync("@pi-agent-session-eager-todo-");
		streamCallCount = 0;
		scriptedResponses = [];
		announceToolCalls = false;
		observedCalls.length = 0;
		await createSession();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		vi.restoreAllMocks();
		if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
		else Bun.env.PI_NO_TITLE = previousNoTitle;
		tempDir.removeSync();
	});

	it("prepends a hidden eager todo reminder without repeating the prompt text", async () => {
		await session.prompt("list all work trees");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]).toEqual({
			toolChoice: "todo",
			toolNames: ["todo", "bash"],
			messageRoles: ["developer", "user"],
			messageTexts: [expect.any(String), "list all work trees"],
			lastMessageRole: "user",
			lastMessageText: "list all work trees",
		});
		expect(observedCalls[0]?.messageTexts.filter(text => text.includes("list all work trees"))).toHaveLength(1);
		expect(observedCalls[0]?.messageTexts[0]).not.toContain("list all work trees");
		// `always` renders the hard, forced reminder.
		expect(session.formatSessionAsText()).not.toContain("<user-request>");
	});

	it("initializes todos once, then continues within the same user turn", async () => {
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
				list: [{ phase: "List worktrees", items: ["List all git worktrees in the current repository"] }],
			}),
			createAssistantMessage("real user turn handled"),
		];

		await session.prompt("list all work trees");

		expect(streamCallCount).toBe(2);
		expect(observedCalls).toHaveLength(2);
		expect(observedCalls[0]).toEqual({
			toolChoice: "todo",
			toolNames: ["todo", "bash"],
			messageRoles: ["developer", "user"],
			messageTexts: [expect.any(String), "list all work trees"],
			lastMessageRole: "user",
			lastMessageText: "list all work trees",
		});
		expect(observedCalls[1]?.toolChoice).toBeUndefined();
		expect(observedCalls[1]?.lastMessageRole).toBe("toolResult");
		expect(observedCalls[1]?.messageRoles.slice(-2)).toEqual(["assistant", "toolResult"]);
		expect(session.getTodoPhases()).toHaveLength(1);
		expect(session.getTodoPhases()[0]?.tasks[0]?.content).toBe("List all git worktrees in the current repository");
	});

	it("refreshes an auto title on todo init from recent user, assistant, and thinking context", async () => {
		// Boring icons: the plain title would otherwise go on to a card request.
		await recreateSession({ "title.refreshOnReplan": true, "title.icons": "boring" });
		await session.setSessionName("Old auto title", "auto");
		const priorUser: AgentMessage = {
			role: "user",
			content: "fix parser recovery",
			timestamp: Date.now() - 2,
		};
		const priorAssistant = createAssistantMessageWithThinking(
			"I found the parser recovery path.",
			"The recovery heuristic should drive the replan title.",
		);
		session.agent.appendMessage(priorUser);
		session.sessionManager.appendMessage(priorUser);
		session.agent.appendMessage(priorAssistant);
		session.sessionManager.appendMessage(priorAssistant);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Parser recovery replan</title>" }],
		} as never);
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
				list: [{ phase: "Parser", items: ["Rework parser diagnostics around recovery"] }],
			}),
			createAssistantMessage("todo initialized"),
		];

		const titleApplied = waitForSessionName("Parser recovery replan");
		await session.prompt("replan parser diagnostics");
		await titleApplied;

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const request = completeSimpleMock.mock.calls[0]?.[1] as { messages?: Array<{ content?: string }> } | undefined;
		const titleInput = request?.messages?.[0]?.content;
		expect(titleInput).toContain("fix parser recovery");
		expect(titleInput).toContain("I found the parser recovery path.");
		expect(titleInput).toContain("The recovery heuristic should drive the replan title.");
		expect(titleInput).toContain("replan parser diagnostics");
		const metadata = completeSimpleMock.mock.calls[0]?.[2]?.metadata;
		if (!metadata || typeof metadata.user_id !== "string") {
			throw new Error("Expected title request metadata.user_id");
		}
		const userId: unknown = JSON.parse(metadata.user_id);
		if (!userId || typeof userId !== "object" || !("session_id" in userId) || typeof userId.session_id !== "string") {
			throw new Error("Expected title request metadata.user_id.session_id");
		}
		expect(userId.session_id).not.toBe(session.sessionId);
	});

	// Every way a successful todo init reaches the replan: the tool names the op in its
	// result details, infers it from an op-less list, or names none and the call's op decides.
	const planInits = [
		{ spelling: "an init op", args: { op: "init" }, resultNamesOp: true },
		{ spelling: "an op-less list", args: {}, resultNamesOp: true },
		{ spelling: "a result that names no op", args: { op: "init" }, resultNamesOp: false },
	];
	for (const { spelling, args, resultNamesOp } of planInits) {
		it(`titles a todo-init replan from the plan it wrote, not the thinking before it (${spelling})`, async () => {
			// A long-running agent wrote a plan for its new work while its thinking was about
			// something else; the replan refresh exists to title that plan.
			await recreateSession({ "title.refreshOnReplan": true, "title.icons": "boring" });
			await session.setSessionName("Implement arity delta rule", "auto");
			const plan = "Prove the eta rule for primitive ops";
			const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, request) => {
				// The title model names what it is shown: the plan when the request carries it.
				const message = request.messages[0];
				const input = message ? getMessageText(message) : "";
				const title = input.includes(plan)
					? "Prove eta rule for primitive ops"
					: "Fix omp overwriting tmux pane title";
				return createAssistantMessage(`<title>${title}</title>`);
			});
			if (!resultNamesOp) {
				const execute = TodoTool.prototype.execute;
				vi.spyOn(TodoTool.prototype, "execute").mockImplementation(async function (this: TodoTool, ...callArgs) {
					const result = await execute.apply(this, callArgs);
					return { ...result, details: result.details && { ...result.details, op: undefined } };
				});
			}
			const todoInit = { ...args, list: [{ phase: "Eta", items: [plan] }] };
			scriptedResponses = [
				{
					...createToolCallAssistantMessage("todo", todoInit),
					content: [
						{
							type: "thinking",
							thinking:
								"omp overwrites the tmux pane title, so set the current task and check whether the title follows",
						},
						{ type: "toolCall", id: "call_todo", name: "todo", arguments: todoInit },
					],
				},
				createAssistantMessage("todo initialized"),
			];

			const retitled = Promise.withResolvers<void>();
			const unsubscribe = session.sessionManager.onSessionNameChanged(() => retitled.resolve());
			await session.prompt("resume your lane");
			await retitled.promise;
			unsubscribe();

			expect(session.sessionManager.getSessionName()).toBe("Prove eta rule for primitive ops");
			expect(completeSimpleMock).toHaveBeenCalledTimes(1);
			const message = completeSimpleMock.mock.calls[0]?.[1].messages[0];
			expect(message && getMessageText(message)).toMatch(
				/<plan>[\s\S]*Prove the eta rule for primitive ops[\s\S]*<\/plan>/,
			);
		});
	}

	it("keeps a title the user sets while a replan is naming the plan", async () => {
		// An extension's `pi.setSessionName` lands as a user title mid-refresh; the plan title must not replace it.
		await recreateSession({ "title.refreshOnReplan": true, "title.icons": "boring" });
		await session.setSessionName("Implement arity delta rule", "auto");
		const titleRequested = Promise.withResolvers<void>();
		const titleReply = Promise.withResolvers<void>();
		vi.spyOn(ai, "completeSimple").mockImplementation(async () => {
			titleRequested.resolve();
			await titleReply.promise;
			return createAssistantMessage("<title>Prove eta rule for primitive ops</title>");
		});
		const generateTitle = vi.spyOn(session, "generateTitle");
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
				list: [{ phase: "Eta", items: ["Prove the eta rule for primitive ops"] }],
			}),
			createAssistantMessage("todo initialized"),
		];

		await session.prompt("resume your lane");
		await titleRequested.promise;
		await session.sessionManager.setSessionName("Eta rule lane", "user");
		titleReply.resolve();
		await generateTitle.mock.results[0]?.value;
		// The refresh exposes no completion signal, and after generation it only awaits
		// promises (boring icons skip the card request), so one zero-delay turn drains it.
		await Bun.sleep(0);

		expect(generateTitle).toHaveBeenCalledTimes(1);
		expect(session.sessionManager.getSessionName()).toBe("Eta rule lane");
		expect(session.sessionManager.titleSource).toBe("user");
	});

	/** The title model names the plan its request carries; the first request's reply waits for `release()`. */
	function titleModelNamingPlans(titles: Record<string, string>, fallback: string) {
		const requests: string[] = [];
		const firstRequested = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, request) => {
			const message = request.messages[0];
			const input = message ? getMessageText(message) : "";
			requests.push(input);
			if (requests.length === 1) {
				firstRequested.resolve();
				await release.promise;
			}
			const title = Object.entries(titles).find(([plan]) => input.includes(plan))?.[1] ?? fallback;
			return createAssistantMessage(`<title>${title}</title>`);
		});
		return { requests, firstRequested: firstRequested.promise, release: () => release.resolve() };
	}

	function todoInit(id: string, phase: string, task: string): AssistantMessage {
		const args = { op: "init", list: [{ phase, items: [task] }] };
		return {
			...createToolCallAssistantMessage("todo", args),
			content: [{ type: "toolCall", id, name: "todo", arguments: args }],
		};
	}

	function recordNames(): string[] {
		const names: string[] = [];
		session.sessionManager.onSessionNameChanged(() => names.push(session.sessionManager.getSessionName() ?? ""));
		return names;
	}

	it("titles the latest plan when the agent replans while an earlier plan is being titled", async () => {
		// Two `todo init`s in one turn: the first plan's title request is still open when the second
		// plan is written. The second plan names the session; the reply about the first does not.
		await recreateSession({ "title.refreshOnReplan": true, "title.icons": "boring" });
		await session.setSessionName("Implement arity delta rule", "auto");
		const model = titleModelNamingPlans(
			{ "Prove the eta rule": "Prove eta rule", "Prepare the migration": "Prepare migration" },
			"Unrelated title",
		);
		const names = recordNames();
		scriptedResponses = [
			todoInit("call_todo_1", "Migrate", "Prepare the migration"),
			todoInit("call_todo_2", "Eta", "Prove the eta rule"),
			createAssistantMessage("plans written"),
		];

		await session.prompt("resume your lane");
		await model.firstRequested;
		const renamed = Promise.withResolvers<void>();
		session.sessionManager.onSessionNameChanged(() => renamed.resolve());
		model.release();
		await renamed.promise;

		expect(names).toEqual(["Prove eta rule"]);
		expect(model.requests).toHaveLength(2);
		expect(model.requests[0]).toContain("Prepare the migration");
		expect(model.requests[1]).toMatch(/<plan>[\s\S]*Prove the eta rule[\s\S]*<\/plan>/);
	});

	it("titles a plan written while the first title is being named, once that title lands", async () => {
		await recreateSession(
			{ "title.refreshOnReplan": true, "title.icons": "boring", "title.generator": "tiny" },
			{ autoTitle: true },
		);
		const model = titleModelNamingPlans({ "Prove the eta rule": "Prove eta rule" }, "Refactor parser module");
		const names = recordNames();
		// The reply's tool call starts the first title request before the todo tool runs.
		announceToolCalls = true;
		scriptedResponses = [
			todoInit("call_todo_1", "Eta", "Prove the eta rule"),
			createAssistantMessage("plan written"),
		];

		await session.prompt("refactor the parser module");
		await model.firstRequested;
		model.release();
		await waitForSessionName("Prove eta rule");

		expect(names).toEqual(["Refactor parser module", "Prove eta rule"]);
		expect(model.requests).toHaveLength(2);
		expect(model.requests[0]).not.toContain("<plan>");
		expect(model.requests[1]).toMatch(/<plan>[\s\S]*Prove the eta rule[\s\S]*<\/plan>/);
	});

	it("asks for no card for a replan's title that a later plan superseded", async () => {
		await recreateSession({ "title.refreshOnReplan": true, "title.icons": "emoji" });
		await session.setSessionName("Implement arity delta rule", "auto");
		const model = titleModelNamingPlans(
			{ "Prove the eta rule": "Prove eta rule", "Prepare the migration": "Prepare migration" },
			"Unrelated title",
		);
		scriptedResponses = [
			todoInit("call_todo_1", "Migrate", "Prepare the migration"),
			todoInit("call_todo_2", "Eta", "Prove the eta rule"),
			createAssistantMessage("plans written"),
		];

		await session.prompt("resume your lane");
		await model.firstRequested;
		const renamed = Promise.withResolvers<void>();
		session.sessionManager.onSessionNameChanged(() => renamed.resolve());
		model.release();
		await renamed.promise;

		// The first plan's retitle came back after the second plan was written: its card is never asked for.
		expect(model.requests.some(request => request.includes("Prepare migration"))).toBe(false);
		expect(session.sessionManager.getSessionName()).toContain("Prove eta rule");
	});

	it("keeps a card title's icon and code when a replan refreshes it", async () => {
		// Tern indexes parked panes by the card; the title model names none, so the refresh must carry it over.
		await recreateSession({ "title.refreshOnReplan": true });
		await session.setSessionName("🧪 FLAKY: Fix flaky park tests", "auto");
		vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Stabilize park test timing</title>" }],
		} as never);
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
				list: [{ phase: "Park", items: ["Stabilize park test timing"] }],
			}),
			createAssistantMessage("todo initialized"),
		];

		const titleApplied = waitForSessionName("🧪 FLAKY: Stabilize park test timing");
		await session.prompt("replan the park tests");
		await titleApplied;

		expect(session.sessionManager.getSessionName()).toBe("🧪 FLAKY: Stabilize park test timing");
	});

	describe("title.refreshAfterPrompts", () => {
		const titleReply = (title: string) =>
			({ stopReason: "stop", content: [{ type: "text", text: `<title>${title}</title>` }] }) as never;

		async function autoTitled(settings: Record<string, unknown>): Promise<void> {
			await recreateSession({ "title.icons": "boring", ...settings }, { autoTitle: true });
			await session.setSessionName("Fix parser recovery", "auto");
		}

		it("asks the judge once enough operator prompts have counted, and regenerates a stale title", async () => {
			await autoTitled({ "title.refreshAfterPrompts": 2 });
			const driftSpy = vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockResolvedValue(true);
			vi.spyOn(ai, "completeSimple").mockResolvedValue(titleReply("Ship release notes"));

			await session.prompt("now draft the release notes for 2.0");
			expect(driftSpy).not.toHaveBeenCalled();

			const titleApplied = waitForSessionName("Ship release notes");
			await session.prompt("publish the release notes to the changelog");
			await titleApplied;
			expect(driftSpy).toHaveBeenCalledTimes(1);
			const [, title, recent] = driftSpy.mock.calls[0]!;
			expect(title).toBe("Fix parser recovery");
			expect(recent).toContainEqual({ role: "user", text: "publish the release notes to the changelog" });
		});

		it.each([
			["still fits", false],
			["no judge answers", undefined],
		])("keeps the title when %s, and asks again only after as many prompts", async (_, verdict) => {
			await autoTitled({ "title.refreshAfterPrompts": 2 });
			const driftSpy = vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockResolvedValue(verdict);
			const completeSimpleMock = vi.spyOn(ai, "completeSimple");

			await session.prompt("add a regression test for parser recovery");
			await session.prompt("run the parser tests");
			await session.prompt("fix the failing parser test");
			expect(driftSpy).toHaveBeenCalledTimes(1);
			await session.prompt("run the parser tests again");
			expect(driftSpy).toHaveBeenCalledTimes(2);
			expect(completeSimpleMock).not.toHaveBeenCalled();
			expect(session.sessionManager.getSessionName()).toBe("Fix parser recovery");
		});

		it("does not count low-signal prompts", async () => {
			await autoTitled({ "title.refreshAfterPrompts": 2 });
			const driftSpy = vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockResolvedValue(false);

			await session.prompt("now draft the release notes for 2.0");
			await session.prompt("ok thanks");
			expect(driftSpy).not.toHaveBeenCalled();
			await session.prompt("publish the release notes to the changelog");
			expect(driftSpy).toHaveBeenCalledTimes(1);
		});

		it("is off by default", async () => {
			await autoTitled({});
			const driftSpy = vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockResolvedValue(true);

			for (let i = 0; i < 10; i++) await session.prompt(`release step ${i}: draft the notes`);
			expect(driftSpy).not.toHaveBeenCalled();
		});

		it("adds a missing card when the refresh regenerates the current plain title", async () => {
			await autoTitled({ "title.refreshAfterPrompts": 1, "title.icons": "emoji" });
			vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockResolvedValue(true);
			vi.spyOn(ai, "completeSimple")
				.mockResolvedValueOnce(titleReply("Fix parser recovery"))
				.mockResolvedValueOnce(titleReply("🧪 PARSER"));

			const titleApplied = waitForSessionName("🧪 PARSER: Fix parser recovery");
			await session.prompt("keep fixing parser recovery");
			await titleApplied;
		});

		it("never checks a user-set title", async () => {
			await recreateSession({ "title.refreshAfterPrompts": 1 }, { autoTitle: true });
			await session.setSessionName("Manual parser title", "user");
			const driftSpy = vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockResolvedValue(true);

			await session.prompt("now draft the release notes for 2.0");
			expect(driftSpy).not.toHaveBeenCalled();
		});

		it("does not regenerate a title the user renames while the judge is deciding", async () => {
			await autoTitled({ "title.refreshAfterPrompts": 1 });
			const verdict = Promise.withResolvers<boolean | undefined>();
			vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockReturnValue(verdict.promise);
			const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue(titleReply("Ship release notes"));

			await session.prompt("now draft the release notes for 2.0");
			await session.setSessionName("Release notes", "user");
			verdict.resolve(true);
			// A full run after the verdict gives a regeneration started by it time to reach the title model.
			await session.prompt("publish the release notes to the changelog");

			expect(completeSimpleMock).not.toHaveBeenCalled();
			expect(session.sessionManager.getSessionName()).toBe("Release notes");
		});

		it("asks the title model nothing for a drift check that a plan superseded while the judge decided", async () => {
			await autoTitled({ "title.refreshAfterPrompts": 1, "title.refreshOnReplan": true });
			const verdict = Promise.withResolvers<boolean | undefined>();
			vi.spyOn(titleDriftClassifier, "classifyTitleDrift").mockReturnValue(verdict.promise);
			const requests: string[] = [];
			vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, request) => {
				const input = request.messages[0] ? getMessageText(request.messages[0]) : "";
				requests.push(input);
				return titleReply(input.includes("Prove the eta rule") ? "Prove eta rule" : "Drift title");
			});

			await session.prompt("now draft the release notes for 2.0");
			scriptedResponses = [todoInit("call_todo_1", "Eta", "Prove the eta rule"), createAssistantMessage("planned")];
			await session.prompt("plan the eta proof");
			const titleApplied = waitForSessionName("Prove eta rule");
			verdict.resolve(true);
			await titleApplied;

			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatch(/<plan>[\s\S]*Prove the eta rule[\s\S]*<\/plan>/);
		});
	});

	it("forwards the configured title system prompt to the replan refresh path", async () => {
		// Issue #3734: TITLE_SYSTEM.md must apply on todo-init replan refresh,
		// not just first-input titling. Without the threaded override, the
		// bundled prompt silently overwrote auto titles in Plan Mode.
		const customPrompt = "Generate kebab-case titles prefixed with `plan/`.";
		await recreateSession({ "title.refreshOnReplan": true });
		session.setTitleSystemPrompt(customPrompt);
		await session.setSessionName("Old auto title", "auto");
		const priorUser: AgentMessage = {
			role: "user",
			content: "rework parser diagnostics",
			timestamp: Date.now() - 1,
		};
		session.agent.appendMessage(priorUser);
		session.sessionManager.appendMessage(priorUser);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>plan/parser-diagnostics</title>" }],
		} as never);
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
				list: [{ phase: "Parser", items: ["Replan parser diagnostics"] }],
			}),
			createAssistantMessage("todo initialized"),
		];

		const titleApplied = waitForSessionName("plan/parser-diagnostics");
		await session.prompt("replan parser diagnostics");
		await titleApplied;

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const request = completeSimpleMock.mock.calls[0]?.[1] as { systemPrompt?: string[] } | undefined;
		expect(request?.systemPrompt?.[0]).toBe(customPrompt);
		expect(request?.systemPrompt?.[1]).toContain("<title>");
	});

	it("does not refresh todo-init titles when the current title is user-authored", async () => {
		await recreateSession({ "title.refreshOnReplan": true });
		await session.setSessionName("Manual parser title", "user");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
				list: [{ phase: "Parser", items: ["Replan parser diagnostics"] }],
			}),
			createAssistantMessage("todo initialized"),
		];

		await session.prompt("replan parser diagnostics");

		expect(completeSimpleMock).not.toHaveBeenCalled();
		expect(session.sessionManager.getSessionName()).toBe("Manual parser title");
	});

	it("does not refresh todo-init titles for headless subagent sessions", async () => {
		// Issue #5910: a subagent (agentKind "sub") in a non-interactive host has no
		// operator-visible title, so a todo-init replan refresh only wastes a
		// tiny-model LLM call. isInteractiveHost() defaults false under bun test.
		await recreateSession({ "title.refreshOnReplan": true }, { agentKind: "sub" });
		await session.setSessionName("Old auto title", "auto");
		const priorUser: AgentMessage = {
			role: "user",
			content: "rework parser diagnostics",
			timestamp: Date.now() - 1,
		};
		session.agent.appendMessage(priorUser);
		session.sessionManager.appendMessage(priorUser);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
				list: [{ phase: "Parser", items: ["Replan parser diagnostics"] }],
			}),
			createAssistantMessage("todo initialized"),
		];

		await session.prompt("replan parser diagnostics");

		expect(completeSimpleMock).not.toHaveBeenCalled();
		expect(session.sessionManager.getSessionName()).toBe("Old auto title");
	});

	it("refreshes and cards todo-init titles for a subagent focusable in an interactive host", async () => {
		// A live subagent selected from the Agent Hub renders its session name in
		// the status line, so the interactive host must keep the replan refresh the
		// user enabled — only headless hosts skip it (issue #5910 review follow-up).
		// Subagents never fork a title, so the replan is where a card comes from.
		const previousInteractiveHost = setInteractiveHost(true);
		try {
			await recreateSession({ "title.refreshOnReplan": true }, { agentKind: "sub" });
			await session.setSessionName("Old auto title", "auto");
			const priorUser: AgentMessage = {
				role: "user",
				content: "rework parser diagnostics",
				timestamp: Date.now() - 1,
			};
			session.agent.appendMessage(priorUser);
			session.sessionManager.appendMessage(priorUser);
			const completeSimpleMock = vi
				.spyOn(ai, "completeSimple")
				.mockResolvedValueOnce({
					stopReason: "stop",
					content: [{ type: "text", text: "<title>Parser diagnostics replan</title>" }],
				} as never)
				.mockResolvedValueOnce({
					stopReason: "stop",
					content: [{ type: "text", text: "<title>🔍 PARSE</title>" }],
				} as never);
			scriptedResponses = [
				createToolCallAssistantMessage("todo", {
					op: "init",
					list: [{ phase: "Parser", items: ["Replan parser diagnostics"] }],
				}),
				createAssistantMessage("todo initialized"),
			];

			const titleApplied = waitForSessionName("🔍 PARSE: Parser diagnostics replan");
			await session.prompt("replan parser diagnostics");
			await titleApplied;

			expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		} finally {
			setInteractiveHost(previousInteractiveHost);
		}
	});

	it("does not refresh todo-init titles when title refresh on replan is disabled", async () => {
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		await session.setSessionName("Old auto title", "auto");
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
				list: [{ phase: "Parser", items: ["Replan parser diagnostics"] }],
			}),
			createAssistantMessage("todo initialized"),
		];

		await session.prompt("replan parser diagnostics");

		expect(completeSimpleMock).not.toHaveBeenCalled();
		expect(session.sessionManager.getSessionName()).toBe("Old auto title");
	});

	it("does not refresh todo-init titles when automatic titles are disabled", async () => {
		Bun.env.PI_NO_TITLE = "1";
		await recreateSession({ "title.refreshOnReplan": true });
		await session.setSessionName("Old auto title", "auto");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		scriptedResponses = [
			createToolCallAssistantMessage("todo", {
				op: "init",
				list: [{ phase: "Parser", items: ["Replan parser diagnostics"] }],
			}),
			createAssistantMessage("todo initialized"),
		];

		await session.prompt("replan parser diagnostics");

		expect(completeSimpleMock).not.toHaveBeenCalled();
		expect(session.sessionManager.getSessionName()).toBe("Old auto title");
	});

	it("skips eager todo enforcement for prompts ending with a question mark", async () => {
		await session.prompt("list all work trees?");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]).toEqual({
			toolChoice: undefined,
			toolNames: ["todo", "bash"],
			messageRoles: ["user"],
			messageTexts: ["list all work trees?"],
			lastMessageRole: "user",
			lastMessageText: "list all work trees?",
		});
	});

	it("skips eager todo enforcement for prompts ending with an exclamation mark", async () => {
		await session.prompt("list all work trees!");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]).toEqual({
			toolChoice: undefined,
			toolNames: ["todo", "bash"],
			messageRoles: ["user"],
			messageTexts: ["list all work trees!"],
			lastMessageRole: "user",
			lastMessageText: "list all work trees!",
		});
	});

	it("skips eager todo enforcement for subsequent user messages", async () => {
		// First prompt: eager todo fires
		await session.prompt("refactor the parser module");
		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.toolChoice).toBe("todo");

		// Second prompt: eager todo must NOT fire
		observedCalls.length = 0;
		await session.prompt("actually skip that, just fix the typo");
		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]).toEqual({
			toolChoice: undefined,
			toolNames: ["todo", "bash"],
			messageRoles: expect.arrayContaining(["user"]),
			messageTexts: expect.arrayContaining(["actually skip that, just fix the typo"]),
			lastMessageRole: "user",
			lastMessageText: "actually skip that, just fix the typo",
		});
	});

	it("prepends the eager todo reminder without forcing the todo tool when todo.eager is preferred", async () => {
		await session.dispose();
		await createSession({ "todo.eager": "preferred" });

		await session.prompt("list all work trees");

		expect(observedCalls).toHaveLength(1);
		expect(observedCalls[0]?.toolChoice).toBeUndefined();
		expect(observedCalls[0]?.messageRoles).toEqual(["developer", "user"]);
		expect(observedCalls[0]?.messageTexts.at(-1)).toBe("list all work trees");
		expect(observedCalls[0]?.messageTexts[0]).not.toContain("list all work trees");
		// `preferred` renders the soft nudge, never the hard MUST directive.
	});
});
