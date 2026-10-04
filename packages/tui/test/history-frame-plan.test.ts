import { describe, expect, it } from "bun:test";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";
import {
	type Component,
	CURSOR_MARKER,
	type HistoryFlushOptions,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type TUIStopOptions,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { WidthReplayProvider } from "./width-replay-provider";

class Provider implements TerminalFrameProvider {
	plan: TerminalFramePlan;
	resizeRows: readonly string[] | undefined;
	acknowledged: number[] = [];

	constructor(plan: TerminalFramePlan) {
		this.plan = plan;
	}

	renderFrame(_viewport: ViewportSize): TerminalFramePlan {
		return this.plan;
	}
	renderResizeFrame(_viewport: ViewportSize): readonly string[] {
		return this.resizeRows ?? this.plan.viewport;
	}

	acknowledgeHistory(id: number): void {
		this.acknowledged.push(id);
		this.plan = { viewport: this.plan.viewport };
	}
}

class FullscreenOverlay implements Component {
	render(): string[] {
		return ["fullscreen overlay"];
	}
}

class CountingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

const scheduler = {
	now: () => 0,
	scheduleImmediate(callback: () => void) {
		callback();
		return { cancel() {} };
	},
	scheduleRender(callback: () => void) {
		callback();
		return { cancel() {} };
	},
};
class ResizeScheduler {
	#now = 0;
	#pending = new Set<() => void>();

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void): void {
		callback();
	}

	scheduleRender(callback: () => void, _delayMs: number) {
		this.#pending.add(callback);
		return { cancel: () => this.#pending.delete(callback) };
	}

	settle(): void {
		this.#now += 120;
		const pending = [...this.#pending];
		this.#pending.clear();
		for (const callback of pending) callback();
	}
}

class HeightReplayProvider implements TerminalFrameProvider {
	#nextHistoryId = 1;
	#retired = false;
	resetCount = 0;

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		return {
			history: this.#retired
				? undefined
				: { id: this.#nextHistoryId, rows: ["real-todo-block", "real-read-block", "real-bash-block"] },
			viewport: ["dot-live-one", "dot-live-two", "editor"].slice(-viewport.rows),
		};
	}

	renderResizeFrame(): readonly string[] {
		return ["resize frame"];
	}

	acknowledgeHistory(id: number): void {
		if (id !== this.#nextHistoryId) return;
		this.#nextHistoryId++;
		this.#retired = true;
	}

	beginHistoryReplay(): void {
		this.#retired = false;
		this.resetCount++;
	}
}

class FlushProvider implements TerminalFrameProvider {
	#nextId = 1;
	readonly pending = ["final one", "final two"];
	#flushing = false;
	readonly acknowledged: number[] = [];
	/** Flush lifecycle calls and offered history rows, in order. */
	readonly events: unknown[][] = [];

	renderFrame(): TerminalFramePlan {
		const row = this.#flushing ? this.pending[0] : undefined;
		if (row !== undefined) this.events.push(["history", row]);
		return {
			history: row === undefined ? undefined : { id: this.#nextId, rows: [row] },
			viewport: ["editor"],
		};
	}

	acknowledgeHistory(id: number): void {
		if (id !== this.#nextId || this.pending.length === 0) return;
		this.acknowledged.push(id);
		this.#nextId++;
		this.pending.shift();
	}

	beginHistoryFlush(options?: HistoryFlushOptions): void {
		this.events.push(["begin", options]);
		this.#flushing = true;
	}

	endHistoryFlush(): void {
		this.events.push(["end"]);
		this.#flushing = false;
	}
}

function plainBuffer(terminal: VirtualTerminal): string[] {
	return terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
}
/**
 * A Composer with 30 one-row blocks, added under a fullscreen overlay when
 * `overlay`, then stopped. Renders are deferred to `renderScheduler.settle()`,
 * as in production, so none re-enters `stop()`.
 */
async function stopWithTranscript(overlay: boolean, options: TUIStopOptions | undefined) {
	const terminal = new VirtualTerminal(40, 10);
	const renderScheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const transcript = new TranscriptContainer();
	composer.setRuntimeChildren([transcript, new Text("editor", 0, 0)]);
	composer.start({ playWelcomeIntro: false });
	await renderScheduler.settle(terminal);
	const shown = overlay ? composer.ui.showOverlay(new FullscreenOverlay(), { fullscreen: true }) : undefined;
	await renderScheduler.settle(terminal);
	for (let i = 0; i < 30; i++) transcript.addChild(new Text(`row-${i}`, 0, 0));
	composer.ui.requestRender();
	await renderScheduler.settle(terminal);
	composer.ui.stop(options);
	return { terminal, composer, transcript, shown, renderScheduler };
}

/** Models tmux's preserved clear: a full-screen ED0/ED2 scrolls the live
 *  screen into pane history before blanking, unlike xterm-family discard. */
class TmuxPreservedClearTerminal extends VirtualTerminal {
	override write(data: string): void {
		const fullScreenClear = /\x1b\[1;1H\x1b\[J|\x1b\[2J/g;
		let translated = "";
		let last = 0;
		for (let match = fullScreenClear.exec(data); match; match = fullScreenClear.exec(data)) {
			translated += data.slice(last, match.index);
			translated += `\x1b[${this.rows};1H${"\n".repeat(this.rows)}${match[0]}`;
			last = match.index + match[0].length;
		}
		translated += data.slice(last);
		super.write(translated);
	}
}
/**
 * Models ConPTY materializing a pending wrap before the cursor move that follows
 * an exact-width bottom-row repaint, as observed in issue #9783's PTY capture.
 */
class ConptyPendingWrapTerminal extends VirtualTerminal {
	override write(data: string): void {
		const cursorMove = /\x1b\[\d+;\d+H/g;
		let offset = 0;
		for (let match = cursorMove.exec(data); match; match = cursorMove.exec(data)) {
			const beforeMove = data.slice(offset, match.index);
			super.write(beforeMove);
			const lastReturn = Math.max(beforeMove.lastIndexOf("\r"), beforeMove.lastIndexOf("\n"));
			const trailingText = Bun.stripANSI(beforeMove.slice(lastReturn + 1));
			if (trailingText.length >= this.columns && this.getCursor().row === this.rows - 1) {
				super.write("\r\n");
			}
			super.write(match[0]);
			offset = match.index + match[0].length;
		}
		super.write(data.slice(offset));
	}
}

describe("terminal frame plans", () => {
	withoutTerminalMultiplexer();
	it("appends finalized history once and leaves the requested mutable viewport intact", () => {
		const terminal = new VirtualTerminal(20, 3);
		const provider = new Provider({
			history: { id: 1, rows: ["history one", "history two"] },
			viewport: ["editor", "status"],
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		expect(provider.acknowledged).toEqual([1]);
		expect(terminal.getBufferPosition().baseY).toBe(1);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["history two", "editor", "status"]);
		tui.stop();
	});
	it("keeps an exact-width live row out of scrollback when ConPTY materializes pending wrap", () => {
		const terminal = new ConptyPendingWrapTerminal(20, 4);
		const provider = new Provider({
			history: { id: 1, rows: ["history one", "history two"] },
			viewport: [`editor${CURSOR_MARKER}`, "status one".padEnd(20, ".")],
		});
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		for (let frame = 2; frame <= 8; frame++) {
			provider.plan = { viewport: [`editor${CURSOR_MARKER}`, `status ${frame}`.padEnd(20, ".")] };
			tui.requestRender(true);
		}

		expect(terminal.getBufferPosition().baseY).toBe(0);
		expect(plainBuffer(terminal)).toEqual(["history one", "history two", "editor", "status 8............"]);
		tui.stop();
	});
	it("places the cursor from a moved marker row and hides it once the marker is gone", () => {
		const terminal = new CountingTerminal(20, 4);
		const provider = new Provider({ viewport: ["alpha", `ed${CURSOR_MARKER}it`, "status"] });
		const tui = new TUI(terminal, true, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		// Every row moved, so each is reused by content rather than position.
		terminal.writes.length = 0;
		provider.plan = { viewport: [`ed${CURSOR_MARKER}it`, "status", "alpha"] };
		tui.requestRender(true);
		let written = terminal.writes.join("");
		expect(written).not.toContain(CURSOR_MARKER);
		expect(written).toContain("\x1b[1;3H\x1b[?25h");

		// The marker-free row now matches the stripped row painted last frame.
		terminal.writes.length = 0;
		provider.plan = { viewport: ["status", "alpha", "edit"] };
		tui.requestRender(true);
		written = terminal.writes.join("");
		expect(written).not.toContain("\x1b[?25h");
		expect(written).toContain("\x1b[?25l");
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["status", "alpha", "edit", ""]);
		tui.stop();
	});
	it("keeps live viewport rows out of tmux-style preserved-clear scrollback on a scrolling append", () => {
		// Viewport at row 0 fills the screen: the protective erase is emitted
		// full-screen, which tmux would archive as the #9780 duplication.
		const terminal = new TmuxPreservedClearTerminal(20, 4);
		const provider = new Provider({ viewport: ["live-1", "live-2", "live-3", "editor"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		expect(terminal.getBufferPosition().baseY).toBe(0);

		provider.plan = {
			history: { id: 1, rows: ["hist-1", "hist-2"] },
			viewport: ["live-2", "live-3", "live-4", "editor"],
		};
		tui.requestRender(true);

		expect(provider.acknowledged).toEqual([1]);
		const scrollback = plainBuffer(terminal).slice(0, terminal.getBufferPosition().baseY);
		expect(scrollback.some(row => row.includes("live-") || row.includes("editor"))).toBe(false);
		expect(scrollback.filter(Boolean)).toEqual(["hist-1", "hist-2"]);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["live-2", "live-3", "live-4", "editor"]);
		tui.stop();
	});
	it("bottom-splits a complete replay and serializes it in one terminal write", () => {
		const terminal = new CountingTerminal(20, 4);
		const provider = new Provider({ viewport: ["live", "editor"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		terminal.writes.length = 0;

		provider.plan = {
			history: { id: 1, rows: ["history one", "history two", "history three", "history four"], kind: "replay" },
			viewport: ["live", "editor"],
		};
		tui.requestRender(true);

		expect(terminal.writes).toHaveLength(1);
		expect(provider.acknowledged).toEqual([1]);
		expect(plainBuffer(terminal)).toEqual([
			"history one",
			"history two",
			"history three",
			"history four",
			"live",
			"editor",
		]);

		tui.requestRender(true);
		expect(plainBuffer(terminal)).toEqual([
			"history one",
			"history two",
			"history three",
			"history four",
			"live",
			"editor",
		]);
		tui.stop();
	});

	it("publishes composer-space hit-test origin across a replay pad", () => {
		// A replay splices history rows over the viewport's leading blanks for
		// painting, but click spans stay indexed to the composer's unpadded
		// rows: the published top must back out that pad so a click on a live
		// row resolves to its own span instead of one pad-length above it.
		const terminal = new CountingTerminal(20, 4);
		const provider = new Provider({ viewport: ["", "", "live", "editor"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		provider.plan = {
			history: { id: 1, rows: ["history one", "history two"], kind: "replay" },
			viewport: ["", "", "live", "editor"],
		};
		tui.requestRender(true);

		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual([
			"history one",
			"history two",
			"live",
			"editor",
		]);
		expect(tui.getMutableViewport()).toEqual({ top: 0, length: 2 });
		tui.stop();
	});

	it("publishes composer-space origin when a replay prepends blanks", () => {
		// A short viewport is prepended with blanks before the replay split,
		// so composer row 0 sits that many screens below the painted top even
		// when fewer blanks were replaced by history rows.
		const terminal = new CountingTerminal(20, 4);
		const provider = new Provider({ viewport: ["live", "editor"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		provider.plan = {
			history: { id: 1, rows: ["history one"], kind: "replay" },
			viewport: ["live", "editor"],
		};
		tui.requestRender(true);

		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["history one", "", "live", "editor"]);
		expect(tui.getMutableViewport()).toEqual({ top: 2, length: 3 });
		tui.stop();
	});

	it("fuses fullscreen overlay exit into a session replacement paint", () => {
		const terminal = new CountingTerminal(171, 39);
		const provider = new Provider({ viewport: ["old session"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);
		const overlay = tui.showOverlay(
			{
				render: () => ["session selector"],
			},
			{
				width: "100%",
				maxHeight: "100%",
				fullscreen: true,
			},
		);
		terminal.writes.length = 0;

		provider.plan = { viewport: ["resumed transcript", "resumed prompt"] };
		tui.requestRender(true, { clearScrollback: true });
		overlay.hide();

		const exitPaints = terminal.writes.filter(write => write.includes("\x1b[?1049l"));
		expect(exitPaints).toHaveLength(1);
		expect(exitPaints[0]).toContain("\x1b[3J");
		expect(exitPaints[0]).toContain("resumed transcript");
		tui.stop();
	});

	it("repaints a viewport-only frame in place without scrolling", () => {
		const terminal = new VirtualTerminal(20, 4);
		const provider = new Provider({ viewport: ["spinner one", "editor"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		provider.plan = { viewport: ["spinner two", "editor"] };
		tui.requestRender(true);
		expect(terminal.getBufferPosition().baseY).toBe(0);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(["spinner two", "editor", "", ""]);
		tui.stop();
	});

	it("flushes every eligible history batch before terminal handoff", () => {
		const terminal = new VirtualTerminal(20, 3);
		const provider = new FlushProvider();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		tui.stop();

		expect(provider.acknowledged).toEqual([1, 2]);
		expect(plainBuffer(terminal)).toContain("final one");
		expect(plainBuffer(terminal)).toContain("final two");
	});

	it("ends the history flush after its last batch, so the TUI no longer flushes after start() resumes", () => {
		const terminal = new VirtualTerminal(20, 3);
		const provider = new FlushProvider();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		tui.stop();
		expect(provider.events).toEqual([["begin", {}], ["history", "final one"], ["history", "final two"], ["end"]]);

		provider.pending.push("after handoff");
		tui.start();
		tui.requestRender(true);
		expect(provider.events).toHaveLength(4);
		expect(plainBuffer(terminal)).not.toContain("after handoff");
		tui.stop();
	});

	it("flushes an exiting stop without options, such as Ctrl+D, as the owner's exit flush provider says", async () => {
		for (const [flush, written] of [
			[{}, 30],
			[{ maxRows: 10 }, 5],
		] as const) {
			const terminal = new VirtualTerminal(40, 10);
			const renderScheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				exit: () => {},
				tuiOptions: { renderScheduler },
				preferences: { ...COMPOSER_DEFAULTS, quiet: true },
			});
			composer.ui.setExitFlushProvider(() => flush);
			const transcript = new TranscriptContainer();
			composer.setRuntimeChildren([transcript, new Text("editor", 0, 0)]);
			composer.start({ playWelcomeIntro: false });
			await renderScheduler.settle(terminal);
			composer.ui.showOverlay(new FullscreenOverlay(), { fullscreen: true });
			await renderScheduler.settle(terminal);
			for (let i = 0; i < 30; i++) transcript.addChild(new Text(`row-${i}`, 0, 0));
			composer.ui.requestRender();
			await renderScheduler.settle(terminal);
			// Ctrl+D on the composer before InteractiveMode installs its own handlers.
			composer.editor.onExit!();
			expect(plainBuffer(terminal).filter(row => row.startsWith("row-"))).toHaveLength(written);
		}
	});

	it("retires by pressure again after a handoff stop resumes", () => {
		const terminal = new VirtualTerminal(40, 10);
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		transcript.addChild(new Text("before handoff", 0, 0));
		composer.setRuntimeChildren([transcript, new Text("editor", 0, 0)]);
		composer.start({ playWelcomeIntro: false });

		// A suspend or external-editor handoff: the full flush commits the block.
		composer.ui.stop({ resuming: true });
		expect(transcript.blockStates()).toEqual(["committed"]);

		composer.ui.start();
		transcript.addChild(new Text("after handoff", 0, 0));
		composer.ui.requestRender(true);
		// The screen has room, so pressure keeps the new block live.
		expect(transcript.blockStates()).toEqual(["committed", "settled"]);
		composer.ui.stop();
	});

	it("flushes nothing at a resuming stop under a fullscreen overlay, then retires the same rows once it closes", async () => {
		const handoff = await stopWithTranscript(true, { resuming: true });
		expect(handoff.transcript.blockStates().some(state => state === "committed")).toBe(false);
		expect(plainBuffer(handoff.terminal).some(row => row.startsWith("row-"))).toBe(false);
		const full = await stopWithTranscript(true, undefined);

		for (const { terminal, composer, shown, renderScheduler } of [handoff, full]) {
			composer.ui.start();
			await renderScheduler.settle(terminal);
			shown!.hide();
			await renderScheduler.settle(terminal);
		}
		expect(plainBuffer(handoff.terminal).filter(Boolean)).toEqual(plainBuffer(full.terminal).filter(Boolean));
		handoff.composer.ui.stop();
		full.composer.ui.stop();
	});

	it("still flushes in full under a fullscreen overlay when the stop is not resuming", async () => {
		const quit = await stopWithTranscript(true, undefined);
		expect(quit.transcript.blockStates().every(state => state === "committed")).toBe(true);
		expect(plainBuffer(quit.terminal).filter(row => row.startsWith("row-"))).toHaveLength(30);
	});

	it("flushes in full at a resuming stop without a fullscreen overlay", async () => {
		const handoff = await stopWithTranscript(false, { resuming: true });
		expect(handoff.transcript.blockStates().every(state => state === "committed")).toBe(true);
		expect(plainBuffer(handoff.terminal).filter(row => row.startsWith("row-"))).toHaveLength(30);
		handoff.composer.ui.start();
		handoff.composer.ui.stop();
	});

	it("keeps a clearing repaint queued under a fullscreen overlay across a resuming stop, so each row lands once", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const renderScheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		composer.setRuntimeChildren([transcript, new Text("editor", 0, 0)]);
		composer.start({ playWelcomeIntro: false });
		for (let i = 0; i < 30; i++) transcript.addChild(new Text(`row-${i}`, 0, 0));
		composer.ui.requestRender();
		await renderScheduler.settle(terminal);
		// Pressure has already written the older blocks to scrollback.
		expect(transcript.blockStates().filter(state => state === "committed")).toHaveLength(25);

		const shown = composer.ui.showOverlay(new FullscreenOverlay(), { fullscreen: true });
		await renderScheduler.settle(terminal);
		// A clearing repaint (compaction, /clear, a settings change) under the overlay.
		composer.ui.resetDisplay();
		composer.ui.stop({ resuming: true });
		composer.ui.start();
		await renderScheduler.settle(terminal);
		shown.hide();
		await renderScheduler.settle(terminal);

		expect(plainBuffer(terminal).filter(Boolean)).toEqual([
			...Array.from({ length: 30 }, (_, i) => `row-${i}`),
			"editor",
		]);
		composer.ui.stop();
	});

	it("keeps visible history above the anchored viewport while room remains", () => {
		const terminal = new VirtualTerminal(20, 6);
		const provider = new Provider({ history: { id: 1, rows: ["block one"] }, viewport: ["editor"] });
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		tui.setFrameProvider(provider);

		provider.plan = { history: { id: 2, rows: ["block two"] }, viewport: ["editor"] };
		tui.requestRender(true);
		expect(terminal.getBufferPosition().baseY).toBe(0);
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual([
			"block one",
			"block two",
			"editor",
			"",
			"",
			"",
		]);
		tui.stop();
	});

	it("uses the alternate buffer during resize and restores anchored history", () => {
		const terminal = new VirtualTerminal(20, 4);
		const provider = new Provider({ history: { id: 1, rows: ["welcome"] }, viewport: ["editor"] });
		provider.resizeRows = ["welcome", "editor"];
		const renderScheduler = new ResizeScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setFrameProvider(provider);
		tui.start();

		terminal.resize(24, 5);
		expect(
			terminal
				.getViewport()
				.map(row => row.trimEnd())
				.slice(0, 2),
		).toEqual(["welcome", "editor"]);

		renderScheduler.settle();
		terminal.sendInput("\x1b[2;17R");
		renderScheduler.settle();
		expect(
			terminal
				.getViewport()
				.map(row => row.trimEnd())
				.slice(0, 2),
		).toEqual(["welcome", "editor"]);
		tui.stop();
	});
	it("keeps live viewport rows out of scrollback during a height shrink", () => {
		// Committed history above a pressured live tail (compact placeholder
		// rows). The terminal can push a placeholder before the resize callback runs,
		// so rebuild the semantic history after every geometry change: only real
		// finalized blocks become permanent scrollback bytes.
		const terminal = new VirtualTerminal(20, 6);
		const provider = new HeightReplayProvider();
		const renderScheduler = new ResizeScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setFrameProvider(provider);
		tui.setResizeScrollback("rebuild");
		tui.start();
		expect(terminal.getViewport().map(row => row.trimEnd())).toEqual([
			"real-todo-block",
			"real-read-block",
			"real-bash-block",
			"dot-live-one",
			"dot-live-two",
			"editor",
		]);

		terminal.resize(20, 2); // a single large shrink can push live rows before the callback runs
		renderScheduler.settle(); // restore the normal buffer, start the anchor probe
		renderScheduler.settle(); // probe timeout → one bounded retry under a multiplexer
		renderScheduler.settle(); // final timeout → settled repaint (no-op settle on direct)
		renderScheduler.settle(); // drag-end quiet window → destructive rebuild

		const scrollback = plainBuffer(terminal).slice(0, terminal.getBufferPosition().baseY);
		expect(scrollback.some(row => row.includes("dot-live"))).toBe(false);
		expect(scrollback).toEqual(["real-todo-block", "real-read-block", "real-bash-block"]);
		expect(provider.resetCount).toBe(1);
		tui.stop();
	});

	it("appends a current-width replay after settled resize", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const provider = new WidthReplayProvider();
		const renderScheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setResizeScrollback("append");
		tui.setFrameProvider(provider);
		tui.start();
		await renderScheduler.settle(terminal);

		expect(plainBuffer(terminal)).toContain("history-one@20");

		terminal.resize(30, 2);
		// A refresh-capable settle waits out the 120 ms settle window plus the
		// 40 ms drain horizon and then replays the ledger at the settled width
		// in the same transaction.
		await renderScheduler.advance(terminal, 160);

		const resized = plainBuffer(terminal);
		expect(provider.resetCount).toBe(1);
		expect(resized).toContain("history-one@20");
		expect(resized).toContain("history-one@30");
		expect(resized.slice(-2)).toEqual(["history-two@30", "editor@30"]);
		tui.stop();
	});

	it("does not duplicate current-width history on a height-only grow", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const provider = new WidthReplayProvider();
		const renderScheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setResizeScrollback("append");
		tui.setFrameProvider(provider);
		tui.start();
		await renderScheduler.settle(terminal);

		expect(plainBuffer(terminal)).toContain("history-one@20");

		terminal.resize(20, 6); // height-only grow: width unchanged, nothing rewraps
		await renderScheduler.advance(terminal, 160);

		const resized = plainBuffer(terminal);
		expect(provider.resetCount).toBe(0);
		expect(resized.filter(row => row === "history-one@20")).toEqual(["history-one@20"]);
		tui.stop();
	});

	it("skips the destructive rebuild on a height-only zoom grow", async () => {
		const terminal = new CountingTerminal(20, 2);
		const provider = new WidthReplayProvider();
		const renderScheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setResizeScrollback("rebuild");
		tui.setFrameProvider(provider);
		tui.start();
		await renderScheduler.settle(terminal);
		provider.resetCount = 0;
		terminal.writes.length = 0;

		// A tmux zoom toggles the pane height at a constant width: nothing
		// rewraps, so the settled transaction must not clear and re-stream the
		// ledger, and it commits at the normal settle window.
		terminal.resize(20, 6);
		await renderScheduler.advance(terminal, 160);

		expect(provider.resetCount).toBe(0);
		expect(terminal.writes.join("")).not.toContain("\x1b[3J");
		const resized = plainBuffer(terminal);
		expect(resized.filter(row => row === "history-one@20")).toEqual(["history-one@20"]);
		expect(resized).toContain("editor@20");
		tui.stop();
	});

	it("rebuilds on a multiplexer height shrink to repair clipped and pushed live rows", async () => {
		Bun.env.TMUX = "/tmp/tmux-0/default,1,0"; // isInsideTerminalMultiplexer ← authoritative
		try {
			const terminal = new CountingTerminal(20, 6);
			const provider = new WidthReplayProvider();
			const renderScheduler = new VirtualRenderScheduler();
			const tui = new TUI(terminal, undefined, { renderScheduler });
			tui.setResizeScrollback("rebuild");
			tui.setFrameProvider(provider);
			tui.start();
			await renderScheduler.settle(terminal);
			provider.resetCount = 0;
			terminal.writes.length = 0;

			// tmux discards below the cursor first, then pushes above it. A
			// current-width replay must replace that damaged physical copy.
			terminal.resize(20, 2);
			await renderScheduler.advance(terminal, 160);

			expect(provider.resetCount).toBe(1);
			expect(plainBuffer(terminal)).toEqual(["history-one@20", "history-two@20", "editor@20"]);
			tui.stop();
		} finally {
			delete Bun.env.TMUX;
		}
	});

	it("re-anchors retained history after a height grow behind a fullscreen overlay", async () => {
		const history = Array.from({ length: 20 }, (_value, index) => `history-${index}`);
		const terminal = new CountingTerminal(20, 4);
		const provider = new WidthReplayProvider(history);
		const renderScheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setResizeScrollback("append");
		tui.setFrameProvider(provider);
		tui.start();
		await renderScheduler.settle(terminal);

		const overlay = tui.showOverlay(new FullscreenOverlay(), { fullscreen: true });
		await renderScheduler.settle(terminal);
		terminal.resize(20, 12);
		await renderScheduler.settle(terminal);
		terminal.writes.length = 0;
		overlay.hide();
		await renderScheduler.settle(terminal);

		expect(terminal.writes.join("")).toContain("\x1b[6n");

		expect(provider.resetCount).toBe(0);
		expect(plainBuffer(terminal).filter(Boolean)).toEqual([...history.map(row => `${row}@20`), "editor@20"]);
		tui.stop();
	});

	it("rebuilds current-width history without retaining stale rows", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const provider = new WidthReplayProvider();
		const renderScheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setResizeScrollback("rebuild");
		tui.setFrameProvider(provider);
		tui.start();
		await renderScheduler.settle(terminal);

		terminal.resize(30, 2);
		// A refresh-capable settle waits out the 120 ms settle window plus the
		// 40 ms drain horizon and then erases and re-streams the ledger at the
		// settled width in the same transaction.
		await renderScheduler.advance(terminal, 160);

		const resized = plainBuffer(terminal);
		expect(provider.resetCount).toBe(1);
		expect(resized.some(row => row.includes("@20"))).toBe(false);
		expect(resized).toEqual(["history-one@30", "history-two@30", "editor@30"]);
		tui.stop();
	});

	it("commits one history refresh for a resize burst", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const provider = new WidthReplayProvider();
		const renderScheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		tui.setResizeScrollback("rebuild");
		tui.setFrameProvider(provider);
		tui.start();
		await renderScheduler.settle(terminal);
		provider.resetCount = 0;

		// A pane drag delivers every step inside one settle window. Each step
		// repaints the borrowed resize frame at its own geometry, but the
		// transaction that clears and re-streams the ledger waits for 120 ms
		// without another resize.
		for (const width of [30, 32, 34]) {
			terminal.resize(width, 2);
			await renderScheduler.advance(terminal, 60);
			expect(provider.resetCount).toBe(0);
			// The borrowed resize frame tracks the dragged geometry; the ledger
			// refresh — the clear-and-replay this guard exists for — has not run.
			expect(plainBuffer(terminal)).toContain(`editor@${width}`);
		}

		// Drag end: the 120 ms window plus the 40 ms drain horizon elapses and
		// the burst commits exactly one settled refresh.
		await renderScheduler.advance(terminal, 160);

		expect(provider.resetCount).toBe(1);
		expect(plainBuffer(terminal)).toEqual(["history-one@34", "history-two@34", "editor@34"]);
		tui.stop();
	});

	for (const mode of ["rebuild", "append"] as const) {
		it(`refreshes history in ${mode} mode after a burst that returns to its starting width`, async () => {
			const terminal = new VirtualTerminal(20, 2);
			const provider = new WidthReplayProvider();
			const renderScheduler = new VirtualRenderScheduler();
			const tui = new TUI(terminal, undefined, { renderScheduler });
			tui.setResizeScrollback(mode);
			tui.setFrameProvider(provider);
			tui.start();
			await renderScheduler.settle(terminal);
			provider.resetCount = 0;

			// A drag out and back coalesces into one transaction whose settled size
			// equals the committed one, but the terminal reflowed the normal buffer
			// at the intermediate width. Gating the refresh on the net change left
			// that reflow's stale rows stacked above the repainted viewport.
			terminal.resize(30, 2);
			await renderScheduler.advance(terminal, 60);
			terminal.resize(20, 2);
			// The re-armed 120 ms settle window plus the 40 ms drain horizon
			// elapses, and the burst commits one refresh even though its settled
			// size equals the committed one.
			await renderScheduler.advance(terminal, 160);

			expect(provider.resetCount).toBe(1);
			tui.stop();
		});
	}
});
