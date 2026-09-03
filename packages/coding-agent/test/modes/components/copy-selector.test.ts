/**
 * Contract tests for the transcript-based `/copy` picker: Enter copies the
 * outlined turn's text, Right descends into its inner blocks (fenced code,
 * commands, tool output) and Enter copies the outlined block verbatim,
 * Left/Esc ascend before Esc cancels, and turns without prose fall back to
 * their blocks.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CopySelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/copy-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { setKeybindings, type TUI } from "@oh-my-pi/pi-tui";

const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const ESC = "\x1b";

const CODE = "const answer = 42;\nconsole.log(answer);";
const ASSISTANT_TEXT = `Here is the fix:\n\`\`\`ts\n${CODE}\n\`\`\`\nDone.`;

function entry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: "2024-01-01T00:00:00Z", message };
}

/** user → assistant(text + code fence + bash call) → bash result. */
function makeEntries(): SessionMessageEntry[] {
	return [
		entry("u1", null, { role: "user", content: "fix the logging", timestamp: 1 } as AgentMessage),
		entry("a1", "u1", {
			role: "assistant",
			content: [
				{ type: "text", text: ASSISTANT_TEXT },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "bun test" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 2,
		} as unknown as AgentMessage),
		entry("t1", "a1", {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: "12 pass" }],
			isError: false,
			timestamp: 3,
		} as unknown as AgentMessage),
	];
}

function makeSelector(picks: Array<{ content: string; label: string }>, onCancel = () => {}): CopySelectorComponent {
	return new CopySelectorComponent(makeEntries(), {
		ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
		cwd: "/tmp",
		requestRender: () => {},
		onPick: (content, label) => picks.push({ content, label }),
		onCancel,
	});
}

describe("CopySelectorComponent", () => {
	beforeAll(async () => {
		await initTheme();
	});
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		setKeybindings(KeybindingsManager.inMemory());
	});
	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		resetSettingsForTest();
	});

	it("copies the outlined turn's prose on Enter", () => {
		const picks: Array<{ content: string; label: string }> = [];
		const selector = makeSelector(picks);
		selector.render(100);

		selector.handleInput(ENTER);
		selector.dispose();

		// The newest item is the assistant turn (bash result folded into it);
		// its item-level copy is the assistant prose, not tool noise.
		expect(picks).toEqual([{ content: ASSISTANT_TEXT, label: "assistant message" }]);
	});

	it("descends into inner blocks with Right and copies the block verbatim", () => {
		const picks: Array<{ content: string; label: string }> = [];
		const selector = makeSelector(picks);
		selector.render(100);

		selector.handleInput(RIGHT);
		selector.handleInput(ENTER);
		selector.dispose();

		// First block of the turn is the fenced code — copied without fences.
		expect(picks).toEqual([{ content: CODE, label: "ts code" }]);
	});

	it("steps through command and tool-output blocks of the same turn", () => {
		const picks: Array<{ content: string; label: string }> = [];
		const selector = makeSelector(picks);
		selector.render(100);

		selector.handleInput(RIGHT);
		selector.handleInput("\x1b[B");
		selector.handleInput(ENTER);
		selector.handleInput(RIGHT);
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput(ENTER);
		selector.dispose();

		// Block order within the turn: code fence, bash command, bash result.
		expect(picks).toEqual([
			{ content: "bun test", label: "bash command" },
			{ content: "12 pass", label: "bash result" },
		]);
	});

	it("Esc ascends from the block view before it cancels the picker", () => {
		const picks: Array<{ content: string; label: string }> = [];
		const onCancel = vi.fn();
		const selector = makeSelector(picks, onCancel);
		selector.render(100);

		selector.handleInput(RIGHT);
		selector.handleInput(ESC);
		expect(onCancel).not.toHaveBeenCalled();
		selector.handleInput(ENTER);
		selector.handleInput(ESC);
		selector.dispose();

		// Post-ascend Enter copies the whole turn again; the second Esc cancels.
		expect(picks).toEqual([{ content: ASSISTANT_TEXT, label: "assistant message" }]);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("Left/Up navigate: user prompt copies its raw text", () => {
		const picks: Array<{ content: string; label: string }> = [];
		const selector = makeSelector(picks);
		selector.render(100);

		selector.handleInput(UP);
		selector.handleInput(ENTER);
		selector.dispose();

		expect(picks).toEqual([{ content: "fix the logging", label: "user message" }]);
	});

	it("renders the descended block stack with captions and dotted outline", () => {
		const selector = makeSelector([]);
		const itemView = selector.render(100).map(line => Bun.stripANSI(line));
		// The outline advertises the descent affordance before Right is pressed.
		expect(itemView.join("\n")).toContain("3 blocks →");
		selector.handleInput(RIGHT);
		const lines = selector.render(100).map(line => Bun.stripANSI(line));
		selector.handleInput(LEFT);
		selector.dispose();

		const joined = lines.join("\n");
		expect(joined).toContain("1/3 · ts code");
		expect(joined).toContain("2/3 · bash command");
		expect(joined).toContain("3/3 · bash result");
		// The selected block sits inside the dotted outline; the rest are plain.
		const boxed = lines.filter(line => line.startsWith("┆")).join("\n");
		expect(boxed).toContain("const answer = 42;");
		expect(boxed).not.toContain("bun test");
	});
});
