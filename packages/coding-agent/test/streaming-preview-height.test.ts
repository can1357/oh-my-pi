import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EDIT_MODE_STRATEGIES } from "@oh-my-pi/pi-coding-agent/edit";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { theme as activeTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { previewWindowRows } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

// The streaming edit preview is a fixed-height tail window ("cursor"): the last
// EDIT_STREAMING_PREVIEW_LINES rows of the recomputed diff are pinned to the
// bottom, so the box stays a steady, full window of real diff context.
//
// A whole-file Myers re-diff is recomputed on every streamed chunk; its optimal
// alignment is not monotonic in payload length, so a hunk-aware window that kept
// whole change segments grew and shrank tick to tick (the stutter), and the
// earlier high-water fix padded the deficit with blank rows (the "large
// rectangle that is half empty" regression). The tail window has neither.
withoutTerminalMultiplexer();

describe("streaming edit preview height (stable, full tail window)", () => {
	const oldBlock = ["function foo() {", "  const x = 1;", "  return x;", "}"].join("\n");
	const tail = ["", "function bar() {", "  return 2;", "}", "", "function baz() {", "  return 3;", "}", ""].join("\n");
	const fileContent = `${oldBlock}\n${tail}`;
	const fullNew = [
		"function foo() {",
		"  const x = 1;",
		"  const y = 2;",
		"  const z = 3;",
		"  return x + y + z;",
		"}",
	].join("\n");

	let tmpDir: string;
	let file: string;
	let themed = false;

	// The streaming edit window is sized as min(EDIT_STREAMING_PREVIEW_LINES,
	// previewWindowRows()), and previewWindowRows() reads process.stdout.rows.
	// Pin a tall, stable viewport so the "full window of real diff" height
	// assertions don't shrink (and flake) under a short ambient terminal when the
	// file runs inside the full suite. Restored in afterAll.
	let originalRowsDescriptor: PropertyDescriptor | undefined;
	beforeAll(() => {
		originalRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { value: 50, configurable: true });
	});
	afterAll(() => {
		if (originalRowsDescriptor) {
			Object.defineProperty(process.stdout, "rows", originalRowsDescriptor);
		} else {
			delete (process.stdout as { rows?: number }).rows;
		}
	});

	beforeEach(async () => {
		if (!themed) {
			await initTheme();
			themed = true;
		}
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-height-"));
		file = path.join(tmpDir, "mod.ts");
		await fs.writeFile(file, fileContent);
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tmpDir });
	});

	afterEach(async () => {
		resetSettingsForTest();
		await removeWithRetries(tmpDir);
	});

	// Char-by-char partials of the new function body.
	const partials = Array.from({ length: fullNew.length }, (_, i) => fullNew.slice(0, i + 1));

	// Deterministic render scheduler. The live TUI throttles renders behind
	// setTimeout (~33ms/frame) and resize settles, and the harness's
	// waitForRender sleeps 40ms per settle, so a finalization loop burns ~16
	// real frame waits in wall-clock time for cadence this test never asserts.
	// This queue-backed scheduler records every immediate/throttled render the
	// TUI requests (including resize-settle repaints) and replays them on demand
	// via flush(), so the scrollback-replace and stable-window contracts are
	// driven by explicit render flushes instead of the clock.
	type DrainableScheduler = {
		now(): number;
		scheduleImmediate(cb: () => void): void;
		scheduleRender(cb: () => void, delayMs: number): { cancel(): void };
		flush(): void;
	};
	function makeDrainableScheduler(): DrainableScheduler {
		let clock = 0;
		const queue: Array<{ run: () => void; cancelled: boolean }> = [];
		const enqueue = (cb: () => void) => {
			const item = { run: cb, cancelled: false };
			queue.push(item);
			return item;
		};
		return {
			now: () => clock,
			scheduleImmediate(cb) {
				enqueue(cb);
			},
			scheduleRender(cb) {
				const item = enqueue(cb);
				return {
					cancel() {
						item.cancelled = true;
					},
				};
			},
			// Drain to quiescence: a render callback may queue follow-up renders
			// (the post-frame re-schedule, a resize settle's forced clear), which
			// this loop picks up. The guard trips only on a pathological render
			// that re-arms itself unconditionally.
			flush() {
				let guard = 0;
				while (queue.length > 0) {
					if (++guard > 100_000) throw new Error("render scheduler did not settle");
					const item = queue.shift()!;
					clock += 1;
					if (!item.cancelled) item.run();
				}
			},
		};
	}

	// Real TUI + virtual terminal harness: drives the component through the
	// actual differential renderer so native scrollback (not just the in-memory
	// component height) is exercised. Mirrors makeComponent's construction but
	// swaps the stub for a live TUI wired to a kitty-vt-backed terminal and the
	// drainable scheduler in place of wall-clock frame timers.
	function makeTuiComponent(): {
		component: ToolExecutionComponent;
		term: VirtualTerminal;
		tui: TUI;
		scheduler: DrainableScheduler;
	} {
		const term = new VirtualTerminal(80, 8);
		const scheduler = makeDrainableScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const tool = { mode: "replace" } as unknown as AgentTool;
		const component = new ToolExecutionComponent(
			"edit",
			{ path: file, old_string: oldBlock, new_string: fullNew.slice(0, 1) },
			{},
			tool,
			tui,
			tmpDir,
		);
		tui.addChild(component);
		return { component, term, tui, scheduler };
	}

	// Settle the preview deterministically: await the off-render-path diff
	// recompute kicked off by the latest updateArgs/setArgsComplete (its
	// completion is what queues the preview's render), then replay every queued
	// render synchronously and drain the terminal — no frame/animation sleeps.
	async function settleTerminal(
		component: ToolExecutionComponent,
		scheduler: DrainableScheduler,
		term: VirtualTerminal,
	): Promise<void> {
		await component.whenPreviewSettled();
		scheduler.flush();
		await term.flush();
	}

	// Whole native buffer (scrollback + viewport) with trailing padding trimmed.
	function normalizedBufferRows(term: VirtualTerminal): string[] {
		return term.getScrollBuffer().map(row => row.trimEnd());
	}

	test("stays a stable, full window (no half-empty padded box) while streaming", async () => {
		// A large oscillating diff: replace a block of duplicate-ish lines so the
		// recomputed alignment gains and loses rows tick to tick. The diff outgrows
		// the window from the first chunk, so the tail window stays saturated and
		// the box height must hold steady — without padding the deficit with blanks.
		const RENDER_WIDTH_WIDE = 100;
		const dup = Array.from({ length: 24 }, () => "\tstep();").join("\n");
		const bigOld = `function gen() {\n${dup}\n\treturn out;\n}`;
		const bigTail = `\nfunction other() {\n${dup}\n\treturn 0;\n}\n`;
		const bigFile = path.join(tmpDir, "big.ts");
		await fs.writeFile(bigFile, `${bigOld}\n${bigTail}`);
		const bigNew = [
			"function gen() {",
			...Array.from({ length: 24 }, (_v, i) => `\tconst k${i} = ${i};`),
			"\treturn out;",
			"}",
		].join("\n");
		// Stream a line at a time ("as lines come in"): each chunk recomputes the
		// whole-file diff, which the tail window pins to its last rows.
		const bigLines = bigNew.split("\n");
		const bigPartials = bigLines.map((_v, i) => bigLines.slice(0, i + 1).join("\n"));

		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const tool = { mode: "replace" } as unknown as AgentTool;
		const component = new ToolExecutionComponent(
			"edit",
			{ path: bigFile, old_string: bigOld, new_string: bigNew.slice(0, 1) },
			{},
			tool,
			uiStub,
			tmpDir,
		);
		// Await the actual diff recompute rather than racing the spinner's render
		// ticks. The streaming spinner calls requestRender every ~33ms, so on a
		// slow box a tick — not the (file-read + whole-file Myers) compute — would
		// resolve the wait and let us sample a stale, mid-abort preview. That is the
		// CI flake that collapsed Math.min(...steady) to 4. whenPreviewSettled()
		// resolves only when this chunk's recompute has updated the preview.
		await component.whenPreviewSettled();

		const trailingBlankRows = (rows: readonly string[]): number => {
			let n = 0;
			for (let i = rows.length - 1; i >= 0; i--) {
				if (rows[i].replace(/\x1b\[[0-9;]*m/gu, "").trimEnd() === "") n++;
				else break;
			}
			return n;
		};

		const heights: number[] = [];
		let maxTrailingBlank = 0;
		for (const newText of bigPartials) {
			component.updateArgs({ path: bigFile, old_string: bigOld, new_string: newText });
			await component.whenPreviewSettled();
			const rows = component.render(RENDER_WIDTH_WIDE);
			heights.push(rows.length);
			maxTrailingBlank = Math.max(maxTrailingBlank, trailingBlankRows(rows));
		}

		// Finalize still renders a real diff.
		component.setArgsComplete();
		await component.whenPreviewSettled();
		const finalizedHeight = component.render(RENDER_WIDTH_WIDE).length;
		component.stopAnimation();

		// The tail window saturates immediately and the box height holds dead
		// steady for the rest of the stream — it neither stutters larger/smaller
		// (the pre-fix overshoot) nor balloons to a high-water peak. Only the very
		// first chunk is a warmup (the unbalanced-removal stabilizer trims the
		// removals-only diff before any addition arrives).
		const steady = heights.slice(1);
		expect(steady.length).toBeGreaterThan(5);
		expect(Math.min(...steady)).toBeGreaterThan(12); // a full window of real diff
		expect(Math.max(...steady) - Math.min(...steady)).toBe(0);
		// And it is never padded into a half-empty rectangle (the regression).
		expect(maxTrailingBlank).toBeLessThanOrEqual(1);
		expect(finalizedHeight).toBeGreaterThan(1);
	}, 30_000);

	test("real TUI finalization leaves no preview at or below the committed diff", async () => {
		const previewPrefix = "PREVIEW_ONLY_STREAM_SENTINEL_";
		const finalSentinel = "FINAL_RESULT_SENTINEL_committed_edit";
		const streamedReplacements = Array.from({ length: 12 }, (_unused, i) =>
			[
				"function foo() {",
				"  const x = 1;",
				...Array.from({ length: 10 + (i % 5) }, (_value, j) => `  const p${j} = "${previewPrefix}${i}_${j}";`),
				`  return "${previewPrefix}${i}_tail";`,
				"}",
			].join("\n"),
		);
		const finalDiff = [
			"@@ -1,4 +1,5 @@",
			" function foo() {",
			"   const x = 1;",
			"-  return x;",
			`+  const finalValue = "${finalSentinel}";`,
			"+  return finalValue;",
			" }",
		].join("\n");
		const { component, term, tui, scheduler } = makeTuiComponent();

		try {
			tui.start();
			await settleTerminal(component, scheduler, term);

			let maxStreamingHeight = 0;
			let sawPreviewSentinel = false;
			const streamingStepCount = streamedReplacements.length;
			const lifecycleSteps = [
				...streamedReplacements.map((newText, i) => () => {
					component.updateArgs({ path: file, old_string: oldBlock, new_string: newText });
					if (i % 4 === 1) {
						component.setExpanded(true);
					} else if (i % 4 === 3) {
						component.setExpanded(false);
					}
					if (i % 5 === 2) {
						term.resize(68, 7);
					} else if (i % 5 === 4) {
						term.resize(72, 8);
					}
				}),
				() => {
					component.setArgsComplete();
				},
				() => {
					component.updateResult(
						{
							content: [{ type: "text", text: finalSentinel }],
							details: { path: file, diff: finalDiff, firstChangedLine: 3 },
						},
						false,
					);
					component.setExpanded(true);
					term.resize(70, 9);
				},
			];

			for (const [i, applyStep] of lifecycleSteps.entries()) {
				applyStep();
				term.scrollLines(1_000);
				tui.requestRender(i % 3 === 0 || i >= streamingStepCount);
				await settleTerminal(component, scheduler, term);

				if (i < streamingStepCount) {
					const rows = normalizedBufferRows(term);
					sawPreviewSentinel ||= rows.some(row => row.includes(previewPrefix));
					maxStreamingHeight = Math.max(maxStreamingHeight, component.render(term.columns).length);
					expect(term.isNativeViewportAtBottom()).toBe(true);
				}
			}

			expect(sawPreviewSentinel).toBe(true);
			expect(maxStreamingHeight).toBeGreaterThan(term.rows);

			term.scrollLines(1_000);
			await settleTerminal(component, scheduler, term);

			// Mid-stream shrinks make the terminal reflow-push live preview rows into
			// scrollback before the app hears about the resize; an inline app cannot
			// erase another buffer's history without ED3 (forbidden outside explicit
			// user gestures). The enforceable contract: the finalized diff is
			// present, appears exactly once, and no preview row survives at or
			// below it — the screen itself ends preview-free.
			const bufferRows = normalizedBufferRows(term);
			const finalRows = bufferRows.filter(row => row.includes(finalSentinel));
			expect(finalRows.length).toBe(1);
			const firstFinal = bufferRows.findIndex(row => row.includes(finalSentinel));
			expect(bufferRows.slice(firstFinal).some(row => row.includes(previewPrefix))).toBe(false);
			const screenText = term
				.getViewport()
				.map(row => Bun.stripANSI(row).trimEnd())
				.join("\n");
			expect(screenText).toContain(finalSentinel);
			expect(screenText).not.toContain(previewPrefix);
		} finally {
			component.stopAnimation();
			tui.stop();
			await term.flush();
		}
		// Real TUI + Ghostty WASM integration can exceed Bun's default budget on CI:
		// startup, repeated native scrollback refreshes, and throttled render frames are
		// intentionally exercised here. Keep the contract assertions above; only widen
		// the integration-test budget.
	}, 30_000);

	test("the underlying diff genuinely oscillates (guard against a vacuous test)", async () => {
		const ctx = {
			cwd: tmpDir,
			signal: new AbortController().signal,
			snapshots: undefined as never,
			allowFuzzy: true,
			isStreaming: true,
		};
		const rawLineCounts: number[] = [];
		for (const newText of partials) {
			const previews = await EDIT_MODE_STRATEGIES.replace.computeDiffPreview(
				{ path: file, old_string: oldBlock, new_string: newText },
				ctx,
			);
			const first = previews?.[0];
			const diff = first && "diff" in first ? (first.diff ?? "") : "";
			rawLineCounts.push(diff ? diff.split("\n").length : 0);
		}
		const hasDecrease = rawLineCounts.some((count, i) => i > 0 && count < rawLineCounts[i - 1]);
		expect(hasDecrease).toBe(true);
	}, 30_000);
});

describe("streaming tool call preview height (bounded across renderers)", () => {
	beforeAll(async () => {
		// `evalToolRenderer.renderCall` walks the theme during highlighting; the
		// bash/eval pending previews exercised below DO NOT read
		// `settings.*`, so the global Settings singleton is intentionally left
		// untouched here. Resetting/initialising it in `beforeEach` raced with
		// parallel test files that do the same dance (issue #2582), flipping the
		// proxy under us and timing the eval test out.
		await initTheme();
	});
	function renderPending(toolName: string, args: unknown): { lines: readonly string[]; text: string } {
		const term = new VirtualTerminal(80, 20);
		const tui = new TUI(term);
		const component = new ToolExecutionComponent(toolName, args, {}, undefined, tui, process.cwd());
		try {
			const lines = component.render(80);
			return { lines, text: lines.map(line => Bun.stripANSI(line)).join("\n") };
		} finally {
			component.stopAnimation();
		}
	}

	function getRenderedLines(lines: readonly string[]): string[] {
		return lines
			.map(line => Bun.stripANSI(line).trim())
			.filter(line => line.startsWith("│") && line.endsWith("│"))
			.map(line => line.slice(1, -1).trim())
			.filter(line => line !== "" && !line.includes("earlier lines"));
	}

	test("framed inline tool previews span the full tool width", () => {
		const width = 80;
		const { lines } = renderPending("bash", { command: "echo hi" });
		const strippedLines = lines.map(line => Bun.stripANSI(line));
		const topBorder = strippedLines.find(line => line.includes(activeTheme.boxRound.topLeft));

		expect(topBorder).toBeDefined();
		expect(topBorder?.[0]).toBe(activeTheme.boxRound.topLeft);
		expect(topBorder?.endsWith(activeTheme.boxRound.topRight)).toBe(true);
		expect(visibleWidth(topBorder ?? "")).toBe(width);
	});

	test("bash pending previews stay short even with very long multiline args", () => {
		// bash windows the collapsed command to a viewport-sized TAIL: the end
		// (the live edge while args stream) stays visible behind an "… N earlier
		// lines" marker on top; the head is elided.
		const window = previewWindowRows();
		const total = window + 5;
		const longLines = Array.from({ length: total }, (_, i) => `line-${i}`);
		// Tail window = marker row + the last (window - 1) command lines.
		const hidden = total - (window - 1);
		const lastHidden = `line-${hidden - 1}`;
		const firstVisible = `line-${hidden}`;
		const lastVisible = `line-${total - 1}`;
		const cases: Array<{ name: string; args: unknown }> = [{ name: "bash", args: { command: longLines.join("\n") } }];

		for (const testCase of cases) {
			const { lines, text } = renderPending(testCase.name, testCase.args);
			expect(lines.length, `${testCase.name} preview should stay bounded`).toBeLessThan(window + 10);
			const renderedLines = getRenderedLines(lines);
			expect(renderedLines, `${testCase.name} preview should keep ${firstVisible}`).toContain(firstVisible);
			expect(renderedLines, `${testCase.name} preview should keep ${lastVisible}`).toContain(lastVisible);
			expect(renderedLines, `${testCase.name} preview should elide line-0`).not.toContain("line-0");
			expect(renderedLines, `${testCase.name} preview should elide ${lastHidden}`).not.toContain(lastHidden);
			expect(text, `${testCase.name} preview should advertise the elided head`).toContain(
				`… ${hidden} earlier lines`,
			);
		}
	}, 30_000);

	test("eval pending preview windows the code to the viewport tail", () => {
		// Eval cell code is capped to the same viewport-sized TAIL window as
		// bash: the live edge stays visible behind an "… N earlier lines"
		// marker on top; ctrl+o uncaps. Unlike bash, the marker row sits above
		// the window, so previewWindowRows() code lines stay visible.
		const window = previewWindowRows();
		const total = window + 5;
		const hidden = total - window;
		// Underscore identifiers: the display formatter would space `line-1` as a
		// subtraction, and this test asserts windowing, not operator layout.
		const longLines = Array.from({ length: total }, (_, i) => `line_${i}`);
		const { lines, text } = renderPending("eval", {
			language: "js",
			title: "big",
			code: longLines.map(line => `const ${line} = 1;`).join("\n"),
		});

		expect(lines.length, "eval code preview should stay bounded").toBeLessThan(window + 10);
		const renderedLines = getRenderedLines(lines);
		expect(renderedLines).toContain(`const line_${total - 1} = 1;`);
		expect(renderedLines).toContain(`const line_${hidden} = 1;`);
		expect(renderedLines).not.toContain("const line_0 = 1;");
		expect(renderedLines).not.toContain(`const line_${hidden - 1} = 1;`);
		expect(text).toContain(`… ${hidden} earlier lines`);
	}, 30_000);
});
