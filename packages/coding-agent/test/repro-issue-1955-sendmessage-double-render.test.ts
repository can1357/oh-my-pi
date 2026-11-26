import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionRunner,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { normalizeCustomMessagePayload } from "@oh-my-pi/pi-coding-agent/session/transcript/messages";
import { createInteractiveModeContext, renderTranscript } from "./helpers/interactive-mode-context";

/**
 * Issue #1955: `sendMessage` with `display: true` renders twice during
 * `session_start`.
 *
 * Repro:
 * - Extension calls `pi.sendMessage({ display: true, ... })` from a
 *   `session_start` handler while the session is idle.
 * - `ExtensionUiController.#applyCustomMessageDisplay` rebuilds the transcript
 *   from the freshly-persisted session entry, so it ends up holding one
 *   custom-message block.
 * - `main.ts` then calls `mode.renderInitialMessages({ preserveExistingChat: true })`,
 *   which re-renders from session entries (adding the same custom message
 *   again) while preserving the existing blocks — leaving two identical
 *   custom-message blocks.
 */
beforeAll(async () => {
	// renderInitialMessages reads the global Settings (display.collapseCompacted).
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
});

interface Harness {
	ctx: InteractiveModeContext;
	helpers: UiHelpers;
	controller: ExtensionUiController;
	sessionManager: SessionManager;
	getActions: () => ExtensionActions | undefined;
}

function createHarness(): Harness {
	let capturedActions: ExtensionActions | undefined;
	const fakeRunner = {
		initialize: (
			a: ExtensionActions,
			_ca: ExtensionContextActions,
			_cca: ExtensionCommandContextActions,
			_ui: ExtensionUIContext,
		) => {
			capturedActions = a;
		},
		onError: () => {},
		emit: async () => undefined,
		getMessageRenderer: () => undefined,
		getAssistantThinkingRenderers: () => undefined,
		getAssistantTextRenderers: () => [],
		getComposerShapes: () => [],
	};

	const sessionManager = SessionManager.inMemory();
	const messages: AgentMessage[] = [];
	const ctx = createInteractiveModeContext({
		sessionManager,
		initialChatRendered: false,
		setToolUIContext: vi.fn(),
		session: {
			messages,
			extensionRunner: fakeRunner as unknown as ExtensionRunner,
			buildTranscriptSessionContext: () => sessionManager.buildSessionContext(),
			/**
			 * Mirror `AgentSession.sendCustomMessage` non-streaming
			 * `deliverAs: "nextTurn"` / no-trigger path: persist the message as a
			 * `custom_message` session entry and append it to the session messages
			 * (silently — no event, no render), reporting it delivered.
			 */
			sendCustomMessage: async payload => {
				const msg = normalizeCustomMessagePayload(payload);
				sessionManager.appendCustomMessageEntry(msg.customType, msg.content, msg.display, undefined, "agent");
				messages.push({
					role: "custom",
					customType: msg.customType,
					content: msg.content,
					display: msg.display,
					attribution: "agent",
					timestamp: Date.now(),
				});
				return true;
			},
		},
	});
	const helpers = new UiHelpers(ctx);
	ctx.renderSessionContext = (context, options) => helpers.renderSessionContext(context, options);
	ctx.renderSessionContextIncrementally = (context, options, renderChunk) =>
		helpers.renderSessionContextIncrementally(context, options, renderChunk);
	ctx.addMessageToChat = message => helpers.addMessageToChat(message);
	ctx.rebuildChatFromMessages = () => {
		ctx.shell.transcript.clear();
		helpers.renderSessionContext(sessionManager.buildSessionContext());
	};

	return {
		ctx,
		helpers,
		controller: new ExtensionUiController(ctx),
		sessionManager,
		getActions: () => capturedActions,
	};
}

function seed(harness: Harness, prefix: string, count: number): void {
	for (let index = 0; index < count; index++) {
		harness.sessionManager.appendCustomMessageEntry(
			"issue-1955-probe",
			[{ type: "text", text: `${prefix}_${index}_END` }],
			true,
			undefined,
			"agent",
		);
	}
}

/** Let the `.then(applyCustomMessageDisplay)` chain queued by `actions.sendMessage` run. */
async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let idx = 0;
	while (true) {
		const found = haystack.indexOf(needle, idx);
		if (found === -1) return count;
		count++;
		idx = found + needle.length;
	}
}

describe("issue #1955 — sendMessage(display:true) during session_start", () => {
	test("renders the custom message exactly once after the initial transcript render", async () => {
		const marker = "issue-1955-marker-text";
		const harness = createHarness();
		await harness.controller.initHooksAndCustomTools();

		const actions = harness.getActions();
		expect(actions).toBeDefined();

		// Simulate the extension's session_start handler firing
		// `pi.sendMessage({ display: true, ... })`.
		actions!.sendMessage(
			{
				customType: "issue-1955-probe",
				content: [{ type: "text", text: marker }],
				display: true,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn" },
		);

		// Drain the `.then(applyCustomMessageDisplay)` microtask chain queued by
		// `actions.sendMessage` before the host's renderInitialMessages fires.
		await drainMicrotasks();

		// Mirror main.ts: after `mode.init()` returns, the host renders the
		// initial transcript while preserving anything previously added to chat.
		await harness.helpers.renderInitialMessages({ preserveExistingChat: true });

		const rendered = renderTranscript(harness.ctx).join("\n");
		const occurrences = countOccurrences(rendered, marker);
		expect(occurrences).toBe(1);
	});

	test("after the initial render, sendMessage(display:true) still renders the message", async () => {
		const marker = "issue-1955-late-marker";
		const harness = createHarness();
		await harness.controller.initHooksAndCustomTools();

		// Establish the initial render — the host's `renderInitialMessages`
		// flips `initialChatRendered` so subsequent extension sends can rebuild.
		await harness.helpers.renderInitialMessages({ preserveExistingChat: true });

		const actions = harness.getActions();
		actions!.sendMessage(
			{
				customType: "issue-1955-probe",
				content: [{ type: "text", text: marker }],
				display: true,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn" },
		);
		await drainMicrotasks();

		const rendered = renderTranscript(harness.ctx).join("\n");
		expect(countOccurrences(rendered, marker)).toBe(1);
	});

	test("defers display rebuilds that arrive during the incremental initial replay", async () => {
		const initialMarker = "INITIAL_ENTRY_127_END";
		const lateMarker = "LATE_EXTENSION_MESSAGE_END";
		const harness = createHarness();
		seed(harness, "INITIAL_ENTRY", 128);
		await harness.controller.initHooksAndCustomTools();
		const actions = harness.getActions();
		expect(actions).toBeDefined();

		const initialReplay = harness.helpers.renderInitialMessages({
			preserveExistingChat: true,
			clearTerminalHistory: true,
		});
		expect(harness.ctx.initialChatRendered).toBe(false);
		actions!.sendMessage(
			{
				customType: "issue-1955-probe",
				content: [{ type: "text", text: lateMarker }],
				display: true,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn" },
		);
		await initialReplay;

		const rendered = renderTranscript(harness.ctx).join("\n");
		expect(countOccurrences(rendered, initialMarker)).toBe(1);
		expect(countOccurrences(rendered, lateMarker)).toBe(1);
		expect(rendered.indexOf(initialMarker)).toBeLessThan(rendered.indexOf(lateMarker));
	});

	test("defers display rebuilds that arrive during a later incremental replay", async () => {
		const existingMarker = "EXISTING_ENTRY_127_END";
		const lateMarker = "LATE_DURING_REPLAY_END";
		const harness = createHarness();
		seed(harness, "EXISTING_ENTRY", 128);
		await harness.controller.initHooksAndCustomTools();
		await harness.helpers.renderInitialMessages({ clearTerminalHistory: true });
		const actions = harness.getActions();
		expect(actions).toBeDefined();

		const replay = harness.helpers.renderInitialMessages({
			clearTerminalHistory: true,
		});
		expect(harness.ctx.initialChatRendered).toBe(false);
		actions!.sendMessage(
			{
				customType: "issue-1955-probe",
				content: [{ type: "text", text: lateMarker }],
				display: true,
				attribution: "agent",
			},
			{ deliverAs: "nextTurn" },
		);
		await replay;

		const rendered = renderTranscript(harness.ctx).join("\n");
		expect(countOccurrences(rendered, existingMarker)).toBe(1);
		expect(countOccurrences(rendered, lateMarker)).toBe(1);
		expect(rendered.indexOf(existingMarker)).toBeLessThan(rendered.indexOf(lateMarker));
	});
});
