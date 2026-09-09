/**
 * Render `omp gallery` output to PNG screenshots via VHS.
 *
 * ANSI escapes are invisible to anything that can only read raw bytes (e.g.
 * agents), so `--screenshot` drives the rendered gallery through a real virtual
 * terminal (VHS + ttyd + ffmpeg) and writes the captured frame to disk. The
 * gallery is pre-rendered to truecolor ANSI in this process — where the user's
 * theme and symbol preset are correct — then `cat`'d inside VHS so the captured
 * pixels match exactly what the live TUI would draw.
 *
 * VHS is a hard dependency of this path: if it is not installed we fail loudly
 * rather than degrade to a lossy fallback.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import { theme } from "../modes/theme/theme";
import type { GallerySection } from "./gallery-cli";

/** Nerd Font family so the gallery's icon glyphs (PUA) render instead of tofu. */
export const DEFAULT_SCREENSHOT_FONT = "JetBrainsMono Nerd Font";
export const DEFAULT_SCREENSHOT_FONT_SIZE = 18;

/** Inner padding (px) VHS leaves around the terminal grid. */
const PADDING = 14;
const LINE_HEIGHT = 1.0;
/**
 * Upper-bound cell metrics relative to font size. Real monospace cells are
 * smaller, so over-provisioning the canvas guarantees the gallery never
 * soft-wraps (too few columns) or scrolls off the top (too few rows). The slack
 * shows up only as a modest background margin, which is harmless for review.
 */
const CELL_WIDTH_RATIO = 0.65;
const CELL_HEIGHT_RATIO = 1.5;
/** Keep each image well under headless-Chromium's tall-canvas limits. */
const MAX_IMAGE_HEIGHT_PX = 8000;

export interface GalleryScreenshotOptions {
	/** Gallery render width in columns (matches the ANSI line width). */
	width: number;
	/** VHS `FontFamily`. */
	font?: string;
	/** VHS `FontSize`. */
	fontSize?: number;
	/**
	 * Output destination. When omitted, PNGs land in a fresh temp directory.
	 * With multiple images the path is suffixed (`name-01.png`, `name-02.png`).
	 */
	out?: string;
}

/**
 * Capture the gallery sections as one or more PNGs and return their absolute
 * paths. Tall galleries are split across images so no single capture exceeds
 * the terminal-canvas height limit.
 */
export async function captureGalleryScreenshots(
	sections: GallerySection[],
	options: GalleryScreenshotOptions,
): Promise<string[]> {
	const vhs = $which("vhs");
	if (!vhs) {
		throw new Error(
			"`omp gallery --screenshot` requires VHS, which is not installed. " +
				"Install it (e.g. `brew install vhs`, or see https://github.com/charmbracelet/vhs) and retry.",
		);
	}

	const font = options.font ?? DEFAULT_SCREENSHOT_FONT;
	const fontSize = options.fontSize ?? DEFAULT_SCREENSHOT_FONT_SIZE;
	const cellHeight = fontSize * Math.max(LINE_HEIGHT, 1) * CELL_HEIGHT_RATIO;
	const cellWidth = fontSize * CELL_WIDTH_RATIO;
	const rowBudget = Math.max(40, Math.floor((MAX_IMAGE_HEIGHT_PX - 2 * PADDING) / cellHeight) - 2);
	const chunks = chunkGallerySections(sections, rowBudget);
	const themeJson = buildVhsTheme();

	const baseDir = options.out
		? path.dirname(path.resolve(options.out))
		: fs.mkdtempSync(path.join(os.tmpdir(), "omp-gallery-"));
	await fs.promises.mkdir(baseDir, { recursive: true });

	const outPaths: string[] = [];
	for (let i = 0; i < chunks.length; i++) {
		if (chunks.length > 1) {
			process.stderr.write(`Rendering gallery screenshot ${i + 1}/${chunks.length}…\n`);
		}
		const outPng = resolveScreenshotOutputPath(options.out, baseDir, i, chunks.length);
		const lines = chunks[i].flatMap(section => section.lines);
		await renderChunk({ vhs, lines, outPng, font, fontSize, cellWidth, cellHeight, width: options.width, themeJson });
		outPaths.push(outPng);
	}
	return outPaths;
}

interface RenderChunkArgs {
	vhs: string;
	lines: string[];
	outPng: string;
	font: string;
	fontSize: number;
	cellWidth: number;
	cellHeight: number;
	width: number;
	themeJson: string;
}

async function renderChunk(args: RenderChunkArgs): Promise<void> {
	const rows = args.lines.length;
	const widthPx = Math.ceil(args.width * args.cellWidth) + 2 * PADDING;
	const heightPx = Math.ceil((rows + 2) * args.cellHeight) + 2 * PADDING;

	const dir = path.dirname(args.outPng);
	const stem = path.basename(args.outPng, path.extname(args.outPng));
	const ansiPath = path.join(dir, `.${stem}.ansi`);
	const tapePath = path.join(dir, `.${stem}.tape`);
	const gifPath = path.join(dir, `.${stem}.gif`);

	// CRLF so each gallery line is its own terminal row regardless of how the
	// captured shell handles bare LF.
	await Bun.write(ansiPath, `${args.lines.join("\r\n")}\r\n`);
	await Bun.write(
		tapePath,
		buildTape({
			gifPath,
			outPng: args.outPng,
			ansiPath,
			widthPx,
			heightPx,
			font: args.font,
			fontSize: args.fontSize,
			themeJson: args.themeJson,
		}),
	);

	try {
		const result = await Bun.$`${args.vhs} ${tapePath}`.quiet().nothrow();
		if (result.exitCode !== 0 || !(await Bun.file(args.outPng).exists())) {
			const detail = result.stderr.toString().trim() || result.stdout.toString().trim();
			throw new Error(`VHS failed to render the gallery screenshot${detail ? `: ${detail.slice(-600)}` : ""}`);
		}
	} finally {
		await Promise.all([
			fs.promises.rm(ansiPath, { force: true }),
			fs.promises.rm(tapePath, { force: true }),
			fs.promises.rm(gifPath, { force: true }),
		]);
	}
}

interface TapeArgs {
	gifPath: string;
	outPng: string;
	ansiPath: string;
	widthPx: number;
	heightPx: number;
	font: string;
	fontSize: number;
	themeJson: string;
}

function buildTape(args: TapeArgs): string {
	// `Output` (a throwaway GIF) is mandatory for VHS to record; the screenshot
	// is captured from the final visible frame. Setup is hidden so the typed
	// `cat` command and shell prompt never appear in the capture, and a trailing
	// `sleep` keeps the shell from drawing a fresh prompt under the output.
	const shellCommand = `clear; cat ${shellSingleQuote(args.ansiPath)}; sleep 120`;
	return `${[
		`Output ${JSON.stringify(args.gifPath)}`,
		`Set Width ${args.widthPx}`,
		`Set Height ${args.heightPx}`,
		`Set FontFamily ${JSON.stringify(args.font)}`,
		`Set FontSize ${args.fontSize}`,
		`Set Padding ${PADDING}`,
		`Set LineHeight ${LINE_HEIGHT}`,
		`Set Theme ${args.themeJson}`,
		"Hide",
		`Type ${JSON.stringify(shellCommand)}`,
		"Enter",
		"Sleep 1.2s",
		"Show",
		"Sleep 400ms",
		`Screenshot ${JSON.stringify(args.outPng)}`,
	].join("\n")}\n`;
}

/**
 * Build the VHS terminal theme. Only background/foreground/cursor matter: the
 * gallery emits truecolor (`38;2`/`48;2`) escapes, so the 16-color palette is
 * never consulted — it is filler to satisfy VHS's theme schema.
 */
function buildVhsTheme(): string {
	const background = parseAnsiRgb(theme.getBgAnsi("statusLineBg")) ?? (theme.isLight ? "#ffffff" : "#1a1a1a");
	const foreground = theme.isLight ? "#1a1a1a" : "#d4d4d4";
	const selection = theme.isLight ? "#c8d6ff" : "#404862";
	return JSON.stringify({
		name: "omp-gallery",
		background,
		foreground,
		cursor: foreground,
		selection,
		black: "#000000",
		red: "#ff5555",
		green: "#50fa7b",
		yellow: "#f1fa8c",
		blue: "#6272ff",
		magenta: "#ff79c6",
		cyan: "#8be9fd",
		white: "#bfbfbf",
		brightBlack: "#4d4d4d",
		brightRed: "#ff6e6e",
		brightGreen: "#69ff94",
		brightYellow: "#ffffa5",
		brightBlue: "#8aa0ff",
		brightMagenta: "#ff92df",
		brightCyan: "#a4ffff",
		brightWhite: "#ffffff",
	});
}

/** Extract `#rrggbb` from a truecolor SGR escape (`…38;2;r;g;b…` / `…48;2;…`). */
function parseAnsiRgb(ansi: string): string | undefined {
	const match = /[34]8;2;(\d+);(\d+);(\d+)/.exec(ansi);
	if (!match) return undefined;
	const hex = (value: string) => Number(value).toString(16).padStart(2, "0");
	return `#${hex(match[1])}${hex(match[2])}${hex(match[3])}`;
}

/** POSIX single-quote a path for embedding in the VHS shell command. */
function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve a chunk's PNG path. A single image keeps the bare name (or the exact
 * `out`); multiple images gain a zero-padded `-NN` suffix so they sort and never
 * collide.
 */
export function resolveScreenshotOutputPath(
	out: string | undefined,
	baseDir: string,
	index: number,
	total: number,
): string {
	if (total === 1) {
		return out ? path.resolve(out) : path.join(baseDir, "gallery.png");
	}
	const suffix = String(index + 1).padStart(2, "0");
	if (out) {
		const resolved = path.resolve(out);
		const ext = path.extname(resolved) || ".png";
		const stem = path.basename(resolved, ext);
		return path.join(path.dirname(resolved), `${stem}-${suffix}${ext}`);
	}
	return path.join(baseDir, `gallery-${suffix}.png`);
}

/**
 * Group whole tool sections into chunks that stay under `rowBudget` rows. A
 * single section larger than the budget gets its own (taller) image rather than
 * being split mid-renderer.
 */
export function chunkGallerySections(sections: GallerySection[], rowBudget: number): GallerySection[][] {
	const chunks: GallerySection[][] = [];
	let current: GallerySection[] = [];
	let currentRows = 0;
	for (const section of sections) {
		const rows = section.lines.length;
		if (current.length > 0 && currentRows + rows > rowBudget) {
			chunks.push(current);
			current = [];
			currentRows = 0;
		}
		current.push(section);
		currentRows += rows;
	}
	if (current.length > 0) chunks.push(current);
	return chunks.length > 0 ? chunks : [[]];
}
