/**
 * Contracts:
 * - `showError(message, { failsTurn: true })` registers its notice as a `failure` transcript
 *   entry (turn marks read it); a plain `showError` registers nothing.
 * - A collapsed transcript replay whose latest `/clear` boundary hides earlier messages opens
 *   with one notice saying so and how to show them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgDisplayCollapseCompacted } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInteractiveModeContext, renderTranscript } from "../../helpers/interactive-mode-context";

const CLEARED_NOTICE = "Earlier messages are hidden by a /clear boundary.";

beforeEach(async () => {
	// The replay reads the global Settings (display.collapseCompacted).
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
});

function userMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp };
}

describe("UiHelpers.showError turn failure", () => {
	it("registers a failsTurn error notice as a failure entry", () => {
		const ctx = createInteractiveModeContext();
		const helpers = new UiHelpers(ctx);

		helpers.showError("Retry failed after 3 attempts: overloaded", { failsTurn: true });

		const block = ctx.shell.transcript.blocks().at(-1);
		expect(block).toBeDefined();
		expect(ctx.transcriptEntry(block!)).toEqual({ kind: "failure" });
	});

	it("leaves turn outcomes alone for a plain error", () => {
		const ctx = createInteractiveModeContext();
		const helpers = new UiHelpers(ctx);

		helpers.showError("Plan file not found");

		const blocks = ctx.shell.transcript.blocks();
		expect(blocks).toHaveLength(1);
		expect(ctx.transcriptEntry(blocks[0]!)).toBeUndefined();
	});
});

describe("UiHelpers.renderInitialMessages cleared-history notice", () => {
	/** A context over `manager` whose collapsed transcript is `shown`, replayed by one real UiHelpers. */
	function replayCtx(manager: SessionManager, shown: AgentMessage[]): InteractiveModeContext {
		const transcript: SessionContext = {
			messages: shown,
			thinkingLevel: "off",
			serviceTier: undefined,
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		};
		const ctx = createInteractiveModeContext({
			sessionManager: manager,
			session: {
				buildTranscriptSessionContext: () => transcript,
				getQueuedMessages: () => ({ steering: [], followUp: [], liveSteered: 0 }),
			},
		});
		const helpers = new UiHelpers(ctx);
		Object.assign(ctx, {
			addMessageToChat: helpers.addMessageToChat.bind(helpers),
			renderSessionContext: helpers.renderSessionContext.bind(helpers),
			renderSessionContextIncrementally: helpers.renderSessionContextIncrementally.bind(helpers),
			renderInitialMessages: helpers.renderInitialMessages.bind(helpers),
			updatePendingMessagesDisplay: helpers.updatePendingMessagesDisplay.bind(helpers),
		});
		return ctx;
	}

	async function replayText(manager: SessionManager, shown: AgentMessage[]): Promise<string> {
		const ctx = replayCtx(manager, shown);
		await ctx.renderInitialMessages();
		return renderTranscript(ctx, 240).join("\n");
	}

	it("shows one notice when a /clear boundary hides earlier messages", async () => {
		const manager = SessionManager.inMemory(process.cwd());
		manager.appendMessage({ role: "user", content: "before clear", timestamp: 1 });
		manager.appendResetBoundary();
		const after = userMessage("after clear", 2);
		manager.appendMessage({ role: "user", content: "after clear", timestamp: 2 });

		const text = await replayText(manager, [after]);

		expect(text.split(CLEARED_NOTICE)).toHaveLength(2);
		expect(text).toContain("Collapse Compacted History");
		expect(text.indexOf(CLEARED_NOTICE)).toBeLessThan(text.indexOf("after clear"));
		expect(text).not.toContain("before clear");
	});

	it("shows no notice without a /clear boundary", async () => {
		const manager = SessionManager.inMemory(process.cwd());
		const only = userMessage("plain history", 1);
		manager.appendMessage({ role: "user", content: "plain history", timestamp: 1 });

		expect(await replayText(manager, [only])).not.toContain(CLEARED_NOTICE);
	});

	it("shows no notice when the boundary hides nothing", async () => {
		const manager = SessionManager.inMemory(process.cwd());
		manager.appendResetBoundary();
		const after = userMessage("after clear", 2);
		manager.appendMessage({ role: "user", content: "after clear", timestamp: 2 });

		expect(await replayText(manager, [after])).not.toContain(CLEARED_NOTICE);
	});

	it("shows no notice when a later compaction supersedes the boundary", async () => {
		const manager = SessionManager.inMemory(process.cwd());
		manager.appendMessage({ role: "user", content: "before clear", timestamp: 1 });
		manager.appendResetBoundary();
		const keptId = manager.appendMessage({ role: "user", content: "after clear", timestamp: 2 });
		manager.appendCompaction("summary", undefined, keptId, 100);

		expect(await replayText(manager, [])).not.toContain(CLEARED_NOTICE);
	});

	it("shows no notice when the transcript is not collapsed", async () => {
		cfgDisplayCollapseCompacted.set(settings, false);
		const manager = SessionManager.inMemory(process.cwd());
		manager.appendMessage({ role: "user", content: "before clear", timestamp: 1 });
		manager.appendResetBoundary();

		expect(await replayText(manager, [])).not.toContain(CLEARED_NOTICE);
	});
});
