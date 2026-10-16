import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { EditorTopGap } from "@oh-my-pi/pi-tui/prompt/editor-top-gap";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type Component, Container, getKeybindings, setKeybindings, Text } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

const ROWS = 40;
const COLUMNS = 100;
const TRANSCRIPT_ROWS = 60;
const TRANSCRIPT_PREFIX = "Settled transcript row ";

/** A settled assistant turn carrying one text block, typed so schema drift fails at compile time. */
function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
}

/** Below-transcript chrome that inflates on demand, mimicking a confirmation dialog or a tall multi-line editor swapped in above the input. */
class InlineWidget implements Component {
	rows = 0;
	render(): readonly string[] {
		return Array.from({ length: this.rows }, (_, i) => `Live widget row ${i}`);
	}
}

interface Harness {
	terminal: VirtualTerminal;
	scheduler: VirtualRenderScheduler;
	composer: Composer;
	transcript: TranscriptContainer;
	widget: InlineWidget;
	/** Turn-scoped chrome between transcript and editor (loader, todo/subagent HUDs). */
	hud: InlineWidget;
	editor: Container;
}

function makeHarness(
	columns = COLUMNS,
	rows = ROWS,
	transcriptRows = TRANSCRIPT_ROWS,
	shellHistory: readonly string[] = [],
): Harness {
	const terminal = new VirtualTerminal(columns, rows);
	if (shellHistory.length > 0) terminal.write(`${shellHistory.join("\r\n")}${"\r\n".repeat(rows + 1)}`);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const transcript = new TranscriptContainer();
	for (let i = 0; i < transcriptRows; i++) {
		const row = i;
		transcript.addChild({ render: () => [`${TRANSCRIPT_PREFIX}${row}`] });
	}
	const hud = new InlineWidget();
	const editor = new Container();
	const widget = new InlineWidget();
	editor.addChild(widget);
	editor.addChild(new Text("EDITOR", 0, 0));
	composer.setRuntimeChildren([transcript, hud, editor], { transientChrome: [editor] });
	composer.start({ playWelcomeIntro: false });
	return { terminal, scheduler, composer, transcript, widget, hud, editor };
}

/** Settle, grow the inline chrome, settle, shrink it back, settle. */
async function cycleWidget(h: Harness): Promise<void> {
	await h.scheduler.settle(h.terminal);
	h.widget.rows = 24;
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
	h.widget.rows = 0;
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
}

/**
 * Longest run of blank rows above the row containing `bottom`. Transcript
 * blocks are separated by one blank row, so a longer run is a band of rows no
 * frame can fill.
 */
function blankBand(terminal: VirtualTerminal, bottom = "EDITOR"): number {
	const view = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
	let run = 0;
	let longest = 0;
	for (const row of view.slice(
		0,
		view.findIndex(line => line.includes(bottom)),
	)) {
		run = row === "" ? run + 1 : 0;
		longest = Math.max(longest, run);
	}
	return longest;
}

/** Stream a 110-paragraph answer one paragraph per frame, then finalize it. */
async function streamFinalizedAnswer(h: Harness): Promise<void> {
	const message = new AssistantMessageComponent();
	h.transcript.addChild(message);
	const reply = (text: string): AssistantMessage => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	});
	const lines = Array.from({ length: 110 }, (_, i) => `line${i}`);
	for (let n = 1; n <= lines.length; n++) {
		message.updateContent(reply(lines.slice(0, n).join("\n\n")), { transient: true });
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
	}
	message.updateContent(reply(lines.join("\n\n")));
	message.markTranscriptBlockFinalized();
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
}

beforeAll(async () => {
	await initTheme();
});

describe("composer inline shrink (#11007)", () => {
	it("answers an ask at the reported 54x112 geometry without losing, duplicating or stranding rows", async () => {
		const h = makeHarness(112, 54);
		await h.scheduler.settle(h.terminal);
		let submitted = false;
		const dialog = new AskDialogComponent(
			[
				{
					id: "approve",
					question: "Approve this section and the complete design for writing the spec?",
					options: [{ label: "Approve" }, { label: "Revise" }],
				},
			],
			{
				onSubmit: () => {
					submitted = true;
					h.editor.clear();
					h.editor.addChild(new Text("EDITOR", 0, 0));
					h.composer.ui.requestRender();
				},
				onCancel: () => {},
				onPrompt: () => Promise.resolve(undefined),
			},
		);
		h.editor.clear();
		h.editor.addChild(dialog);
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const visibleRows = (): number[] =>
			h.terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
				.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		dialog.handleInput("\r");
		await h.scheduler.settle(h.terminal);
		expect(submitted).toBe(true);
		expect(visibleRows()).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(53);
		expect(blankBand(h.terminal)).toBeLessThanOrEqual(1);
		dialog.dispose();
		h.composer.stop();
	});

	it("leaves a short transcript top-anchored after an inline panel closes", async () => {
		const h = makeHarness(COLUMNS, ROWS, 3);
		await h.scheduler.settle(h.terminal);
		h.widget.rows = 6;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const row = (needle: string): number =>
			h.terminal.getViewport().findIndex(line => Bun.stripANSI(line).trimEnd().startsWith(needle));
		expect(row(`${TRANSCRIPT_PREFIX}0`)).toBe(0);
		h.widget.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(row(`${TRANSCRIPT_PREFIX}0`)).toBe(0);
		expect(row("EDITOR")).toBeLessThan(ROWS - 1);
		h.composer.stop();
	});

	it("lets a reset to an empty transcript shrink in place instead of pinning to the bottom", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);
		// A new session: scrollback is cleared and nothing replays into it.
		h.composer.setRuntimeChildren([new TranscriptContainer(), h.hud, h.editor]);
		h.composer.ui.resetDisplay();
		await h.scheduler.settle(h.terminal);
		h.widget.rows = ROWS + 5;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		h.widget.rows = 3;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(3);
		h.composer.stop();
	});

	it("refills the screen after an ask closes below a response taller than the screen", async () => {
		const terminal = new VirtualTerminal(COLUMNS, ROWS);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		// The response straddles the top edge: only its rows above the screen
		// may reach scrollback, or the panel would push on-screen history out
		// of reach and leave a band behind when it closes.
		transcript.addChild({ render: () => Array.from({ length: 80 }, (_, i) => `${TRANSCRIPT_PREFIX}${i}`) });
		transcript.addChild({ render: () => Array.from({ length: 11 }, (_, i) => `Tool row ${i}`) });
		const editor = new Container();
		editor.addChild(new Text("EDITOR", 0, 0));
		composer.setRuntimeChildren([transcript, editor]);
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);
		const dialog = new AskDialogComponent(
			[{ id: "q", question: "Is it good?", options: [{ label: "Yes" }, { label: "No" }] }],
			{
				onSubmit: () => {
					editor.clear();
					editor.addChild(new Text("EDITOR", 0, 0));
					composer.ui.requestRender();
				},
				onCancel: () => {},
				onPrompt: () => Promise.resolve(undefined),
			},
		);
		editor.clear();
		editor.addChild(dialog);
		composer.ui.requestRender();
		await scheduler.settle(terminal);
		dialog.handleInput("\r");
		await scheduler.settle(terminal);
		expect(terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		expect(blankBand(terminal)).toBeLessThanOrEqual(1);
		const indices = terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(indices).toEqual(Array.from({ length: 80 }, (_, i) => i));
		dialog.dispose();
		composer.stop();
	});

	it("brings rows an ask panel covered back on screen when the ask is hidden", async () => {
		// The default app bindings (Alt+H hides a pending ask).
		const previous = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory());
		try {
			const h = makeHarness();
			await h.scheduler.settle(h.terminal);
			const dialog = new AskDialogComponent(
				[
					{
						id: "q",
						question: "Is it good?",
						options: ["A", "B", "C", "D"].map(label => ({ label, description: `${label} described` })),
					},
				],
				{ onSubmit: () => {}, onCancel: () => {}, onPrompt: () => Promise.resolve(undefined) },
				{ tui: h.composer.ui },
			);
			h.editor.clear();
			h.editor.addChild(dialog);
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			const reachable = (): number[] =>
				h.terminal
					.getScrollBuffer()
					.map(row => Bun.stripANSI(row).trimEnd())
					.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
					.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
			// Alt+H collapses the pending ask to one line: the rows it covered are
			// still live, so they refill the screen instead of leaving a band.
			dialog.handleInput("\x1bh");
			await h.scheduler.settle(h.terminal);
			const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			expect(view[ROWS - 1]).toContain("Ask hidden");
			expect(blankBand(h.terminal, "Ask hidden")).toBeLessThanOrEqual(1);
			expect(reachable()).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
			// Showing it again covers them without writing anything twice.
			dialog.handleInput("\x1bh");
			await h.scheduler.settle(h.terminal);
			const shown = reachable();
			expect(new Set(shown).size).toBe(shown.length);
			dialog.dispose();
			h.composer.stop();
		} finally {
			setKeybindings(previous);
		}
	});

	it("keeps the editor pinned to the bottom after transient below-transcript chrome shrinks", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);
		const before = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(before.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);

		await cycleWidget(h);

		const after = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		// Regression: the editor used to strand ~24 blank rows below it after the
		// shrink because retired transcript rows never returned to the live tail.
		expect(after.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		const lastContent = after.reduce((last, row, i) => (row.length > 0 ? i : last), -1);
		expect(lastContent).toBe(ROWS - 1);

		h.composer.stop();
	});

	it("retires transcript rows contiguously with no duplication or gaps across the grow/shrink cycle", async () => {
		const h = makeHarness();
		await cycleWidget(h);

		// Every transcript row appears exactly once (native scrollback + live grid),
		// in order — the shrink must not drop rows into a gap or duplicate them.
		const indices = h.terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(indices).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));

		h.composer.stop();
	});

	it("keeps the below-chrome baseline across a height resize while inline chrome is expanded", async () => {
		const shorter = ROWS - 10;
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);

		// Expand, resize the terminal height *while still expanded*, then keep
		// rendering before shrinking. The retirement baseline must not adopt the
		// expanded peak at the resize, or the frames before the shrink retire
		// rows the shrink cannot reclaim and the editor is stranded again.
		h.widget.rows = 24;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		h.terminal.resize(COLUMNS, shorter);
		await h.scheduler.advance(h.terminal, 300);
		for (let frame = 0; frame < 5; frame++) {
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
		}
		h.widget.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const after = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(after.findIndex(row => row.includes("EDITOR"))).toBe(shorter - 1);
		const lastContent = after.reduce((last, row, i) => (row.length > 0 ? i : last), -1);
		expect(lastContent).toBe(shorter - 1);

		h.composer.stop();
	});

	it("clips the live tail from the top instead of compacting it when the chrome grows a few rows", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);

		// A persistent few-row growth (multi-line prompt, todo HUD, subagent badge)
		// lifts the chrome above the retirement baseline. The tail must scroll
		// off the top like native history would — not collapse into the
		// one-row-per-block emergency layout that drops every inter-block blank
		// and strands the freed rows below the editor.
		h.widget.rows = 3;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		const editorRow = view.findIndex(row => row.includes("EDITOR"));
		expect(editorRow).toBe(ROWS - 1);
		const transcriptRows = view.slice(0, editorRow - 3);
		const separators = transcriptRows.filter(
			(row, i) => row === "" && transcriptRows[i - 1]?.startsWith(TRANSCRIPT_PREFIX),
		);
		expect(separators.length).toBeGreaterThan(0);
		expect(transcriptRows.at(-1)).toBe(`${TRANSCRIPT_PREFIX}${TRANSCRIPT_ROWS - 1}`);

		h.composer.stop();
	});

	it("refills the screen with live rows when turn-scoped chrome goes away", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);
		h.hud.rows = 6;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		// The turn ends: the todo/loader HUD closes. The rows it pushed aside
		// stayed live, so they return instead of leaving a band.
		h.hud.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		expect(blankBand(h.terminal)).toBeLessThanOrEqual(1);
		const indices = h.terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(indices).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		h.composer.stop();
	});

	it("leaves no band inside a streamed answer when the working loader goes away", async () => {
		const h = makeHarness(COLUMNS, 30);
		await h.scheduler.settle(h.terminal);
		const message = new AssistantMessageComponent();
		h.transcript.addChild(message);
		h.hud.rows = 2; // the working loader, up for the whole turn
		let text = "";
		for (let p = 0; p < 12; p++) {
			const words = Array.from({ length: 25 + (p % 4) * 10 }, (_, w) => `p${p}w${w}`).join(" ");
			for (const chunk of [words.slice(0, words.length / 2), words]) {
				message.updateContent(reply(`${text}${chunk}`), { transient: true });
				h.composer.ui.requestRender();
				await h.scheduler.settle(h.terminal);
			}
			text += `${words}\n\n`;
		}
		message.updateContent(reply(text.trim()));
		message.markTranscriptBlockFinalized();
		h.hud.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		// Streaming committed only rows that had left the screen, so the rows the
		// loader covered refill from the live tail instead of a blank band.
		expect(blankBand(h.terminal)).toBeLessThanOrEqual(1);
		const words = h.terminal
			.getScrollBuffer()
			.join(" ")
			.split(/\s+/)
			.map(word => Bun.stripANSI(word))
			.filter(word => /^p\d+w\d+$/.test(word));
		expect(new Set(words).size).toBe(words.length);
		expect(words.length).toBe(text.split(/\s+/).filter(Boolean).length);
		h.composer.stop();
	});

	it("refills the screen when a tall HUD closes a frame after the answer finalizes", async () => {
		const rows = 30;
		const h = makeHarness(COLUMNS, rows, 0);
		await h.scheduler.settle(h.terminal);
		h.hud.rows = 23;
		await streamFinalizedAnswer(h);
		// The HUD outlives the finalizing paint by a frame, as a loader does when
		// the turn-end event trails the message-end event.
		h.hud.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.advance(h.terminal, 300);
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(rows - 1);
		expect(blankBand(h.terminal)).toBeLessThanOrEqual(1);
		h.composer.stop();
	});

	it("keeps turn-scoped chrome out of the floor across a mid-run gap with no streaming block", async () => {
		const rows = 30;
		const h = makeHarness(COLUMNS, rows, 0);
		await h.scheduler.settle(h.terminal);
		h.composer.setRunActive(true);
		h.hud.rows = 23;
		await streamFinalizedAnswer(h);
		// A tool runs between assistant blocks for longer than the settle window.
		await h.scheduler.advance(h.terminal, 300);
		h.hud.rows = 0;
		h.composer.setRunActive(false);
		await h.scheduler.advance(h.terminal, 300);
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(rows - 1);
		expect(blankBand(h.terminal)).toBeLessThanOrEqual(1);
		h.composer.stop();
	});

	it("keeps a draft left open after the run out of the floor", async () => {
		const rows = 30;
		const h = makeHarness(COLUMNS, rows, 0);
		h.composer.setRuntimeChildren([h.transcript, h.hud, h.editor], { transientChrome: [h.editor] });
		await h.scheduler.settle(h.terminal);
		h.widget.rows = 15;
		await streamFinalizedAnswer(h);
		await h.scheduler.advance(h.terminal, 300);
		// Submitting or clearing the draft collapses the editor surface.
		h.widget.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(rows - 1);
		expect(blankBand(h.terminal)).toBeLessThanOrEqual(1);
		h.composer.stop();
	});

	for (const placement of ["above", "below"] as const) {
		it(`clears a settled extension widget ${placement} the editor without a seam band or erasing shell history`, async () => {
			const rows = 30;
			const shell = Array.from({ length: 12 }, (_, i) => `shell${i}`);
			const h = makeHarness(COLUMNS, rows, 0, shell);
			const above = new Container();
			above.addChild(new EditorTopGap(() => false));
			const below = new Container();
			const widget = new InlineWidget();
			const root = placement === "above" ? above : below;
			root.addChild(widget);
			h.composer.setRuntimeChildren([h.transcript, above, h.editor, below]);
			await h.scheduler.settle(h.terminal);
			h.composer.setRunActive(true);
			widget.rows = 7;
			await streamFinalizedAnswer(h);
			h.composer.setRunActive(false);
			await h.scheduler.advance(h.terminal, 300);
			const history = (): string[] =>
				h.terminal
					.getScrollBuffer()
					.map(row => Bun.stripANSI(row).trim())
					.filter(row => /^(shell|line|next)\d+$/.test(row));
			const expected = [...shell, ...Array.from({ length: 110 }, (_, i) => `line${i}`)];
			expect(history()).toEqual(expected);
			expect(
				h.terminal
					.getViewport()
					.map(row => Bun.stripANSI(row).trim())
					.filter(row => row.startsWith("Live widget row ")),
			).toEqual(Array.from({ length: 7 }, (_, i) => `Live widget row ${i}`));

			root.removeChild(widget);
			h.composer.ui.requestRender();
			await h.scheduler.advance(h.terminal, 300);
			const editorRow = h.terminal.getViewport().findIndex(row => row.includes("EDITOR"));
			expect(editorRow).toBeLessThan(rows - 1);
			expect(editorRow).toBeGreaterThanOrEqual(0);
			expect(blankBand(h.terminal)).toBeLessThanOrEqual(2);
			expect(history()).toEqual(expected);
			for (let frame = 0; frame < 3; frame++) {
				h.composer.ui.requestRender();
				await h.scheduler.advance(h.terminal, 300);
				expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(editorRow);
				expect(blankBand(h.terminal)).toBeLessThanOrEqual(2);
				expect(history()).toEqual(expected);
			}

			// New output naturally fills the freed rows and restores bottom alignment.
			const next = Array.from({ length: 40 }, (_, i) => `next${i}`);
			h.composer.setRunActive(true);
			for (const row of next) h.transcript.addChild({ render: () => [row] });
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			h.composer.setRunActive(false);
			await h.scheduler.advance(h.terminal, 300);
			expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(rows - 1);
			expect(blankBand(h.terminal)).toBeLessThanOrEqual(2);
			expect(history()).toEqual([...expected, ...next]);
			h.composer.stop();
		});

		for (const timing of ["before settlement", "after settlement"] as const) {
			it(`preserves every transcript and shell row when an extension widget ${placement} the editor appears ${timing}`, async () => {
				const rows = 30;
				const shell = Array.from({ length: 12 }, (_, i) => `shell${i}`);
				const h = makeHarness(COLUMNS, rows, 0, shell);
				const persistent = new InlineWidget();
				const above = new Container();
				above.addChild(new EditorTopGap(() => false));
				const below = new Container();
				const root = placement === "above" ? above : below;
				h.composer.setRuntimeChildren([h.transcript, persistent, above, h.editor, below], {
					transientChrome: [h.editor],
				});
				try {
					await h.scheduler.settle(h.terminal);
					h.composer.setRunActive(true);
					persistent.rows = 3;
					await streamFinalizedAnswer(h);
					h.composer.setRunActive(false);
					await h.scheduler.settle(h.terminal);
					if (timing === "after settlement") await h.scheduler.advance(h.terminal, 300);

					// Extension agent_end work can install chrome after the final busy
					// paint, including after the first idle height has already settled.
					const widget = new InlineWidget();
					widget.rows = 7;
					root.addChild(widget);
					h.composer.ui.requestRender();
					await h.scheduler.advance(h.terminal, 300);
					const history = (): string[] =>
						h.terminal
							.getScrollBuffer()
							.map(row => Bun.stripANSI(row).trim())
							.filter(row => /^(shell|line)\d+$/.test(row));
					const expected = [...shell, ...Array.from({ length: 110 }, (_, i) => `line${i}`)];
					expect(history()).toEqual(expected);
					expect(
						h.terminal
							.getViewport()
							.map(row => Bun.stripANSI(row).trim())
							.filter(row => row.startsWith("Live widget row ")),
					).toEqual([
						...Array.from({ length: 3 }, (_, i) => `Live widget row ${i}`),
						...Array.from({ length: 7 }, (_, i) => `Live widget row ${i}`),
					]);

					root.removeChild(widget);
					h.composer.ui.requestRender();
					await h.scheduler.advance(h.terminal, 300);
					const editorRow = h.terminal.getViewport().findIndex(row => row.includes("EDITOR"));
					expect(editorRow).toBeGreaterThanOrEqual(0);
					expect(editorRow).toBeLessThan(rows - 1);
					expect(blankBand(h.terminal)).toBeLessThanOrEqual(2);
					expect(history()).toEqual(expected);
					h.composer.ui.requestRender();
					await h.scheduler.advance(h.terminal, 300);
					expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(editorRow);
					expect(history()).toEqual(expected);
				} finally {
					h.composer.stop();
				}
			});
		}
	}

	it("contracts a promoted persistent widget floor even while a tall transient draft masks the removal", async () => {
		const rows = 30;
		const shell = Array.from({ length: 12 }, (_, i) => `shell${i}`);
		const h = makeHarness(COLUMNS, rows, 0, shell);
		const persistent = new InlineWidget();
		h.composer.setRuntimeChildren([h.transcript, persistent, h.editor], { transientChrome: [h.editor] });
		try {
			await h.scheduler.settle(h.terminal);
			h.composer.setRunActive(true);
			persistent.rows = 7;
			await streamFinalizedAnswer(h);
			h.composer.setRunActive(false);
			await h.scheduler.advance(h.terminal, 300);
			const history = (): string[] =>
				h.terminal
					.getScrollBuffer()
					.map(row => Bun.stripANSI(row).trim())
					.filter(row => /^(shell|line|next)\d+$/.test(row));
			const widgetRows = (): number =>
				h.terminal.getViewport().filter(row => Bun.stripANSI(row).trim().startsWith("Live widget row ")).length;
			const expected = [...shell, ...Array.from({ length: 110 }, (_, i) => `line${i}`)];
			// The persistent widget settled and was promoted into the retirement floor.
			expect(history()).toEqual(expected);
			expect(widgetRows()).toBe(7);

			// A tall multi-line draft expands the transient editor by 15 rows.
			h.widget.rows = 15;
			h.composer.ui.requestRender();
			await h.scheduler.advance(h.terminal, 300);
			expect(widgetRows()).toBe(22);

			// The persistent widget disappears while the draft stays expanded: the
			// total painted chrome is still taller than the old floor, so only the
			// transient-adjusted height reveals the contraction.
			persistent.rows = 0;
			h.composer.ui.requestRender();
			await h.scheduler.advance(h.terminal, 300);
			expect(widgetRows()).toBe(15);

			// Output finalized now must retire against the contracted floor, not the
			// stale 7-row one.
			const next = Array.from({ length: 40 }, (_, i) => `next${i}`);
			h.composer.setRunActive(true);
			for (const row of next) h.transcript.addChild({ render: () => [row] });
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			h.composer.setRunActive(false);
			await h.scheduler.advance(h.terminal, 300);
			expect(widgetRows()).toBe(15);

			// Closing the draft refills the freed rows from the transcript with no seam.
			h.widget.rows = 0;
			h.composer.ui.requestRender();
			await h.scheduler.advance(h.terminal, 300);
			expect(widgetRows()).toBe(0);
			expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(rows - 1);
			expect(blankBand(h.terminal)).toBeLessThanOrEqual(2);
			const viewport = h.terminal.getViewport().map(row => Bun.stripANSI(row).trim());
			expect(viewport.filter(row => /^next\d+$/.test(row)).at(-1)).toBe("next39");
			expect(history()).toEqual([...expected, ...next]);
			h.composer.ui.requestRender();
			await h.scheduler.advance(h.terminal, 300);
			expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(rows - 1);
			expect(history()).toEqual([...expected, ...next]);
		} finally {
			h.composer.stop();
		}
	});

	it("does not bill a transient HUD already painted on the first frame into the floor", async () => {
		const rows = 30;
		const shell = Array.from({ length: 12 }, (_, i) => `shell${i}`);
		const terminal = new VirtualTerminal(COLUMNS, rows);
		terminal.write(`${shell.join("\r\n")}${"\r\n".repeat(rows + 1)}`);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		const todos = new InlineWidget();
		const editor = new Container();
		editor.addChild(new Text("EDITOR", 0, 0));
		// A resumed session paints its restored todo HUD before the first frame.
		todos.rows = 8;
		composer.setRuntimeChildren([transcript, todos, editor], {
			transientChrome: [editor],
			selfClearingChrome: [todos],
		});
		composer.start({ playWelcomeIntro: false });
		const h = { terminal, scheduler, composer, transcript, editor };
		try {
			await h.scheduler.settle(h.terminal);
			composer.setRunActive(true);
			const answer = Array.from({ length: 110 }, (_, i) => `line${i}`);
			for (const row of answer) transcript.addChild({ render: () => [row] });
			composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			composer.setRunActive(false);
			await h.scheduler.advance(h.terminal, 300);

			// The todo HUD auto-clears: rows it covered must come back, not leave a band.
			todos.rows = 0;
			composer.ui.requestRender();
			await h.scheduler.advance(h.terminal, 300);
			expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(rows - 1);
			expect(blankBand(h.terminal)).toBeLessThanOrEqual(2);
			const history = h.terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trim())
				.filter(row => /^(shell|line)\d+$/.test(row));
			expect(history).toEqual([...shell, ...answer]);
		} finally {
			composer.stop();
		}
	});

	it("does not bill a startup draft replayed before runtime mount into the floor", async () => {
		const rows = 30;
		const shell = Array.from({ length: 12 }, (_, i) => `shell${i}`);
		const terminal = new VirtualTerminal(COLUMNS, rows);
		terminal.write(`${shell.join("\r\n")}${"\r\n".repeat(rows + 1)}`);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		const editorRoot = new Container();
		composer.start({ playWelcomeIntro: false });
		try {
			// The bootstrap frame paints the empty editor before any keystroke replay.
			await scheduler.settle(terminal);
			// Buffered keystrokes replay into the editor before the runtime mounts.
			composer.editor.setText("draft1\ndraft2\ndraft3\ndraft4\ndraft5");
			const originalRender = composer.editor.render.bind(composer.editor);
			let editorRenders = 0;
			composer.editor.render = (width: number) => {
				editorRenders++;
				return originalRender(width);
			};
			composer.renderFrame({ columns: COLUMNS, rows });
			composer.editor.render = originalRender;
			// A pre-mount frame renders the editor once, not once for layout and again for row tracking.
			expect(editorRenders).toBe(1);
			editorRoot.addChild(composer.editor);
			composer.setRuntimeChildren([transcript, editorRoot], { transientChrome: [editorRoot] });
			await scheduler.settle(terminal);

			composer.setRunActive(true);
			const answer = Array.from({ length: 110 }, (_, i) => `line${i}`);
			for (const row of answer) transcript.addChild({ render: () => [row] });
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			composer.setRunActive(false);
			await scheduler.advance(terminal, 300);

			// Clearing (not submitting) the draft must hand its rows back, not leave a band.
			composer.editor.setText("EDITOR");
			composer.ui.requestRender();
			await scheduler.advance(terminal, 300);
			const view = terminal.getViewport().map(row => Bun.stripANSI(row));
			expect(view.some(row => row.includes("draft1"))).toBe(false);
			expect(view.findIndex(row => row.includes("EDITOR"))).toBeGreaterThanOrEqual(rows - 3);
			expect(blankBand(terminal)).toBeLessThanOrEqual(2);
			const history = terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trim())
				.filter(row => /^(shell|line)\d+$/.test(row));
			expect(history).toEqual([...shell, ...answer]);
		} finally {
			composer.stop();
		}
	});

	it("keeps the editor on the bottom row when a live block collapses under retired history", async () => {
		const h = makeHarness();
		const transcript = new TranscriptContainer();
		for (let i = 0; i < TRANSCRIPT_ROWS; i++) transcript.addChild({ render: () => [`${TRANSCRIPT_PREFIX}${i}`] });
		// A streaming tool preview that collapses to its short result.
		let toolRows = 12;
		transcript.addChild({ render: () => Array.from({ length: toolRows }, (_, i) => `Tool row ${i}`) });
		h.composer.setRuntimeChildren([transcript, h.hud, h.editor]);
		await h.scheduler.settle(h.terminal);
		toolRows = 4;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(view.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		expect(view.filter(row => row.startsWith("Tool row "))).toHaveLength(4);
		h.composer.stop();
	});

	it("parks a collapsing block's slack below the reply instead of banding its history", async () => {
		const rows = 50;
		const h = makeHarness(107, rows, 10);
		const card = new InlineWidget();
		card.rows = 25;
		h.transcript.addChild(card);
		const message = new AssistantMessageComponent();
		h.transcript.addChild(message);
		h.hud.rows = 2;
		await h.scheduler.settle(h.terminal);
		const table = [
			"| When | Where / unit | What he reports |",
			"|---|---|---|",
			`| 2024-08→ | **Kursk** | ${"Joined the Kursk counterattack after Ukraine's incursion; the unit retook territory; in Feb 2025 awarded a medal. ".repeat(3)} |`,
		].join("\n");
		const text = `**What the sources describe** — his own account, as printed in the interviews.\n\n${table}\n\n**Motivation.** Another paragraph of the reply, long enough to wrap at this width.\n`;
		for (let i = 1; i <= text.length; i += 24) {
			if (i / text.length > 0.7) card.rows = 1;
			message.updateContent(reply(text.slice(0, i)), { transient: true });
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
		}
		message.updateContent(reply(text));
		message.markTranscriptBlockFinalized();
		h.hud.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		const bottom = view.findIndex(row => row.includes("└"));
		let run = 0;
		let longest = 0;
		for (const row of view.slice(0, bottom + 1)) {
			run = row === "" ? run + 1 : 0;
			longest = Math.max(longest, run);
		}
		// The reply rides directly under the retired history: the slack the collapse
		// opened must not sit above the live rows, where it reads as a hole punched
		// into the answer (and, carrying no cells, cannot be covered by any repaint).
		expect(view[0]).not.toBe("");
		expect(longest).toBeLessThanOrEqual(1);
		expect(view.findIndex(row => row.includes("EDITOR"))).toBe(rows - 1);
		h.composer.stop();
	});
});
