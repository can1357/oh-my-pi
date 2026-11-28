/**
 * A superseded assistant attempt must not leave its tool cards above the
 * attempt that replaces it. Failed turns keep their card (settled by the
 * synthetic aborted result) until an auto-retry supersedes them; a TTSR rewind
 * retracts the rewound turn's cards at message_end, so the re-run renders each
 * logical call exactly once.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { TranscriptBlock } from "../../../src/ui/shell";
import { initTheme } from "../../../src/ui/theme/service";
import { createModeTerminal, renderRows, transcriptText } from "../../helpers/mode-terminal";

const CMD = "which psql";
const READ_PATH = "src/index.ts";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function bashToolCall(id: string): ToolCall {
	return { type: "toolCall", id, name: "bash", arguments: { command: CMD } };
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason,
		timestamp: 2,
	};
}

/**
 * Transcript cards showing {@link CMD}. Counts cards, not text: a streaming card
 * draws the command through the shell visualization, a finished one as `$ cmd`.
 */
function countCommand(mode: InteractiveMode): number {
	return blocksShowing(mode, CMD).length;
}

/** Transcript blocks whose painted rows contain `text`. */
function blocksShowing(mode: InteractiveMode, text: string): TranscriptBlock[] {
	return mode.shell.transcript.blocks().filter(block =>
		renderRows(() => block.node)
			.join("\n")
			.includes(text),
	);
}

describe("EventController retracts tool cards of superseded turns", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let settingsDir: TempDir;

	beforeAll(async () => {
		initTheme();
		resetSettingsForTest();
		settingsDir = TempDir.createSync("@pi-superseded-tool-cards-settings-");
		await Settings.init({ inMemory: true, cwd: settingsDir.path() });
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-superseded-tool-cards-");
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		// The session is constructed with no tools; bash is a built-in in real
		// sessions, so provenance-gated rendering must treat it as one here.
		vi.spyOn(session, "hasBuiltInTool").mockReturnValue(true);
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			createModeTerminal().frame,
		);
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
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

	async function streamToolCall(id: string, stopReason: AssistantMessage["stopReason"]): Promise<void> {
		const ec = mode.eventController;
		await ec.handleEvent({ type: "message_start", message: assistantMessage([], "toolUse") } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await ec.handleEvent({
			type: "message_update",
			message: assistantMessage([bashToolCall(id)], "toolUse"),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: bashToolCall(id),
				partial: assistantMessage([bashToolCall(id)], "toolUse"),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await ec.handleEvent({
			type: "message_end",
			message: assistantMessage([bashToolCall(id)], stopReason),
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
	}

	async function streamReadToolCall(
		id: string,
		stopReason: AssistantMessage["stopReason"],
		path = READ_PATH,
	): Promise<void> {
		const readCall: ToolCall = {
			type: "toolCall",
			id,
			name: "read",
			arguments: { path, i: "Inspect entrypoint" },
		};
		const ec = mode.eventController;
		await ec.handleEvent({ type: "message_start", message: assistantMessage([], "toolUse") } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await ec.handleEvent({
			type: "message_update",
			message: assistantMessage([readCall], "toolUse"),
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: readCall,
				partial: assistantMessage([readCall], "toolUse"),
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await ec.handleEvent({
			type: "message_end",
			message: assistantMessage([readCall], stopReason),
		} as Extract<AgentSessionEvent, { type: "message_end" }>);
	}

	async function runToolCallToCompletion(id: string): Promise<void> {
		const ec = mode.eventController;
		await ec.handleEvent({
			type: "tool_execution_start",
			toolCallId: id,
			toolName: "bash",
			args: { command: CMD },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await ec.handleEvent({
			type: "tool_execution_end",
			toolCallId: id,
			toolName: "bash",
			result: { content: [{ type: "text", text: "(no output)" }] },
			isError: true,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await ec.handleEvent({ type: "message_end", message: assistantMessage([bashToolCall(id)], "toolUse") } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
	}

	function enableTtsrRewind(pending: boolean): void {
		Object.defineProperty(session, "isTtsrAbortPending", { configurable: true, get: () => pending });
	}

	async function emitSyntheticAbort(id: string, source: string): Promise<void> {
		const ec = mode.eventController;
		await ec.handleEvent({
			type: "tool_execution_start",
			toolCallId: id,
			toolName: "bash",
			args: { command: CMD },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await ec.handleEvent({
			type: "tool_execution_end",
			toolCallId: id,
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "Tool execution was aborted." }],
				details: { __synthetic: true, source, executed: false },
			},
			isError: true,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
	}

	it("keeps a terminally failed turn's tool card visible via its synthetic result", async () => {
		const ec = mode.eventController;
		await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);

		// The turn errors after streaming the call; agent-loop then emits a
		// synthetic aborted result for the never-run call. No retry follows.
		await streamToolCall("call-terminal", "error");
		await emitSyntheticAbort("call-terminal", "assistant_stop_error");

		// The card stays visible (settled with the failure) instead of vanishing.
		expect(countCommand(mode)).toBe(1);
	});

	it("removes a synthetic-settled failed card when an auto-retry supersedes the turn", async () => {
		const ec = mode.eventController;
		await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);

		// Attempt 1 errors; the synthetic result settles the card in place.
		await streamToolCall("call-attempt-1", "error");
		await emitSyntheticAbort("call-attempt-1", "assistant_stop_error");
		expect(countCommand(mode)).toBe(1);

		// The retry supersedes the turn: the settled failed card is removed so the
		// retry's fresh card does not render the call twice.
		await ec.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 0,
			errorMessage: "overloaded",
		} as Extract<AgentSessionEvent, { type: "auto_retry_start" }>);
		expect(countCommand(mode)).toBe(0);
		await ec.handleEvent({ type: "auto_retry_end", success: true, attempt: 1 } as Extract<
			AgentSessionEvent,
			{ type: "auto_retry_end" }
		>);

		await streamToolCall("call-attempt-2", "toolUse");
		await runToolCallToCompletion("call-attempt-2");
		expect(countCommand(mode)).toBe(1);
	});

	it("stops and retracts an animated tool card on a TTSR rewind", async () => {
		vi.useFakeTimers();
		try {
			enableTtsrRewind(true);
			const ec = mode.eventController;
			const writeCall: ToolCall = {
				type: "toolCall",
				id: "write-rewound",
				name: "write",
				arguments: { path: "out.txt", content: "pending content", i: "Write output" },
			};
			await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
			await ec.handleEvent({ type: "message_start", message: assistantMessage([], "toolUse") } as Extract<
				AgentSessionEvent,
				{ type: "message_start" }
			>);
			await ec.handleEvent({
				type: "message_update",
				message: assistantMessage([writeCall], "toolUse"),
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: writeCall,
					partial: assistantMessage([writeCall], "toolUse"),
				},
			} as Extract<AgentSessionEvent, { type: "message_update" }>);
			const writeComponent = mode.pendingTools.get(writeCall.id);
			if (!writeComponent) throw new Error("Expected animated write component");

			const writeBlock = writeComponent.block;
			vi.advanceTimersByTime(500);
			expect(mode.shell.transcript.blocks()).toContain(writeBlock);

			// TTSR rewind is known at message_end (isTtsrAbortPending): retract now.
			await ec.handleEvent({
				type: "message_end",
				message: assistantMessage([writeCall], "aborted"),
			} as Extract<AgentSessionEvent, { type: "message_end" }>);
			expect(mode.pendingTools.has(writeCall.id)).toBeFalse();

			// Retracted: the card left the transcript and its animation went with its node.
			expect(mode.shell.transcript.blocks()).not.toContain(writeBlock);
			expect(writeBlock.node.disposed).toBeTrue();
		} finally {
			vi.useRealTimers();
		}
	});

	it("resets a detached read group on a TTSR rewind so the re-run stays visible", async () => {
		const ec = mode.eventController;
		await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);

		enableTtsrRewind(true);
		await streamReadToolCall("read-rewound", "aborted");
		expect(mode.pendingTools.has("read-rewound")).toBeFalse();

		enableTtsrRewind(false);
		await streamReadToolCall("read-rerun", "toolUse");
		const retryGroup = mode.pendingTools.get("read-rerun");
		if (!retryGroup) throw new Error("Expected retry read group");
		expect(mode.shell.transcript.blocks()).toContain(retryGroup.block);

		await ec.handleEvent({
			type: "tool_execution_start",
			toolCallId: "read-rerun",
			toolName: "read",
			args: { path: READ_PATH, i: "Inspect entrypoint" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await ec.handleEvent({
			type: "tool_execution_end",
			toolCallId: "read-rerun",
			toolName: "read",
			result: { content: [{ type: "text", text: "entrypoint contents" }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		const rendered = transcriptText(mode.shell);
		expect(rendered).toContain(READ_PATH);
	});

	it("preserves successful siblings when retracting a pending read from a shared group", async () => {
		const ec = mode.eventController;
		const keptPath = "/tmp/kept.ts";
		const supersededPath = "/tmp/superseded.ts";
		await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);

		await streamReadToolCall("read-kept", "toolUse", keptPath);
		await ec.handleEvent({
			type: "tool_execution_start",
			toolCallId: "read-kept",
			toolName: "read",
			args: { path: keptPath, i: "Read kept file" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await ec.handleEvent({
			type: "tool_execution_end",
			toolCallId: "read-kept",
			toolName: "read",
			result: { content: [{ type: "text", text: "kept contents" }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);

		enableTtsrRewind(true);
		await streamReadToolCall("read-superseded", "aborted", supersededPath);

		const rendered = transcriptText(mode.shell);
		expect(mode.pendingTools.has("read-superseded")).toBeFalse();
		expect(rendered).toContain(keptPath);
		expect(rendered).not.toContain(supersededPath);
	});

	it("retracts a TTSR-rewound turn's tool card so the re-run renders it once", async () => {
		const ec = mode.eventController;
		await ec.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);

		// Attempt 1: card streams, turn is aborted for a TTSR rewind.
		enableTtsrRewind(true);
		await streamToolCall("call-rewound", "aborted");
		expect(countCommand(mode)).toBe(0);

		// Fresh turn re-issues and completes the call.
		enableTtsrRewind(false);
		await streamToolCall("call-rerun", "toolUse");
		await runToolCallToCompletion("call-rerun");

		expect(countCommand(mode)).toBe(1);
	});
});
