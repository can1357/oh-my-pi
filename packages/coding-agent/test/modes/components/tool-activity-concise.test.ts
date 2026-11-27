import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { ToolActivityMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { activityClock } from "../../../src/ui/overlays/pickers/agent-hub-model";
import { initTheme } from "../../../src/ui/theme/service";
import { contextDisplay, createInteractiveModeContext, renderTranscript } from "../../helpers/interactive-mode-context";
import { nativeShell } from "../../helpers/native-shell";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const LIST_OUTPUT = "LIST-OUTPUT-MARKER";
const FILE_CONTENT = "FILE-CONTENT-MARKER";
const HEREDOC_BODY = "HEREDOC-BODY-MARKER";
const FAILURE = "exit code 2: TESTS-FAILED-MARKER";

const listCall: ToolCall = {
	type: "toolCall",
	id: "call-list",
	name: "bash",
	arguments: { command: `cat <<'EOF'\n${HEREDOC_BODY}\nEOF`, i: "Listing files: which changed?" },
};
const readCall: ToolCall = { type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/a.ts" } };
const testCall: ToolCall = {
	type: "toolCall",
	id: "call-test",
	name: "bash",
	arguments: { command: "bun test", i: "Running tests" },
};

function assistant(content: AssistantMessage["content"], timestamp = 1): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet",
		usage,
		stopReason: "toolUse",
		timestamp,
	};
}

function context(toolActivity: ToolActivityMode): InteractiveModeContext {
	const ctx = createInteractiveModeContext({ settings: Settings.isolated() });
	contextDisplay(ctx).toolActivity.set(toolActivity);
	return ctx;
}

const text = (ctx: InteractiveModeContext) => renderTranscript(ctx).join("\n");
/** The transcript rows that mention `needle`. */
const rowsWith = (ctx: InteractiveModeContext, needle: string) =>
	renderTranscript(ctx).filter(row => row.includes(needle));
const glyph = (status: "running" | "success" | "error") => currentTheme().symbols.symbol(`status.${status}`);

async function send(controller: EventController, event: unknown): Promise<void> {
	await controller.handleEvent(event as AgentSessionEvent);
}

async function start(controller: EventController, call: ToolCall): Promise<void> {
	await send(controller, {
		type: "tool_execution_start",
		toolCallId: call.id,
		toolName: call.name,
		args: call.arguments,
	});
}

async function end(controller: EventController, call: ToolCall, output: string, isError = false): Promise<void> {
	await send(controller, {
		type: "tool_execution_end",
		toolCallId: call.id,
		toolName: call.name,
		result: { content: [{ type: "text", text: output }] },
		isError,
	});
}

const restoreTheme = currentTheme();

beforeAll(() => {
	initTheme();
});

afterAll(() => setCurrentTheme(restoreTheme));

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("concise tool activity", () => {
	it("draws a live turn as one status row per call: running, done and failed, without arguments or output", async () => {
		const ctx = context("concise");
		const controller = new EventController(ctx);
		const message = assistant([listCall, readCall, testCall]);
		await send(controller, { type: "message_start", message: assistant([]) });
		await send(controller, {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, toolCall: testCall, partial: message },
		});
		await send(controller, { type: "message_end", message });

		await start(controller, listCall);
		const running = rowsWith(ctx, "Listing files");
		expect(running).toHaveLength(1);
		expect(running[0]).toMatch(/^\d\d:\d\d:\d\d /);
		expect(running[0]).toContain(`${glyph("running")} bash Listing files`);
		expect(running[0]).toMatch(/ 0s$/);

		await end(controller, listCall, LIST_OUTPUT);
		await start(controller, readCall);
		await end(controller, readCall, FILE_CONTENT);
		await start(controller, testCall);
		await end(controller, testCall, `3 pass\n1 fail\n\n${FAILURE}\n`, true);

		expect(rowsWith(ctx, "Listing files")[0]).toContain(`${glyph("success")} bash Listing files`);
		expect(rowsWith(ctx, "src/a.ts")).toEqual([expect.stringContaining(`${glyph("success")} read src/a.ts`)]);
		// The failure stays readable on its row: the error glyph and the last line it reported.
		expect(rowsWith(ctx, "Running tests")).toEqual([
			expect.stringContaining(`${glyph("error")} bash Running tests — ${FAILURE}`),
		]);
		const settled = text(ctx);
		for (const hidden of [LIST_OUTPUT, FILE_CONTENT, HEREDOC_BODY, "bun test", "3 pass"])
			expect(settled).not.toContain(hidden);
	});

	it("opens every call's full card with Ctrl+O and folds back to rows", async () => {
		const ctx = context("concise");
		const controller = new EventController(ctx);
		const message = assistant([listCall]);
		await send(controller, { type: "message_start", message: assistant([]) });
		await send(controller, { type: "message_update", message });
		await send(controller, { type: "message_end", message });
		await start(controller, listCall);
		await end(controller, listCall, LIST_OUTPUT);
		expect(text(ctx)).not.toContain(LIST_OUTPUT);

		ctx.toolOutputExpanded = true;
		expect(text(ctx)).toContain(LIST_OUTPUT);
		expect(text(ctx)).toContain(HEREDOC_BODY);

		ctx.toolOutputExpanded = false;
		expect(text(ctx)).not.toContain(LIST_OUTPUT);
		expect(rowsWith(ctx, "Listing files")).toHaveLength(1);
	});

	it("draws a rebuilt transcript by the current mode, clocked by the recorded call times", async () => {
		const at = Date.UTC(2026, 10, 3, 14, 2, 11);
		const messages: AgentMessage[] = [
			assistant([listCall], at),
			{
				role: "toolResult",
				toolCallId: listCall.id,
				toolName: "bash",
				content: [{ type: "text", text: LIST_OUTPUT }],
				isError: false,
				timestamp: at + 5,
			},
			assistant([readCall], at + 60_000),
			{
				role: "toolResult",
				toolCallId: readCall.id,
				toolName: "read",
				content: [{ type: "text", text: FILE_CONTENT }],
				isError: false,
				timestamp: at + 60_005,
			},
		];
		const render = (mode: ToolActivityMode) => {
			const ctx = context(mode);
			new UiHelpers(ctx).renderSessionContext({
				messages,
				thinkingLevel: "off",
				serviceTier: undefined,
				models: {},
				injectedTtsrRules: [],
				mode: "none",
			});
			return ctx;
		};

		const concise = render("concise");
		expect(rowsWith(concise, "Listing files")).toEqual([
			`${activityClock(at)} ${glyph("success")} bash Listing files`,
		]);
		expect(rowsWith(concise, "src/a.ts")).toEqual([
			`${activityClock(at + 60_005)} ${glyph("success")} read src/a.ts`,
		]);
		expect(text(concise)).not.toContain(LIST_OUTPUT);

		// Detailed draws the full cards, as before the mode existed.
		const detailed = text(render("detailed"));
		expect(detailed).toContain(LIST_OUTPUT);
		expect(detailed).toContain(HEREDOC_BODY);
		expect(detailed).not.toContain(activityClock(at));

		// Switching modes redraws the same blocks.
		contextDisplay(concise).toolActivity.set("detailed");
		expect(text(concise)).toContain(LIST_OUTPUT);
		contextDisplay(concise).toolActivity.set("hidden");
		expect(text(concise)).not.toContain("Listing files");
	});

	it("sends Tern a folded inline row that unfolds into the full card", async () => {
		const ctx = context("concise");
		const controller = new EventController(ctx);
		await using ui = await nativeShell(ctx.shell);
		const message = assistant([testCall]);
		await send(controller, { type: "message_start", message: assistant([]) });
		await send(controller, { type: "message_update", message });
		await send(controller, { type: "message_end", message });
		await start(controller, testCall);
		expect(ui.node("tool").p).toMatchObject({ status: "running", frame: "inline", collapsed: true });

		await end(controller, testCall, FAILURE, true);
		const row = ui.node("tool");
		// One row: the summary with the failure, no command and no body.
		expect(row.p).toMatchObject({
			status: "error",
			frame: "inline",
			collapsed: true,
			preview: "none",
			target: `Running tests — ${FAILURE}`,
		});
		expect(row.p.command).toBeUndefined();
		expect(row.c).toHaveLength(0);

		ui.send({ ev: "toggle", sf: ui.sf, id: row.id, collapsed: false });
		// The bash card itself: its command and output body, open.
		const card = ui.node("tool");
		expect(card.p).toMatchObject({ status: "error", command: "bun test", collapsed: false, preview: "children" });
		expect(JSON.stringify(ui.tree(card.id))).toContain("TESTS-FAILED-MARKER");

		ui.send({ ev: "toggle", sf: ui.sf, id: card.id, collapsed: true });
		expect(ui.node("tool").p).toMatchObject({ collapsed: true, preview: "none" });
	});
});
