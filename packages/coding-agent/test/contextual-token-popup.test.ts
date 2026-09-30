import { afterEach, expect, it } from "bun:test";
import { KeybindingsManager as AppKeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { createPromptActionAutocompleteProvider } from "@oh-my-pi/pi-tui/prompt/prompt-action-autocomplete";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

let composer: Composer | undefined;
afterEach(() => composer?.stop());

const WIDTH = 120;

async function openComposer(options: {
	contextual: boolean;
	width?: number;
	style?: "compact" | "stacked";
	titles?: Record<string, string>;
}): Promise<{
	terminal: VirtualTerminal;
	editor: Composer["editor"];
	paint: () => Promise<void>;
}> {
	const terminal = new VirtualTerminal(options.width ?? WIDTH, 16);
	const active = new Composer({ preferences: { quiet: true }, terminal });
	composer = active;
	const transcript = new TranscriptContainer();
	const block = {
		render: () => Array.from({ length: 30 }, (_, i) => `CHAT_${i + 1}`),
		isTranscriptBlockFinalized: () => true,
	};
	transcript.addChild(block);
	active.setRuntimeChildren([transcript, active.editor]);
	active.editor.autocompleteSuggestionsPopup = true;
	active.editor.contextualTokenPopup = options.contextual;
	// Compact is the shipped default, so the anchoring tests exercise the width users actually get.
	active.editor.referenceCardStyle = options.style ?? "compact";
	if (options.titles) {
		const titles = options.titles;
		active.editor.referenceTitle = (kind, number) => titles[`${kind}:${number}`];
	}
	active.editor.onAutocompleteRender = (render, offset, rows, anchor) =>
		active.ui.setCursorOverlay(render, offset, rows, "auto", anchor);
	active.editor.setAutocompleteProvider(
		createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory({}),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		}),
	);
	active.editor.onAutocompleteUpdate = () => active.ui.requestRender();
	active.editor.onAutocompleteCancel = () => active.ui.requestRender();
	active.start();
	active.ui.setFocus(active.editor);
	const paint = async () => {
		// The composer settles on a real render timer; there is no event to await.
		await Bun.sleep(40);
		active.ui.requestRender();
		await terminal.waitForRender();
	};
	await paint();
	await paint();
	return { terminal, editor: active.editor, paint };
}

/** First viewport row containing `needle`, with the 0-based visible column where it starts. */
function locate(rows: readonly string[], needle: string): { row: number; col: number } | undefined {
	for (let row = 0; row < rows.length; row++) {
		const col = rows[row]!.indexOf(needle);
		if (col !== -1) return { row, col };
	}
	return undefined;
}

/** Last viewport row containing `needle`: the composer input sits below any popup that repeats the token. */
function locateLast(rows: readonly string[], needle: string): { row: number; col: number } | undefined {
	for (let row = rows.length - 1; row >= 0; row--) {
		const col = rows[row]!.lastIndexOf(needle);
		if (col !== -1) return { row, col };
	}
	return undefined;
}

/**
 * Width of the contextual card for a `#N` token: compact is frame, inset, both cursor cells and the divider around
 * both labels; stacked is the list's cursor cell and margin plus frame around the widest label. Hosts that supply
 * titles raise either to the width a wrapped title needs.
 */
function cardWidth(token: string, style: "compact" | "stacked" = "compact", hasTitles = false): number {
	const floor = style === "compact" ? 8 + `PR ${token} | Issue ${token}`.length : 6 + `Issue ${token}`.length;
	return hasTitles ? Math.max(46, floor) : floor;
}

it("starts the #N popup box exactly at the token column and leaves the chat text beside it", async () => {
	const { terminal, editor, paint } = await openComposer({ contextual: true });
	const lead = "please review the pull request ";
	editor.handleInput(lead);
	for (const ch of "#12") editor.handleInput(ch);
	await paint();

	const rows = terminal.getViewport().map(Bun.stripANSI);
	const input = locate(rows, `${lead}#12`);
	const label = locate(rows, "PR #12");
	expect(input).toBeDefined();
	expect(label).toBeDefined();
	const tokenCol = input!.col + lead.length;

	// The box's left border sits on the token's column, above the input row.
	const boxRow = rows[label!.row]!;
	expect(label!.row).toBeLessThan(input!.row);
	expect(boxRow.indexOf("│")).toBe(tokenCol);
	// The chat text on that row is preserved to the left of the box.
	expect(boxRow.slice(0, tokenCol)).toMatch(/^CHAT_\d+\s*$/);
	// The card is as wide as its content, not a full-width band and not a fixed width.
	expect(boxRow.trimEnd().length).toBe(tokenCol + cardWidth("#12"));
});

it("follows the token when it moves right instead of staying at a fixed column", async () => {
	const { terminal, editor, paint } = await openComposer({ contextual: true });
	editor.handleInput("see #3");
	await paint();
	const early = locate(terminal.getViewport().map(Bun.stripANSI), "PR #3");
	editor.setText("");
	editor.handleInput(`${"words ".repeat(8)}#3`);
	await paint();
	const late = locate(terminal.getViewport().map(Bun.stripANSI), "PR #3");

	expect(early).toBeDefined();
	expect(late).toBeDefined();
	// The anchor is derived from the typed token position, so a later token yields a later box.
	expect(late!.col).toBeGreaterThan(early!.col);
});

it("pulls the box left of a token near the right edge so the whole card stays on screen", async () => {
	const { terminal, editor, paint } = await openComposer({ contextual: true });
	editor.handleInput(`${"x".repeat(WIDTH - 12)} #7`);
	await paint();

	const rows = terminal.getViewport().map(Bun.stripANSI);
	const input = locateLast(rows, "#7");
	const label = locate(rows, "PR #7");
	expect(input).toBeDefined();
	expect(label).toBeDefined();
	const boxRow = rows[label!.row]!;
	expect(label!.row).toBeLessThan(input!.row);
	// Clamped to the last column that still fits the card: its right border is the terminal's last cell.
	expect(boxRow.indexOf("│")).toBe(WIDTH - cardWidth("#7"));
	expect(boxRow.trimEnd().length).toBe(WIDTH);
});

it("anchors to the token's own column when the text wrapped onto a second row", async () => {
	const { terminal, editor, paint } = await openComposer({ contextual: true });
	// Enough words to fill the first row so the sentence wraps; the short tail puts `#12` early on the
	// wrapped row, left of the column where the right-edge clamp would take over.
	const words = Array.from({ length: 22 }, (_, i) => `word${i}`).join(" ");
	editor.handleInput(`${words} see #12`);
	await paint();

	const rows = terminal.getViewport().map(Bun.stripANSI);
	const input = locateLast(rows, "#12");
	const label = locate(rows, "PR #12");
	expect(input).toBeDefined();
	expect(label).toBeDefined();
	// The token really is on a wrapped row, not on the row the sentence began on.
	const firstRow = locate(rows, "word0");
	expect(firstRow).toBeDefined();
	expect(input!.row).toBeGreaterThan(firstRow!.row);
	// The box opens above the input at the wrapped token's own column, not at the column-0 fallback.
	expect(label!.row).toBeLessThan(input!.row);
	expect(rows[label!.row]!.indexOf("│")).toBe(input!.col);
});

it("keeps the full-width popup band when contextual anchoring is off", async () => {
	const { terminal, editor, paint } = await openComposer({ contextual: false });
	editor.handleInput("see ");
	for (const ch of "#12") editor.handleInput(ch);
	await paint();

	const rows = terminal.getViewport().map(Bun.stripANSI);
	const label = locate(rows, "PR #12");
	expect(label).toBeDefined();
	// Off: the popup stays the band of the popup PR, its box starting at column 0 and spanning the terminal.
	const boxRow = rows[label!.row]!;
	expect(boxRow.indexOf("│")).toBe(0);
	expect(boxRow.trimEnd().length).toBe(WIDTH);
});

it("keeps short references at one fixed width and only grows the card for a long number", async () => {
	const widthOf = async (typed: string, token: string, style: "compact" | "stacked"): Promise<number> => {
		const { terminal, editor, paint } = await openComposer({ contextual: true, style });
		editor.handleInput(typed);
		await paint();
		const rows = terminal.getViewport().map(Bun.stripANSI);
		const label = locate(rows, `PR ${token}`);
		expect(label).toBeDefined();
		const boxRow = rows[label!.row]!;
		return boxRow.trimEnd().length - boxRow.indexOf("│");
	};
	for (const style of ["stacked", "compact"] as const) {
		const one = await widthOf("see #1", "#1", style);
		const twelve = await widthOf("see #12", "#12", style);
		const long = await widthOf("see #12345678901234567890", "#12345678901234567890", style);

		// Without a title source the card is sized by its content: no wide padding for hosts that cannot show titles.
		expect(one).toBe(cardWidth("#1", style));
		expect(long).toBe(cardWidth("#12345678901234567890", style));
		expect(long).toBeGreaterThan(twelve);
		expect(twelve).toBeGreaterThan(one);
	}
});

/** Rows of the viewport that still show a #12 suggestion. */
function suggestionRows(terminal: VirtualTerminal): string[] {
	return terminal
		.getViewport()
		.map(Bun.stripANSI)
		.filter(row => row.includes("PR #12") || row.includes("Issue #12"));
}

it("dismisses the #N suggestions when the draft is cleared, as Ctrl+C does", async () => {
	const { terminal, editor, paint } = await openComposer({ contextual: true });
	editor.handleInput("see ");
	for (const ch of "#12") editor.handleInput(ch);
	await paint();
	expect(suggestionRows(terminal).length).toBeGreaterThan(0);

	editor.clearDraft();
	await paint();

	// The buffer is empty, so no suggestion may survive on screen or in the editor's state.
	expect(editor.getText()).toBe("");
	expect(editor.isAutocompleteActive()).toBe(false);
	expect(suggestionRows(terminal)).toEqual([]);
});

it("dismisses the #N list below the editor when the draft is cleared with the popup setting off", async () => {
	const { terminal, editor, paint } = await openComposer({ contextual: false });
	editor.handleInput("see ");
	for (const ch of "#12") editor.handleInput(ch);
	await paint();
	expect(suggestionRows(terminal).length).toBeGreaterThan(0);

	editor.setText("");
	await paint();

	expect(editor.isAutocompleteActive()).toBe(false);
	expect(suggestionRows(terminal)).toEqual([]);
});

/** Viewport rows from the card's top border to its bottom border, ANSI stripped. */
function cardRows(terminal: VirtualTerminal): string[] {
	const rows = terminal.getViewport().map(Bun.stripANSI);
	const top = rows.findIndex(row => row.includes("╭") && row.includes("GITHUB"));
	expect(top).toBeGreaterThanOrEqual(0);
	const start = rows[top]!.indexOf("╭");
	const bottom = rows.findIndex((row, i) => i > top && row.includes("╰"));
	expect(bottom).toBeGreaterThan(top);
	return rows.slice(top, bottom + 1).map(row => row.slice(start).trimEnd());
}

const TITLES = {
	"pr:12": "Fix the resize replay when the popup covers the input",
	"issue:12": "Popup covers the input",
};

it("stacks PR and Issue on separate rows with the wrapped title of the selection beneath, under a GITHUB heading", async () => {
	const { terminal, editor, paint } = await openComposer({ contextual: true, style: "stacked", titles: TITLES });
	editor.handleInput("see #12");
	await paint();

	const card = cardRows(terminal);
	expect(card[0]).toMatch(/^╭─+ GITHUB ─+╮$/);
	// Drawing: the list's cursor sits flush at the frame, the unselected row is indented under it.
	expect(card[1]).toMatch(/^│❯ PR #12 *│$/);
	expect(card[2]).toMatch(/^│ {2}Issue #12 *│$/);
	// The 53-character PR title does not fit one row at the card width, so it wraps beneath the options.
	const title = card.slice(3, -1).map(row => row.slice(1, -1));
	expect(title[0]).toMatch(/^ {2}>Fix the resize/);
	expect(title.length).toBeGreaterThanOrEqual(2);
	expect(title.join(" ")).toContain("input");

	editor.handleInput("\x1b[B");
	await paint();
	const after = cardRows(terminal);
	expect(after[2]).toMatch(/^│❯ Issue #12 *│$/);
	expect(after.join("\n")).toContain(">Popup covers the input");
	expect(after.join("\n")).not.toContain("Fix the resize");
});

it("puts both options on one row in the compact layout and moves the selection with Up/Down", async () => {
	const { terminal, editor, paint } = await openComposer({ contextual: true, style: "compact", titles: TITLES });
	editor.handleInput("see #12");
	await paint();

	const card = cardRows(terminal);
	expect(card[0]).toMatch(/^╭─+ GITHUB ─+╮$/);
	// Drawing: `│  ❯ PR #12 |   Issue #12`, then `│  >title`, both two cells in from the frame.
	expect(card[1]).toMatch(/^│ {2}❯ PR #12 \| {3}Issue #12 *│$/);
	expect(card[2]).toMatch(/^│ {2}>Fix the resize/);

	editor.handleInput("\x1b[B");
	await paint();
	const after = cardRows(terminal);
	expect(after[1]).toMatch(/^│ {4}PR #12 \| ❯ Issue #12 *│$/);
	expect(after.join("\n")).toContain(">Popup covers the input");
	expect(after.join("\n")).not.toContain("Fix the resize");

	// Sized by content alone, without a title source, the row must still show both options in full.
	composer?.stop();
	const bare = await openComposer({ contextual: true, style: "compact" });
	bare.editor.handleInput("see #12");
	await bare.paint();
	expect(cardRows(bare.terminal)[1]).toMatch(/^│ {2}❯ PR #12 \| {3}Issue #12│$/);
});

it("shows only the options when no title is cached and keeps the same card width when one appears", async () => {
	const titled = await openComposer({ contextual: true, style: "compact", titles: TITLES });
	titled.editor.handleInput("see #12");
	await titled.paint();
	// Read from this terminal now: the next openComposer replaces the active composer.
	const withTitle = cardRows(titled.terminal);

	composer?.stop();
	const cold = await openComposer({ contextual: true, style: "compact", titles: {} });
	cold.editor.handleInput("see #12");
	await cold.paint();
	const withoutTitle = cardRows(cold.terminal);

	expect(withoutTitle.join("\n")).not.toContain(">");
	expect(withoutTitle[0]!.length).toBe(withTitle[0]!.length);
});

const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";

it("moves between PR and Issue with Left/Right in the compact card, without wrapping or accepting", async () => {
	const { terminal, editor, paint } = await openComposer({ contextual: true, style: "compact", titles: TITLES });
	editor.handleInput("see #12");
	await paint();
	expect(cardRows(terminal)[1]).toMatch(/^│ {2}❯ PR #12 /);

	editor.handleInput(RIGHT);
	await paint();
	let card = cardRows(terminal);
	expect(card[1]).toMatch(/^│ {4}PR #12 \| ❯ Issue #12 *│$/);
	expect(card.join("\n")).toContain(">Popup covers the input");

	// Right on the last option neither wraps nor accepts: the draft stays exactly as typed.
	editor.handleInput(RIGHT);
	await paint();
	expect(cardRows(terminal)[1]).toMatch(/❯ Issue #12/);
	expect(editor.getText()).toBe("see #12");

	editor.handleInput(LEFT);
	await paint();
	card = cardRows(terminal);
	expect(card[1]).toMatch(/^│ {2}❯ PR #12 /);
	expect(card.join("\n")).toContain(">Fix the resize");

	editor.handleInput(LEFT);
	await paint();
	expect(cardRows(terminal)[1]).toMatch(/^│ {2}❯ PR #12 /);
	expect(editor.getText()).toBe("see #12");
});

it("still accepts the option chosen with Left/Right by Tab in the compact card", async () => {
	const { editor, paint } = await openComposer({ contextual: true, style: "compact", titles: TITLES });
	editor.handleInput("see #12");
	await paint();
	editor.handleInput(RIGHT);
	await paint();
	editor.handleInput("\t");
	await paint();

	// Tab inserts the reference for the highlighted option, so the typed token is replaced by the issue URL form.
	expect(editor.getText()).not.toBe("see #12");
	expect(editor.getText()).toContain("issue");
});

it("keeps Right as accept in the stacked card, where the options are vertical", async () => {
	const { editor, paint } = await openComposer({ contextual: true, style: "stacked", titles: TITLES });
	editor.handleInput("see #12");
	await paint();
	editor.handleInput(RIGHT);
	await paint();

	expect(editor.getText()).not.toBe("see #12");
});

for (const style of ["compact", "stacked"] as const) {
	it(`keeps every ${style} option in step with the typed number in the frame drawn before the list refreshes`, async () => {
		const { terminal, editor, paint } = await openComposer({ contextual: true, style, titles: TITLES });
		editor.handleInput("see #1234");
		await paint();
		expect(cardRows(terminal).join("\n")).toContain("PR #1234");

		// The suggestion list is rebuilt ~100ms after a key, so a frame drawn sooner still holds the previous number's
		// items. Draw exactly such a frame (the key is processed, the refresh has not run): every option must already
		// show the number now in the text. Waiting for the render alone returns the frame from before the key.
		editor.handleInput("\x7f");
		await Bun.sleep(10);
		composer!.ui.requestRender();
		await terminal.waitForRender();
		await terminal.waitForRender();
		const card = cardRows(terminal).join("\n");
		expect(card).toMatch(/PR #123(?!\d)/);
		expect(card).toMatch(/Issue #123(?!\d)/);
		expect(card).not.toContain("#1234");
	});
}
