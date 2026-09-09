import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, ThinkingContent } from "@oh-my-pi/pi-ai";
import {
	createMockModel,
	type MockContent,
	type MockModel,
	type MockResponseSource,
} from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { CheckpointTool, RewindTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const checkpointSchema = type({ goal: type("string") });
const rewindSchema = type({ report: type("string") });

const xdevWriteSchema = type({ path: type("string"), content: type("string") });

const xdevWriteTool: AgentTool<typeof xdevWriteSchema, unknown> = {
	name: "write",
	label: "Write",
	description: "Dispatch a write to an xd:// device",
	parameters: xdevWriteSchema,
	async execute(_toolCallId, params) {
		const tool = params.path === "xd://checkpoint" ? "checkpoint" : "rewind";
		if (/^\s*(?:\?|help)?\s*$/i.test(params.content)) {
			return {
				content: [{ type: "text" as const, text: `${tool} docs via xdev` }],
				details: { xdev: { tool, mode: "help" } },
			};
		}
		const parsed: unknown = JSON.parse(params.content);
		const args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		const goal = "goal" in args && typeof args.goal === "string" ? args.goal : undefined;
		const report = "report" in args && typeof args.report === "string" ? args.report : undefined;
		const inner = tool === "checkpoint" ? { goal, startedAt: "2026-01-01T00:00:00.000Z" } : { report, rewound: true };
		return {
			content: [{ type: "text" as const, text: `${tool} via xdev` }],
			details: {
				xdev: {
					tool,
					mode: "execute",
					args,
					inner,
				},
			},
		};
	},
};

const checkpointTool: AgentTool<typeof checkpointSchema, { startedAt: string }> = {
	name: "checkpoint",
	label: "Checkpoint",
	description: "Create a checkpoint",
	parameters: checkpointSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text" as const, text: `checkpoint:${params.goal}` }],
			details: { startedAt: "2026-01-01T00:00:00.000Z" },
		};
	},
};

const rewindTool: AgentTool<typeof rewindSchema, { report: string; rewound: boolean }> = {
	name: "rewind",
	label: "Rewind",
	description: "Rewind to the checkpoint",
	parameters: rewindSchema,
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text" as const, text: "rewind requested" }],
			details: { report: params.report, rewound: true },
		};
	},
};

type Harness = {
	session: AgentSession;
	authStorage: AuthStorage;
	extraSessions: AgentSession[];
	tempDir: TempDir;
};

const activeHarnesses: Harness[] = [];

afterEach(async () => {
	while (activeHarnesses.length > 0) {
		const harness = activeHarnesses.pop();
		for (const extraSession of harness?.extraSessions ?? []) {
			await extraSession.dispose();
		}
		await harness?.session.dispose();
		harness?.authStorage.close();
		harness?.tempDir.removeSync();
	}
});

function signedThinking(thinking: string, thinkingSignature: string): MockContent {
	return { type: "thinking", thinking, thinkingSignature } as unknown as MockContent;
}

async function createHarness(
	responses: MockResponseSource,
	tools: AgentTool[] = [checkpointTool as AgentTool, rewindTool as AgentTool],
	options?: {
		onAgentEnd?: (willContinue: boolean | undefined) => void;
		resolveFallbackTool?: (name: string) => AgentTool | undefined;
	},
): Promise<Harness & { mock: MockModel }> {
	const tempDir = TempDir.createSync("@pi-checkpoint-rewind-branch-");
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("mock", "test-key");

	const mock = createMockModel({ responses });
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.eager": "default",
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const toolRegistry = new Map(tools.map(tool => [tool.name, tool]));
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: mock,
			systemPrompt: ["Test"],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
		resolveFallbackTool: options?.resolveFallbackTool,
	});

	const sessionManager = SessionManager.inMemory(tempDir.path());
	let extensionRunner: ExtensionRunner | undefined;
	if (options?.onAgentEnd) {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("agent_end", event => options.onAgentEnd?.(event.willContinue));
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"capture-agent-end",
		);
		extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry,
		extensionRunner,
	});
	const harness = { session, authStorage, tempDir, extraSessions: [] };
	activeHarnesses.push(harness);
	return { ...harness, mock };
}

function messageText(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

function expectLastAssistant(messages: AgentMessage[]): AssistantMessage {
	const message = messages.at(-1);
	expect(message?.role).toBe("assistant");
	if (message?.role !== "assistant") throw new Error("Expected last message to be assistant");
	return message;
}
function createToolSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function rewindToolForSession(session: AgentSession): RewindTool {
	return new RewindTool(
		createToolSession({
			getCheckpointState: () => session.getCheckpointState(),
			getLastCompletedRewind: () => session.getLastCompletedRewind(),
		}),
	);
}

async function expectNoActiveCheckpointError(session: AgentSession): Promise<void> {
	await expect(rewindToolForSession(session).execute("repeat_rewind", { report: "retry" })).rejects.toThrow(
		"No active checkpoint. Create a checkpoint before calling rewind.",
	);
}

describe("AgentSession checkpoint rewind branch context", () => {
	it("rebuilds active history through branch_summary before the post-rewind assistant turn", async () => {
		const report = "findings: kept checkpoint; risks: stale signed thinking";
		const { session, mock } = await createHarness([
			{
				content: [
					signedThinking("checkpoint before exploring", "sig_checkpoint"),
					{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } },
				],
				stopReason: "toolUse",
			},
			{
				content: [
					signedThinking("ready to rewind", "sig_rewind"),
					{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report } },
				],
				stopReason: "toolUse",
			},
			{
				content: [signedThinking("answer after rewind", "sig_after_rewind"), "DONE"],
				stopReason: "stop",
			},
		]);

		await session.prompt("investigate with a checkpoint");

		expect(mock.calls.length).toBe(3);
		const finalCall = mock.calls[2];
		if (!finalCall) throw new Error("Expected final post-rewind provider call");
		const summaryIndex = finalCall.context.messages.findIndex(message => {
			if (message.role !== "user") return false;
			const text = messageText(message);
			const openIndex = text.indexOf("<summary>");
			const closeIndex = text.indexOf("</summary>", openIndex + "<summary>".length);
			return (
				openIndex >= 0 &&
				closeIndex > openIndex + "<summary>".length &&
				text.slice(openIndex + "<summary>".length, closeIndex).trim().length > 0
			);
		});
		const reportIndex = finalCall.context.messages.findIndex(
			message => message.role === "developer" && messageText(message).includes(report),
		);
		expect(summaryIndex).toBeGreaterThan(-1);
		expect(reportIndex).toBeGreaterThan(summaryIndex);
		const reportMessage = finalCall.context.messages[reportIndex];
		if (!reportMessage) throw new Error("Expected rewind report context");
		const reportText = messageText(reportMessage);
		expect(reportText).toContain(
			"Checkpoint called and rewound. Report retained below. Need explore again → new `checkpoint`.",
		);
		expect(reportText).toContain(report);

		expect(
			finalCall.context.messages.some(message => message.role === "toolResult" && message.toolName === "rewind"),
		).toBe(false);

		const activeRoles = session.messages.map(message => message.role);
		expect(activeRoles).toEqual(["user", "assistant", "toolResult", "branchSummary", "custom", "assistant"]);
		expect(activeRoles).toEqual(session.sessionManager.buildSessionContext().messages.map(message => message.role));

		const finalAssistant = expectLastAssistant(session.messages);
		const finalThinking = finalAssistant.content.find((block): block is ThinkingContent => block.type === "thinking");
		expect(finalThinking?.thinking).toBe("answer after rewind");
		expect(finalThinking?.thinkingSignature).toBe("sig_after_rewind");
	});

	it("shows a transient checkpoint-active reminder that is branch-cut away on rewind", async () => {
		const report = "findings: transient reminder";
		const proceed = Promise.withResolvers<void>();
		const { session, mock } = await createHarness(
			(async function* () {
				yield {
					content: [
						{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } },
					],
					stopReason: "toolUse",
				};
				await proceed.promise;
				yield {
					content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report } }],
					stopReason: "toolUse",
				};
				yield { content: ["DONE"], stopReason: "stop" };
			})() as MockResponseSource,
		);

		const promptPromise = session.prompt("investigate with a checkpoint");
		// Pause the model between the checkpoint and rewind calls to observe the
		// active-checkpoint state: the transient notice must be in the active path.
		const deadline = Date.now() + 5000;
		while (
			!session.messages.some(
				message => message.role === "custom" && message.customType === "checkpoint-active-reminder",
			) ||
			mock.calls.length < 2
		) {
			if (Date.now() > deadline) throw new Error("checkpoint reminder/provider call never appeared");
			await Bun.sleep(10);
		}
		const reminder = session.messages.find(
			(message): message is Extract<AgentMessage, { role: "custom" }> =>
				message.role === "custom" && message.customType === "checkpoint-active-reminder",
		);
		expect(reminder).toBeDefined();
		expect(reminder?.content).toContain("MUST `rewind` before yielding");
		const activeCall = mock.calls[1];
		expect(activeCall).toBeDefined();
		expect(
			activeCall?.context.messages.some(message => messageText(message).includes("Exploration checkpoint active.")),
		).toBe(true);
		// #checkpointState is set synchronously with the reminder (pre-await), so an
		// immediate rewind would find an active checkpoint, not "No active checkpoint".
		expect(session.getCheckpointState()).toBeDefined();
		proceed.resolve();
		await promptPromise;

		// After rewind the branch cut dropped the reminder from the active path.
		expect(
			session.messages.some(
				message => message.role === "custom" && message.customType === "checkpoint-active-reminder",
			),
		).toBe(false);

		// No negation guard anywhere in the model-visible context.
		const finalCall = mock.calls.at(-1);
		if (!finalCall) throw new Error("Expected final post-rewind provider call");
		for (const message of finalCall.context.messages) {
			const text = messageText(message);
			expect(text).not.toContain("NEVER call");
			expect(text).not.toContain("Do not call `rewind` again");
		}

		// Exactly one developer message carries the forward-looking rewind report.
		const reportMessages = finalCall.context.messages.filter(
			message => message.role === "developer" && messageText(message).includes("Checkpoint called and rewound."),
		);
		expect(reportMessages).toHaveLength(1);
		expect(messageText(reportMessages[0]!)).toContain("Need explore again → new `checkpoint`.");
		expect(messageText(reportMessages[0]!)).toContain(report);
	});

	it("checkpoint tool result carries only the goal and a forward-looking line", async () => {
		const tool = new CheckpointTool(
			createToolSession({
				getCheckpointState: () => undefined,
			}),
		);
		const result = await tool.execute("call_checkpoint", { goal: "inspect" });
		const text = result.content.find(part => part.type === "text")?.text;
		expect(text).toBe("Checkpoint: inspect\nFinish exploration and formulate findings.");
		expect(text).not.toContain("Run your investigation");
		expect(text).not.toContain("call rewind");
	});

	it("ignores a completed cycle's rewind result after rebuilding context", async () => {
		const staleReport = "findings from the previous checkpoint";
		const currentReport = "findings from the current checkpoint";
		const { session, mock } = await createHarness([
			{
				content: [
					{ type: "toolCall", id: "call_checkpoint_a", name: "checkpoint", arguments: { goal: "inspect A" } },
				],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind_a", name: "rewind", arguments: { report: staleReport } }],
				stopReason: "toolUse",
			},
			{ content: ["DONE"], stopReason: "stop" },
		]);
		await session.prompt("investigate the first checkpoint");

		session.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call_rewind_a_late",
			toolName: "rewind",
			content: [{ type: "text", text: "rewind requested" }],
			details: { report: staleReport, rewound: true },
			isError: false,
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);

		mock.push({
			content: [{ type: "toolCall", id: "call_checkpoint_b", name: "checkpoint", arguments: { goal: "inspect B" } }],
			stopReason: "toolUse",
		});
		mock.push({
			content: [{ type: "toolCall", id: "call_rewind_b", name: "rewind", arguments: { report: currentReport } }],
			stopReason: "toolUse",
		});
		mock.push({ content: ["DONE"], stopReason: "stop" });

		await session.prompt("investigate the second checkpoint");

		expect(session.getLastCompletedRewind()?.report).toBe(currentReport);
	});

	it("does not start checkpoint tracking for xdev help envelopes", async () => {
		const { session } = await createHarness(
			[
				{
					content: [
						{
							type: "toolCall",
							id: "call_checkpoint_help",
							name: "write",
							arguments: { path: "xd://checkpoint", content: "help" },
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			],
			[xdevWriteTool],
		);

		await session.prompt("show checkpoint help");

		expect(session.getCheckpointState()).toBeUndefined();
	});

	it("tracks checkpoint and rewind through execute xdev write results", async () => {
		const report = "findings: xdev wrapper";
		const { session, mock } = await createHarness(
			[
				{
					content: [
						{
							type: "toolCall",
							id: "call_checkpoint_xdev",
							name: "write",
							arguments: {
								path: "xd://checkpoint",
								content: JSON.stringify({ goal: "inspect" }),
							},
						},
					],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "call_rewind_xdev",
							name: "write",
							arguments: {
								path: "xd://rewind",
								content: JSON.stringify({ report }),
							},
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			],
			[xdevWriteTool],
		);

		await session.prompt("investigate with an xdev checkpoint");

		const finalCall = mock.calls.at(-1);
		if (!finalCall) throw new Error("Expected final post-rewind provider call");
		expect(
			finalCall.context.messages.some(
				message => message.role === "toolResult" && message.toolCallId === "call_rewind_xdev",
			),
		).toBe(false);
		expect(
			session.messages.some(message => message.role === "toolResult" && message.toolCallId === "call_rewind_xdev"),
		).toBe(false);
		expect(session.messages).toEqual(session.sessionManager.buildSessionContext().messages);

		expect(session.getLastCompletedRewind()).toEqual({
			report,
			startedAt: "2026-01-01T00:00:00.000Z",
			rewoundAt: expect.any(String),
		});
	});

	it("tracks direct xd:// checkpoint and rewind calls through the session lifecycle", async () => {
		const report = "findings: prefixed direct calls";
		const proceed = Promise.withResolvers<void>();
		const secondRequestStarted = Promise.withResolvers<void>();
		const { session } = await createHarness(
			(async function* () {
				yield {
					content: [
						{
							type: "toolCall",
							id: "call_checkpoint_direct_xdev",
							name: "xd://checkpoint",
							arguments: { goal: "inspect" },
						},
					],
					stopReason: "toolUse",
				};
				secondRequestStarted.resolve();
				await proceed.promise;
				yield {
					content: [
						{
							type: "toolCall",
							id: "call_rewind_direct_xdev",
							name: "xd://rewind",
							arguments: { report },
						},
					],
					stopReason: "toolUse",
				};
				yield { content: ["DONE"], stopReason: "stop" };
			})() as MockResponseSource,
			[checkpointTool as AgentTool, rewindTool as AgentTool],
			{
				resolveFallbackTool: name => {
					if (name === "xd://checkpoint") return checkpointTool as AgentTool;
					if (name === "xd://rewind") return rewindTool as AgentTool;
					return undefined;
				},
			},
		);

		const promptPromise = session.prompt("investigate with direct xd device calls");
		await secondRequestStarted.promise;

		// Exercise the real RewindTool while the provider's second response is
		// paused: prefixed checkpoint results must activate its session state.
		const checkpointState = session.getCheckpointState();
		const rewindProbe = await rewindToolForSession(session)
			.execute("probe_rewind_after_direct_xdev", { report: "probe" })
			.then(
				result => ({ result }),
				error => ({ error }),
			);
		proceed.resolve();
		await promptPromise;

		expect(checkpointState).toBeDefined();
		expect(rewindProbe).not.toHaveProperty("error");
		expect(session.getCheckpointState()).toBeUndefined();
		expect(session.getLastCompletedRewind()).toEqual({
			report,
			startedAt: "2026-01-01T00:00:00.000Z",
			rewoundAt: expect.any(String),
		});
		expect(
			session.messages.some(
				message => message.role === "toolResult" && message.toolCallId === "call_rewind_direct_xdev",
			),
		).toBe(false);
	});

	it("rehydrates completed rewind state from the retained report on resume", async () => {
		const report = "findings: retained after resume";
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report } }],
				stopReason: "toolUse",
			},
			{
				content: ["DONE"],
				stopReason: "stop",
			},
		]);

		await harness.session.prompt("investigate with a checkpoint");

		const reloadedMock = createMockModel({ responses: [] });
		const reloadedSettings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		});
		reloadedSettings.setModelRole("default", `${reloadedMock.provider}/${reloadedMock.id}`);
		const reloadedTools = [checkpointTool as AgentTool, rewindTool as AgentTool];
		const reloadedAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: reloadedMock,
				systemPrompt: ["Test"],
				tools: reloadedTools,
				messages: harness.session.sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: reloadedMock.stream,
		});
		const reloadedSession = new AgentSession({
			agent: reloadedAgent,
			sessionManager: harness.session.sessionManager,
			settings: reloadedSettings,
			modelRegistry: new ModelRegistry(
				harness.authStorage,
				path.join(harness.tempDir.path(), "models-reloaded.yml"),
			),
			toolRegistry: new Map(reloadedTools.map(tool => [tool.name, tool])),
		});
		harness.extraSessions.push(reloadedSession);

		expect(reloadedSession.getLastCompletedRewind()).toEqual({
			report,
			startedAt: "2026-01-01T00:00:00.000Z",
			rewoundAt: expect.any(String),
		});
		const tool = new RewindTool(
			createToolSession({
				getLastCompletedRewind: () => reloadedSession.getLastCompletedRewind(),
			}),
		);
		await expect(tool.execute("repeat_rewind", { report: "retry" })).rejects.toThrow(
			"Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.",
		);
	});

	it("clears completed rewind state when starting a new session", async () => {
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report: "findings" } }],
				stopReason: "toolUse",
			},
			{
				content: ["DONE"],
				stopReason: "stop",
			},
		]);

		await harness.session.prompt("investigate with a checkpoint");
		expect(harness.session.getLastCompletedRewind()).toBeDefined();

		await harness.session.newSession();

		expect(harness.session.getLastCompletedRewind()).toBeUndefined();
		await expectNoActiveCheckpointError(harness.session);
	});

	it("rehydrates completed rewind state from the branched path", async () => {
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report: "findings" } }],
				stopReason: "toolUse",
			},
			{
				content: ["DONE"],
				stopReason: "stop",
			},
		]);

		await harness.session.prompt("investigate with a checkpoint");
		expect(harness.session.getLastCompletedRewind()).toBeDefined();
		const userEntry = harness.session.sessionManager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "user");
		if (!userEntry) throw new Error("Expected user entry for branch");

		await harness.session.branch(userEntry.id);

		expect(harness.session.getLastCompletedRewind()).toBeUndefined();
		await expectNoActiveCheckpointError(harness.session);
	});
	it("tells the model to continue when rewind is repeated after completion", async () => {
		const tool = new RewindTool(
			createToolSession({
				getLastCompletedRewind: () => ({
					report: "findings retained",
					startedAt: "2026-01-01T00:00:00.000Z",
					rewoundAt: "2026-01-01T00:01:00.000Z",
				}),
			}),
		);

		await expect(tool.execute("repeat_rewind", { report: "retry" })).rejects.toThrow(
			"Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.",
		);
	});

	it("rehydrates active checkpoint state when resuming a session with no rewind yet", async () => {
		const startedAt = "2026-01-01T00:00:00.000Z";
		const harness = await createHarness([
			{
				content: [{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
				stopReason: "toolUse",
			},
			{
				content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report: "findings" } }],
				stopReason: "toolUse",
			},
			{
				content: ["DONE"],
				stopReason: "stop",
			},
		]);
		await harness.session.prompt("investigate with a checkpoint");
		const originalCompleted = harness.session.getLastCompletedRewind();
		expect(originalCompleted).toBeDefined();

		// Simulate "run aborted between checkpoint and rewind" by branching to the
		// checkpoint entry itself — the rewind and its rewind-report entry drop off
		// the active branch, leaving the checkpoint tool result as the leaf.
		const branch = harness.session.sessionManager.getBranch();
		const checkpointEntry = branch.find(
			entry =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "checkpoint",
		);
		if (!checkpointEntry) throw new Error("Expected checkpoint tool result entry");
		harness.session.sessionManager.branch(checkpointEntry.id);

		const reloadedMock = createMockModel({ responses: [] });
		const reloadedSettings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		});
		reloadedSettings.setModelRole("default", `${reloadedMock.provider}/${reloadedMock.id}`);
		const reloadedTools = [checkpointTool as AgentTool, rewindTool as AgentTool];
		const reloadedAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: reloadedMock,
				systemPrompt: ["Test"],
				tools: reloadedTools,
				messages: harness.session.sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: reloadedMock.stream,
		});
		const reloadedSession = new AgentSession({
			agent: reloadedAgent,
			sessionManager: harness.session.sessionManager,
			settings: reloadedSettings,
			modelRegistry: new ModelRegistry(
				harness.authStorage,
				path.join(harness.tempDir.path(), "models-reloaded.yml"),
			),
			toolRegistry: new Map(reloadedTools.map(tool => [tool.name, tool])),
		});
		harness.extraSessions.push(reloadedSession);

		const restored = reloadedSession.getCheckpointState();
		expect(restored).toBeDefined();
		expect(restored?.checkpointEntryId).toBe(checkpointEntry.id);
		expect(restored?.startedAt).toBe(startedAt);
		expect(reloadedSession.getLastCompletedRewind()).toBeUndefined();

		// The rewind tool must accept the request now that the active checkpoint
		// has been re-hydrated — previously this threw "No active checkpoint".
		const rewindResult = await rewindToolForSession(reloadedSession).execute("call_rewind_after_resume", {
			report: "post-resume findings",
		});
		expect(rewindResult.content.some(part => part.type === "text" && part.text.includes("Rewind requested"))).toBe(
			true,
		);
	});
	it("marks extension agent_end willContinue when enforceRewindBeforeYield continues", async () => {
		const agentEnds: Array<boolean | undefined> = [];

		const report = "findings: enforced rewind before yield";
		const { session, mock } = await createHarness(
			[
				{
					content: [
						{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "inspect" } },
					],
					stopReason: "toolUse",
				},
				// Text-only stop while checkpoint is open → #enforceRewindBeforeYield.
				{ content: ["done without rewind"], stopReason: "stop" },
				{
					content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report } }],
					stopReason: "toolUse",
				},
				{ content: ["terminal after rewind"], stopReason: "stop" },
			],
			undefined,
			{ onAgentEnd: willContinue => agentEnds.push(willContinue) },
		);

		await session.prompt("investigate with a checkpoint then yield early");
		await session.waitForIdle();

		// Intermediate enforceRewindBeforeYield settle, then terminal post-rewind settle.
		expect(agentEnds.length).toBeGreaterThanOrEqual(2);
		const continuing = agentEnds.filter(willContinue => willContinue === true);
		expect(continuing).toHaveLength(1);
		const intermediateIndex = agentEnds.indexOf(true);
		expect(intermediateIndex).toBeGreaterThanOrEqual(0);
		expect(intermediateIndex).toBeLessThan(agentEnds.length - 1);
		expect(agentEnds.at(-1)).toBeFalsy();
		expect(mock.calls.length).toBeGreaterThanOrEqual(3);
		expect(expectLastAssistant(session.messages).stopReason).toBe("stop");
	});

	it("rehydrates an active checkpoint from an xdev write after branching and resume", async () => {
		const harness = await createHarness(
			[
				{
					content: [
						{
							type: "toolCall",
							id: "call_checkpoint_xdev",
							name: "write",
							arguments: {
								path: "xd://checkpoint",
								content: JSON.stringify({ goal: "inspect" }),
							},
						},
					],
					stopReason: "toolUse",
				},
				{
					content: [
						{
							type: "toolCall",
							id: "call_rewind_xdev",
							name: "write",
							arguments: {
								path: "xd://rewind",
								content: JSON.stringify({ report: "findings" }),
							},
						},
					],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			],
			[xdevWriteTool],
		);
		await harness.session.prompt("investigate with an xdev checkpoint");

		const checkpointEntry = harness.session.sessionManager.getBranch().find(entry => {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "write") {
				return false;
			}
			const details = entry.message.details as { xdev?: { tool?: string } } | undefined;
			return details?.xdev?.tool === "checkpoint";
		});
		if (!checkpointEntry) throw new Error("Expected xdev checkpoint tool result entry");
		harness.session.sessionManager.branch(checkpointEntry.id);

		const reloadedMock = createMockModel({ responses: [] });
		const reloadedSettings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.eager": "default",
			"todo.reminders": false,
		});
		reloadedSettings.setModelRole("default", `${reloadedMock.provider}/${reloadedMock.id}`);
		const reloadedTools = [xdevWriteTool as AgentTool];
		const reloadedAgent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: reloadedMock,
				systemPrompt: ["Test"],
				tools: reloadedTools,
				messages: harness.session.sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: reloadedMock.stream,
		});
		const reloadedSession = new AgentSession({
			agent: reloadedAgent,
			sessionManager: harness.session.sessionManager,
			settings: reloadedSettings,
			modelRegistry: new ModelRegistry(
				harness.authStorage,
				path.join(harness.tempDir.path(), "models-xdev-reloaded.yml"),
			),
			toolRegistry: new Map(reloadedTools.map(tool => [tool.name, tool])),
		});
		harness.extraSessions.push(reloadedSession);

		expect(reloadedSession.getCheckpointState()).toMatchObject({
			checkpointEntryId: checkpointEntry.id,
			startedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(reloadedSession.getLastCompletedRewind()).toBeUndefined();
		await expect(
			rewindToolForSession(reloadedSession).execute("call_rewind_after_xdev_resume", {
				report: "post-resume findings",
			}),
		).resolves.toMatchObject({ details: { report: "post-resume findings", rewound: true } });
	});
});
