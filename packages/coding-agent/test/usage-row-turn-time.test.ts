/**
 * Coverage for the per-turn prompt→yield time (Δ + clock) in transcript usage
 * rows, gated by `display.showTurnTime` — the delta sits right after the turn's
 * timestamp and counts hooks, tool calls, and the final generation.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-coding-agent/modes/components/chat-transcript-builder";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { formatUsageRow } from "@oh-my-pi/pi-coding-agent/modes/components/usage-row";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Container, type TUI } from "@oh-my-pi/pi-tui";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// 60s of elapsed: 30s between the prompt and the final response's creation,
// plus a 30s provider request — formatDuration renders this as "1m".
const PROMPT_AT = new Date(2026, 0, 2, 3, 4, 5).getTime();
const RESPONSE_CREATED_AT = PROMPT_AT + 30_000;
const REQUEST_DURATION_MS = 30_000;
const USAGE_LABEL = "4.2K";
const TURN_ELAPSED_LABEL = "Δ1m";

type AssistantFixture = Extract<AgentMessage, { role: "assistant" }>;

function assistantMessage(overrides: Partial<AssistantFixture> = {}): AssistantFixture {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 4242,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 4249,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: RESPONSE_CREATED_AT,
		duration: REQUEST_DURATION_MS,
		completedAt: PROMPT_AT + 60_000,
		...overrides,
	} as unknown as AssistantFixture;
}

function userMessage(text = "build it"): AgentMessage {
	return { role: "user", content: text, timestamp: PROMPT_AT } as unknown as AgentMessage;
}

function toEntries(
	messages: AgentMessage[],
): Array<{ type: "message"; id: string; parentId: string | null; timestamp: string; message: AgentMessage }> {
	return messages.map((message, index) => ({
		type: "message",
		id: `m${index}`,
		parentId: index === 0 ? null : `m${index - 1}`,
		timestamp: new Date(0).toISOString(),
		message,
	}));
}

function renderedText(container: Container): string {
	return Bun.stripANSI(container.children.map(child => child.render(120).join("\n")).join("\n"));
}

describe("formatUsageRow turn elapsed", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders the clock-and-delta prompt→yield time right after the timestamp", () => {
		const row = formatUsageRow(assistantMessage().usage as Usage, REQUEST_DURATION_MS, undefined, PROMPT_AT, 60_000);
		expect(row.indexOf("2026-01-02 03:04:05")).toBeLessThan(row.indexOf(TURN_ELAPSED_LABEL));
		expect(row).toContain(TURN_ELAPSED_LABEL);
	});

	it("omits the delta when no elapsed is supplied", () => {
		expect(formatUsageRow(assistantMessage().usage as Usage)).not.toContain("Δ");
	});

	it("rounds fractional elapsed so the label never prints a raw float", () => {
		// `message.duration` comes from performance.now(); the combined value must
		// not leak the fraction into the label (roboomp: unstable oversized text).
		const row = formatUsageRow(
			assistantMessage().usage as Usage,
			undefined,
			undefined,
			undefined,
			347.28381699998863,
		);
		expect(row).toContain("Δ347ms");
		expect(row).not.toContain("347.28381699998863");
	});
});

describe("ChatTranscriptBuilder turn elapsed", () => {
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		settings.set("display.showTokenUsage", true);
	});
	afterEach(() => {
		resetSettingsForTest();
	});

	function builder(): ChatTranscriptBuilder {
		return new ChatTranscriptBuilder({
			ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
			cwd: process.cwd(),
			requestRender: () => {},
		});
	}

	it("shows the prompt→yield delta when display.showTurnTime is on", () => {
		settings.set("display.showTurnTime", true);
		const transcript = builder();
		transcript.rebuild(toEntries([userMessage(), assistantMessage()]));
		const rendered = renderedText(transcript.container);
		expect(rendered).toContain(TURN_ELAPSED_LABEL);
		expect(rendered).toContain(USAGE_LABEL);
	});

	it("hides the delta when display.showTurnTime is off", () => {
		settings.set("display.showTurnTime", false);
		const transcript = builder();
		transcript.rebuild(toEntries([userMessage(), assistantMessage()]));
		expect(renderedText(transcript.container)).not.toContain(TURN_ELAPSED_LABEL);
	});

	it("shows no delta when the turn start is unknown (no user message)", () => {
		settings.set("display.showTurnTime", true);
		const transcript = builder();
		transcript.rebuild(toEntries([assistantMessage()]));
		expect(renderedText(transcript.container)).not.toContain(TURN_ELAPSED_LABEL);
	});
	it("measures the span from the local completion time when the provider omits duration", () => {
		settings.set("display.showTurnTime", true);
		const transcript = builder();
		// gitlab-duo-style: `timestamp` stamped at request start, no provider
		// `duration` — the session's `completedAt` stamp still yields the full span.
		transcript.rebuild(toEntries([userMessage(), assistantMessage({ duration: undefined })]));
		expect(renderedText(transcript.container)).toContain("Δ1m");
	});

	it("shows no delta for a legacy message without the local completion stamp", () => {
		settings.set("display.showTurnTime", true);
		const transcript = builder();
		transcript.rebuild(toEntries([userMessage(), assistantMessage({ completedAt: undefined })]));
		expect(renderedText(transcript.container)).not.toContain("Δ");
	});
	it("clears the prompt anchor at a developer-initiated synthetic run during replay", () => {
		settings.set("display.showTurnTime", true);
		const transcript = builder();
		const developer = {
			role: "developer",
			content: "auto-continue",
			synthetic: true,
			timestamp: RESPONSE_CREATED_AT + 5_000,
		} as unknown as AgentMessage;
		transcript.rebuild(toEntries([userMessage(), assistantMessage(), developer, assistantMessage()]));
		// Only the user turn's row carries the delta; the auto-continuation run
		// (developer message, no user prompt) must not inherit the user anchor.
		const occurrences = renderedText(transcript.container).match(/Δ1m/g)?.length ?? 0;
		expect(occurrences).toBe(1);
	});
	it("keeps the prompt anchor across a persisted same-turn continuation reminder", () => {
		settings.set("display.showTurnTime", true);
		const transcript = builder();
		// The todo/plan continuation reminders are persisted developer messages
		// WITHOUT the synthetic marker (auto-continue carries it): the continued
		// assistant row must keep measuring from the initiating user prompt.
		const reminder = {
			role: "developer",
			content: "todo reminder",
			timestamp: RESPONSE_CREATED_AT + 5_000,
		} as unknown as AgentMessage;
		transcript.rebuild(toEntries([userMessage(), assistantMessage(), reminder, assistantMessage()]));
		const occurrences = renderedText(transcript.container).match(/Δ1m/g)?.length ?? 0;
		expect(occurrences).toBe(2);
	});
	it("anchors a user-initiated continue shortcut to its own submission time", () => {
		settings.set("display.showTurnTime", true);
		const transcript = builder();
		// `.`/`c` continue: a synthetic developer prompt the OPERATOR issued — the
		// message's timestamp is the prompt time, not a continuation to clear.
		const continuePrompt = {
			role: "developer",
			content: "continue",
			attribution: "agent",
			synthetic: true,
			userInitiated: true,
			timestamp: PROMPT_AT,
		} as unknown as AgentMessage;
		transcript.rebuild(toEntries([continuePrompt, assistantMessage()]));
		expect(renderedText(transcript.container)).toContain("Δ1m");
	});

	it("seeds the prompt→yield delta from a user-invoked skill custom message", () => {
		settings.set("display.showTurnTime", true);
		const transcript = builder();
		const skill = {
			role: "custom",
			customType: "skill-prompt",
			attribution: "user",
			content: "/skill:build",
			display: false,
			timestamp: PROMPT_AT,
		} as unknown as AgentMessage;
		transcript.rebuild(toEntries([skill, assistantMessage()]));
		expect(renderedText(transcript.container)).toContain(TURN_ELAPSED_LABEL);
	});
	it("seeds the prompt→yield delta from a writable-collab peer prompt", () => {
		settings.set("display.showTurnTime", true);
		const transcript = builder();
		const collabPrompt = {
			role: "custom",
			customType: "collab-prompt",
			attribution: "user",
			content: "hello from the peer",
			display: true,
			timestamp: PROMPT_AT,
		} as unknown as AgentMessage;
		transcript.rebuild(toEntries([collabPrompt, assistantMessage()]));
		expect(renderedText(transcript.container)).toContain(TURN_ELAPSED_LABEL);
	});
	it("ignores an agent-attributed user message as a turn start", () => {
		settings.set("display.showTurnTime", true);
		const transcript = builder();
		// The advisor's tool-loop guard injects a mid-run `user` corrective with
		// `attribution: "agent"`; it must not reset the anchor to the redirect.
		const redirect = {
			role: "user",
			content: [{ type: "text", text: "stop looping" }],
			synthetic: true,
			attribution: "agent",
			timestamp: RESPONSE_CREATED_AT + 5_000,
		} as unknown as AgentMessage;
		transcript.rebuild(toEntries([userMessage(), assistantMessage(), redirect, assistantMessage()]));
		// The real user prompt anchors both turns; the redirect adds no reset, so
		// the second assistant row still measures from the initiating prompt.
		const occurrences = renderedText(transcript.container).match(/Δ1m/g)?.length ?? 0;
		expect(occurrences).toBe(2);
	});
});

describe("UiHelpers.renderSessionContext turn elapsed", () => {
	beforeAll(async () => {
		await initTheme();
	});

	function makeHarness(turnTimeOn: boolean): { ctx: InteractiveModeContext; helpers: UiHelpers } {
		const ctx = {
			chatContainer: new Container(),
			transcriptMessageComponents: new WeakMap(),
			pendingTools: new Map(),
			ui: { requestRender: vi.fn() },
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			settings: {
				get: (key: string) =>
					key === "display.showTokenUsage" ? true : key === "display.showTurnTime" ? turnTimeOn : false,
			},
			getUserMessageText: (message: { content?: unknown }) =>
				typeof message.content === "string" ? message.content : "",
			addMessageToChat: (message: AgentMessage) => helpers.addMessageToChat(message),
			session: {
				retryAttempt: 0,
				getToolByName: () => undefined,
				sessionManager: { getCwd: () => process.cwd(), putBlobSync: () => undefined },
			},
			get viewSession() {
				return (this as typeof ctx).session;
			},
			toolOutputExpanded: false,
			hideThinkingBlock: false,
			clearTransientSessionUi: () => {},
		} as unknown as InteractiveModeContext;
		const helpers = new UiHelpers(ctx);
		return { ctx, helpers };
	}

	it("renders the delta on the rebuilt usage row after the turn timestamp", () => {
		const { ctx, helpers } = makeHarness(true);
		helpers.renderSessionContext({ messages: [userMessage(), assistantMessage()] } as SessionContext);
		const rendered = renderedText(ctx.chatContainer);
		expect(rendered).toContain(TURN_ELAPSED_LABEL);
		expect(rendered).toContain(USAGE_LABEL);
	});

	it("omits the delta when display.showTurnTime is off", () => {
		const { ctx, helpers } = makeHarness(false);
		helpers.renderSessionContext({ messages: [userMessage(), assistantMessage()] } as SessionContext);
		expect(renderedText(ctx.chatContainer)).not.toContain(TURN_ELAPSED_LABEL);
	});
});

describe("focus-attach mid-turn keeps the prompt→yield delta", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		settings.set("display.showTokenUsage", true);
		settings.set("display.showTurnTime", true);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function createFixture() {
		const chatContainer = new TranscriptContainer();
		chatContainer.setToolActivityVisible(true);
		const ui = {
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
			imageBudget: undefined,
		} as unknown as TUI;
		const viewSession = {
			getToolByName: () => undefined,
			hasBuiltInTool: () => true,
			extensionRunner: undefined,
			isTtsrAbortPending: false,
			retryAttempt: 0,
			isStreaming: false,
			sessionManager: { getCwd: () => process.cwd(), putBlobSync: () => undefined, getSessionName: () => undefined },
		};
		const ctx = {
			isInitialized: true,
			init: vi.fn(async () => {}),
			ui,
			settings,
			chatContainer,
			transcriptMessageComponents: new WeakMap(),
			pendingTools: new Map(),
			toolOutputExpanded: false,
			hideToolActivity: false,
			effectiveHideThinkingBlock: false,
			proseOnlyThinking: true,
			statusLine: { invalidate: vi.fn(), markActivityEnd: vi.fn(), markActivityStart: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			editor: { getText: () => "busy", setText: vi.fn() },
			noteDisplayableThinkingContent: vi.fn(() => false),
			locallySubmittedUserSignatures: new Set<string>(),
			optimisticUserMessageSignature: undefined,
			updatePendingMessagesDisplay: vi.fn(),
			ensureLoadingAnimation: vi.fn(),
			flushPendingModelSwitch: vi.fn(async () => {}),
			flushPendingCommandOutput: vi.fn(),
			syncRetryHintRow: vi.fn(),
			session: viewSession,
			viewSession,
			sessionManager: viewSession.sessionManager,
			showWarning: vi.fn(),
			showPinnedError: vi.fn(),
			clearPinnedError: vi.fn(),
			clearTransientSessionUi: vi.fn(),
			lastAssistantUsage: undefined,
			eventController: undefined as unknown as EventController,
			getUserMessageText: (message: { content?: unknown }) =>
				typeof message.content === "string" ? message.content : "",
			addMessageToChat: (message: AgentMessage) => helpers.addMessageToChat(message),
			updateEditorBorderColor: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new EventController(ctx);
		ctx.eventController = controller;
		const helpers = new UiHelpers(ctx);
		return { controller, helpers, chatContainer, viewSession };
	}

	async function driveAssistantTurn(controller: EventController, message: AssistantFixture): Promise<void> {
		await controller.handleEvent({ type: "message_start", message } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({ type: "message_end", message } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);
	}

	it("hands the replayed user timestamp to the controller so the live message_end row shows the delta", async () => {
		const { controller, helpers, chatContainer, viewSession } = createFixture();
		viewSession.isStreaming = true;

		// Focus attach: reset clears the controller's turn start, then the rebuild
		// replays the user prompt; because the target is streaming, the generator
		// hands the timestamp back instead of discarding it.
		controller.resetTranscriptAnchors();
		helpers.renderSessionContext({ messages: [userMessage(), assistantMessage()] } as SessionContext);

		// The in-flight assistant message ends on the live controller — no user
		// message_start follows, so only the handoff keeps the delta available.
		await driveAssistantTurn(controller, assistantMessage());

		const rendered = renderedText(chatContainer);
		expect(rendered).toContain(TURN_ELAPSED_LABEL);
		expect(rendered).toContain(USAGE_LABEL);
	});

	it("clears a stale prompt anchor for a synthetic-only run", async () => {
		const { controller, chatContainer } = createFixture();

		// Turn 1: a real user prompt anchors the delta in the controller.
		controller.resetTranscriptAnchors();
		await controller.handleEvent({ type: "message_start", message: userMessage() } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await driveAssistantTurn(controller, assistantMessage());
		expect(renderedText(chatContainer)).toContain(TURN_ELAPSED_LABEL);
		await controller.handleEvent({ type: "agent_end", isTerminal: true, messages: [] } as Extract<
			AgentSessionEvent,
			{ type: "agent_end" }
		>);

		// Synthetic-only run (`/goal` kickoff, approved-plan execution): agent_start
		// with no user message must not measure prompt→yield from the completed
		// turn's prompt (which would fold the idle gap into the delta).
		await controller.handleEvent({ type: "agent_start" } as Extract<AgentSessionEvent, { type: "agent_start" }>);
		await driveAssistantTurn(controller, assistantMessage());

		// Turn 1 keeps its row's delta; the synthetic run must not add another.
		const occurrences = renderedText(chatContainer).match(/Δ1m/g)?.length ?? 0;
		expect(occurrences).toBe(1);
	});
	it("seeds the delta from a user-invoked skill prompt in the live path", async () => {
		const { controller, chatContainer } = createFixture();
		controller.resetTranscriptAnchors();
		const skill = {
			role: "custom",
			customType: "skill-prompt",
			attribution: "user",
			content: "/skill:build",
			display: false,
			timestamp: PROMPT_AT,
		} as unknown as AgentMessage;
		await controller.handleEvent({ type: "message_start", message: skill } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await driveAssistantTurn(controller, assistantMessage());
		expect(renderedText(chatContainer)).toContain(TURN_ELAPSED_LABEL);
	});
	it("clears the live anchor when a synthetic developer prompt drains inside the run", async () => {
		const { controller, chatContainer } = createFixture();
		controller.resetTranscriptAnchors();
		await controller.handleEvent({ type: "message_start", message: userMessage() } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await driveAssistantTurn(controller, assistantMessage());
		expect(renderedText(chatContainer)).toContain(TURN_ELAPSED_LABEL);

		// Queued synthetic follow-up (plan approval, /goal) drained inside the same
		// run — no new agent_start, so the developer message_start must clear the
		// preceding user prompt's anchor itself.
		const developer = {
			role: "developer",
			content: "approved plan",
			attribution: "agent",
			synthetic: true,
			timestamp: RESPONSE_CREATED_AT + 5_000,
		} as unknown as AgentMessage;
		await controller.handleEvent({ type: "message_start", message: developer } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await driveAssistantTurn(controller, assistantMessage());

		const occurrences = renderedText(chatContainer).match(/Δ1m/g)?.length ?? 0;
		expect(occurrences).toBe(1); // the synthetic run's row adds no delta
	});
});
describe("AgentSession synthetic follow-up marking", () => {
	let sharedDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = path.join(os.tmpdir(), `pi-turn-time-shared-${Snowflake.next()}`);
		fs.mkdirSync(sharedDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir, "models.yml"));
	});
	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	it("marks a queued synthetic follow-up as a run-initiating developer message", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner: {} as unknown as ExtensionRunner,
		});
		try {
			// The approved-plan execution path queues the hidden directive this way
			// (plan approval racing a busy turn); the queued developer message must
			// carry the run-initiating synthetic marker so replay clears the
			// preceding user prompt's anchor.
			await session.followUp("approved plan", undefined, { synthetic: true });
			const developer = agent.peekFollowUpQueue().find(message => message.role === "developer");
			expect(developer?.synthetic).toBe(true);
		} finally {
			await session.dispose();
		}
	});
	it("persists a user-attributed custom prompt with its original submission timestamp", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			// Real provider delay: the session's internal settle timers use the
			// platform clock, so fake timers would freeze both the submission and
			// the (buggy) emission stamp identically — a genuine delay is the only
			// way to separate the two and prove the entry carries the submission.
			handler: async () => {
				await Bun.sleep(150);
				return { content: ["Done"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
			convertToLlm,
		});
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			extensionRunner: {
				emit: vi.fn(async () => undefined),
				emitBeforeAgentStart: vi.fn(async () => undefined),
				hasHandlers: vi.fn(() => false),
				emitSessionStop: vi.fn(async () => undefined),
			} as unknown as ExtensionRunner,
		});
		const submittedAt = Date.now();
		try {
			await session.promptCustomMessage({
				customType: "collab-prompt",
				content: "hello from the peer",
				display: true,
				attribution: "user",
			});
			await session.waitForIdle();
			const entry = sessionManager.getEntries().find(entry => entry.type === "custom_message");
			expect(entry).toBeDefined();
			const entryMs = new Date((entry as { timestamp: string }).timestamp).getTime();
			// The entry carries the submission instant, not the post-run emission.
			expect(entryMs - submittedAt).toBeLessThan(50);
		} finally {
			await session.dispose();
		}
	});

	it("stores a caller-supplied timestamp on the custom message entry", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomMessageEntry("collab-prompt", "hi", true, undefined, "user", 1_700_000_000_123);
		const entry = sessionManager.getEntries().find(entry => entry.type === "custom_message") as {
			timestamp: string;
		};
		expect(entry.timestamp).toBe(new Date(1_700_000_000_123).toISOString());
	});
});
