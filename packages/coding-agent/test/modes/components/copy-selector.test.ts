/**
 * Contract tests for the transcript-based `/copy` picker: Enter copies the
 * outlined turn's text, Right descends into its inner blocks (fenced code,
 * commands, tool output) and Enter copies the outlined block verbatim,
 * Left/Esc ascend before Esc cancels, and turns without prose fall back to
 * their blocks.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
} from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CopyPickSource } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/copy-selector";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { createRoot, isUiNode } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { CopySelector } from "../../../src/ui/overlays/pickers/copy-selector";
import { mountOverlay } from "../../helpers/overlay-terminal";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

const CODE = "const answer = 42;\nconsole.log(answer);";
const LINK = "https://github.com/can1357/oh-my-pi/pull/10503";
const ASSISTANT_TEXT = `Here is the fix:\n\`\`\`ts\n${CODE}\n\`\`\`\nDone. See [the PR](${LINK}).`;

function entry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: "2024-01-01T00:00:00Z", message };
}

/** user → assistant(text + code fence + bash call) → bash result. */
function makeEntries(assistantText = ASSISTANT_TEXT): SessionMessageEntry[] {
	return [
		entry("u1", null, { role: "user", content: "fix the logging", timestamp: 1 } as AgentMessage),
		entry("a1", "u1", {
			role: "assistant",
			content: [
				{ type: "text", text: assistantText },
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

const REPLY_FENCE = "flux reconcile kustomization apps";
const REPLY_TEXT = `DEVX-1468 status:\n\nnongprod branch created.\n\n\`\`\`sh\n${REPLY_FENCE}\n\`\`\``;
const REPLY_PLACEHOLDER = "Shown to the user.";
const INTRO_TEXT = "Checking the branches now.";
const TASK_RESULT = "Spawned 2 background agents using reviewer.\n- `StandardsReview` (job `StandardsReview`)";

/**
 * user → assistant(`write out://` reply + task call) → both results. The reply
 * draws as assistant prose in the transcript, so the turn copies as prose.
 */
function makeReplyTurnEntries(): SessionMessageEntry[] {
	return [
		entry("u-r", null, { role: "user", content: "status?", timestamp: 1 } as AgentMessage),
		entry("a-r", "u-r", {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "reply-1", name: "write", arguments: { path: "out://", content: REPLY_TEXT } },
				{ type: "toolCall", id: "task-1", name: "task", arguments: { tasks: [] } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
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
		entry("t-reply", "a-r", {
			role: "toolResult",
			toolCallId: "reply-1",
			toolName: "write",
			content: [{ type: "text", text: REPLY_PLACEHOLDER }],
			isError: false,
			timestamp: 3,
		} as unknown as AgentMessage),
		entry("t-task", "a-r", {
			role: "toolResult",
			toolCallId: "task-1",
			toolName: "task",
			content: [{ type: "text", text: TASK_RESULT }],
			isError: false,
			timestamp: 4,
		} as unknown as AgentMessage),
	];
}

/**
 * user → assistant(bash call, plus `intro` text when given) → bash result carrying the `> out://`
 * reply in its `details.replies`.
 */
function makeBashReplyEntries(options: { intro?: string; replies?: readonly string[] } = {}): SessionMessageEntry[] {
	return [
		entry("u-b", null, { role: "user", content: "status?", timestamp: 1 } as AgentMessage),
		entry("a-b", "u-b", {
			role: "assistant",
			content: [
				...(options.intro === undefined ? [] : [{ type: "text" as const, text: options.intro }]),
				{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "printf '%s' x > out://" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "toolUse",
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
		entry("t-bash", "a-b", {
			role: "toolResult",
			toolCallId: "bash-1",
			toolName: "bash",
			content: [{ type: "text", text: "12 pass" }],
			details: options.replies === undefined ? undefined : { replies: [...options.replies] },
			isError: false,
			timestamp: 3,
		} as unknown as AgentMessage),
	];
}

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

type Pick = { content: string; label: string };

/** The picker over `entries` on a terminal, recording picks (and their sources) and opens. */
function makeSelector(
	picks: Pick[],
	onCancel: () => void = () => {},
	opens?: Array<{ href: string; label: string }>,
	entries: SessionMessageEntry[] = makeEntries(),
	sources?: CopyPickSource[],
): TestTerminal {
	return mountOverlay(
		() =>
			CopySelector({
				entries,
				onPick: (content, label, source) => {
					picks.push({ content, label });
					sources?.push(source);
				},
				onOpen: opens ? (href, label) => opens.push({ href, label }) : undefined,
				onCancel,
			}),
		{ columns: 100, rows: 40 },
	);
}

/** Press `keys` in order (`enter`, `up`, `right`, `o`, …). */
function press(term: TestTerminal, ...keys: string[]): void {
	for (const key of keys) term.press(key);
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

/**
 * One prompt, then 700 bash calls with their results: a final turn far longer than the replay cap.
 * `answer` closes the run with a reply, which moves the replay cap's cut onto a tool result.
 */
function longFinalTurn(answer?: string): SessionMessageEntry[] {
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
	if (answer)
		entries.push(
			entry("answer", entries.at(-1)!.id, {
				role: "assistant",
				content: [{ type: "text", text: answer }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 1500,
			} as unknown as AgentMessage),
		);
	return entries;
}

describe("copy selector", () => {
	const previousKeybindings = getKeybindings();
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});
	afterEach(() => {
		resetSettingsForTest();
		setKeybindings(previousKeybindings);
	});

	it("paints the bound expand key in the painter's symbol preset", () => {
		setKeybindings(KeybindingsManager.inMemory({ "app.tools.expand": "up" }));
		createRoot(dispose => {
			try {
				const picker = CopySelector({ entries: makeEntries(), onPick() {}, onCancel() {} });
				if (!isUiNode(picker)) throw new Error("expected one picker node");
				const ascii = staticEnvironment(loadThemeSync("dark", { symbolPreset: "ascii" }));
				const unicode = staticEnvironment(loadThemeSync("dark", { symbolPreset: "unicode" }));
				expect(paintNode(ascii, picker, 100).rows.join("\n")).toContain("Up expand");
				expect(paintNode(unicode, picker, 100).rows.join("\n")).toContain("↑ expand");
			} finally {
				dispose();
			}
		});
	});

	it("keeps whole-turn picks exact and ties them to the native transcript entries", () => {
		const entries = makeEntries();
		const picks: Pick[] = [];
		const sources: CopyPickSource[] = [];
		const term = makeSelector(picks, () => {}, undefined, entries, sources);
		press(term, "enter", "up", "enter");
		term.dispose();

		expect(picks).toEqual([
			{ content: ASSISTANT_TEXT, label: "assistant message" },
			{ content: "fix the logging", label: "user message" },
		]);
		expect(sources).toEqual([{ entry: entries[1] }, { entry: entries[0] }]);
	});

	it("keeps block content and metadata exact while retaining each block's source entry", () => {
		const quote = "quoted first line\nquoted second line";
		const assistantText = `${ASSISTANT_TEXT}\n> ${quote.replace("\n", "\n> ")}`;
		const entries = makeEntries(assistantText);
		const assistantEntry = entries[1]!;
		const toolResultEntry = entries[2]!;
		const picks: Pick[] = [];
		const sources: CopyPickSource[] = [];
		const term = makeSelector(picks, () => {}, undefined, entries, sources);
		press(term, "right");
		for (let index = 0; index < 5; index++) {
			press(term, "enter");
			if (index < 4) press(term, "down");
		}
		term.dispose();

		const link = "link · the PR";
		expect(picks).toEqual([
			{ content: CODE, label: "ts code" },
			{ content: quote, label: "quote" },
			{ content: LINK, label: link },
			{ content: "bun test", label: "bash command" },
			{ content: "12 pass", label: "bash result" },
		]);
		expect(sources.map(source => source.entry)).toEqual([
			assistantEntry,
			assistantEntry,
			assistantEntry,
			assistantEntry,
			toolResultEntry,
		]);
		expect(sources.map(source => source.block)).toEqual([
			{ content: CODE, label: "ts code", entry: assistantEntry, language: "ts", kind: "code" },
			{ content: quote, label: "quote", entry: assistantEntry, kind: "quote" },
			{ content: LINK, label: link, entry: assistantEntry, href: LINK },
			{ content: "bun test", label: "bash command", entry: assistantEntry, language: "bash", kind: "command" },
			{ content: "12 pass", label: "bash result", entry: toolResultEntry },
		]);
	});

	it("folds grouped reads into the assistant turn so Enter copies the yield", () => {
		const picks: Pick[] = [];
		const term = makeSelector(picks, () => {}, undefined, makeGroupedReadEntries());
		press(term, "enter");
		term.dispose();

		expect(picks).toEqual([{ content: GROUPED_READ_YIELD, label: "assistant message" }]);
	});

	it("copies a turn whose prose is an out:// reply, not its placeholder result", () => {
		const picks: Pick[] = [];
		const term = makeSelector(picks, () => {}, undefined, makeReplyTurnEntries());
		// Blocks: the reply's own fence, then the task result. The write's result is
		// a placeholder the transcript never draws, so it must not surface either.
		press(term, "right", "enter", "down", "enter", "left", "enter");
		term.dispose();

		expect(picks).toEqual([
			{ content: REPLY_FENCE, label: "sh code" },
			{ content: TASK_RESULT, label: "task result" },
			{ content: REPLY_TEXT, label: "assistant message" },
		]);
	});

	it("copies the reply a command sent through out:// after the turn's own text", () => {
		const picks: Pick[] = [];
		const term = makeSelector(
			picks,
			() => {},
			undefined,
			makeBashReplyEntries({ intro: INTRO_TEXT, replies: [REPLY_TEXT] }),
		);
		press(term, "enter");
		term.dispose();

		expect(picks).toEqual([{ content: `${INTRO_TEXT}\n\n${REPLY_TEXT}`, label: "assistant message" }]);
	});

	it("keeps adjacent assistant text blocks concatenated verbatim", () => {
		const entries = makeEntries();
		entries[1] = entry("a1", "u1", {
			...(entries[1]!.message as unknown as Record<string, unknown>),
			content: [
				{ type: "text", text: "hello " },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "bun test" } },
				{ type: "text", text: "world" },
			],
		} as unknown as AgentMessage);
		const picks: Pick[] = [];
		const term = makeSelector(picks, () => {}, undefined, entries);
		press(term, "enter");
		term.dispose();

		expect(picks).toEqual([{ content: "hello world", label: "assistant message" }]);
	});

	it("separates a reply write from the text on either side of it", () => {
		const entries = makeReplyTurnEntries();
		entries[1] = entry("a-r", "u-r", {
			...(entries[1]!.message as unknown as Record<string, unknown>),
			content: [
				{ type: "text", text: "Intro." },
				{ type: "toolCall", id: "reply-1", name: "write", arguments: { path: "out://", content: REPLY_TEXT } },
				{ type: "text", text: "Done." },
			],
		} as unknown as AgentMessage);
		const picks: Pick[] = [];
		const term = makeSelector(picks, () => {}, undefined, entries);
		press(term, "enter");
		term.dispose();

		expect(picks).toEqual([{ content: `Intro.\n\n${REPLY_TEXT}\n\nDone.`, label: "assistant message" }]);
	});

	it("lists the turn's links as blocks after code; Enter copies the URL, o opens it", () => {
		const picks: Pick[] = [];
		const opens: Array<{ href: string; label: string }> = [];
		const term = makeSelector(picks, () => {}, opens);
		// Blocks: ts code, link, bash command, bash result — the link follows the message's own blocks.
		press(term, "right", "down", "enter", "o");
		// o on a non-link block is ignored.
		press(term, "down", "o");
		term.dispose();

		const link = "link · the PR";
		expect(picks).toEqual([{ content: LINK, label: link }]);
		expect(opens).toEqual([{ href: LINK, label: link }]);
	});

	it("ignores o without an opener", () => {
		const picks: Pick[] = [];
		const term = makeSelector(picks);
		press(term, "right", "down", "o");
		term.dispose();
		expect(picks).toEqual([]);
	});

	it("Esc ascends from the block view before it cancels the picker", () => {
		const picks: Pick[] = [];
		const onCancel = vi.fn();
		const term = makeSelector(picks, onCancel);
		press(term, "right", "escape");
		expect(onCancel).not.toHaveBeenCalled();
		press(term, "enter", "escape");
		term.dispose();

		// Post-ascend Enter copies the whole turn again; the second Esc cancels.
		expect(picks).toEqual([{ content: ASSISTANT_TEXT, label: "assistant message" }]);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("replays only the recent tail of a long branch until `a` loads the earlier turns", () => {
		const entries = promptChain(900);
		const picks: Pick[] = [];
		const term = makeSelector(picks, () => {}, undefined, entries);
		try {
			// Step off the newest turn: the reload must keep this turn, not fall back to
			// the last target of the fuller transcript.
			press(term, "up", "up", "a", "enter");
			expect(picks).toEqual([{ content: "prompt 897", label: "user message" }]);
		} finally {
			term.dispose();
		}
	});

	it("steps Up past the oldest replayed turn into the earlier history", () => {
		const entries = promptChain(900);
		const picks: Pick[] = [];
		const term = makeSelector(picks, () => {}, undefined, entries);
		try {
			for (let index = entries.length; index > 0; index--) press(term, "up");
			press(term, "enter");
			expect(picks).toEqual([{ content: "prompt 0", label: "user message" }]);
		} finally {
			term.dispose();
		}
	});

	it("keeps a copyable target when the final turn is longer than the replay cap", () => {
		// The run alone outgrows the replay cap: the tail opens on a call inside it, so the newest
		// call still copies with its output.
		const picks: Pick[] = [];
		const term = makeSelector(picks, () => {}, undefined, longFinalTurn());
		try {
			press(term, "enter");
			expect(picks).toHaveLength(1);
			expect(picks[0]!.content).toContain("output 699");
		} finally {
			term.dispose();
		}
	});

	it("opens a final turn longer than the replay cap on its recent calls, not the whole branch", () => {
		// The tail once reached back to the turn's prompt, replaying all 701 turns of a branch with one prompt.
		// The cut lands on a tool result whose call is cut off: the tail starts at the next call
		// (a blind cut would list the orphan result as a 301st turn).
		createRoot(dispose => {
			try {
				const picker = CopySelector({ entries: longFinalTurn("swept"), onPick() {}, onCancel() {} });
				if (!isUiNode(picker)) throw new Error("expected one picker node");
				const screen = paintNode(staticEnvironment(loadThemeSync("dark")), picker, 100).rows.join("\n");
				expect(screen).toContain("300/300");
				expect(screen).toContain("a earlier turns");
			} finally {
				dispose();
			}
		});
	});
});
