import { afterEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";

function decodeOsc52(osc: string): string {
	const marker = "\x1b]52;c;";
	const start = osc.indexOf(marker);
	if (start === -1) return "";
	return Buffer.from(osc.slice(start + marker.length).replace(/\x07$/, ""), "base64").toString("utf8");
}

import {
	FullscreenChatView,
	findTranscriptMatches,
	highlightTranscriptRanges,
} from "@oh-my-pi/pi-coding-agent/modes/components/fullscreen-chat-view";
import { type Component, Container, type MouseRoutable, visibleWidth } from "@oh-my-pi/pi-tui";

class LinesComponent implements Component, MouseRoutable {
	constructor(private readonly lines: readonly string[]) {}

	render(): readonly string[] {
		return this.lines;
	}

	routeMouse(): void {
		// Not exercised in these tests; the editor slot contract requires it.
	}
}

/** Mutable transcript stand-in for streaming appends during a test. */
class GrowableComponent implements Component {
	lines: string[];
	constructor(lines: readonly string[]) {
		this.lines = [...lines];
	}

	render(): readonly string[] {
		return this.lines;
	}
}

class WrappingComponent implements Component {
	constructor(private readonly text: string) {}

	render(width: number): readonly string[] {
		const lineWidth = Math.max(1, width);
		const lines: string[] = [];
		for (let index = 0; index < this.text.length; index += lineWidth) {
			lines.push(this.text.slice(index, index + lineWidth));
		}
		return lines;
	}
}

describe("transcript search helpers", () => {
	it("finds literal case-insensitive hits across SGR-stripped lines", () => {
		const lines = ["\x1b[1mHello\x1b[0m world", "no match here", "hello HELLO hello"];
		expect(findTranscriptMatches(lines, "")).toEqual([]);
		expect(findTranscriptMatches(lines, "hello")).toEqual([
			{ line: 0, start: 0, end: 5 },
			{ line: 2, start: 0, end: 5 },
			{ line: 2, start: 6, end: 11 },
			{ line: 2, start: 12, end: 17 },
		]);
	});
	it("keeps original text offsets after Unicode case folding and treats punctuation literally", () => {
		expect(findTranscriptMatches(["İBETA"], "beta")).toEqual([{ line: 0, start: 1, end: 5 }]);
		expect(findTranscriptMatches(["a.b aXb"], "a.b")).toEqual([{ line: 0, start: 0, end: 3 }]);
	});
});

describe("highlightTranscriptRanges", () => {
	it("passes through escape sequences without consuming index space", () => {
		expect(highlightTranscriptRanges("\x1b[1mabc\x1b[0mdef", [{ start: 2, end: 5 }])).toBe(
			"\x1b[1mab\x1b[7mc\x1b[0m\x1b[7mde\x1b[27mf",
		);
	});

	it("keeps OSC 8 link payloads intact", () => {
		const line = "\x1b]8;;https://example.com\x1b\\clickable\x1b]8;;\x1b\\ tail";
		expect(highlightTranscriptRanges(line, [{ start: 0, end: 4 }])).toBe(
			"\x1b]8;;https://example.com\x1b\\\x1b[7mclic\x1b[27mkable\x1b]8;;\x1b\\ tail",
		);
	});

	it("merges adjacent ranges and ignores empty input", () => {
		expect(highlightTranscriptRanges("abcdef", [])).toBe("abcdef");
		expect(
			highlightTranscriptRanges("abcdef", [
				{ start: 0, end: 2 },
				{ start: 2, end: 4 },
			]),
		).toBe("\x1b[7mabcd\x1b[27mef");
	});
});

describe("FullscreenChatView", () => {
	it("keeps the editor dock visible while history scrolls independently", () => {
		const transcript = new LinesComponent(Array.from({ length: 10 }, (_, index) => `message-${index + 1}`));
		const status = new LinesComponent(["status"]);
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView({
			transcript: [transcript],
			dock: [status, editorContainer],
			editorContainer: editorContainer,
			terminalRows: () => 6,
			editor: () => editor,
			write: () => {},
		});

		const initial = view.render(12);
		expect(initial[0]).toContain("message-7");
		expect(initial.slice(-2)).toEqual(["status", "editor"]);
		expect(view.ownsOverlayFocusTarget(editor)).toBe(true);
		expect(view.ownsOverlayFocusTarget(transcript)).toBe(false);
		expect(view.handleViewportInput("\x1b[A")).toBe(false);

		expect(view.handleViewportInput("\x1b[5~")).toBe(true);
		const pageUp = view.render(12);
		// Viewport height 4 keeps a 4-row overlap, clamped to a 1-row minimum step.
		expect(pageUp[0]).toContain("message-6");
		expect(pageUp.slice(-2)).toEqual(["status", "editor"]);

		// Click the top of the scrollbar. The visible transcript jumps back to
		// the beginning while the fixed dock remains in place.
		expect(view.handleViewportInput("\x1b[<0;12;1M")).toBe(true);
		const top = view.render(12);
		expect(top[0]).toContain("message-1");
		expect(top.slice(-2)).toEqual(["status", "editor"]);
	});

	it("reflows transcript lines before reserving space for the scrollbar", () => {
		const transcript = new WrappingComponent("abcdefghijklmnopqrstuvwxyz0123456789".repeat(2));
		const status = new LinesComponent(["status"]);
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView({
			transcript: [transcript],
			dock: [status, editorContainer],
			editorContainer: editorContainer,
			terminalRows: () => 6,
			editor: () => editor,
			write: () => {},
		});

		const rendered = view.render(12);
		expect(rendered.slice(0, 4).some(line => line.includes("…"))).toBe(false);
	});

	it("leaves Home/End to the editor and scrolls the viewport on Ctrl+Home/End", () => {
		const transcript = new LinesComponent(Array.from({ length: 10 }, (_, index) => `message-${index + 1}`));
		const status = new LinesComponent(["status"]);
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView({
			transcript: [transcript],
			dock: [status, editorContainer],
			editorContainer: editorContainer,
			terminalRows: () => 6,
			editor: () => editor,
			write: () => {},
		});

		view.render(12);
		// Leave the tail so the Ctrl+Home/End jumps below are observable.
		expect(view.handleViewportInput("\x1b[5~")).toBe(true);

		// Plain Home/End move the editor caret instead: the viewport must let
		// them fall through (upstream Pi returned them to the editor in 1.0.3).
		expect(view.handleViewportInput("\x1b[H")).toBe(false);
		expect(view.handleViewportInput("\x1b[F")).toBe(false);

		expect(view.handleViewportInput("\x1b[1;5H")).toBe(true); // ctrl+home
		expect(view.render(12)[0]).toContain("message-1");
		expect(view.handleViewportInput("\x1b[1;5F")).toBe(true); // ctrl+end
		// Back at the tail, and follow-tail re-engaged for future appends.
		expect(view.render(12)[0]).toContain("message-7");
	});

	it("consumes wheel events for accelerated scrolling", () => {
		const transcript = new LinesComponent(Array.from({ length: 30 }, (_, index) => `message-${index + 1}`));
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView({
			transcript: [transcript],
			dock: [editorContainer],
			editorContainer: editorContainer,
			terminalRows: () => 6,
			editor: () => editor,
			write: () => {},
		});

		view.render(12);
		// Wheel up must be consumed by the viewport regardless of how many lines
		// the speed heuristic picks (line-count behavior is pinned in the
		// wheel-scroll unit tests with an injected clock).
		expect(view.handleViewportInput("\x1b[<64;5;1M")).toBe(true);
		expect(view.render(12)[0]).toContain("message-25");
	});

	it("shows a clickable jump-to-latest indicator only while scrolled away", () => {
		const transcript = new GrowableComponent(Array.from({ length: 10 }, (_, index) => `message-${index + 1}`));
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView({
			transcript: [transcript],
			dock: [editorContainer],
			editorContainer: editorContainer,
			terminalRows: () => 6,
			editor: () => editor,
			write: () => {},
		});

		// Following the tail: no indicator, the last viewport row is content.
		const following = view.render(80);
		expect(following[4]).toContain("message-10");

		expect(view.handleViewportInput("\x1b[5~")).toBe(true);
		const scrolled = view.render(80);
		expect(scrolled[4]).toContain("Back to bottom");
		expect(scrolled[4]).not.toContain("message-");

		// Streaming appends while scrolled away switch to the new-activity label.
		transcript.lines.push("message-11", "message-12");
		const notified = view.render(80);
		expect(notified[4]).toContain("New activity");
		expect(notified[4]).toContain("Back to bottom");

		// Clicking the indicator row returns to the tail, clears the activity
		// flag, and re-engages follow so later appends stay pinned.
		expect(view.handleViewportInput("\x1b[<0;2;5M")).toBe(true);
		const back = view.render(80);
		expect(back[4]).toContain("message-12");
		transcript.lines.push("message-13");
		expect(view.render(80)[4]).toContain("message-13");

		// Scrolling away again shows the plain label until content grows again.
		expect(view.handleViewportInput("\x1b[5~")).toBe(true);
		expect(view.render(80)[4]).not.toContain("New activity");
	});

	it("opens, types, cycles, and closes the transcript search bar", () => {
		const transcript = new LinesComponent(
			Array.from({ length: 20 }, (_, index) => (index % 3 === 0 ? `alpha line ${index}` : `beta line ${index}`)),
		);
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView({
			transcript: [transcript],
			dock: [editorContainer],
			editorContainer: editorContainer,
			terminalRows: () => 8,
			editor: () => editor,
			write: () => {},
		});

		view.render(80);
		// Ctrl+F reserves a row above the transcript for the search bar.
		expect(view.handleViewportInput("\x06")).toBe(true);
		const bar = view.render(80);
		expect(bar[0]).toContain("find:");
		expect(bar[0]).toContain("no matches");

		// Typing filters incrementally and lands on the first on-screen hit.
		for (const ch of "alpha") expect(view.handleViewportInput(ch)).toBe(true);
		const searching = view.render(80);
		expect(searching[0]).toContain("6/7");
		expect(searching.slice(1, 8).some(line => line.includes("alpha"))).toBe(true);

		// Enter cycles with wraparound; Esc closes and restores content row 0.
		expect(view.handleViewportInput("\r")).toBe(true);
		const next = view.render(80);
		expect(next[0]).toContain("7/7");
		expect(view.handleViewportInput("\x1b")).toBe(true);
		const closed = view.render(80);
		expect(closed[0]).not.toContain("find:");
	});

	it("scrolls the current match into the upper third of the viewport", () => {
		const transcript = new LinesComponent(Array.from({ length: 40 }, (_, index) => `row ${index}`));
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView({
			transcript: [transcript],
			dock: [editorContainer],
			editorContainer: editorContainer,
			terminalRows: () => 8,
			editor: () => editor,
			write: () => {},
		});

		view.render(12);
		expect(view.handleViewportInput("\x06")).toBe(true);
		for (const ch of "row 30") expect(view.handleViewportInput(ch)).toBe(true);
		const rendered = view.render(12);
		// Search and status leave five transcript rows: the match sits one
		// transcript row below the search bar.
		expect(rendered[2]).toContain("row 30");
		expect(rendered[2]).toContain("\x1b[7mrow 30\x1b[27m");
	});

	it("routes editor-row clicks through the MouseRoutable contract with frame-local coordinates", () => {
		class RoutableEditor implements Component, MouseRoutable {
			routed: { line: number; col: number }[] = [];
			render(): readonly string[] {
				return ["editor-line"];
			}
			routeMouse(_event: unknown, line: number, col: number): void {
				this.routed.push({ line, col });
			}
		}
		const transcript = new LinesComponent(["message"]);
		const editor = new RoutableEditor();
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView({
			transcript: [transcript],
			dock: [editorContainer],
			editorContainer: editorContainer,
			terminalRows: () => 6,
			editor: () => editor,
			write: () => {},
		});

		const rendered = view.render(12);
		const editorRow = rendered.findIndex(line => line.includes("editor-line"));
		expect(editorRow).toBeGreaterThanOrEqual(0);

		// Click into the editor row: routed with the row relative to the editor's
		// own output, and the raw column. A click one row above (viewport) is not routed.
		expect(view.handleViewportInput(`\x1b[<0;5;${editorRow + 1}M`)).toBe(true);
		expect(editor.routed).toEqual([{ line: 0, col: 4 }]);
		expect(view.handleViewportInput("\x1b[<0;5;1M")).toBe(true);
		expect(editor.routed.length).toBe(1);
	});

	it("disables editor click routing when dock truncation cuts into the editor", () => {
		class RoutableEditor implements Component, MouseRoutable {
			routed = 0;
			render(): readonly string[] {
				return ["editor-line"];
			}
			routeMouse(): void {
				this.routed += 1;
			}
		}
		const transcript = new LinesComponent(["message"]);
		const editor = new RoutableEditor();
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		// terminalRows=1 forces the dock to truncate to a single row (the editor
		// tail survives only if it is the last row; with the editor first it is
		// cut away entirely).
		const view = new FullscreenChatView({
			transcript: [transcript],
			dock: [editorContainer],
			editorContainer: editorContainer,
			terminalRows: () => 1,
			editor: () => editor,
			write: () => {},
		});

		view.render(12);
		for (let row = 0; row < 3; row++) {
			view.handleViewportInput(`\x1b[<0;5;${row + 1}M`);
		}
		expect(editor.routed).toBe(0);
	});

	it("selects transcript lines on drag and pushes them via OSC 52 on release", () => {
		const transcript = new LinesComponent(["\x1b[1mmsg-one\x1b[0m", "msg-two", "msg-three", "msg-four"]);
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const writes: string[] = [];
		const view = new FullscreenChatView({
			transcript: [transcript],
			dock: [editorContainer],
			editorContainer: editorContainer,
			terminalRows: () => 6,
			editor: () => editor,
			write: data => writes.push(data),
		});

		// viewport = 6 - 1 dock row = 5 rows; content 4 lines fits, scrollOffset 0.
		view.render(12);
		// Press at the tail of row 0, drag to the head of row 2 (button 32 =
		// left drag), release: with character anchors this still covers the
		// three full lines.
		expect(view.handleViewportInput("\x1b[<0;1;1M")).toBe(true);
		// A single press plants a zero-width anchor: no highlight yet.
		expect(view.render(12)[0]).not.toContain("\x1b[7m");
		expect(view.handleViewportInput("\x1b[<32;10;3M")).toBe(true);
		const mid = view.render(12);
		expect(mid[0]).toContain("\x1b[7m"); // selection highlight on the first line
		expect(view.handleViewportInput("\x1b[<0;2;3m")).toBe(true);

		expect(writes.length).toBe(1);
		const osc = writes[0] ?? "";
		expect(osc.startsWith("\x1b]52;c;")).toBe(true);
		const b64 = osc.slice("\x1b]52;c;".length).replace(/\x07$/, "");
		const decoded = Buffer.from(b64, "base64").toString("utf8");
		// SGR stripped, trailing padding trimmed, three lines joined.
		expect(decoded).toBe("msg-one\nmsg-two\nmsg-three");

		// The highlight clears on release right after the copy fires.
		const after = view.render(12);
		expect(after[0]).not.toContain("\x1b[7m");
	});

	it("double-click selects a word and triple-click the whole line", () => {
		const transcript = new LinesComponent(["see /path/to/file now"]);
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const writes: string[] = [];
		const view = new FullscreenChatView({
			transcript: [transcript],
			dock: [editorContainer],
			editorContainer: editorContainer,
			terminalRows: () => 3,
			editor: () => editor,
			write: data => writes.push(data),
		});
		view.render(20);

		// Two presses on the same cell (col 7 lands inside "path"): the word
		// "/path/to/file" survives — / is a joiner, not a boundary.
		expect(view.handleViewportInput("\x1b[<0;7;1M")).toBe(true);
		expect(view.handleViewportInput("\x1b[<0;7;1M")).toBe(true);
		const word = view.render(20);
		expect(word[0]).toContain("\x1b[7m/path/to/file\x1b[27m");
		expect(view.handleViewportInput("\x1b[<0;7;1m")).toBe(true);
		expect(decodeOsc52(writes[0] ?? "")).toBe("/path/to/file");

		// A third press upgrades the selection to the entire line.
		writes.length = 0;
		expect(view.handleViewportInput("\x1b[<0;7;1M")).toBe(true);
		expect(view.handleViewportInput("\x1b[<0;7;1M")).toBe(true);
		expect(view.handleViewportInput("\x1b[<0;7;1M")).toBe(true);
		expect(view.handleViewportInput("\x1b[<0;7;1m")).toBe(true);
		expect(decodeOsc52(writes[0] ?? "")).toBe("see /path/to/file now");
	});

	it("copies a mid-line character range, not whole lines", () => {
		const transcript = new LinesComponent(["the quick brown fox", "jumps over"]);
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const writes: string[] = [];
		const view = new FullscreenChatView({
			transcript: [transcript],
			dock: [editorContainer],
			editorContainer: editorContainer,
			terminalRows: () => 4,
			editor: () => editor,
			write: data => writes.push(data),
		});
		view.render(20);

		// Press before "q" (SGR col 5 → 0-based 4), drag past "brown" (col 16).
		expect(view.handleViewportInput("\x1b[<0;5;1M")).toBe(true);
		expect(view.handleViewportInput("\x1b[<32;16;1M")).toBe(true);
		expect(view.handleViewportInput("\x1b[<0;6;1m")).toBe(true);
		expect(decodeOsc52(writes[0] ?? "")).toBe("quick brown");
	});

	it("shows a copy confirmation below the transcript after release", () => {
		const transcript = new LinesComponent(Array.from({ length: 6 }, (_, i) => `line ${i + 1}`));
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView({
			transcript: [transcript],
			dock: [editorContainer],
			editorContainer: editorContainer,
			terminalRows: () => 4,
			editor: () => editor,
			write: () => {},
		});
		view.render(80);
		expect(view.handleViewportInput("\x1b[<0;3;1M")).toBe(true);
		expect(view.handleViewportInput("\x1b[<32;3;2M")).toBe(true);
		expect(view.handleViewportInput("\x1b[<0;3;2m")).toBe(true);
		expect(view.render(80)[2]).toContain("Copied 2 lines");
	});

	it("auto-scrolls the viewport while a drag holds the top edge", () => {
		vi.useFakeTimers();
		const transcript = new LinesComponent(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`));
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView({
			transcript: [transcript],
			dock: [editorContainer],
			editorContainer,
			terminalRows: () => 4,
			editor: () => editor,
			write: () => {},
		});
		view.render(12);
		expect(view.handleViewportInput("\x1b[<0;3;3M")).toBe(true);
		// Drag to the top edge and hold: three 50ms ticks scroll six rows.
		expect(view.handleViewportInput("\x1b[<32;3;1M")).toBe(true);
		vi.advanceTimersByTime(150);
		const scrolled = view.render(12).map(line => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
		expect(scrolled[0]).toContain("line 22");
		// Release stops the scroll; a later tick cannot move it.
		expect(view.handleViewportInput("\x1b[<0;3;1m")).toBe(true);
		vi.advanceTimersByTime(120);
		expect(view.render(12)[0].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")).toContain("line 22");
		view.dispose();
		vi.useRealTimers();
	});

	it("does not start a selection from clicks on the editor rows", () => {
		const transcript = new LinesComponent(["message"]);
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const writes: string[] = [];
		const view = new FullscreenChatView({
			transcript: [transcript],
			dock: [editorContainer],
			editorContainer: editorContainer,
			terminalRows: () => 3,
			editor: () => editor,
			write: data => writes.push(data),
		});

		const rendered = view.render(12);
		const editorRow = rendered.findIndex(line => line.includes("editor"));
		expect(view.handleViewportInput(`\x1b[<0;2;${editorRow + 1}M`)).toBe(true);
		expect(view.handleViewportInput(`\x1b[<0;2;${editorRow + 1}m`)).toBe(true);
		expect(writes.length).toBe(0);
	});

	it("consumes mouse releases that do not end a scrollbar drag", () => {
		const transcript = new LinesComponent(["message"]);
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const view = new FullscreenChatView({
			transcript: [transcript],
			dock: [editorContainer],
			editorContainer: editorContainer,
			terminalRows: () => 6,
			editor: () => editor,
			write: () => {},
		});

		view.render(12);
		// A press away from the scrollbar is ignored by navigation but remains
		// consumed. Its matching release must not leak an SGR sequence to the editor.
		expect(view.handleViewportInput("\x1b[<0;1;1M")).toBe(true);
		expect(view.handleViewportInput("\x1b[<0;1;1m")).toBe(true);
	});
});

describe("fullscreen streaming and lifecycle regressions", () => {
	const views: FullscreenChatView[] = [];
	afterEach(() => {
		for (const view of views.splice(0)) view.dispose();
		vi.useRealTimers();
	});

	function setup(lines: string[] = ["alpha", "bravo", "charlie"], rows = 8) {
		const transcript = new GrowableComponent(lines);
		const editor = new LinesComponent(["editor"]);
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const writes: string[] = [];
		const requestRender = vi.fn();
		const view = new FullscreenChatView({
			transcript: [transcript],
			dock: [editorContainer],
			editorContainer,
			terminalRows: () => rows,
			editor: () => editor,
			write: data => writes.push(data),
			requestRender,
		});
		views.push(view);
		return { view, transcript, writes, requestRender };
	}

	it("copies the selected text, not the next row, after streaming appends", () => {
		const { view, transcript, writes } = setup();
		view.render(80);
		view.handleViewportInput("\x1b[<0;1;1M");
		view.handleViewportInput("\x1b[<32;4;1M");
		transcript.lines.push("delta");
		expect(view.render(80)[0]).toContain("\x1b[7malp\x1b[27m");
		view.handleViewportInput("\x1b[<0;4;1m");
		expect(decodeOsc52(writes[0] ?? "")).toBe("alp");
	});

	it("copies upward selections in reading order", () => {
		const { view, writes } = setup();
		view.render(80);
		view.handleViewportInput("\x1b[<0;4;2M");
		view.handleViewportInput("\x1b[<32;3;1M");
		view.handleViewportInput("\x1b[<0;3;1m");
		expect(decodeOsc52(writes[0] ?? "")).toBe("pha\nbra");
	});

	it("does not copy unrelated text when the selected layout is replaced or resized", () => {
		const { view, transcript, writes } = setup();
		view.render(80);
		view.handleViewportInput("\x1b[<0;1;1M");
		view.handleViewportInput("\x1b[<32;4;1M");
		transcript.lines.unshift("replacement");
		view.render(80);
		view.handleViewportInput("\x1b[<0;4;1m");
		expect(writes).toEqual([]);
		view.handleViewportInput("\x1b[<0;1;2M");
		view.handleViewportInput("\x1b[<32;4;2M");
		view.render(40);
		view.handleViewportInput("\x1b[<0;4;2m");
		expect(writes).toEqual([]);
	});

	it("keeps search and status rows within narrow terminal widths", () => {
		const { view } = setup(Array.from({ length: 20 }, () => "row"));
		view.render(12);
		view.handleViewportInput("\x06");
		view.handleViewportInput("查询emoji🙂".repeat(5));
		for (const width of [1, 12, 40]) {
			const rows = view.render(width);
			expect(visibleWidth(rows[0])).toBeLessThanOrEqual(width);
			expect(visibleWidth(rows[rows.length - 2])).toBeLessThanOrEqual(width);
		}
	});

	it("refreshes search hits as output streams and erases a whole grapheme", () => {
		const { view, transcript } = setup(["🙂 alpha"]);
		view.render(80);
		view.handleViewportInput("\x06");
		view.handleViewportInput("🙂");
		expect(view.render(80)[0]).toContain("1/1");
		transcript.lines.push("🙂 bravo");
		expect(view.render(80)[0]).toContain("1/2");
		view.handleViewportInput("\x7f");
		view.handleViewportInput("alpha");
		expect(view.render(80)[0]).toContain("1/1");
	});

	it("stops drag scrolling on disposal and cancels delayed copy feedback", () => {
		vi.useFakeTimers();
		const { view, requestRender } = setup(
			Array.from({ length: 30 }, (_, i) => `row ${i}`),
			4,
		);
		view.render(80);
		view.handleViewportInput("\x1b[<0;1;2M");
		view.handleViewportInput("\x1b[<32;4;2M");
		view.handleViewportInput("\x1b[<0;4;2m");
		view.handleViewportInput("\x1b[<0;2;2M");
		view.handleViewportInput("\x1b[<32;2;1M");
		vi.advanceTimersByTime(50);
		expect(requestRender).toHaveBeenCalled();
		view.dispose();
		requestRender.mockClear();
		vi.advanceTimersByTime(2000);
		expect(requestRender).not.toHaveBeenCalled();
	});
	it("reveals first and last search hits without covering them with chrome", () => {
		const lines = Array.from({ length: 20 }, (_, i) => (i === 0 || i === 19 ? `needle ${i}` : `row ${i}`));
		const { view } = setup(lines);
		view.render(80);
		view.handleViewportInput("\x06");
		view.handleViewportInput("needle");
		const last = view.render(80).map(stripVTControlCharacters);
		expect(last[0]).toContain("2/2");
		expect(last.slice(1)).toContainEqual(expect.stringContaining("needle 19"));
		view.handleViewportInput("\r");
		const first = view.render(80).map(stripVTControlCharacters);
		expect(first[0]).toContain("1/2");
		expect(first.slice(1)).toContainEqual(expect.stringContaining("needle 0"));
		expect(first).toHaveLength(8);
	});

	it("reserves search chrome even when only two rows remain above the editor", () => {
		const { view } = setup(["needle", "other"], 3);
		view.render(80);
		view.handleViewportInput("\x06");
		view.handleViewportInput("needle");
		const frame = view.render(80).map(stripVTControlCharacters);
		expect(frame).toHaveLength(3);
		expect(frame[0]).toContain("1/1");
		expect(frame[1]).toContain("needle");
		expect(frame[2]).toBe("editor");
	});

	it("does not select hidden transcript text when clicking the search bar", () => {
		const { view, writes } = setup();
		view.render(80);
		view.handleViewportInput("\x06");
		view.render(80);
		view.handleViewportInput("\x1b[<0;1;1M");
		view.handleViewportInput("\x1b[<32;5;1M");
		view.handleViewportInput("\x1b[<0;5;1m");
		expect(writes).toEqual([]);
		expect(view.render(80)[0]).toContain("find:");
	});

	it("keeps a selection when transcript rows exactly fill the available height", () => {
		const { view, writes } = setup(["alpha", "bravo", "charlie"], 4);
		view.render(80);
		view.handleViewportInput("\x1b[<0;1;1M");
		view.render(80);
		view.handleViewportInput("\x1b[<32;4;1M");
		view.render(80);
		view.handleViewportInput("\x1b[<0;4;1m");
		expect(decodeOsc52(writes[0] ?? "")).toBe("alp");
	});
});
