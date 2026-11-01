/**
 * Regression: turn-boundary text overlap on ConPTY-class terminals (#9783).
 *
 * The markdown renderer right-pads every row to the full layout width
 * (components/markdown.ts, "No background - just pad to width"), and the
 * turn-boundary retirement replays history through #lineRewriteSequence as a
 * bare "\n"-chain that assumes one emitted line advances exactly one physical
 * row. Live captures in Windows Terminal (PR #17692) show the unpatched
 * renderer expanding retired full-width rows into TWO physical buffer rows
 * (160 of 161 streamed table rows), which the layout-width fix reduces to one
 * artifact per 123 rows. Single-shot cursor probes on conhost, ConPTY, and
 * OpenConsole 1.23/1.24/1.25 did NOT reproduce a +1 advance for a settled LF
 * after an exact-width row, and CR clears the delayed-EOL wrap flag on every
 * host tested — the trigger is a real-time write-timing condition (#9783),
 * not a generic grid property. The emulation below is the STRICTEST model of
 * that condition, and the fix is preventive by design: no row reaches the
 * final column, so the trigger can never arm, whatever its timing. See also
 * the CR-terminated rewrites at #lineRewriteSequence, which reduce (not
 * eliminate) materialization.
 *
 * The kitty-vt-wasm engine (test/virtual-terminal.ts) models permissive
 * DECAWM only, so the ConPTY semantics are injected below: the CSI-move
 * materialization mirrors ConptyPendingWrapTerminal
 * (test/history-frame-plan.test.ts); the LF materialization is the
 * turn-boundary variant.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

const COLUMNS = 60;
const ROWS = 12;
const TRANSCRIPT_ROWS = 40;
const LINES_A = 30;
const LINES_B = 12;

/**
 * Models a ConPTY-class host: pending wrap materializes before the next
 * cursor-addressing sequence even while DECAWM is disabled (#9783).
 * LF is cursor addressing, so an exact-width row whose text the app
 * terminated with CR still drifts by one physical row at the LF.
 */
class ConptyClassTerminal extends VirtualTerminal {
	lfMaterializations = 0;
	csiMaterializations = 0;

	// A classified ConPTY host mirrors production Terminal.hostOwnsGridOnResize
	// (src/terminal.ts: `get hostOwnsGridOnResize() { return this.#conpty }`).
	// The TUI consumes this exact flag to enable the right-margin cap that
	// prevents the wrap materialization this fake emulates.
	get hostOwnsGridOnResize(): boolean {
		return true;
	}

	override write(data: string): void {
		const tokens = /\n|\x1b\[\d+;\d+H/g;
		let offset = 0;
		for (let match = tokens.exec(data); match; match = tokens.exec(data)) {
			const segment = data.slice(offset, match.index);
			super.write(segment);
			if (match[0] === "\n") {
				const stripped = Bun.stripANSI(segment);
				const rowText = stripped.endsWith("\r") ? stripped.slice(0, -1) : stripped;
				if (rowText.length >= this.columns) {
					// conhost materializes the wrap before the line feed.
					super.write("\r\n");
					this.lfMaterializations++;
				}
				super.write("\n");
			} else {
				// ConptyPendingWrapTerminal semantics: strict text-since-last-
				// break measure, bottom-row gate (mid-screen CSI self-corrects).
				const lastReturn = Math.max(segment.lastIndexOf("\r"), segment.lastIndexOf("\n"));
				const trailingText = Bun.stripANSI(segment.slice(lastReturn + 1));
				if (trailingText.length >= this.columns && this.getCursor().row === this.rows - 1) {
					super.write("\r\n");
					this.csiMaterializations++;
				}
				super.write(match[0]);
			}
			offset = match.index + match[0].length;
		}
		super.write(data.slice(offset));
	}
}

/** Same emulation WITHOUT the classification flag — models the pre-fix TUI,
 *  where the right-margin cap was gated off. Retained for the vacuity guard:
 *  it proves the emulated hazard still arms, so a clean flagged run is
 *  evidence of the fix, not of an idle harness. */
class UnclassifiedConptyTerminal extends ConptyClassTerminal {
	override get hostOwnsGridOnResize(): boolean {
		return false;
	}
}

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

/** Mirror of composer-inline-shrink.test.ts makeHarness, terminal injected. */
function makeHarness(terminal: VirtualTerminal) {
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const transcript = new TranscriptContainer();
	for (let i = 0; i < TRANSCRIPT_ROWS; i++) {
		const row = i;
		transcript.addChild({ render: () => [`settled transcript row ${row}`] });
	}
	const editor = new Container();
	editor.addChild(new Text("EDITOR", 0, 0));
	composer.setRuntimeChildren([transcript, editor], { transientChrome: [editor] });
	composer.start({ playWelcomeIntro: false });
	return { scheduler, composer, transcript };
}

/**
 * Stream a settled turn (rows long enough that markdown right-pads them to
 * exact width), finalize it (turn boundary: provider history retirement via
 * the "\n"-chain), then start a second streamed response.
 */
async function runTurnBoundary(terminal: VirtualTerminal) {
	const { scheduler, composer, transcript } = makeHarness(terminal);
	await scheduler.settle(terminal);
	const fill = "filler word stream"; // keeps every paragraph row >= COLUMNS wide
	const messageA = new AssistantMessageComponent();
	transcript.addChild(messageA);
	const lines = Array.from({ length: LINES_A }, (_, i) => `turnA line${i} ${fill.repeat(4)}`);
	for (let n = 1; n <= lines.length; n++) {
		messageA.updateContent(reply(lines.slice(0, n).join("\n\n")), { transient: true });
		composer.ui.requestRender();
		await scheduler.settle(terminal);
	}
	messageA.updateContent(reply(lines.join("\n\n")));
	messageA.markTranscriptBlockFinalized(); // TURN BOUNDARY
	composer.ui.requestRender();
	await scheduler.settle(terminal);
	const messageB = new AssistantMessageComponent();
	transcript.addChild(messageB);
	const linesB = Array.from({ length: LINES_B }, (_, i) => `turnB line${i} ${fill.repeat(4)}`);
	for (let n = 1; n <= linesB.length; n++) {
		messageB.updateContent(reply(linesB.slice(0, n).join("\n\n")), { transient: true });
		composer.ui.requestRender();
		await scheduler.settle(terminal);
	}
}

/** Every fed logical row present exactly once, in order, no interleaving. */
function expectCleanTranscript(terminal: VirtualTerminal) {
	const buffer = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
	for (const [prefix, count] of [
		["turnA line", LINES_A],
		["turnB line", LINES_B],
	] as const) {
		for (let i = 0; i < count; i++) {
			const token = `${prefix}${i} `;
			const hits = buffer.filter(row => row.includes(token)).length;
			expect({ token, hits }, `row ${token} must survive exactly once`).toEqual({ token, hits: 1 });
		}
	}
	const lastA = buffer.findLastIndex(row => row.includes(`turnA line${LINES_A - 1} `));
	const firstB = buffer.findIndex(row => row.includes("turnB line0 "));
	expect(firstB, "turnA rows must be present").toBeGreaterThan(-1);
	expect(lastA, "turnA rows must be present").toBeGreaterThan(-1);
	expect(firstB, "turnB rows must be present").toBeGreaterThan(-1);
	expect(firstB, "turnB must not paint over retired turnA rows").toBeGreaterThan(lastA);
	return buffer;
}

beforeAll(async () => {
	await initTheme();
});

describe("turn-boundary overlap (#9783 family, LF-chain drift)", () => {
	it("baseline: plain VT-model terminal keeps retired and new rows separate", async () => {
		const terminal = new VirtualTerminal(COLUMNS, ROWS);
		await runTurnBoundary(terminal);
		expectCleanTranscript(terminal);
	});

	it("ConPTY-class host must not paint new rows over retired rows", async () => {
		// Control: the same driver on the permissive engine is clean.
		const control = new VirtualTerminal(COLUMNS, ROWS);
		await runTurnBoundary(control);
		const baseline = control.getBufferPosition().baseY;

		// Vacuity guard: with the classification flag off (pre-fix TUI the cap
		// is gated off), the quirk engine must arm the hazard — exact-width
		// rows materialize a wrap at every LF. Pre-fix, the flagged run below
		// behaved exactly like this leg (observed: 3 copies of 'turnA line0',
		// baseY drift).
		const unclassified = new UnclassifiedConptyTerminal(COLUMNS, ROWS);
		await runTurnBoundary(unclassified);
		expect(
			unclassified.lfMaterializations + unclassified.csiMaterializations,
			"hazard not exercised: no pending-wrap materialization observed",
		).toBeGreaterThan(0);

		// Fix acceptance: a classified ConPTY host never arms the hazard — no
		// row is written to the final column, so nothing materializes and the
		// retirement chain stays a clean 1:1 row map.
		const conpty = new ConptyClassTerminal(COLUMNS, ROWS);
		await runTurnBoundary(conpty);
		expect(
			conpty.lfMaterializations + conpty.csiMaterializations,
			"right-margin cap leaked: a row still armed a pending wrap",
		).toBe(0);
		expectCleanTranscript(conpty);
		expect(conpty.getBufferPosition().baseY, "untracked scroll: baseY drifted past baseline").toBe(baseline);
	});

	it("right-aligned chrome keeps its final glyph on a ConPTY-class host", async () => {
		// The margin must be reserved at layout width, not clipped after
		// layout: a component that fills its layout width with a closed box
		// keeps its right border, one column before the physical final one.
		// A post-layout truncation instead (the naive fix) drops the closing
		// glyph — every box/table/status right border silently vanishes on
		// Windows hosts.
		const terminal = new ConptyClassTerminal(COLUMNS, ROWS);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const content = new Container();
		content.addChild({
			render: (width: number) => [`│${"-".repeat(Math.max(0, width - 2))}│`, "box body"],
		});
		composer.setRuntimeChildren([content], { transientChrome: [] });
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);
		const boxRow = terminal
			.getViewport()
			.map(row => Bun.stripANSI(row))
			.find(row => row.startsWith("│"));
		expect(boxRow, "the box row must reach the viewport").toBeDefined();
		expect(boxRow!.trimEnd().endsWith("│"), `right border must close the row: ${JSON.stringify(boxRow)}`).toBe(true);
	});
});
