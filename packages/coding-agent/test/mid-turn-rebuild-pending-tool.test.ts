/**
 * A transcript rebuild while a tool is still executing (subagent focus
 * attach/unfocus, overlay close) must not hide the in-flight call: the
 * assistant turn is persisted at message_end but its toolResult is not, so a
 * rebuild used to strip the dangling toolCall and the agent looked idle while
 * still waiting on the tool.
 *
 * Contracts under test:
 *  - renderSessionContext renders a dangling toolCall as a pending block and,
 *    while the viewed session streams, keeps it tracked in `pendingTools` so
 *    the live event stream lands the result in the SAME component.
 *  - Idle rebuilds seal leftover danglers instead of pinning the transcript
 *    live region with a spinner that can never resolve.
 *  - A tool whose result already landed in the session entries renders once:
 *    the replayed completed block wins over a component still lingering in
 *    `pendingTools`, while genuinely in-flight components (dangling calls,
 *    running background tasks, read groups with a pending sibling) stay live.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgTerminalShowImages } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { PendingTool } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { buildSessionContext, type SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isSettled } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { TranscriptBlock } from "../src/ui/shell";
import { initTheme } from "../src/ui/theme/service";
import { createInteractiveModeContext, renderTranscript } from "./helpers/interactive-mode-context";
import { createModeTerminal, renderRows, transcriptText } from "./helpers/mode-terminal";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Assistant turn persisted mid-execution: toolCall present, no toolResult. */
const danglingAssistant = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "call-1",
			name: "bash",
			arguments: { command: "sleep 60" },
		},
	],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	stopReason: "toolUse",
	usage,
	timestamp: Date.now(),
} as unknown as AgentMessage;

function createFixture(opts: { isStreaming: boolean }) {
	const ctx = createInteractiveModeContext({
		session: { isStreaming: opts.isStreaming },
	});
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
	const controller = new EventController(ctx);
	ctx.eventController = controller;
	return { ctx, helpers, controller };
}

const imageMarks = (ctx: ReturnType<typeof createFixture>["ctx"]) =>
	renderTranscript(ctx)
		.join("\n")
		.match(/\[Image: image\/png\]/g);

describe("mid-turn transcript rebuild keeps in-flight tool calls", () => {
	const created: PendingTool[] = [];

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		for (const tool of created.splice(0)) tool.seal();
		vi.restoreAllMocks();
	});

	it("renders a dangling toolCall as pending, tracks it, and routes the live result into it", async () => {
		const { ctx, helpers, controller } = createFixture({ isStreaming: true });

		helpers.renderSessionContext({
			messages: [danglingAssistant],
		} as SessionContext);

		// Still awaiting its result: the block stays live and the map keeps
		// routing events into it after the rebuild.
		const component = ctx.pendingTools.get("call-1")!;
		expect(component).toBeDefined();
		created.push(component);
		expect(ctx.shell.transcript.blocks()).toContain(component.block);
		expect(isSettled(component.block.node)).toBe(false);

		// The tool finishes after the rebuild: the result must land in the same
		// rebuilt component instead of being dropped.
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		});

		expect(isSettled(component.block.node)).toBe(true);
		expect(ctx.pendingTools.size).toBe(0);
		expect(renderTranscript(ctx).join("\n")).toContain("done");
	});

	for (const arrival of ["buffered", "live", "persisted", "during-replay"] as const) {
		it(`keeps replayed read images visible after ${arrival} completion`, async () => {
			const { ctx, helpers, controller } = createFixture({ isStreaming: true });
			const showImages = cfgTerminalShowImages.get(ctx.settings);
			cfgTerminalShowImages.set(ctx.settings, true);
			try {
				const assistant: AssistantMessage = {
					role: "assistant",
					content: [
						{ type: "text", text: "Inspecting the image." },
						{
							type: "toolCall",
							id: "image-read",
							name: "read",
							arguments: { path: "pixel.png" },
						},
						{ type: "text", text: "Continuing after the read." },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "toolUse",
					usage,
					timestamp: 1,
				};
				const result: ToolResultMessage = {
					role: "toolResult",
					toolCallId: "image-read",
					toolName: "read",
					content: [
						{
							type: "image",
							mimeType: "image/png",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
						},
					],
					isError: false,
					timestamp: 2,
				};
				ctx.viewSession.agent.getPendingToolResults = () => (arrival === "buffered" ? [result] : []);
				controller.resetTranscriptAnchors();
				if (arrival === "during-replay") {
					let completion: Promise<void> | undefined;
					const messages: AgentMessage[] = [assistant];
					for (let i = 0; i < 100; i++) {
						messages.push({
							role: "user",
							content: `Replay message ${i}`,
							timestamp: i + 3,
						});
					}
					await helpers.renderSessionContextIncrementally({ messages } as SessionContext, {}, () => {
						completion ??= controller.handleEvent({
							type: "tool_execution_end",
							toolCallId: result.toolCallId,
							toolName: result.toolName,
							result: { content: result.content },
							isError: false,
						});
					});
					await completion;
				} else {
					helpers.renderSessionContext({
						messages: arrival === "persisted" ? [assistant, result] : [assistant],
					} as SessionContext);
				}
				controller.restorePendingToolResults();
				if (arrival !== "live") {
					expect(imageMarks(ctx)).toHaveLength(1);
					expect(ctx.pendingTools.size).toBe(0);
				}
				await controller.handleEvent({
					type: "tool_execution_end",
					toolCallId: result.toolCallId,
					toolName: result.toolName,
					result: { content: result.content },
					isError: false,
				});
				expect(imageMarks(ctx)).toHaveLength(1);
				expect(ctx.pendingTools.size).toBe(0);
			} finally {
				cfgTerminalShowImages.set(ctx.settings, showImages);
			}
		});
	}

	it("seals dangling toolCalls on idle rebuilds instead of leaving a live spinner", async () => {
		const { ctx, helpers } = createFixture({ isStreaming: false });

		helpers.renderSessionContext({
			messages: [danglingAssistant],
		} as SessionContext);
		await Promise.resolve();

		// No result is coming: the block freezes as history and live tracking
		// stays empty so historical components never receive live events.
		expect(renderTranscript(ctx).join("\n")).toContain("sleep 60");
		expect(ctx.shell.transcript.blocks().every(block => isSettled(block.node))).toBe(true);
		expect(ctx.pendingTools.size).toBe(0);
	});
});

describe("InteractiveMode rebuild renders each tool call once", () => {
	const CMD = "mvn -q -pl module -Dmaven.gitcommitid.skip=true -DskipTests clean compile";

	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let settingsDir: TempDir;

	beforeAll(async () => {
		initTheme();
		resetSettingsForTest();
		settingsDir = TempDir.createSync("@pi-rebuild-tool-once-settings-");
		await Settings.init({ inMemory: true, cwd: settingsDir.path() });
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-rebuild-tool-once-");
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			createModeTerminal().frame,
		);
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		tempDir?.removeSync();
	});

	afterAll(() => {
		authStorage.close();
		settingsDir.removeSync();
		resetSettingsForTest();
	});

	function countCommand(): number {
		return transcriptText(mode.shell).split(CMD).length - 1;
	}

	function addLiveBash(): PendingTool {
		const tool = mode.presentToolCall({
			name: "bash",
			args: { command: CMD },
			tool: undefined,
			id: "call-1",
			cwd: tempDir.path(),
		});
		mode.pendingTools.set("call-1", tool);
		return tool;
	}

	/** The transcript's tool entries (cards and read groups). */
	function toolEntries(): PendingTool[] {
		return mode.shell.transcript.blocks().flatMap(block => {
			const entry = mode.transcriptEntry(block);
			return entry?.kind === "tool" ? [entry.tool] : [];
		});
	}

	/** Transcript blocks whose painted rows contain `text`. */
	function blocksShowing(text: string): TranscriptBlock[] {
		return mode.shell.transcript.blocks().filter(block =>
			renderRows(() => block.node)
				.join("\n")
				.includes(text),
		);
	}

	it("renders a completed tool once when its component lingers in pendingTools during a rebuild", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: Date.now(),
				message: { role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: Date.now(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: CMD } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage,
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "m3",
				parentId: "m2",
				timestamp: Date.now(),
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "" }],
					isError: false,
					timestamp: 3,
				},
			},
		] as unknown as SessionEntry[];

		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		vi.spyOn(session, "buildTranscriptSessionContext").mockReturnValue(
			buildSessionContext(entries, undefined, undefined, { transcript: true }),
		);

		addLiveBash();
		expect(countCommand()).toBe(1);

		mode.rebuildChatFromMessages();

		// The replay reconstructs the completed block from the persisted
		// toolResult; the stale live component must NOT be re-appended on top.
		expect(countCommand()).toBe(1);
	});

	it("keeps a genuinely in-flight tool call across a rebuild (still exactly once, still live)", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: Date.now(),
				message: { role: "user", content: [{ type: "text", text: "run it" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: Date.now(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: CMD } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage,
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
		] as unknown as SessionEntry[];

		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		vi.spyOn(session, "buildTranscriptSessionContext").mockReturnValue(
			buildSessionContext(entries, undefined, undefined, { transcript: true }),
		);

		const live = addLiveBash();
		mode.rebuildChatFromMessages();

		expect(countCommand()).toBe(1);
		// The in-flight component is preserved for live routing so the pending
		// tool's result still lands in the on-screen block.
		expect(mode.pendingTools.get("call-1")).toBe(live);
	});

	it("keeps a still-running background task's live handle across a rebuild", () => {
		const runningDetails = { async: { state: "running", jobId: "job-1", type: "task" } };
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: Date.now(),
				message: { role: "user", content: [{ type: "text", text: "spawn it" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: Date.now(),
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-1", name: "task", arguments: { description: "run", prompt: "go" } },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage,
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "m3",
				parentId: "m2",
				timestamp: Date.now(),
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "task",
					content: [{ type: "text", text: "running…" }],
					details: runningDetails,
					isError: false,
					timestamp: 3,
				},
			},
		] as unknown as SessionEntry[];

		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		vi.spyOn(session, "buildTranscriptSessionContext").mockReturnValue(
			buildSessionContext(entries, undefined, undefined, { transcript: true }),
		);

		const live = mode.presentToolCall({
			name: "task",
			args: { description: "run", prompt: "go" },
			tool: undefined,
			id: "call-1",
			cwd: tempDir.path(),
		});
		live.updateResult(
			{ content: [{ type: "text", text: "running…" }], details: runningDetails, isError: false },
			true,
			"call-1",
		);
		mode.pendingTools.set("call-1", live);

		mode.rebuildChatFromMessages();

		// The still-running task's live handle must survive the rebuild so a later
		// tool_execution_update/_end settles it instead of stranding on "running",
		// without also leaving the replayed snapshot on screen.
		expect(mode.pendingTools.get("call-1")).toBe(live);
		expect(toolEntries()).toHaveLength(1);
	});

	it("keeps a shared read group attached while a sibling read is still in flight", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: Date.now(),
				message: { role: "user", content: [{ type: "text", text: "read them" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: Date.now(),
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
						{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "b.txt" } },
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage,
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "m3",
				parentId: "m2",
				timestamp: Date.now(),
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "contents of a" }],
					isError: false,
					timestamp: 3,
				},
			},
		] as unknown as SessionEntry[];

		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		vi.spyOn(session, "buildTranscriptSessionContext").mockReturnValue(
			buildSessionContext(entries, undefined, undefined, { transcript: true }),
		);

		// One group component shared by both read ids, exactly as the live path
		// wires it (ui-helpers sets the same ReadToolGroupComponent per read id).
		const group = mode.presentReadGroup();
		group.updateArgs({ path: "a.txt" }, "call-1");
		group.updateArgs({ path: "b.txt" }, "call-2");
		mode.pendingTools.set("call-1", group);
		mode.pendingTools.set("call-2", group);

		mode.rebuildChatFromMessages();

		// The shared group must stay the sole on-screen owner for both the completed
		// call-1 and pending call-2 — splicing it would detach the pending read's
		// display, while replaying call-1 would duplicate the group.
		expect(mode.pendingTools.get("call-1")).toBeUndefined();
		expect(mode.pendingTools.get("call-2")).toBe(group);
		expect(mode.shell.transcript.blocks().includes(group.block)).toBe(true);
		expect(toolEntries().filter(tool => tool.group !== undefined)).toHaveLength(1);
	});

	it("keeps a successful internal read single when replay beats its live completion", async () => {
		// The session has no tools; read is a built-in in real sessions, so
		// provenance-gated rendering must treat it as one here.
		vi.spyOn(session, "hasBuiltInTool").mockReturnValue(true);
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
		const toolUseTurn = (content: AssistantMessage["content"]): AssistantMessage => ({
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage,
			stopReason: "toolUse",
			timestamp: 2,
		});
		const ec = mode.eventController;
		const memoryPath = "memory://root/rollout_summaries/successful-read";
		const readCall: ToolCall = {
			type: "toolCall",
			id: "read-success",
			name: "read",
			arguments: { path: memoryPath, i: "Read successful memory" },
		};
		await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		await ec.handleEvent({ type: "message_start", message: toolUseTurn([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await ec.handleEvent({
			type: "message_update",
			message: toolUseTurn([readCall]),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: readCall,
				partial: toolUseTurn([readCall]),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await ec.handleEvent({
			type: "message_end",
			message: toolUseTurn([readCall]),
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
		await ec.handleEvent({
			type: "tool_execution_start",
			toolCallId: readCall.id,
			toolName: readCall.name,
			args: readCall.arguments,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);

		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "user-success",
				parentId: null,
				timestamp: Date.now(),
				message: { role: "user", content: [{ type: "text", text: "read memory" }], timestamp: 1 },
			},
			{
				type: "message",
				id: "assistant-success",
				parentId: "user-success",
				timestamp: Date.now(),
				message: toolUseTurn([readCall]),
			},
			{
				type: "message",
				id: "result-success",
				parentId: "assistant-success",
				timestamp: Date.now(),
				message: {
					role: "toolResult",
					toolCallId: readCall.id,
					toolName: readCall.name,
					content: [{ type: "text", text: "successful memory contents" }],
					isError: false,
					timestamp: 3,
				},
			},
		] as unknown as SessionEntry[];
		vi.spyOn(session, "buildTranscriptSessionContext").mockReturnValue(
			buildSessionContext(entries, undefined, undefined, { transcript: true }),
		);
		mode.rebuildChatFromMessages();

		expect(blocksShowing(memoryPath)).toHaveLength(1);
		const replayChildCount = mode.shell.transcript.blocks().length;

		// Persistence/replay won the race; the delayed live completion must not
		// create a fallback read group beside the completed replay card.
		await ec.handleEvent({
			type: "tool_execution_end",
			toolCallId: readCall.id,
			toolName: readCall.name,
			result: { content: [{ type: "text", text: "successful memory contents" }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		expect(blocksShowing(memoryPath)).toHaveLength(1);
		expect(mode.shell.transcript.blocks()).toHaveLength(replayChildCount);
	});
});
