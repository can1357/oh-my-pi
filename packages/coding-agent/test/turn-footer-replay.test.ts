/**
 * A rebuilt transcript (resume, compaction, focus attach) draws each turn's
 * native footer under its answer as the live turn did: the footer is where
 * the answer's Copy lives.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { setTranscriptActionHandler, type TranscriptAction } from "@oh-my-pi/pi-tui/chat/transcript-actions";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TspHarness } from "../../tui/test/native/tsp-harness";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const AT = new Date(2026, 0, 2, 3, 4, 5).getTime();

function user(text: string, at: number): AgentMessage {
	return { role: "user", content: text, timestamp: at } as unknown as AgentMessage;
}

function assistant(
	content: unknown[],
	stopReason: "stop" | "toolUse",
	tokens: { input: number; output: number },
	at: number,
): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason,
		usage: {
			...tokens,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens.input + tokens.output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: at,
		completedAt: at + 1_000,
	} as unknown as AgentMessage;
}

let harness: TspHarness | undefined;

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	harness?.stop();
	harness = undefined;
	setTranscriptActionHandler(undefined);
});

describe("rebuilt transcript turn footers", () => {
	it("gives every turn's answer its footer, with that turn's totals and a Copy of that answer", async () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const ctx = createInteractiveModeContext();
		const helpers = new UiHelpers(ctx);
		ctx.addMessageToChat = (message, options) => helpers.addMessageToChat(message, options);
		helpers.renderSessionContext({
			messages: [
				user("list the files", AT),
				assistant(
					[{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
					"toolUse",
					{ input: 1_000, output: 10 },
					AT + 1_000,
				),
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "a.txt" }],
					isError: false,
					timestamp: AT + 2_000,
				} as unknown as AgentMessage,
				assistant([{ type: "text", text: "One file: a.txt." }], "stop", { input: 2_000, output: 20 }, AT + 3_000),
				user("thanks", AT + 10_000),
				assistant([{ type: "text", text: "Anytime." }], "stop", { input: 500, output: 5 }, AT + 11_000),
			],
		} as unknown as SessionContext);
		harness = await TspHarness.start(tui => tui.addChild(ctx.chatContainer));

		const footers = harness.findAll(node => node.p?.role === "omp.turn.usage");
		expect(footers.map(footer => footer.p?.title)).toEqual([
			expect.stringContaining("3,030 tokens"),
			expect.stringContaining("505 tokens"),
		]);
		for (const copy of harness.findAll(node => node.p?.role === "omp.turn.copy")) {
			harness.event({ ev: "action", sf: harness.terminal.surface!, id: copy.id, act: "copy-answer" });
		}
		expect(actions).toEqual([
			{ act: "copy", text: "One file: a.txt." },
			{ act: "copy", text: "Anytime." },
		]);
		expect(harness.errors).toEqual([]);
	});
});
