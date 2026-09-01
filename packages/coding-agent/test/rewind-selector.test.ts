/**
 * Contract tests for the esc-esc rewind selector's target construction and
 * navigation: Up steps through rendered items in transcript order, Left jumps
 * to the previous user turn, entries that render nothing (hidden notices) are
 * never selectable, and componentless tool results fold into the turn that
 * rendered their call so rewinding a turn keeps its tool output.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type BranchVariantPath,
	RewindSelectorComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/rewind-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { setKeybindings, type TUI } from "@oh-my-pi/pi-tui";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const ENTER = "\r";

function entry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: "2024-01-01T00:00:00Z", message };
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 } as AgentMessage;
}

function assistantWithBashCall(callId: string): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "Running a command." },
			{ type: "toolCall", id: callId, name: "bash", arguments: { command: "ls" } },
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
	} as unknown as AgentMessage;
}

function bashResult(callId: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "bash",
		content: [{ type: "text", text: "file.txt" }],
		isError: false,
		timestamp: 3,
	} as unknown as AgentMessage;
}

/** u1 → a1(bash call) → tr1 → hidden notice → u2. */
function makeEntries(): SessionMessageEntry[] {
	return [
		entry("u1", null, userMessage("first prompt")),
		entry("a1", "u1", assistantWithBashCall("call-1")),
		entry("tr1", "a1", bashResult("call-1")),
		entry("notice", "tr1", {
			role: "custom",
			customType: "test-notice",
			content: "invisible",
			display: false,
			timestamp: 4,
		} as unknown as AgentMessage),
		entry("u2", "notice", userMessage("second prompt")),
	];
}

function makeSelector(
	onSelect: (id: string) => void,
	siblingPaths?: (entryId: string) => BranchVariantPath[],
): RewindSelectorComponent {
	return new RewindSelectorComponent(makeEntries(), {
		ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
		cwd: "/tmp",
		requestRender: () => {},
		siblingPaths,
		onSelect,
		onCancel: () => {},
	});
}

describe("RewindSelectorComponent", () => {
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

	it("starts on the newest rendered item and Up steps in transcript order past hidden notices", () => {
		const selected: string[] = [];
		const selector = makeSelector(id => selected.push(id));
		selector.render(80);

		selector.handleInput(ENTER);
		selector.handleInput(UP);
		selector.handleInput(UP);
		selector.handleInput(ENTER);

		// u2 first; two Up presses land on u1 — the assistant turn is one step,
		// and the display:false notice is never a stop.
		expect(selected).toEqual(["u2", "u1"]);
	});

	it("folds componentless tool results into the turn that rendered their call", () => {
		const selected: string[] = [];
		const selector = makeSelector(id => selected.push(id));
		selector.render(80);

		selector.handleInput(UP);
		selector.handleInput(ENTER);

		// The assistant turn's rewind point is its trailing tool result, so the
		// bash output survives the rewind.
		expect(selected).toEqual(["tr1"]);
	});

	it("jumps between user turns with Left while Down returns in transcript order", () => {
		const selected: string[] = [];
		const selector = makeSelector(id => selected.push(id));
		selector.render(80);

		selector.handleInput(LEFT);
		selector.handleInput(ENTER);
		selector.handleInput(DOWN);
		selector.handleInput(ENTER);

		// Left from u2 skips the assistant turn straight to u1; Down steps back
		// one rendered item onto the assistant turn (folded to tr1).
		expect(selected).toEqual(["u1", "tr1"]);
	});

	it("slides into a sibling branch with Right and rewinds onto its entries", () => {
		const selected: string[] = [];
		const siblings = (entryId: string): BranchVariantPath[] =>
			entryId === "u2" ? [{ rootId: "u2b", entries: [entry("u2b", "a2", userMessage("alternate prompt"))] }] : [];
		const selector = makeSelector(id => selected.push(id), siblings);
		selector.render(120);

		// u2 is the newest target and has a sibling: Right enters the alternate
		// column, Enter rewinds onto the sibling's entry; Left returns to the
		// current path and Enter lands back on u2.
		selector.handleInput(RIGHT);
		selector.handleInput(ENTER);
		selector.handleInput(LEFT);
		selector.handleInput(ENTER);
		selector.dispose();

		expect(selected).toEqual(["u2b", "u2"]);
	});

	it("renders sibling branches as a half-width column strip at the fork", () => {
		const siblings = (entryId: string): BranchVariantPath[] =>
			entryId === "u2" ? [{ rootId: "u2b", entries: [entry("u2b", "a2", userMessage("alternate prompt"))] }] : [];
		const selector = makeSelector(() => {}, siblings);
		const lines = selector.render(120).map(line => Bun.stripANSI(line));
		selector.dispose();

		const joined = lines.join("\n");
		// Both branch columns are visible side by side with their captions.
		expect(joined).toContain("1/2");
		expect(joined).toContain("current");
		expect(joined).toContain("2/2");
		expect(joined).toContain("alternate prompt");
		// The shared history above the fork stays full width and un-columned.
		expect(joined).toContain("first prompt");
	});

	it("shows a dot rail with edge ellipses when branches overflow the window", () => {
		const siblings = (entryId: string): BranchVariantPath[] =>
			entryId === "u2"
				? ["b1", "b2", "b3"].map(id => ({
						rootId: id,
						entries: [entry(id, "a2", userMessage(`${id} prompt`))],
					}))
				: [];
		const selector = makeSelector(() => {}, siblings);

		const first = selector.render(120).map(line => Bun.stripANSI(line));
		const initialRail = first.find(line => line.includes("◉"));
		expect(initialRail).toBeDefined();
		// Four columns, current active: one filled dot, three hollow, more to the
		// right but nothing to the left.
		expect(initialRail!.match(/○/g)).toHaveLength(3);
		expect(initialRail!.trimEnd().endsWith("…")).toBe(true);
		expect(initialRail!.trimStart().startsWith("…")).toBe(false);

		selector.handleInput(RIGHT);
		selector.handleInput(RIGHT);
		selector.handleInput(RIGHT);
		const slid = selector.render(120).map(line => Bun.stripANSI(line));
		selector.dispose();
		const slidRail = slid.find(line => line.includes("◉"));
		// Last column active: content now overflows on the left instead.
		expect(slidRail!.trimStart().startsWith("…")).toBe(true);
	});

	it("outlines exactly the selected block with dotted verticals", () => {
		const selector = makeSelector(() => {});
		const lines = selector.render(80).map(line => Bun.stripANSI(line));

		const boxed = lines.filter(line => line.startsWith("┆"));
		expect(boxed.length).toBeGreaterThan(0);
		// The initial selection is the newest user prompt; the older prompt
		// stays outside the outline.
		expect(boxed.join("\n")).toContain("second prompt");
		expect(boxed.join("\n")).not.toContain("first prompt");
		expect(lines.join("\n")).toContain("first prompt");
	});
});
