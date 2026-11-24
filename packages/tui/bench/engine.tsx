/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * pi-tui engine benchmark: Markdown, the md painter and the terminal frame engine.
 *
 * - `coldMarkdownMs`: one uncached `renderMarkdown` of the document at width 120.
 * - `streamDocMs`: the document streamed through the md painter in 40-char chunks
 *   (paint cache + stable heads), one `paintNode` per chunk.
 * - `firstFrameMs`: the first frame of N Markdown blocks on the real `TermBackend`
 *   and terminal driver/FrameWriter.
 * - `tickFrameMs` / `bytesPerTick`: one dock status update repainted over those
 *   N blocks, and the bytes it writes.
 *
 * Usage: `bun bench/engine.tsx [--n 300] [--settle] [--doc path.md]`
 * (`N=…`, `SETTLE=1` and `DOC=…` env work too). `--settle` settles the blocks
 * before the tick frames, as finished transcript history is.
 */
import { parseArgs } from "node:util";
import type { UiNode } from "@oh-my-pi/pi-tui";

// Dynamic imports on purpose: `importMs` times loading the engine.
const T0 = performance.now();
const ui = await import("@oh-my-pi/pi-tui");
const { TermBackend } = await import("@oh-my-pi/pi-tui/term/backend");
await import("@oh-my-pi/pi-tui/term/painters/index");
const { paintNode, staticEnvironment } = await import("@oh-my-pi/pi-tui/term/paint");
const { renderMarkdown } = await import("@oh-my-pi/pi-tui/text/markdown/index");
const { loadThemeSync } = await import("@oh-my-pi/pi-tui/theme/loader");
const { createTerminalDriver } = await import("@oh-my-pi/pi-tui/driver/index");
const importMs = performance.now() - T0;

const { values: flags } = parseArgs({
	options: {
		n: { type: "string" },
		settle: { type: "boolean" },
		doc: { type: "string" },
	},
});
const N = Number(flags.n ?? Bun.env.N ?? 300);
if (!Number.isSafeInteger(N) || N <= 0) throw new Error(`Expected a positive block count, got ${flags.n ?? Bun.env.N}`);
const SETTLE = flags.settle ?? (Bun.env.SETTLE !== undefined && Bun.env.SETTLE !== "" && Bun.env.SETTLE !== "0");
const docPath = flags.doc ?? Bun.env.DOC;

/** A ~2.5 KB document exercising every Markdown construct the painter handles. */
function corpus(): string {
	const sections: string[] = [];
	for (let i = 1; i <= 4; i++) {
		sections.push(
			`## Section ${i}`,
			"Prose with **bold**, _italic_, `inline code`, a [link](https://example.com/docs) and 🚀 emoji, " +
				"long enough to wrap at the narrower widths the transcript uses.",
			"> A quote with **bold** text.\n>\n> > Nested quote\n> > with two lines\n>\n> - list in quote\n> - second",
			"> [!NOTE]\n> A GitHub-style note callout with `code`.",
			"- first bullet\n- second bullet with `inline`\n  - nested bullet\n1. ordered\n2. items",
			"```ts\nconst total = items.reduce((sum, item) => sum + item.cost, 0);\nreturn total.toFixed(2);\n```",
			"| Column | Value | Notes |\n| --- | ---: | --- |\n| alpha | 1 | first row |\n| beta | 22 | second **row** |",
		);
	}
	return sections.join("\n\n");
}

const theme = loadThemeSync("dark");
const DOC = docPath ? await Bun.file(docPath).text() : corpus();
const W = 120;
const H = 40;

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)]!;
}
function time(fn: () => void, n: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < n; i++) {
		const t = performance.now();
		fn();
		out.push(performance.now() - t);
	}
	return out;
}

// A. Cold markdown render (a nonce defeats the render cache).
let k = 0;
for (let i = 0; i < 20; i++) renderMarkdown(`${DOC}\n\nwarm ${k++}`, W, { theme, paddingX: 1 });
const coldMd = median(time(() => renderMarkdown(`${DOC}\n\nrun ${k++}`, W, { theme, paddingX: 1 }), 200));

// B. Streaming through the md painter (paint cache + stable heads), 40-char chunks.
function stream(): void {
	const text = ui.signal("");
	const env = staticEnvironment(theme);
	ui.createRoot(dispose => {
		const node = (<md text={text} stream />) as UiNode;
		const nonce = `<!-- ${k++} -->\n`;
		for (let i = 40; i <= DOC.length; i += 40) {
			text.set(nonce + DOC.slice(0, i));
			paintNode(env, node, W);
		}
		dispose();
	});
}
stream();
const streamMs = median(time(stream, 15));

// C. Frame engine: real TermBackend + real driver/FrameWriter; the sink counts bytes.
class FakeInput {
	columns = W;
	rows = H;
	capabilities = {
		truecolor: true,
		colors: 16777216,
		synchronizedOutput: true,
		hyperlinks: false,
		images: null,
		kittyKeyboard: false,
		bracketedPaste: true,
		background: null,
		dark: true,
		cell: null,
		multiplexer: null,
		textSizing: false,
		tsp: false,
	};
	identity = { id: "kitty", multiplexer: null, ssh: false, conpty: false, version: null };
	async start() {}
	async stop() {}
	onInput() {
		return () => {};
	}
	onResize() {
		return () => {};
	}
	onDisconnect() {
		return () => {};
	}
	onCapabilities() {
		return () => {};
	}
	setTitle() {}
	setMouse() {}
	refreshAppearance() {}
	keyboardScreenModes() {
		return { enterAlt: "", leaveAltBefore: "", leaveAltAfter: "" };
	}
	async queryCursor() {
		return { row: 0, col: 0 };
	}
	passthrough(s: string) {
		return s;
	}
}

async function buildUi(blocks: number) {
	let written = 0;
	const driver = createTerminalDriver({
		env: {},
		sink: {
			write: d => {
				written += d.length;
			},
			flush: async () => {},
		},
		input: () => new FakeInput() as never,
	});
	await driver.start();
	const status = ui.signal("⠋ Working… 0s");
	const nonce = k++;
	const span = Math.max(1, DOC.length - 600);
	const surface = ui.createSurface(() => ({
		main: Array.from({ length: blocks }, (_, i) => (
			<md text={`### Block ${i} ${nonce}\n\n${DOC.slice((i * 97) % span, ((i * 97) % span) + 600)}`} />
		)),
		dock: <text text={status} />,
	}));
	if (SETTLE) for (const node of surface.main()) ui.settle(node);
	const backend = new TermBackend({ surface, driver, theme: () => theme, frameInterval: 1e9 });
	return { backend, surface, status, written: () => written };
}

const firstFrames: number[] = [];
for (let r = 0; r < 7; r++) {
	const b = await buildUi(N);
	const t = performance.now();
	b.backend.start();
	firstFrames.push(performance.now() - t);
	b.backend.stop();
	b.surface.dispose();
}

const TICKS = 300;
const b = await buildUi(N);
b.backend.start();
const before = b.written();
let tick = 0;
const ticks = time(() => {
	b.status.set(`⠙ Working… ${tick++}s`);
	b.backend.renderNow();
}, TICKS);
const bytesPerTick = (b.written() - before) / TICKS;
b.backend.stop();
b.surface.dispose();

console.log(
	JSON.stringify({
		blocks: N,
		settle: SETTLE,
		docBytes: DOC.length,
		importMs: +importMs.toFixed(1),
		coldMarkdownMs: +coldMd.toFixed(3),
		streamDocMs: +streamMs.toFixed(1),
		firstFrameMs: +median(firstFrames.slice(2)).toFixed(2),
		tickFrameMs: +median(ticks.slice(20)).toFixed(3),
		bytesPerTick: Math.round(bytesPerTick),
		heapMB: +(process.memoryUsage().heapUsed / 1e6).toFixed(1),
	}),
);
process.exit(0);
