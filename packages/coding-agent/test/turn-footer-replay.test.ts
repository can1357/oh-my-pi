/**
 * A rebuilt transcript (resume, compaction, focus attach) draws each turn's
 * native footer under its answer as the live turn did: the footer is where
 * the answer's Copy lives.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { type UiNode, untrack } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext, renderTranscript } from "./helpers/interactive-mode-context";

const AT = new Date(2026, 0, 2, 3, 4, 5).getTime();

function user(text: string, at: number): AgentMessage {
	return {
		role: "user",
		content: text,
		timestamp: at,
	} as unknown as AgentMessage;
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

/** Every node under `node` (itself included) with native role `role`. */
function withRole(node: UiNode, role: string): UiNode[] {
	return untrack(() => {
		const own = (node.props() as { role?: unknown }).role === role ? [node] : [];
		return [...own, ...node.children().flatMap(child => withRole(child, role))];
	});
}

/** Every `text` prop under `node` (text and prose nodes), joined. */
function texts(node: UiNode): string {
	return untrack(() => {
		const text = (node.props() as { text?: unknown }).text;
		return [typeof text === "string" ? text : "", ...node.children().map(texts)].join(" ");
	});
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => resetSettingsForTest());

describe("rebuilt transcript turn footers", () => {
	it("gives every turn's answer its footer, with that turn's totals", () => {
		const ctx = createInteractiveModeContext();
		const helpers = new UiHelpers(ctx);
		ctx.addMessageToChat = (message, options) => helpers.addMessageToChat(message, options);
		helpers.renderSessionContext({
			messages: [
				user("list the files", AT),
				assistant(
					[
						{
							type: "toolCall",
							id: "call-1",
							name: "bash",
							arguments: { command: "ls" },
						},
					],
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

		// Each footer sits in the block of the answer that ended its turn, carrying the whole turn's totals.
		const footers = ctx.shell.transcript.blocks().flatMap(block =>
			withRole(block.node, "omp.turn.usage").map(footer => ({
				title: (footer.props() as { title?: unknown }).title,
				answer: texts(block.node),
			})),
		);
		expect(footers).toEqual([
			{
				title: expect.stringContaining("3,030 tokens"),
				answer: expect.stringContaining("One file: a.txt."),
			},
			{
				title: expect.stringContaining("505 tokens"),
				answer: expect.stringContaining("Anytime."),
			},
		]);
		expect(renderTranscript(ctx).join("\n")).toContain("Anytime.");
	});
});
