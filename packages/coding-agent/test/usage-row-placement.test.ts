/**
 * Regression coverage for per-turn usage placement across transcript rebuilds.
 * Read-only turns keep their metrics inside the compact read group; other
 * assistant turns retain a standalone row below their visible content/tools.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

// 4242 → "4.2K": distinctive enough not to collide with a read group's render.
const USAGE_INPUT = 4242;
const USAGE_LABEL = formatNumber(USAGE_INPUT);
// Fixed local wall-clock time so the rendered stamp is deterministic across time zones.
// Single-digit month/day/hour/minute/second exercise the formatter's zero-padding.
const USAGE_TS = new Date(2026, 0, 2, 3, 4, 5).getTime();
const USAGE_TS_LABEL = "2026-01-02 03:04:05";
const SECOND_USAGE_TS = new Date(2026, 0, 2, 3, 4, 6).getTime();
const SECOND_USAGE_TS_LABEL = "2026-01-02 03:04:06";

function readTurn(
	toolCallId = "r1",
	filePath = "src/foo.ts",
	usageInput = USAGE_INPUT,
	timestamp = USAGE_TS,
): AgentMessage[] {
	const assistant = {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: toolCallId,
				name: "read",
				arguments: { path: filePath },
			},
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: usageInput,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: usageInput + 7,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	} as unknown as AgentMessage;
	const toolResult = {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "line1\nline2" }],
		timestamp,
	} as unknown as AgentMessage;
	return [assistant, toolResult];
}

function makeHarness(showTokenUsage: boolean): {
	ctx: InteractiveModeContext;
	helpers: UiHelpers;
} {
	const ctx = createInteractiveModeContext({
		settings: Settings.isolated({ "display.showTokenUsage": showTokenUsage }),
	});
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = message => helpers.addMessageToChat(message);
	return { ctx, helpers };
}

/** The transcript's blocks, each painted on its own as plain rows. */
function blockTexts(ctx: InteractiveModeContext): string[] {
	return ctx.shell.transcript.blocks().map(block =>
		createTestTerminal(() => ({ main: [block.node] }), {
			columns: 120,
			rows: 200,
		})
			.screen()
			.join("\n"),
	);
}

describe("UiHelpers.renderSessionContext token-usage row placement", () => {
	it("nests the usage row inside the read group for a read-only turn", () => {
		const { ctx, helpers } = makeHarness(true);
		helpers.renderSessionContext({ messages: readTurn() } as SessionContext);

		const blocks = blockTexts(ctx);
		const group = blocks.at(-1)!;
		expect(group).toContain("src/foo.ts");
		expect(group).toContain(USAGE_LABEL);
		expect(group).toContain(USAGE_TS_LABEL);
		expect(blocks.filter(text => text.includes(USAGE_LABEL))).toHaveLength(1);
	});

	it("interleaves consecutive read-only turns with their paths in one group", () => {
		const { ctx, helpers } = makeHarness(true);
		const messages = [...readTurn(), ...readTurn("r2", "src/bar.ts", 2121, SECOND_USAGE_TS)];
		helpers.renderSessionContext({ messages } as SessionContext);

		const groups = blockTexts(ctx).filter(text => text.includes("src/foo.ts"));
		expect(groups).toHaveLength(1);
		const lines = groups[0]!.split("\n");
		const fooIndex = lines.findIndex(line => line.includes("src/foo.ts"));
		const firstUsageIndex = lines.findIndex(line => line.includes(USAGE_TS_LABEL));
		const barIndex = lines.findIndex(line => line.includes("src/bar.ts"));
		const secondUsageIndex = lines.findIndex(line => line.includes(SECOND_USAGE_TS_LABEL));
		expect(fooIndex).toBeLessThan(firstUsageIndex);
		expect(firstUsageIndex).toBeLessThan(barIndex);
		expect(barIndex).toBeLessThan(secondUsageIndex);
	});

	it("renders no usage row when showTokenUsage is off", () => {
		const { ctx, helpers } = makeHarness(false);
		helpers.renderSessionContext({ messages: readTurn() } as SessionContext);

		const blocks = blockTexts(ctx);
		expect(blocks.some(text => text.includes(USAGE_LABEL))).toBe(false);
		// Last block is the read group, not a usage row.
		expect(blocks.at(-1)).toContain("src/foo.ts");
	});

	it("keeps a standalone usage row, with the turn's local timestamp, below a non-read turn", () => {
		const { ctx, helpers } = makeHarness(true);
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: USAGE_INPUT,
				output: 7,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: USAGE_INPUT + 7,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: USAGE_TS,
		} as unknown as AgentMessage;
		helpers.renderSessionContext({ messages: [message] } as SessionContext);

		const blocks = blockTexts(ctx);
		expect(blocks[0]).toContain("done");
		expect(blocks.at(-1)).toContain(USAGE_TS_LABEL);
		expect(blocks.at(-1)).toContain(USAGE_LABEL);
		expect(blocks.at(-1)).not.toContain("done");
	});
});
