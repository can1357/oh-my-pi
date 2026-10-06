import { beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";

withoutTerminalMultiplexer();

const ROWS = 40;
const COLUMNS = 100;
const TRANSCRIPT_ROWS = 60;
const TRANSCRIPT_PREFIX = "Settled transcript row ";

/** Below-transcript chrome that inflates on demand, mimicking a confirmation dialog or a tall multi-line editor swapped in above the input. */
class InlineWidget implements Component {
	rows = 0;
	retireDisplacedTranscript = false;

	render(): readonly string[] {
		return Array.from({ length: this.rows }, (_, i) => `Live widget row ${i}`);
	}
}

interface Harness {
	terminal: VirtualTerminal;
	scheduler: VirtualRenderScheduler;
	composer: Composer;
	widget: InlineWidget;
	/** Turn-scoped chrome between transcript and editor (loader, todo/subagent HUDs). */
	hud: InlineWidget;
	editor: Container;
	transcript: TranscriptContainer;
}

function makeHarness(columns = COLUMNS, rows = ROWS, transcriptRows = TRANSCRIPT_ROWS): Harness {
	const terminal = new VirtualTerminal(columns, rows);
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
	composer.setRuntimeChildren([transcript, hud, editor], { transient: [editor] });
	composer.start({ playWelcomeIntro: false });
	return { terminal, scheduler, composer, widget, hud, editor, transcript };
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

/** Every transcript row of {@link pinnedAskScenario}, in order, exactly once. */
const PINNED_ASK_ROWS = [
	...Array.from({ length: 40 }, (_, i) => `Response ${i}`),
	...Array.from({ length: 5 }, (_, i) => `Follow-up ${i}`),
];

/**
 * #14570 geometry (112x54): a 40-row response, an ask opened and cancelled,
 * then a 5-row follow-up. The next ask retires the response, which leaves the
 * composer pinned to the bottom with the response still on screen above it.
 */
async function pinnedAskScenario() {
	const h = makeHarness(112, 54, 0);
	const block = (tag: string, rows: number): Component => ({
		render: () => Array.from({ length: rows }, (_, i) => `${tag} ${i}`),
	});
	const openAsk = (): AskDialogComponent => {
		const dialog = new AskDialogComponent(
			[
				{
					id: "q1",
					question: "Is the recurring defect the duplicate rendering?",
					options: [
						{ label: "Duplicate", description: "Matches the earlier issue." },
						{ label: "Clipped head", description: "Covered elsewhere." },
						{ label: "New issue", description: "File it anyway." },
					],
				},
			],
			{ onSubmit: () => {}, onCancel: () => {}, onPrompt: () => Promise.resolve(undefined) },
		);
		h.editor.clear();
		h.editor.addChild(dialog);
		h.composer.ui.requestRender();
		return dialog;
	};
	const closeAsk = (dialog: AskDialogComponent): void => {
		dialog.dispose();
		h.editor.clear();
		h.editor.addChild(new Text("EDITOR", 0, 0));
		h.composer.ui.requestRender();
	};
	const settle = (): Promise<void> => h.scheduler.settle(h.terminal);
	const viewport = (): string[] => h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
	h.transcript.addChild(block("Response", 40));
	closeAsk(openAsk());
	await settle();
	h.transcript.addChild(block("Follow-up", 5));
	h.composer.ui.requestRender();
	await settle();
	return {
		h,
		openAsk,
		closeAsk,
		settle,
		viewport,
		/** Rows from the last follow-up row down to the ask question. */
		questionGap: (rows: string[]): number =>
			rows.findIndex(row => row.includes("Is the recurring defect")) - rows.indexOf("Follow-up 4"),
		/** Transcript rows across native scrollback and the screen. */
		transcriptRows: (): string[] =>
			h.terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.filter(row => /^(Response|Follow-up) \d+$/.test(row)),
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("composer inline shrink (#11007)", () => {
	it("preserves response rows while reading and answering an ask at the reported 54x112 geometry", async () => {
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
		expect(visibleRows()).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		dialog.handleInput("\r");
		await h.scheduler.settle(h.terminal);
		expect(submitted).toBe(true);
		expect(visibleRows()).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(53);
		dialog.dispose();
		h.composer.stop();
	});

	it("leaves a short transcript top-anchored when an ask panel retires nothing", async () => {
		const h = makeHarness(COLUMNS, ROWS, 3);
		await h.scheduler.settle(h.terminal);
		h.widget.retireDisplacedTranscript = true;
		h.widget.rows = 6;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const row = (needle: string): number =>
			h.terminal.getViewport().findIndex(line => Bun.stripANSI(line).trimEnd().startsWith(needle));
		expect(row(`${TRANSCRIPT_PREFIX}0`)).toBe(0);
		h.widget.rows = 0;
		h.widget.retireDisplacedTranscript = false;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(row(`${TRANSCRIPT_PREFIX}0`)).toBe(0);
		expect(row("EDITOR")).toBeLessThan(ROWS - 1);
		h.composer.stop();
	});

	it("keeps rows an ask panel retires on screen above it instead of a blank band (#14570)", async () => {
		const s = await pinnedAskScenario();

		// This ask retires the 40-row response. Those rows were on screen: they
		// must stay there above the panel, not scroll away behind blank padding.
		const dialog = s.openAsk();
		await s.settle();
		const open = s.viewport();
		expect(open[0]).toMatch(/^Response \d+$/);
		expect(open).toContain("Response 39");
		expect(s.questionGap(open)).toBe(2);

		// Closing still pins the editor to the bottom row, and every row lands
		// exactly once across native scrollback and the screen.
		s.closeAsk(dialog);
		await s.settle();
		const closed = s.viewport();
		expect(closed.indexOf("EDITOR")).toBe(53);
		expect(closed).toContain("Response 39");
		expect(s.transcriptRows()).toEqual(PINNED_ASK_ROWS);
		s.h.composer.stop();
	});

	it("keeps a pinned frame's retained rows when a normal overlay fits below them (#14570)", async () => {
		const s = await pinnedAskScenario();
		const dialog = s.openAsk();
		await s.settle();

		// A bottom-anchored overlay lands inside the pinned viewport: compositing
		// it must not stretch the frame over the retained rows above.
		s.h.composer.ui.showOverlay({ render: () => ["OVERLAY"] }, { anchor: "bottom-left", width: 20 });
		await s.settle();
		const covered = s.viewport();
		expect(covered[0]).toMatch(/^Response \d+$/);
		expect(covered).toContain("Response 39");
		expect(s.questionGap(covered)).toBe(2);
		expect(covered[53]).toStartWith("OVERLAY");

		s.h.composer.ui.hideOverlay();
		await s.settle();
		const uncovered = s.viewport();
		expect(uncovered[0]).toMatch(/^Response \d+$/);
		expect(s.questionGap(uncovered)).toBe(2);

		s.closeAsk(dialog);
		await s.settle();
		expect(s.viewport().indexOf("EDITOR")).toBe(53);
		expect(s.transcriptRows()).toEqual(PINNED_ASK_ROWS);
		s.h.composer.stop();
	});

	it("keeps a pinned frame on the bottom row under an overlay that covers retained rows (#14570)", async () => {
		const s = await pinnedAskScenario();
		const dialog = s.openAsk();
		await s.settle();
		const question = s.viewport().findIndex(row => row.includes("Is the recurring defect"));

		// A centered overlay reaches above the pinned viewport, so the frame has
		// to cover the screen; the composer must still sit on the bottom rows
		// instead of jumping to the top behind the overlay.
		s.h.composer.ui.showOverlay({ render: () => ["OVERLAY"] }, { width: 20 });
		await s.settle();
		const covered = s.viewport();
		expect(covered.some(row => row.includes("OVERLAY"))).toBe(true);
		expect(covered.findIndex(row => row.includes("Is the recurring defect"))).toBe(question);

		s.h.composer.ui.hideOverlay();
		await s.settle();
		expect(s.viewport().findIndex(row => row.includes("Is the recurring defect"))).toBe(question);

		s.closeAsk(dialog);
		await s.settle();
		expect(s.viewport().indexOf("EDITOR")).toBe(53);
		expect(s.transcriptRows()).toEqual(PINNED_ASK_ROWS);
		s.h.composer.stop();
	});

	it("keeps settled transcript rows reachable while an inline ask panel is expanded (#12398)", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);
		h.widget.retireDisplacedTranscript = true;
		h.widget.rows = 24;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const indices = h.terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		// The ask panel can remain open indefinitely. Its growth must not hide
		// settled response rows from both the live screen and native scrollback.
		expect(indices).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		h.widget.rows = 0;
		h.widget.retireDisplacedTranscript = false;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const after = h.terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
		expect(
			after.filter(row => row.startsWith(TRANSCRIPT_PREFIX)).map(row => Number(row.slice(TRANSCRIPT_PREFIX.length))),
		).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		h.composer.stop();
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

	it("retires settled rows displaced by persistent chrome instead of hiding them until it shrinks", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);

		// A working loader + todo HUD stay up for a whole turn. Settled rows they
		// displace must reach native scrollback, not vanish between history and
		// the viewport until the turn ends.
		h.hud.rows = 4;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const indices = h.terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(indices).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(view.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);

		h.composer.stop();
	});
});
