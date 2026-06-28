import { afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import type { ImageContent, TextContent } from "@pk-nerdsaver-ai/pi-ai";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
	ExtensionUIContext,
} from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions";
import { ExtensionUiController } from "@pk-nerdsaver-ai/pi-coding-agent/modes/controllers/extension-ui-controller";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { UiHelpers } from "@pk-nerdsaver-ai/pi-coding-agent/modes/utils/ui-helpers";
import { buildSessionContext, type SessionContext } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-context";
import type { CustomMessageEntry, SessionEntry } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-entries";
import { Container } from "@pk-nerdsaver-ai/pi-tui";

/**
 * Issue #1955: `sendMessage` with `display: true` renders twice during
 * `session_start`.
 *
 * Repro:
 * - Extension calls `pi.sendMessage({ display: true, ... })` from a
 *   `session_start` handler while the session is idle.
 * - `ExtensionUiController.#applyCustomMessageDisplay` rebuilds the chat from
 *   the freshly-persisted session entry, so the chat container ends up holding
 *   one custom-message component.
 * - `main.ts` then calls `mode.renderInitialMessages({ preserveExistingChat: true })`,
 *   which snapshots the chat children, clears, re-renders from session entries
 *   (adding the same custom message again), and re-appends the snapshot —
 *   leaving two identical custom-message components in the chat.
 */
beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeCustomEntry(id: number, text: string, parentId: string | null): CustomMessageEntry {
	return {
		type: "custom_message",
		customType: "issue-1955-probe",
		content: [{ type: "text", text }],
		display: true,
		attribution: "agent",
		id: `entry-${id}`,
		parentId,
		timestamp: new Date(2026, 5, 5, 0, 0, id).toISOString(),
	};
}

interface Harness {
	ctx: InteractiveModeContext;
	helpers: UiHelpers;
	entries: SessionEntry[];
	controller: ExtensionUiController;
	getActions: () => ExtensionActions | undefined;
}

function createHarness(): Harness {
	const entries: SessionEntry[] = [];
	let capturedActions: ExtensionActions | undefined;
	let helpers!: UiHelpers;
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
	};

	const sessionMock = {
		isStreaming: false,
		extensionRunner: fakeRunner,
		/**
		 * Mirror `AgentSession.sendCustomMessage` non-streaming
		 * `deliverAs: "nextTurn"` / no-trigger path: persist the message as a
		 * `custom_message` session entry. (The real implementation also calls
		 * `agent.appendMessage`, but that path is silent — no event, no render —
		 * so the bug surface is unaffected by omitting it here.)
		 */
		sendCustomMessage: async (msg: {
			customType: string;
			content: string | (TextContent | ImageContent)[];
			display?: boolean;
			details?: unknown;
			attribution?: string;
		}) => {
			const parent = entries.length === 0 ? null : entries[entries.length - 1].id;
			entries.push(makeCustomEntry(entries.length + 1, extractText(msg.content), parent));
		},
	};

	const ctx = {
		chatContainer: new Container(),
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		pendingTools: new Map(),
		ui: { requestRender: vi.fn() },
		isBackgrounded: false,
		initialChatRendered: false,
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		settings: { get: () => false },
		session: sessionMock,
		viewSession: {
			buildTranscriptSessionContext: () => buildSessionContext(entries),
			sessionManager: { getEntries: () => entries },
		},
		focusedAgentId: undefined,
		sessionManager: {
			buildSessionContext: () => buildSessionContext(entries),
			getEntries: () => entries,
		},
		setToolUIContext: vi.fn(),
		setEditorComponent: vi.fn(),
		setWorkingMessage: vi.fn(),
		setToolsExpanded: vi.fn(),
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		showError: vi.fn(),
		editor: {
			setText: vi.fn(),
			handleInput: vi.fn(),
			getText: () => "",
		},
		renderSessionContext: (c: SessionContext, o?: { updateFooter?: boolean; populateHistory?: boolean }) =>
			helpers.renderSessionContext(c, o),
		addMessageToChat: (m: AgentMessage) => helpers.addMessageToChat(m),
		rebuildChatFromMessages: () => {
			ctx.chatContainer.clear();
			helpers.renderSessionContext(buildSessionContext(entries));
		},
	} as unknown as InteractiveModeContext;
	helpers = new UiHelpers(ctx);

	const controller = new ExtensionUiController(ctx);

	return {
		ctx,
		helpers,
		entries,
		controller,
		getActions: () => capturedActions,
	};
}

function extractText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	for (const part of content) {
		if (part.type === "text") return part.text;
	}
	return "";
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
		await Bun.sleep(0);

		// Mirror main.ts: after `mode.init()` returns, the host renders the
		// initial transcript while preserving anything previously added to chat.
		harness.helpers.renderInitialMessages({ preserveExistingChat: true });

		const rendered = Bun.stripANSI(harness.ctx.chatContainer.render(120).join("\n"));
		const occurrences = countOccurrences(rendered, marker);
		expect(occurrences).toBe(1);
	});

	test("after the initial render, sendMessage(display:true) still renders the message", async () => {
		const marker = "issue-1955-late-marker";
		const harness = createHarness();
		await harness.controller.initHooksAndCustomTools();

		// Establish the initial render — the host's `renderInitialMessages`
		// flips `initialChatRendered` so subsequent extension sends can rebuild.
		harness.helpers.renderInitialMessages({ preserveExistingChat: true });

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
		await Bun.sleep(0);

		const rendered = Bun.stripANSI(harness.ctx.chatContainer.render(120).join("\n"));
		expect(countOccurrences(rendered, marker)).toBe(1);
	});
});
