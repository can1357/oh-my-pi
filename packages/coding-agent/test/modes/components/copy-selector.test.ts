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
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { setKeybindings, type TUI } from "@oh-my-pi/pi-tui";

const UP = "\x1b[A";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";
const ESC = "\x1b";

const CODE = "const answer = 42;\nconsole.log(answer);";
const LINK = "https://github.com/can1357/oh-my-pi/pull/10503";
const ASSISTANT_TEXT = `Here is the fix:\n\`\`\`ts\n${CODE}\n\`\`\`\nDone. See [the PR](${LINK}).`;

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

function makeSelector(
	picks: Array<{ content: string; label: string }>,
	onCancel = () => {},
	opens?: Array<{ href: string; label: string }>,
): CopySelectorComponent {
	return new CopySelectorComponent(makeEntries(), {
		ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
		cwd: "/tmp",
		requestRender: () => {},
		onPick: (content, label) => picks.push({ content, label }),
		onOpen: opens ? (href, label) => opens.push({ href, label }) : undefined,
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
		selector.handleInput("\x1b[B");
		selector.handleInput(ENTER);
		selector.handleInput(RIGHT);
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B");
		selector.handleInput(ENTER);
		selector.dispose();

		// Block order within the turn: code fence, link, bash command, bash result.
		expect(picks).toEqual([
			{ content: "bun test", label: "bash command" },
			{ content: "12 pass", label: "bash result" },
		]);
	});

	it("lists the turn's links as blocks after code and commands; Enter copies the URL, o opens it", () => {
		const picks: Array<{ content: string; label: string }> = [];
		const opens: Array<{ href: string; label: string }> = [];
		const selector = makeSelector(picks, () => {}, opens);
		selector.render(100);

		selector.handleInput(RIGHT);
		// Blocks: ts code, link, bash command, bash result — the link follows the message's own blocks.
		selector.handleInput("\x1b[B");
		selector.handleInput(ENTER);
		selector.handleInput("o");
		// o on a non-link block is ignored.
		selector.handleInput("\x1b[B");
		selector.handleInput("o");
		const rows = selector.render(100);
		selector.dispose();

		expect(picks).toEqual([{ content: LINK, label: `link${theme.sep.dot}the PR` }]);
		expect(opens).toEqual([{ href: LINK, label: `link${theme.sep.dot}the PR` }]);
		expect(rows.join("\n")).not.toContain("o open");
	});

	it("advertises o open only while a link block is outlined and an opener exists", () => {
		const opens: Array<{ href: string; label: string }> = [];
		const withOpener = makeSelector([], () => {}, opens);
		withOpener.render(100);
		withOpener.handleInput(RIGHT);
		withOpener.handleInput("\x1b[B");
		expect(withOpener.render(100).join("\n")).toContain("o open");
		withOpener.dispose();

		const withoutOpener = makeSelector([]);
		withoutOpener.render(100);
		withoutOpener.handleInput(RIGHT);
		withoutOpener.handleInput("\x1b[B");
		withoutOpener.handleInput("o");
		expect(withoutOpener.render(100).join("\n")).not.toContain("o open");
		withoutOpener.dispose();
	});

	/** SGR left-press at a 0-based (row, col) of the rendered frame. */
	const click = (row: number, col: number) => `\x1b[<0;${col + 1};${row + 1}M`;

	/** Locate `needle` in the rendered frame: 0-based row and the visible column where it starts. */
	function locate(lines: readonly string[], needle: string): { row: number; col: number } {
		for (let row = 0; row < lines.length; row++) {
			const plain = Bun.stripANSI(lines[row]!);
			const at = plain.indexOf(needle);
			if (at !== -1) return { row, col: at };
		}
		throw new Error(`"${needle}" not rendered`);
	}

	it("renders clickable controls on every block caption; a left click on ⧉ copy copies that block", () => {
		const picks: Array<{ content: string; label: string }> = [];
		const opens: Array<{ href: string; label: string }> = [];
		const selector = makeSelector(picks, () => {}, opens);
		selector.render(100);
		selector.handleInput(RIGHT);
		const frame = selector.render(100);
		const plain = frame.map(line => Bun.stripANSI(line));

		// The bash command is block 3 of 4 and is not the outlined block; its own control still targets it.
		const captionRow = plain.findIndex(line => line.includes("3/4 · bash command"));
		expect(captionRow).toBeGreaterThan(0);
		const copyCol = plain[captionRow]!.indexOf(`${theme.cmd.copy} copy`);
		expect(copyCol).toBeGreaterThan(0);
		selector.handleInput(click(captionRow, copyCol + 1));
		selector.dispose();

		expect(picks).toEqual([{ content: "bun test", label: "bash command" }]);
		expect(opens).toEqual([]);
	});

	it("a left click on ↗ open opens that link; non-link captions render no open control", () => {
		const picks: Array<{ content: string; label: string }> = [];
		const opens: Array<{ href: string; label: string }> = [];
		const selector = makeSelector(picks, () => {}, opens);
		selector.render(100);
		selector.handleInput(RIGHT);
		const frame = selector.render(100);
		const plain = frame.map(line => Bun.stripANSI(line));

		const linkRow = plain.findIndex(line => line.includes("2/4 · link · the PR"));
		const codeRow = plain.findIndex(line => line.includes("1/4 · ts code"));
		expect(plain[linkRow]).toContain(`${theme.cmd.share} open`);
		expect(plain[codeRow]).not.toContain(`${theme.cmd.share} open`);

		const openCol = plain[linkRow]!.indexOf(`${theme.cmd.share} open`);
		selector.handleInput(click(linkRow, openCol + 2));
		// Clicks beside a control (the summary text, or the gap) do nothing.
		selector.handleInput(click(linkRow, 4));
		selector.handleInput(click(linkRow + 1, openCol));
		selector.dispose();

		expect(opens).toEqual([{ href: LINK, label: `link${theme.sep.dot}the PR` }]);
		expect(picks).toEqual([]);
	});

	it("click positions follow the scroll offset", () => {
		const picks: Array<{ content: string; label: string }> = [];
		const selector = makeSelector(picks);
		selector.render(100);
		selector.handleInput(RIGHT);
		// Scroll the view down by one wheel notch (3 lines) and re-render so the map reflects it.
		selector.handleInput("\x1b[<65;1;10M");
		const frame = selector.render(100);
		const { row, col } = locate(frame, `${theme.cmd.copy} copy`);
		selector.handleInput(click(row, col));
		selector.dispose();

		expect(picks).toEqual([{ content: CODE, label: "ts code" }]);
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
		expect(itemView.join("\n")).toContain("4 blocks →");
		selector.handleInput(RIGHT);
		const lines = selector.render(100).map(line => Bun.stripANSI(line));
		selector.handleInput(LEFT);
		selector.dispose();

		const joined = lines.join("\n");
		expect(joined).toContain("1/4 · ts code");
		expect(joined).toContain("2/4 · link · the PR");
		expect(joined).toContain(LINK);
		expect(joined).toContain("3/4 · bash command");
		expect(joined).toContain("4/4 · bash result");
		// The selected block sits inside the dotted outline; the rest are plain.
		const boxed = lines.filter(line => line.startsWith("┆")).join("\n");
		expect(boxed).toContain("const answer = 42;");
		expect(boxed).not.toContain("bun test");
	});
});
