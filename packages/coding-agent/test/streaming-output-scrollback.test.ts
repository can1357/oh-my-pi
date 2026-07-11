import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { ToolExecutionComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/transcript-container";
import { theme as activeTheme, initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { evalToolRenderer } from "@pk-nerdsaver-ai/pi-coding-agent/tools/eval-render";
import { previewWindowRows } from "@pk-nerdsaver-ai/pi-coding-agent/tools/render-utils";
import { type Component, TUI } from "@pk-nerdsaver-ai/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

// Long, path-like output that wraps at the box's inner width — the case that
// made a fixed 10-line preview overflow the viewport once committed.
function longLines(count: number): string {
	return Array.from(
		{ length: count },
		(_, i) => `out-line-${i} ${"=".repeat(60)} https://example.com/very/long/path/segment/${i}`,
	).join("\n");
}

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
		flush() {
			let guard = 0;
			while (queue.length > 0) {
				if (++guard > 100_000) throw new Error("scheduler did not settle");
				const item = queue.shift()!;
				clock += 1;
				if (!item.cancelled) item.run();
			}
		},
	};
}

// Plain Component → finalized by default: a settled block above the live region.
class StaticBlock implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = lines;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return this.#lines;
	}
}

// A still-live predecessor (e.g. a parallel tool that is still running): being
// non-finalized closes the transcript's commit-safe run, so the streaming tool
// below it commits as forced-overflow — the path that sprayed.
class LiveBarrier extends StaticBlock {
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
	isTranscriptBlockCommitStable(): boolean {
		return true;
	}
}

// Stand-in for the input editor + status drawn below the transcript.
class Footer implements Component {
	#rows: number;
	constructor(rows: number) {
		this.#rows = rows;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return Array.from({ length: this.#rows }, (_, i) => `editor-${i}`);
	}
}

const ORIGINAL_ROWS = Object.getOwnPropertyDescriptor(process.stdout, "rows");
function stubStdoutRows(rows: number): void {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
}

describe("streaming tool output never sprays duplicate scrollback banners", () => {
	beforeAll(async () => {
		await initTheme();
	});
	afterEach(() => {
		if (ORIGINAL_ROWS) Object.defineProperty(process.stdout, "rows", ORIGINAL_ROWS);
		else Reflect.deleteProperty(process.stdout, "rows");
	});

	test("bash: growing partial output under a live predecessor does not duplicate banners", async () => {
		if (process.platform === "win32") return;
		const rows = 14;
		stubStdoutRows(rows);
		const term = new VirtualTerminal(80, rows);
		const scheduler = makeDrainableScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new TranscriptContainer();
		transcript.addChild(new StaticBlock(["user: run the build"]));
		transcript.addChild(new LiveBarrier(["assistant: still working in a parallel tool…"]));
		const bash = new ToolExecutionComponent("bash", { command: "build.sh" }, {}, undefined, tui, process.cwd());
		transcript.addChild(bash);
		tui.addChild(transcript);
		tui.addChild(new Footer(6));

		try {
			tui.start();
			scheduler.flush();
			await term.flush();
			for (let n = 1; n <= 40; n++) {
				bash.updateResult({ content: [{ type: "text", text: longLines(n) }], isError: false }, true);
				term.scrollLines(1000);
				tui.requestRender();
				scheduler.flush();
				await term.flush();
			}
			const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			const banners = buffer.filter(row => row.includes("ctrl+o")).length;
			// Pre-fix this re-committed a fresh snapshot per streamed frame (~30+).
			expect(banners).toBeLessThanOrEqual(1);
		} finally {
			bash.stopAnimation();
			tui.stop();
			await term.flush();
		}
	}, 30_000);

	test("eval: collapsed cell output stays within the viewport budget", () => {
		const rows = 18;
		stubStdoutRows(rows);
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				cells: [
					{ index: 0, code: "run()", language: "js" as const, output: longLines(60), status: "running" as const },
				],
			},
			isError: false,
		};
		const component = evalToolRenderer.renderResult(result, { expanded: false, isPartial: true }, activeTheme);
		const lines = component.render(80);
		// The collapsed cell box fits the viewport budget: code + output tails are
		// each capped at previewWindowRows() VISUAL rows. Pre-fix the long output
		// wrapped into ~2x its line count and blew past this.
		expect(lines.length).toBeLessThanOrEqual(previewWindowRows() + 10);
		expect(lines.map(line => Bun.stripANSI(line)).join("\n")).toContain("ctrl+o");
	});
});
