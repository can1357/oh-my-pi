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

const GROUPED_READ_YIELD = "The write landed; here is the yield.";

/** user → assistant(yield + write + two filesystem reads) → write result → two read results. */
function makeGroupedReadEntries(): SessionMessageEntry[] {
	return [
		entry("u-gr", null, { role: "user", content: "write then read", timestamp: 1 } as AgentMessage),
		entry("a-gr", "u-gr", {
			role: "assistant",
			content: [
				{ type: "text", text: GROUPED_READ_YIELD },
				{
					type: "toolCall",
					id: "write-1",
					name: "write",
					arguments: { path: "/tmp/out.ts", content: "export const x = 1;\n" },
				},
				{ type: "toolCall", id: "read-a", name: "read", arguments: { path: "/tmp/a.ts" } },
				{ type: "toolCall", id: "read-b", name: "read", arguments: { path: "/tmp/b.ts" } },
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
		entry("t-write", "a-gr", {
			role: "toolResult",
			toolCallId: "write-1",
			toolName: "write",
			content: [{ type: "text", text: "Wrote /tmp/out.ts" }],
			isError: false,
			timestamp: 3,
		} as unknown as AgentMessage),
		entry("t-read-a", "a-gr", {
			role: "toolResult",
			toolCallId: "read-a",
			toolName: "read",
			content: [{ type: "text", text: "export const a = 1;" }],
			isError: false,
			timestamp: 4,
		} as unknown as AgentMessage),
		entry("t-read-b", "a-gr", {
			role: "toolResult",
			toolCallId: "read-b",
			toolName: "read",
			content: [{ type: "text", text: "export const b = 2;" }],
			isError: false,
			timestamp: 5,
		} as unknown as AgentMessage),
	];
}

function makeSelector(
	picks: Array<{ content: string; label: string }>,
	onCancel = () => {},
	opens?: Array<{ href: string; label: string }>,
	entries: SessionMessageEntry[] = makeEntries(),
): CopySelectorComponent {
	return new CopySelectorComponent(entries, {
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

	it("folds lazily created grouped reads into the assistant turn so Enter copies the yield", () => {
		const picks: Array<{ content: string; label: string }> = [];
		const selector = makeSelector(picks, () => {}, undefined, makeGroupedReadEntries());
		const lines = selector.render(100).map(line => Bun.stripANSI(line));

		// The newest target must span the yield AND the lazily created Read group.
		// A fold that keeps previous.end unchanged can still copy yield while
		// leaving the Read card below the outline.
		const boxed = lines.filter(line => line.startsWith("┆")).join("\n");
		expect(boxed).toContain(GROUPED_READ_YIELD);
		expect(boxed).toContain("Read (2)");

		selector.handleInput(ENTER);
		selector.dispose();

		expect(picks).toEqual([{ content: GROUPED_READ_YIELD, label: "assistant message" }]);
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

	/** A picker over `entries` with the harness deps, recording picks. */
	function pickerOver(
		entries: SessionMessageEntry[],
		picks: Array<{ content: string; label: string }>,
		onRender: () => void = () => {},
	): CopySelectorComponent {
		return new CopySelectorComponent(entries, {
			ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
			cwd: "/tmp",
			requestRender: onRender,
			onPick: (content, label) => picks.push({ content, label }),
			onCancel: () => {},
		});
	}

	/** `count` user turns, oldest first, chained by parent id. */
	function promptChain(count: number): SessionMessageEntry[] {
		const entries: SessionMessageEntry[] = [];
		for (let index = 0; index < count; index++) {
			entries.push(
				entry(`u${index}`, index === 0 ? null : `u${index - 1}`, {
					role: "user",
					content: `prompt ${index}`,
					timestamp: index,
				} as AgentMessage),
			);
		}
		return entries;
	}

	it("does not repaint for a wheel notch that cannot move the viewport", () => {
		// The picker opens scrolled to the newest turn, so every wheel-down
		// notch there used to repaint the whole frame and make it twitch.
		let renders = 0;
		const selector = pickerOver(promptChain(120), [], () => renders++);
		const wheelDown = "\x1b[<65;1;10M";
		const wheelUp = "\x1b[<64;1;10M";
		try {
			selector.render(100);

			selector.handleInput(wheelDown);
			selector.handleInput(wheelDown);
			expect(renders).toBe(0);

			// A notch that moves the viewport still repaints, in both directions.
			selector.handleInput(wheelUp);
			expect(renders).toBe(1);
			selector.handleInput(wheelDown);
			expect(renders).toBe(2);

			selector.handleInput(wheelDown);
			expect(renders).toBe(2);
		} finally {
			selector.dispose();
		}
	});

	it("replays only the recent tail of a long branch until `a` loads the earlier turns", () => {
		// One component is built and rendered per entry, so a long session cost
		// seconds before its first frame; the picker starts at the tail instead.
		const entries = promptChain(900);
		const picks: Array<{ content: string; label: string }> = [];
		const selector = pickerOver(entries, picks);
		try {
			expect(selector.targetCount).toBeLessThan(entries.length);
			expect(Bun.stripANSI(selector.render(100).join("\n"))).toContain("a earlier turns");

			// Step off the newest turn: the reload must restore this turn, not
			// fall back to the last target of the fuller transcript.
			selector.handleInput(UP);
			selector.handleInput(UP);
			selector.handleInput("a");
			expect(selector.targetCount).toBe(entries.length);
			const loaded = Bun.stripANSI(selector.render(100).join("\n"));
			expect(loaded).not.toContain("a earlier turns");
			expect(loaded).toContain(`${entries.length - 2}/${entries.length}`);

			selector.handleInput(ENTER);
			expect(picks).toEqual([{ content: "prompt 897", label: "user message" }]);
		} finally {
			selector.dispose();
		}
	});

	it("keeps a copyable target when the final turn is longer than the replay cap", () => {
		// Cutting blindly at `length - limit` would start the tail inside the
		// tool results, whose calls are gone: the builder drops them and the
		// picker mounts with nothing to copy.
		const entries: SessionMessageEntry[] = [
			entry("u1", null, { role: "user", content: "run the sweep", timestamp: 1 } as AgentMessage),
		];
		for (let index = 0; index < 700; index++) {
			const call = `call-${index}`;
			entries.push(
				entry(`a${index}`, entries.at(-1)!.id, {
					role: "assistant",
					content: [{ type: "toolCall", id: call, name: "bash", arguments: { command: `step ${index}` } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "toolUse",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: 2 + index * 2,
				} as unknown as AgentMessage),
			);
			entries.push(
				entry(`t${index}`, entries.at(-1)!.id, {
					role: "toolResult",
					toolCallId: call,
					toolName: "bash",
					content: [{ type: "text", text: `output ${index}` }],
					isError: false,
					timestamp: 3 + index * 2,
				} as unknown as AgentMessage),
			);
		}
		const picks: Array<{ content: string; label: string }> = [];
		const selector = pickerOver(entries, picks);
		try {
			// The single user turn is the only boundary, so the whole branch replays.
			expect(selector.targetCount).toBeGreaterThan(0);
			expect(Bun.stripANSI(selector.render(100).join("\n"))).not.toContain("a earlier turns");

			selector.handleInput(ENTER);
			expect(picks).toHaveLength(1);
			expect(picks[0]!.content).toContain("output 699");
		} finally {
			selector.dispose();
		}
	});

	it("cuts the tail at a directly invoked skill prompt, not only at a user message", () => {
		// A `/skill:` prompt the user invoked starts a turn of its own, so a
		// branch whose recent history is skill turns must not walk back to a
		// far older user message and replay thousands of entries.
		const entries = promptChain(50);
		for (let index = 0; index < 900; index++) {
			entries.push(
				entry(`s${index}`, entries.at(-1)!.id, {
					role: "custom",
					customType: "skill-prompt",
					attribution: "user",
					content: `skill step ${index}`,
					display: true,
					timestamp: 1000 + index,
				} as unknown as AgentMessage),
			);
		}
		const selector = pickerOver(entries, []);
		try {
			expect(selector.targetCount).toBeLessThan(700);
			expect(Bun.stripANSI(selector.render(100).join("\n"))).toContain("a earlier turns");
		} finally {
			selector.dispose();
		}
	});
});
