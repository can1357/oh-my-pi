/**
 * Project-local `tui` tool: run and debug pi-tui apps headlessly. Each session
 * spawns a TypeScript/JavaScript entry or executable on a Bun-native PTY — a
 * real controlling terminal, so capability probes, SIGWINCH resizes, and
 * immediate-mode hosts all behave as in production — with `OMP_TUI_DEBUG`
 * pointed at the unix socket served by an omp/pi-tui host. Injected input
 * rides the app's own input path, while renderer and component queries inspect
 * the last painted frame.
 *
 * kitty's real terminal core (screen.c + vt-parser.c via kitty-vt-wasm)
 * tracks every PTY byte, so `screen` (and the socketless `text` fallback)
 * render any app's display exactly as kitty would — SGR, rewrap-on-resize,
 * scrollback, graphemes/wide chars — and input ops echo an after-screenshot.
 * Query replies the core generates (DA, DECRQSS, XTGETTCAP, OSC color queries)
 * are written back to the child, so capability probes resolve as on a real
 * terminal instead of timing out.
 *
 * Sessions live in this module for the lifetime of the agent session; the
 * child and its terminal are torn down on `stop` or shutdown.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { inflateSync } from "node:zlib";
import type * as CanvasModule from "@napi-rs/canvas";
import type * as KittyVt from "kitty-vt-wasm";
import type { Color, KittyEvent, KittyTerminal } from "kitty-vt-wasm";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Minimal slice of the host schema builder (`omp.zod`) this tool uses. */
interface Schema {
	describe(text: string): Schema;
	optional(): Schema;
}
interface SchemaBuilder {
	object(shape: Record<string, Schema>): Schema;
	string(): Schema;
	boolean(): Schema;
	number(): Schema;
	array(item: Schema): Schema;
}
/** Minimal slice of `CustomToolAPI` this tool uses. */
interface ToolHost {
	cwd: string;
	zod: SchemaBuilder;
}
interface ToolUpdate {
	content: { type: "text"; text: string }[];
	details?: Record<string, unknown>;
}
interface ToolResult {
	content: (
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string }
	)[];
	details?: Record<string, unknown>;
}

/** Parameter object accepted by the tool's `execute`. */
export interface TuiParams {
	op:
		| "start"
		| "stop"
		| "list"
		| "text"
		| "screen"
		| "frame"
		| "tree"
		| "values"
		| "info"
		| "keys"
		| "type"
		| "paste"
		| "mouse"
		| "send"
		| "resize"
		| "raw"
		| "shot";
	name?: string;
	file?: string;
	bin?: string;
	args?: string[];
	rows?: number;
	cols?: number;
	keys?: string;
	text?: string;
	x?: number;
	y?: number;
	action?: string;
	peek?: number;
	clear?: boolean;
	quiet?: boolean;
	timeout?: number;
}

// ─── VT screen emulator ──────────────────────────────────────────────────────

/** Lazily loaded kitty-vt-wasm module: a missing install degrades `start`, not module load. */
let vtApi: Promise<typeof KittyVt> | null = null;

function loadVt() {
	// Lazy import: a missing optional install must degrade `start`, not fail tool load.
	vtApi ??= import("kitty-vt-wasm").catch((error) => {
		vtApi = null;
		throw new Error(
			`screen emulation needs kitty-vt-wasm — run \`bun install\` in .omp/tools (${error})`,
		);
	});
	return vtApi;
}
/** Decoded kitty-graphics command (the lib exports it only inside the event union). */
type GraphicsCommand = Extract<KittyEvent, { type: "graphics_command" }>;

/**
 * kitty's row/column diacritics (gen/rowcolumn-diacritics.txt): the Nth
 * combining mark on a U+10EEEE image-placeholder cell encodes tile row/col N.
 */
const ROWCOL_DIACRITICS =
	"0305,030D,030E,0310,0312,033D,033E,033F,0346,034A,034B,034C,0350,0351,0352,0357,035B,0363," +
	"0364,0365,0366,0367,0368,0369,036A,036B,036C,036D,036E,036F,0483,0484,0485,0486,0487,0592," +
	"0593,0594,0595,0597,0598,0599,059C,059D,059E,059F,05A0,05A1,05A8,05A9,05AB,05AC,05AF,05C4," +
	"0610,0611,0612,0613,0614,0615,0616,0617,0657,0658,0659,065A,065B,065D,065E,06D6,06D7,06D8," +
	"06D9,06DA,06DB,06DC,06DF,06E0,06E1,06E2,06E4,06E7,06E8,06EB,06EC,0730,0732,0733,0735,0736," +
	"073A,073D,073F,0740,0741,0743,0745,0747,0749,074A,07EB,07EC,07ED,07EE,07EF,07F0,07F1,07F3," +
	"0816,0817,0818,0819,081B,081C,081D,081E,081F,0820,0821,0822,0823,0825,0826,0827,0829,082A," +
	"082B,082C,082D,0951,0953,0954,0F82,0F83,0F86,0F87,135D,135E,135F,17DD,193A,1A17,1A75,1A76," +
	"1A77,1A78,1A79,1A7A,1A7B,1A7C,1B6B,1B6D,1B6E,1B6F,1B70,1B71,1B72,1B73,1CD0,1CD1,1CD2,1CDA," +
	"1CDB,1CE0,1DC0,1DC1,1DC3,1DC4,1DC5,1DC6,1DC7,1DC8,1DC9,1DCB,1DCC,1DD1,1DD2,1DD3,1DD4,1DD5," +
	"1DD6,1DD7,1DD8,1DD9,1DDA,1DDB,1DDC,1DDD,1DDE,1DDF,1DE0,1DE1,1DE2,1DE3,1DE4,1DE5,1DE6,1DFE," +
	"20D0,20D1,20D4,20D5,20D6,20D7,20DB,20DC,20E1,20E7,20E9,20F0,2CEF,2CF0,2CF1,2DE0,2DE1,2DE2," +
	"2DE3,2DE4,2DE5,2DE6,2DE7,2DE8,2DE9,2DEA,2DEB,2DEC,2DED,2DEE,2DEF,2DF0,2DF1,2DF2,2DF3,2DF4," +
	"2DF5,2DF6,2DF7,2DF8,2DF9,2DFA,2DFB,2DFC,2DFD,2DFE,2DFF,A66F,A67C,A67D,A6F0,A6F1,A8E0,A8E1," +
	"A8E2,A8E3,A8E4,A8E5,A8E6,A8E7,A8E8,A8E9,A8EA,A8EB,A8EC,A8ED,A8EE,A8EF,A8F0,A8F1,AAB0,AAB2," +
	"AAB3,AAB7,AAB8,AABE,AABF,AAC1,FE20,FE21,FE22,FE23,FE24,FE25,FE26,10A0F,10A38,1D185,1D186," +
	"1D187,1D188,1D189,1D1AA,1D1AB,1D1AC,1D1AD,1D242,1D243,1D244";

/** Combining-mark codepoint → row/column index for image placeholders. */
const rowcolIndex = new Map<number, number>();
ROWCOL_DIACRITICS.split(",").forEach((hex, index) => {
	rowcolIndex.set(Number.parseInt(hex, 16), index);
});

/** kitty image-placeholder cell (U+10EEEE + diacritics), scrubbed in text snapshots. */
const PLACEHOLDER_RE = /\u{10EEEE}\p{M}*/gu;

/** One completed kitty-graphics transmission (pixels for `shot`). */
interface StoredImage {
	bytes: Uint8Array;
	/** kitty `f=`: 100 png, 32 rgba, 24 rgb. */
	format: number;
	width: number;
	height: number;
}

// ─── PNG rasterizer ──────────────────────────────────────────────────────────
//
// `shot` rasterizes the emulator grid with @napi-rs/canvas (prebuilt Skia):
// real system fonts with an explicit fallback stack (Menlo → nerd font →
// braille → CJK → emoji), so icons, spinners, and wide text render as a
// terminal would. Powerline separators (U+E0B0–E0B3) are drawn as vector
// paths because font metrics leave gaps at cell edges. Imported lazily so a
// missing install degrades only `shot`, not the tool.

/** Cell pixel geometry. */
const CW = 16;
const CH = 32;
/** Font size whose Menlo advance (~0.602 em) fits the 16px cell. */
const FONT_PX = 26;
/** Baseline offset inside a cell (Menlo 26px ascent ≈ 24.2px). */
const BASELINE = 24;
const DEF_FG = 0xd4d4d4;
const DEF_BG = 0x101418;

/** Lazily loaded canvas module + resolved font-family stack. */
let canvasApi: {
	create: typeof CanvasModule.createCanvas;
	load: typeof CanvasModule.loadImage;
	stack: string;
} | null = null;

/**
 * Loads @napi-rs/canvas and builds the fallback font stack from the fonts
 * actually installed: Menlo, first nerd font, braille, CJK, emoji.
 */
async function loadCanvas() {
	if (canvasApi) return canvasApi;
	let mod: typeof CanvasModule;
	try {
		// Lazy import: a missing optional install must degrade `shot`, not fail tool load.
		mod = await import("@napi-rs/canvas");
	} catch (error) {
		throw new Error(
			`shot needs @napi-rs/canvas — run \`bun install\` in .omp/tools (${error})`,
		);
	}
	const families = mod.GlobalFonts.families.map((entry) => entry.family);
	const stack = ["Menlo"];
	const nerd =
		families.find((family) => /nerd font mono/i.test(family)) ??
		families.find((family) => /nerd font/i.test(family));
	if (nerd) stack.push(nerd);
	for (const wanted of [
		"Apple Braille",
		"PingFang SC",
		"Hiragino Sans",
		"Noto Sans CJK SC",
		"Apple Color Emoji",
		"Noto Color Emoji",
	]) {
		if (families.includes(wanted)) stack.push(wanted);
	}
	canvasApi = {
		create: mod.createCanvas,
		load: mod.loadImage,
		stack: stack.map((family) => `"${family}"`).join(", "),
	};
	return canvasApi;
}

/** 0xRRGGBB → CSS hex color. */
function css(rgb: number): string {
	return `#${rgb.toString(16).padStart(6, "0")}`;
}

/** Per-channel linear blend of two 0xRRGGBB colors. */
function lerpColor(from: number, to: number, t: number): number {
	const channel = (shift: number) => {
		const a = (from >> shift) & 0xff;
		const b = (to >> shift) & 0xff;
		return Math.round(a + (b - a) * t) << shift;
	};
	return channel(16) | channel(8) | channel(0);
}

/**
 * Terminal emulation fed every PTY byte: kitty's real core (screen.c +
 * vt-parser.c compiled to wasm via kitty-vt-wasm), so SGR, rewrap-on-resize,
 * scrollback, graphemes, and wide chars behave exactly as in kitty. Any
 * session — omp-tui host or not — can be read as plain text (`snapshot`) or
 * rasterized to pixels (`png`). Backs the `screen`/`shot` ops, the socketless
 * `text` fallback, and the after-screenshot on input ops. Query replies the
 * core emits (DA, DECRQSS, XTGETTCAP, OSC color queries) surface on
 * `onReply` for the session to write back to the child.
 */
export class Screen {
	/** Sink for terminal→child bytes (query replies); wired to the session PTY. */
	onReply: ((bytes: Uint8Array) => void) | null = null;
	#term: KittyTerminal;
	/** Completed image transmissions by image id (insertion order backs eviction). */
	#images = new Map<number, StoredImage>();
	/** In-flight chunked transmission; continuation commands carry no id. */
	#pending: {
		id: number;
		format: number;
		compressed: number;
		width: number;
		height: number;
		chunks: Buffer[];
	} | null = null;

	constructor(term: KittyTerminal) {
		this.#term = term;
	}

	/** Loads the wasm module (cached process-wide) and allocates a terminal. */
	static async create(cols: number, rows: number): Promise<Screen> {
		const vt = await loadVt();
		const term = await vt.KittyTerminal.create({
			columns: cols,
			rows,
			scrollback: 2000,
		});
		const screen = new Screen(term);
		term.onOutput = (bytes) => screen.onReply?.(bytes);
		// Image transmissions are kept for `shot`; the handler also keeps
		// core logs and other host events off the host's stderr.
		term.onEvent = (event) => {
			if (event.type === "graphics_command") screen.#graphics(event);
		};
		return screen;
	}
	/**
	 * Accumulates kitty-graphics transmissions. Chunked payloads (`m=1`)
	 * arrive as separate commands whose continuations carry no id; pixels are
	 * stored per image for the `shot` rasterizer.
	 */
	#graphics(cmd: GraphicsCommand) {
		if (!this.#pending) {
			// Only transmissions carry pixels; queries/puts/deletes do not.
			if (cmd.action !== "t" && cmd.action !== "T") return;
			this.#pending = {
				id: cmd.id || cmd.image_number,
				format: cmd.format,
				compressed: cmd.compressed,
				width: cmd.data_width,
				height: cmd.data_height,
				chunks: [],
			};
		}
		const pending = this.#pending;
		if (cmd.payload) pending.chunks.push(Buffer.from(cmd.payload, "base64"));
		if (cmd.more) return;
		this.#pending = null;
		let bytes: Buffer =
			pending.chunks.length === 1
				? pending.chunks[0]
				: Buffer.concat(pending.chunks);
		if (pending.compressed) {
			try {
				bytes = inflateSync(bytes);
			} catch {
				return;
			}
		}
		this.#images.set(pending.id, {
			bytes,
			format: pending.format,
			width: pending.width,
			height: pending.height,
		});
		// Bound retained pixels: drop the oldest transmissions past 128.
		if (this.#images.size > 128) {
			const oldest = this.#images.keys().next().value;
			if (oldest !== undefined) this.#images.delete(oldest);
		}
	}

	feed(chunk: Uint8Array) {
		this.#term.write(chunk);
	}

	/** Resize with kitty's real semantics: content rewraps and refills from scrollback. */
	resize(cols: number, rows: number) {
		this.#term.resize(cols, rows);
	}

	/** Frees the native terminal. */
	dispose() {
		this.#term.dispose();
	}

	/** Resolves a decoded color against the palette; null = terminal default. */
	#rgb(color: Color, fallback: number): number {
		if (!color) return fallback;
		return "rgb" in color ? color.rgb : this.#term.paletteColor(color.index);
	}

	/** Decodes a stored transmission to a drawable: PNG via Skia, raw RGB(A) via ImageData. */
	async #decodeImage(
		create: typeof CanvasModule.createCanvas,
		load: typeof CanvasModule.loadImage,
		image: StoredImage,
	): Promise<CanvasModule.Image | CanvasModule.Canvas | null> {
		if (image.format === 100) {
			try {
				return await load(Buffer.from(image.bytes));
			} catch {
				return null;
			}
		}
		const channels = image.format === 24 ? 3 : 4;
		const { width, height } = image;
		if (!width || !height || image.bytes.length < width * height * channels)
			return null;
		const off = create(width, height);
		const ctx = off.getContext("2d");
		const data = ctx.createImageData(width, height);
		for (let i = 0, j = 0; i < width * height; i++, j += channels) {
			data.data[i * 4] = image.bytes[j];
			data.data[i * 4 + 1] = image.bytes[j + 1];
			data.data[i * 4 + 2] = image.bytes[j + 2];
			data.data[i * 4 + 3] = channels === 4 ? image.bytes[j + 3] : 255;
		}
		ctx.putImageData(data, 0, 0);
		return off;
	}

	/** Plain-text screen: header, optional scrollback tail, then the viewport. */
	snapshot(history = 0): string {
		const term = this.#term;
		const cursor = term.cursor;
		const out = [
			`── screen ${term.columns}x${term.rows}` +
				`${term.isMainScreen ? "" : ", alt screen"}` +
				`, cursor=[${cursor.x},${cursor.y}]${cursor.visible ? "" : " hidden"}` +
				`, scrollback=${term.scrollbackLength} ──`,
		];
		if (history > 0) {
			const total = term.scrollbackLength;
			for (let i = Math.max(0, total - history); i < total; i++) {
				out.push(
					`┆${(term.scrollbackLine(i) ?? "").replace(PLACEHOLDER_RE, "▒")}`,
				);
			}
		}
		for (let y = 0; y < term.rows; y++)
			out.push(`│${term.line(y).replace(PLACEHOLDER_RE, "▒")}`);
		return out.join("\n");
	}

	/** Rasterizes the viewport to a PNG via Skia with real system fonts. */
	async png(): Promise<Buffer> {
		const { create, load, stack } = await loadCanvas();
		const term = this.#term;
		const cols = term.columns;
		const rows = term.rows;
		const defFg = this.#rgb(term.defaultFg, DEF_FG);
		const defBg = this.#rgb(term.defaultBg, DEF_BG);
		const width = cols * CW;
		const height = rows * CH;
		const canvas = create(width, height);
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = css(defBg);
		ctx.fillRect(0, 0, width, height);
		// Resolve each cell's paint once; draw backgrounds before any text so
		// glyph overhang (italics, wide fallback) never sits under a
		// neighbor's background.
		const cells: {
			px: number;
			py: number;
			ch: string;
			fg: number;
			deco: number;
			bold: boolean;
			italic: boolean;
			underline: number;
			strike: boolean;
			span: number;
		}[] = [];
		// kitty unicode image placeholders collected off the grid (drawn as tiles).
		const holders: {
			px: number;
			py: number;
			id: number;
			row: number;
			col: number;
		}[] = [];
		for (let y = 0; y < rows; y++) {
			for (let x = 0; x < cols; x++) {
				const cell = term.cell(x, y);
				// Wide-char continuations are drawn by their lead cell.
				if (!cell || cell.wideTrail) continue;
				let fg = this.#rgb(cell.fg, defFg);
				let bg = cell.bg ? this.#rgb(cell.bg, defBg) : null;
				if (cell.reverse) {
					const swap = fg;
					fg = bg ?? defBg;
					bg = swap;
				}
				if (cell.dim) fg = lerpColor(fg, bg ?? defBg, 0.45);
				const span = cell.wide ? 2 : 1;
				const px = x * CW;
				const py = y * CH;
				if (bg !== null) {
					ctx.fillStyle = css(bg);
					ctx.fillRect(px, py, span * CW, CH);
				}
				if (cell.ch.codePointAt(0) === 0x10eeee) {
					// Image placeholder: fg encodes the image id, combining
					// diacritics the tile row/col; omitted diacritics continue
					// the previous cell's run (kitty spec).
					const id = cell.fg
						? "rgb" in cell.fg
							? cell.fg.rgb
							: cell.fg.index
						: 0;
					const row = rowcolIndex.get(cell.combining[0]?.codePointAt(0) ?? -1);
					const col = rowcolIndex.get(cell.combining[1]?.codePointAt(0) ?? -1);
					const prev = holders.at(-1);
					const run = prev && prev.id === id && prev.py === py;
					holders.push({
						px,
						py,
						id,
						row: row ?? (run ? prev.row : 0),
						col: col ?? (run ? prev.col + 1 : 0),
					});
					continue;
				}
				cells.push({
					px,
					py,
					ch: cell.ch ? cell.ch + cell.combining.join("") : " ",
					fg,
					deco: cell.decorationFg ? this.#rgb(cell.decorationFg, fg) : fg,
					bold: cell.bold,
					italic: cell.italic,
					underline: cell.underline,
					strike: cell.strikethrough,
					span,
				});
			}
		}
		// Decode every image referenced by a placement or placeholder cell.
		const placements = term.graphicsPlacements();
		const drawable = new Map<
			number,
			CanvasModule.Image | CanvasModule.Canvas
		>();
		const wanted = new Set(holders.map((holder) => holder.id));
		for (const placement of placements) {
			if (!placement.unicodePlacement) wanted.add(placement.imageId);
		}
		for (const id of wanted) {
			const stored = this.#images.get(id);
			if (!stored) continue;
			const image = await this.#decodeImage(create, load, stored);
			if (image) drawable.set(id, image);
		}
		const direct = placements
			.filter((placement) => !placement.unicodePlacement)
			.sort((a, b) => a.zIndex - b.zIndex);
		const drawDirect = (placement: (typeof direct)[number]) => {
			const image = drawable.get(placement.imageId);
			if (!image) return;
			// Natural-size placements (numCols/numRows 0): the wasm core
			// assumes 10x20px cells when sizing them.
			const spanCols = placement.numCols || Math.ceil(image.width / 10);
			const spanRows = placement.numRows || Math.ceil(image.height / 20);
			ctx.drawImage(
				image,
				placement.col * CW,
				placement.row * CH,
				spanCols * CW,
				spanRows * CH,
			);
		};
		// kitty z-order: negative z-index draws under text, the rest above.
		for (const placement of direct)
			if (placement.zIndex < 0) drawDirect(placement);
		for (const {
			px,
			py,
			ch,
			fg,
			deco,
			bold,
			italic,
			underline,
			strike,
			span,
		} of cells) {
			if (underline) {
				// Coarse style fidelity: double gets two bars; straight,
				// curly, dotted, and dashed all render as one.
				ctx.fillStyle = css(deco);
				if (underline === 2) {
					ctx.fillRect(px, py + 27, span * CW, 1);
					ctx.fillRect(px, py + 30, span * CW, 1);
				} else {
					ctx.fillRect(px, py + 28, span * CW, 2);
				}
			}
			ctx.fillStyle = css(fg);
			if (strike) ctx.fillRect(px, py + 15, span * CW, 2);
			if (ch === " ") continue;
			const cp = ch.codePointAt(0) ?? 0;
			if (cp >= 0xe0b0 && cp <= 0xe0b3) {
				// Powerline separators as vector paths: font metrics leave
				// gaps at cell edges, which reads as broken bands.
				ctx.beginPath();
				if (cp <= 0xe0b1) {
					ctx.moveTo(px, py);
					ctx.lineTo(px + CW, py + CH / 2);
					ctx.lineTo(px, py + CH);
				} else {
					ctx.moveTo(px + CW, py);
					ctx.lineTo(px, py + CH / 2);
					ctx.lineTo(px + CW, py + CH);
				}
				if (cp === 0xe0b0 || cp === 0xe0b2) {
					ctx.closePath();
					ctx.fill();
				} else {
					ctx.lineWidth = 2;
					ctx.strokeStyle = css(fg);
					ctx.stroke();
				}
				continue;
			}
			ctx.font =
				`${italic ? "italic " : ""}${bold ? "bold " : ""}` +
				`${FONT_PX}px ${stack}`;
			ctx.fillText(ch, px, py + BASELINE);
		}
		for (const placement of direct)
			if (placement.zIndex >= 0) drawDirect(placement);
		// Placeholder tiles: scale each image to its virtual grid (or the max
		// extent seen) and draw the cell's slice.
		const grids = new Map<number, { cols: number; rows: number }>();
		for (const placement of placements) {
			if (
				placement.unicodePlacement &&
				placement.numCols &&
				placement.numRows
			) {
				grids.set(placement.imageId, {
					cols: placement.numCols,
					rows: placement.numRows,
				});
			}
		}
		for (const holder of holders) {
			const grid = grids.get(holder.id) ?? { cols: 0, rows: 0 };
			grid.cols = Math.max(grid.cols, holder.col + 1);
			grid.rows = Math.max(grid.rows, holder.row + 1);
			grids.set(holder.id, grid);
		}
		for (const holder of holders) {
			const image = drawable.get(holder.id);
			const grid = grids.get(holder.id);
			if (!image || !grid) continue;
			const sw = image.width / grid.cols;
			const sh = image.height / grid.rows;
			ctx.drawImage(
				image,
				holder.col * sw,
				holder.row * sh,
				sw,
				sh,
				holder.px,
				holder.py,
				CW,
				CH,
			);
		}
		const cursor = term.cursor;
		if (cursor.visible) {
			ctx.globalAlpha = 0.4;
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(cursor.x * CW, cursor.y * CH, CW, CH);
			ctx.globalAlpha = 1;
		}
		return canvas.toBuffer("image/png");
	}
}

// ─── Sessions ────────────────────────────────────────────────────────────────

interface Waiter {
	resolve(value: Record<string, unknown>): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

/** The slice of `Bun.spawn`'s PTY handle this tool touches. */
interface TerminalHandle {
	write(data: string | Uint8Array): void;
	resize(cols: number, rows: number): void;
	close(): void;
}

/** The slice of Bun's PTY-backed subprocess this tool touches. */
interface Child {
	pid: number;
	exited: Promise<number>;
	terminal: TerminalHandle;
	kill(signal?: number | NodeJS.Signals): void;
}

interface Session {
	name: string;
	target: string;
	proc: Child;
	cols: number;
	rows: number;
	dir: string;
	screen: Screen;
	sock: net.Socket | null;
	sockBuf: string;
	waiters: Waiter[];
	raw: Buffer[];
	rawBytes: number;
	exit: number | null;
}

const sessions = new Map<string, Session>();

/** Appends one PTY chunk to the session's capped raw capture. */
function capture(session: Session, chunk: Uint8Array) {
	session.screen.feed(chunk);
	const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	session.raw.push(bytes);
	session.rawBytes += bytes.length;
	// Cap the capture at 8 MiB, dropping the oldest chunks.
	while (session.rawBytes > 8 * 1024 * 1024 && session.raw.length > 1) {
		session.rawBytes -= session.raw[0].length;
		session.raw.shift();
	}
}

function connectSocket(
	session: Session,
	path: string,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const attempt = () => {
		const sock = net.createConnection(path);
		sock.on("connect", () => {
			sock.setEncoding("utf8");
			sock.on("data", (data: string) => {
				session.sockBuf += data;
				for (;;) {
					const index = session.sockBuf.indexOf("\n");
					if (index < 0) return;
					const line = session.sockBuf.slice(0, index);
					session.sockBuf = session.sockBuf.slice(index + 1);
					const waiter = session.waiters.shift();
					if (!waiter) continue;
					clearTimeout(waiter.timer);
					try {
						waiter.resolve(JSON.parse(line));
					} catch (error) {
						waiter.reject(new Error(`bad response line: ${error}`));
					}
				}
			});
			sock.on("close", () => {
				if (session.sock === sock) session.sock = null;
			});
			sock.on("error", () => {});
			session.sock = sock;
			resolve(true);
		});
		sock.on("error", () => {
			sock.destroy();
			if (Date.now() >= deadline || session.exit !== null) resolve(false);
			else setTimeout(attempt, 150);
		});
	};
	attempt();
	return promise;
}

/** Sends one debug request and awaits its response line. */
function request(
	session: Session,
	body: Record<string, unknown>,
	timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
	const sock = session.sock;
	if (!sock) {
		return Promise.reject(
			new Error(
				`session "${session.name}" has no debug socket — the app is not an ` +
					"omp-tui host (or exited). screen/raw/send/resize/stop still work.",
			),
		);
	}
	const { promise, resolve, reject } =
		Promise.withResolvers<Record<string, unknown>>();
	const timer = setTimeout(() => {
		const index = session.waiters.findIndex((waiter) => waiter.timer === timer);
		if (index >= 0) session.waiters.splice(index, 1);
		reject(new Error(`debug request timed out: ${JSON.stringify(body)}`));
	}, timeoutMs);
	session.waiters.push({ resolve, reject, timer });
	sock.write(`${JSON.stringify(body)}\n`);
	return promise;
}

function need(session: string | undefined): Session {
	const name = session ?? "main";
	const found = sessions.get(name);
	if (!found) {
		const names = [...sessions.keys()].join(", ") || "none";
		throw new Error(`no session "${name}" (running: ${names})`);
	}
	return found;
}

function sleep(ms: number): Promise<null> {
	const { promise, resolve } = Promise.withResolvers<null>();
	setTimeout(() => resolve(null), ms);
	return promise;
}

async function stopSession(session: Session): Promise<number | null> {
	try {
		if (session.sock) {
			await request(session, { op: "quit" }, 2_000);
		} else if (session.exit === null) {
			// Non-omp-tui apps have no debug socket; Ctrl-C is the
			// conventional quit chord.
			session.proc.terminal.write("\x03");
		}
	} catch {
		// Fall through to signals.
	}
	const exited = await Promise.race([session.proc.exited, sleep(2_000)]);
	if (exited === null) {
		session.proc.kill("SIGKILL");
		await session.proc.exited.catch(() => {});
	}
	session.sock?.destroy();
	session.proc.terminal.close();
	session.screen.dispose();
	rmSync(session.dir, { recursive: true, force: true });
	sessions.delete(session.name);
	return exited ?? -9;
}

// ─── Response narrowing ──────────────────────────────────────────────────────

/** The string rows of a `lines` response field; anything else is empty. */
function stringLines(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((line): line is string => typeof line === "string");
}

/** Reads one property of an unknown JSON value; `undefined` when absent. */
function field(value: unknown, name: string): unknown {
	if (value && typeof value === "object" && name in value) {
		return Reflect.get(value, name);
	}
	return undefined;
}

// ─── Rendering helpers ───────────────────────────────────────────────────────

function screenshotText(response: Record<string, unknown>): string {
	const lines = stringLines(response.lines);
	const header =
		`── viewport (window_top=${response.window_top}` +
		`${response.alt_screen ? ", alt screen" : ""}` +
		`${response.cursor ? `, cursor=${JSON.stringify(response.cursor)}` : ""}) ──`;
	return `${header}\n${lines.map((line) => `│${line}`).join("\n")}`;
}

/**
 * After-input screenshot: the renderer's viewport when a debug socket exists
 * (and answers), else the emulator's screen.
 */
async function settled(
	session: Session,
	note: string,
	waitMs = 180,
): Promise<string> {
	await sleep(waitMs);
	if (session.sock) {
		try {
			const shot = await request(session, { op: "text" }, 3_000);
			if (shot.ok !== false) return `${note}\n${screenshotText(shot)}`;
		} catch {
			// Renderer unavailable; fall back to the emulator.
		}
	}
	return `${note}\n${session.screen.snapshot()}`;
}

/** Renders one `tree` response node (and its children) as outline rows. */
function renderTree(node: unknown, depth: number, out: string[]) {
	if (!node || typeof node !== "object") return;
	const rect = field(node, "rect");
	const id = field(node, "id");
	const flags = [
		field(node, "focused") === true ? "FOCUSED" : "",
		field(node, "focusable") === true ? "focusable" : "",
		field(node, "hidden") === true ? "hidden" : "",
	]
		.filter(Boolean)
		.join(" ");
	out.push(
		"  ".repeat(depth) +
			`${field(node, "kind")}${typeof id === "string" ? `#${id}` : ""}` +
			(Array.isArray(rect)
				? ` [${rect[0]},${rect[1]} ${rect[2]}x${rect[3]}]`
				: "") +
			(flags ? `  ${flags}` : ""),
	);
	const children = field(node, "children");
	if (Array.isArray(children)) {
		for (const child of children) renderTree(child, depth + 1, out);
	}
}

const SEQUENCES: Record<string, string> = {
	alt_enter: "\x1b[?1049h",
	alt_leave: "\x1b[?1049l",
	clear_scrollback: "\x1b[3J",
	sync_begin: "\x1b[?2026h",
	sync_end: "\x1b[?2026l",
	mouse_on: "\x1b[?1003h",
	mouse_off: "\x1b[?1003l",
	cursor_hide: "\x1b[?25l",
	cursor_show: "\x1b[?25h",
};

function count(haystack: Buffer, needle: string): number {
	const bytes = Buffer.from(needle, "latin1");
	let total = 0;
	let from = 0;
	for (;;) {
		const index = haystack.indexOf(bytes, from);
		if (index < 0) return total;
		total += 1;
		from = index + bytes.length;
	}
}

/** Escapes control bytes so raw terminal output is printable. */
function visible(bytes: Buffer): string {
	let out = "";
	for (const byte of bytes) {
		if (byte === 0x1b) out += "\\e";
		else if (byte === 0x0a) out += "\n";
		else if (byte === 0x0d) out += "\\r";
		else if (byte < 0x20 || byte === 0x7f)
			out += `\\x${byte.toString(16).padStart(2, "0")}`;
		else out += String.fromCharCode(byte);
	}
	return out;
}

/** Unescapes `\e`, `\r`, `\n`, `\t`, and `\xNN` in a `send` payload. */
function unescapeBytes(text: string): Buffer {
	const out: number[] = [];
	for (let index = 0; index < text.length; index++) {
		if (text[index] !== "\\") {
			out.push(...Buffer.from(text[index], "utf8"));
			continue;
		}
		const next = text[index + 1];
		if (next === "e") {
			out.push(0x1b);
			index++;
		} else if (next === "r") {
			out.push(0x0d);
			index++;
		} else if (next === "n") {
			out.push(0x0a);
			index++;
		} else if (next === "t") {
			out.push(0x09);
			index++;
		} else if (next === "x") {
			out.push(Number.parseInt(text.slice(index + 2, index + 4), 16));
			index += 3;
		} else {
			out.push(0x5c);
		}
	}
	return Buffer.from(out);
}

// ─── Tool ────────────────────────────────────────────────────────────────────

const factory = (omp: ToolHost) => {
	const startSession = async (params: TuiParams): Promise<string> => {
		const name = params.name ?? "main";
		if (sessions.has(name)) {
			throw new Error(`session "${name}" already running; stop it first`);
		}
		if (params.file && params.bin) {
			throw new Error("start takes `file` or `bin`, not both");
		}
		// Default target: this repo's own TUI, omp itself.
		const file = params.bin ? undefined : (params.file ?? "packages/coding-agent/src/cli.ts");
		const target = file ?? params.bin ?? "";
		const command = file
			? [process.execPath, resolve(omp.cwd, file), ...(params.args ?? [])]
			: [target, ...(params.args ?? [])];

		const rows = params.rows ?? 30;
		const cols = params.cols ?? 100;
		const dir = mkdtempSync(join(tmpdir(), `omp-tui-${name}-`));
		const sockPath = join(dir, "debug.sock");
		const screen = await Screen.create(cols, rows);
		// The PTY data callback closes over `session`; Bun.spawn returns
		// synchronously and the callback fires on the event loop, so the
		// binding is assigned before the first chunk can arrive.
		let session: Session;
		let proc: Child;
		try {
			const spawned = Bun.spawn(command, {
				cwd: omp.cwd,
				env: {
					...process.env,
					OMP_TUI_DEBUG: sockPath,
					TERM: "xterm-256color",
					COLORTERM: "truecolor",
				},
				terminal: {
					cols,
					rows,
					data(_terminal, chunk) {
						capture(session, chunk);
					},
				},
			});
			const terminal = spawned.terminal;
			if (!terminal) throw new Error("Bun.spawn did not create a PTY");
			proc = {
				pid: spawned.pid,
				exited: spawned.exited,
				terminal,
				kill(signal) {
					spawned.kill(signal);
				},
			};
		} catch (error) {
			screen.dispose();
			rmSync(dir, { recursive: true, force: true });
			throw error;
		}
		// Route the core's query replies (DA, DECRQSS, OSC color queries) back
		// to the child: capability probes resolve as on a real terminal.
		screen.onReply = (bytes) => proc.terminal.write(bytes);
		session = {
			name,
			target,
			proc,
			cols,
			rows,
			dir,
			screen,
			sock: null,
			sockBuf: "",
			waiters: [],
			raw: [],
			rawBytes: 0,
			exit: null,
		};
		proc.exited.then((code) => {
			session.exit = code;
		});
		sessions.set(name, session);

		const deadline = Date.now() + (params.timeout ?? 15) * 1000;
		const connected = await connectSocket(
			session,
			sockPath,
			(params.timeout ?? 15) * 1000,
		);
		if (session.exit !== null) {
			const tail = visible(Buffer.concat(session.raw)).slice(-3000);
			await stopSession(session).catch(() => {});
			throw new Error(
				`"${target}" exited immediately (code ${session.exit}).\n` +
					`terminal tail: ${tail || "(empty)"}`,
			);
		}
		let text = `session "${name}": ${target} pid=${proc.pid} pty=${cols}x${rows}`;
		if (connected) {
			// The socket binds at terminal entry, before the first frame
			// paints; retry until the snapshot exists so `start` reliably
			// returns the opening screenshot.
			let shot = await request(session, { op: "text" });
			while (
				shot.ok === false &&
				String(shot.error ?? "").includes("no frame painted yet") &&
				session.exit === null &&
				Date.now() < deadline
			) {
				await sleep(50);
				shot = await request(session, { op: "text" });
			}
			text += `\n${screenshotText(shot)}`;
		} else {
			text +=
				"\n(no debug socket: app is not an omp-tui host; `send` injects " +
				"input, `screen` renders the emulated display)" +
				`\n${session.screen.snapshot()}`;
		}
		return text;
	};

	return {
		name: "tui",
		label: "TUI Debug",
		description:
			"Run and debug omp/pi-tui apps headlessly on a real PTY plus the " +
			"OMP_TUI_DEBUG socket. Start defaults to omp itself " +
			"(packages/coding-agent/src/cli.ts); override with file (a TS/JS entry, e.g. " +
			"file: \"packages/tui/examples/debug-demo.ts\") or bin (an executable name/path), plus optional rows/cols and args. Any omp/pi-tui app serves " +
			"OMP_TUI_DEBUG. Ops: text (viewport screenshot as plain text), screen " +
			"(plain-text screen from kitty's real terminal core — works for any app, no " +
			"debug socket needed; peek=N prepends N scrollback lines), frame (full " +
			"document), tree (component tree with ids/rects/focus), values (widget " +
			"values JSON), info, keys (spec like \"tab C-c enter 'literal'\"), type " +
			"(literal text through the input decoder), paste (bracketed paste), mouse " +
			"(x,y,action: click|right-click|middle-click|move|drag|release|wheel-up|" +
			"wheel-down), send (raw bytes to the terminal, \\e/\\xNN escapes), resize " +
			"(cols,rows delivered via SIGWINCH), raw (exact captured byte stream: " +
			"escape-sequence stats + escaped tail — prefer text/screen unless " +
			"auditing escapes), shot (pixel screenshot of the emulated screen — real " +
			"colors/styles as a PNG image, rasterized in-process), stop, list. " +
			"Input ops (keys/type/paste/mouse/send/" +
			"resize) return an after-screenshot of the resulting display (quiet:true " +
			"skips it). Sessions persist across calls; injected input rides the " +
			"app's real input path.",
		parameters: omp.zod.object({
			op: omp.zod
				.string()
				.describe(
					"operation: start | stop | list | text | screen | shot | frame | tree | values | info | keys | type | paste | mouse | send | resize | raw",
				),
			name: omp.zod
				.string()
				.optional()
				.describe("session name (default: main)"),
			file: omp.zod
				.string()
				.optional()
				.describe("start: TS/JS entry path relative to cwd (default: packages/coding-agent/src/cli.ts — omp itself)"),
			bin: omp.zod
				.string()
				.optional()
				.describe("start: executable name or path"),
			args: omp.zod
				.array(omp.zod.string())
				.optional()
				.describe("start: program argv"),
			rows: omp.zod
				.number()
				.optional()
				.describe("start/resize: pty rows (default 30)"),
			cols: omp.zod
				.number()
				.optional()
				.describe("start/resize: pty cols (default 100)"),
			keys: omp.zod
				.string()
				.optional()
				.describe("keys: spec, e.g. \"tab tab enter C-c pgdn 'hello'\""),
			text: omp.zod
				.string()
				.optional()
				.describe("type/paste/send: payload text"),
			x: omp.zod.number().optional().describe("mouse: zero-based column"),
			y: omp.zod.number().optional().describe("mouse: zero-based viewport row"),
			action: omp.zod
				.string()
				.optional()
				.describe("mouse: gesture (default click)"),
			peek: omp.zod
				.number()
				.optional()
				.describe(
					"screen: scrollback lines to include; raw: tail bytes (default 2000)",
				),
			clear: omp.zod
				.boolean()
				.optional()
				.describe("raw: reset capture after reading"),
			quiet: omp.zod
				.boolean()
				.optional()
				.describe("input ops: skip the after-screenshot"),
			timeout: omp.zod
				.number()
				.optional()
				.describe("start: socket wait seconds (default 15)"),
		}),

		async execute(
			_toolCallId: string,
			params: TuiParams,
			_onUpdate?: (update: ToolUpdate) => void,
		): Promise<ToolResult> {
			const reply = (
				text: string,
				details?: Record<string, unknown>,
			): ToolResult => ({
				content: [{ type: "text", text }],
				details,
			});

			switch (params.op) {
				case "start":
					return reply(await startSession(params));
				case "list": {
					const rows = [...sessions.values()].map(
						(session) =>
							`${session.name}: ${session.target} pid=${session.proc.pid} ` +
							`${session.cols}x${session.rows} ` +
							`${session.exit === null ? "running" : `exited(${session.exit})`}` +
							`${session.sock ? "" : " (no socket)"}`,
					);
					return reply(rows.join("\n") || "no sessions");
				}
				case "stop": {
					const session = need(params.name);
					const code = await stopSession(session);
					return reply(`stopped "${session.name}" (exit ${code})`);
				}
				case "text": {
					const session = need(params.name);
					if (!session.sock)
						return reply(session.screen.snapshot(params.peek ?? 0));
					const response = await request(session, { op: "text" });
					return reply(screenshotText(response), response);
				}
				case "screen": {
					return reply(need(params.name).screen.snapshot(params.peek ?? 0));
				}
				case "shot": {
					const session = need(params.name);
					const png = join(
						tmpdir(),
						`omp-tui-${session.name}-${Date.now()}.png`,
					);
					const bytes = await session.screen.png();
					writeFileSync(png, bytes);
					return {
						content: [
							{
								type: "image",
								data: bytes.toString("base64"),
								mimeType: "image/png",
							},
							{ type: "text", text: `screenshot saved: ${png}` },
						],
					};
				}
				case "frame": {
					const response = await request(need(params.name), { op: "frame" });
					const lines = stringLines(response.lines);
					return reply(lines.map((line) => `│${line}`).join("\n"), response);
				}
				case "tree": {
					const response = await request(need(params.name), { op: "tree" });
					const out: string[] = [];
					renderTree(field(response.tree, "root"), 0, out);
					const overlays = field(response.tree, "overlays");
					if (Array.isArray(overlays)) {
						for (const layer of overlays) {
							out.push(
								`overlay #${field(layer, "overlay")} ` +
									`band=${JSON.stringify(field(layer, "band"))}` +
									`${field(layer, "hidden") === true ? " hidden" : ""}`,
							);
							renderTree(field(layer, "root"), 1, out);
						}
					}
					return reply(out.join("\n"), response);
				}
				case "values":
				case "info": {
					const response = await request(need(params.name), { op: params.op });
					return reply(JSON.stringify(response, null, 1), response);
				}
				case "keys": {
					if (!params.keys) throw new Error("keys op needs `keys`");
					const session = need(params.name);
					const response = await request(session, {
						op: "keys",
						keys: params.keys,
					});
					if (!response.ok) throw new Error(String(response.error));
					const note = `injected ${response.injected} events`;
					return reply(
						params.quiet ? note : await settled(session, note),
						response,
					);
				}
				case "type": {
					if (params.text === undefined)
						throw new Error("type op needs `text`");
					const session = need(params.name);
					const response = await request(session, {
						op: "bytes",
						data: params.text,
					});
					if (!response.ok) throw new Error(String(response.error));
					const note = `typed ${params.text.length} chars`;
					return reply(
						params.quiet ? note : await settled(session, note),
						response,
					);
				}
				case "paste": {
					if (params.text === undefined)
						throw new Error("paste op needs `text`");
					const session = need(params.name);
					const response = await request(session, {
						op: "paste",
						text: params.text,
					});
					if (!response.ok) throw new Error(String(response.error));
					return reply(
						params.quiet ? "pasted" : await settled(session, "pasted"),
						response,
					);
				}
				case "mouse": {
					if (params.x === undefined || params.y === undefined) {
						throw new Error("mouse op needs `x` and `y`");
					}
					const session = need(params.name);
					const response = await request(session, {
						op: "mouse",
						x: params.x,
						y: params.y,
						action: params.action ?? "click",
					});
					if (!response.ok) throw new Error(String(response.error));
					const note = `mouse ${params.action ?? "click"} at ${params.x},${params.y}`;
					return reply(
						params.quiet ? note : await settled(session, note),
						response,
					);
				}
				case "send": {
					if (params.text === undefined)
						throw new Error("send op needs `text`");
					const session = need(params.name);
					const bytes = unescapeBytes(params.text);
					session.proc.terminal.write(bytes);
					const note = `sent ${bytes.length} bytes to the terminal`;
					return reply(params.quiet ? note : await settled(session, note));
				}
				case "resize": {
					const session = need(params.name);
					const rows = params.rows ?? session.rows;
					const cols = params.cols ?? session.cols;
					session.proc.terminal.resize(cols, rows);
					session.screen.resize(cols, rows);
					session.cols = cols;
					session.rows = rows;
					const note = `resized to ${cols}x${rows}; SIGWINCH delivered`;
					return reply(params.quiet ? note : await settled(session, note, 350));
				}
				case "raw": {
					const session = need(params.name);
					const blob = Buffer.concat(session.raw);
					const stats: Record<string, number> = { bytes: blob.length };
					for (const key in SEQUENCES) {
						const total = count(blob, SEQUENCES[key]);
						if (total > 0) stats[key] = total;
					}
					if (params.clear) {
						session.raw = [];
						session.rawBytes = 0;
					}
					const peek = params.peek ?? 2000;
					const tail = peek > 0 ? visible(blob.subarray(-peek)) : "";
					return reply(
						`${JSON.stringify(stats)}${tail ? `\n── tail ──\n${tail}` : ""}`,
						{ stats },
					);
				}
				default:
					throw new Error(`unknown op ${JSON.stringify(params.op)}`);
			}
		},

		onSession(event: { reason?: string }) {
			if (event.reason === "shutdown") {
				for (const session of sessions.values()) {
					try {
						session.proc.kill("SIGKILL");
						session.proc.terminal.close();
						session.screen.dispose();
						rmSync(session.dir, { recursive: true, force: true });
					} catch {
						// Best-effort teardown.
					}
				}
				sessions.clear();
			}
		},
	};
};

export default factory;
