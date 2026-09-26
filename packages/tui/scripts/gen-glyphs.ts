/**
 * Generate `src/theme/glyph-bundle.json`: every private-use icon the TUI and
 * coding-agent emit, as Glyph Protocol `glyf` payloads pulled from a Nerd Font
 * Mono face. The bundle is what `glyph-protocol.ts` registers at startup on
 * terminals that implement the protocol, so the nerd symbol preset renders
 * without a patched font installed.
 *
 * Usage: `bun run gen:glyphs [--font <path/to/NerdFontMono.ttf>]`
 *
 * Source font: a *patched Mono* Nerd Font, not the symbols-only face. The
 * Nerd Fonts patcher already lays every icon out inside the mono cell box
 * (fitted icons, xy-stretched powerline arrows), so pulling outlines from a
 * patched face inherits that per-range layout for free; the symbols-only
 * face ships square em-box glyphs that would need the patcher's rules
 * re-implemented here. Without `--font` a pinned JetBrainsMono release is
 * fetched once into the user cache.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { decodeSimpleGlyph, encodeSimpleGlyph, TrueTypeFont } from "./truetype";

const NERD_FONTS_VERSION = "v3.5.1";
const NERD_FONTS_ARCHIVE = `https://github.com/ryanoasis/nerd-fonts/releases/download/${NERD_FONTS_VERSION}/JetBrainsMono.tar.xz`;
const NERD_FONTS_MEMBER = "JetBrainsMonoNerdFontMono-Regular.ttf";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const SCAN_ROOTS = ["packages/tui/src", "packages/coding-agent/src"].map(dir => path.join(REPO_ROOT, dir));
const OUTPUT = path.join(REPO_ROOT, "packages/tui/src/theme/glyph-bundle.json");

/** Powerline Symbols block: arrows and caps that must fill the cell edge to edge. */
const POWERLINE_RANGE: readonly [number, number] = [0xe0b0, 0xe0d7];

/** Spec §8.2 budget: 64 KiB decoded at 12 bytes per point. */
const MAX_POINTS = 5461;

/** Unicode escape forms TypeScript source uses for private-use icons. */
const ESCAPE_PATTERN = /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g;

function isPrivateUse(cp: number): boolean {
	return (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd) || (cp >= 0x100000 && cp <= 0x10fffd);
}

/** Every PUA codepoint referenced by source under the scan roots, literal or escaped. */
async function collectCodepoints(): Promise<number[]> {
	const glob = new Bun.Glob("**/*.{ts,tsx,json}");
	const found = new Set<number>();
	for (const root of SCAN_ROOTS) {
		for await (const rel of glob.scan({ cwd: root })) {
			if (rel.endsWith(".test.ts") || rel.endsWith("glyph-bundle.json")) continue;
			const text = await Bun.file(path.join(root, rel)).text();
			for (const ch of text) {
				const cp = ch.codePointAt(0)!;
				if (isPrivateUse(cp)) found.add(cp);
			}
			for (const match of text.matchAll(ESCAPE_PATTERN)) {
				const cp = Number.parseInt(match[1] ?? match[2]!, 16);
				if (isPrivateUse(cp)) found.add(cp);
			}
		}
	}
	return [...found].sort((a, b) => a - b);
}

async function resolveFont(explicit: string | undefined): Promise<string> {
	if (explicit) return path.resolve(explicit);
	const cacheDir = path.join(os.homedir(), ".cache", "omp", "gen-glyphs");
	const cached = path.join(cacheDir, `${NERD_FONTS_VERSION}-${NERD_FONTS_MEMBER}`);
	if (await Bun.file(cached).exists()) return cached;
	console.error(`fetching ${NERD_FONTS_ARCHIVE}`);
	const response = await fetch(NERD_FONTS_ARCHIVE);
	if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
	await fs.mkdir(cacheDir, { recursive: true });
	const archive = path.join(cacheDir, "JetBrainsMono.tar.xz");
	await Bun.write(archive, await response.arrayBuffer());
	const result = await $`tar -xJf ${archive} -C ${cacheDir} ${NERD_FONTS_MEMBER}`.quiet().nothrow();
	if (result.exitCode !== 0) throw new Error(`tar failed: ${result.stderr.toString()}`);
	await fs.rename(path.join(cacheDir, NERD_FONTS_MEMBER), cached);
	await fs.rm(archive);
	return cached;
}

async function main(): Promise<void> {
	const fontIndex = process.argv.indexOf("--font");
	const fontPath = await resolveFont(fontIndex >= 0 ? process.argv[fontIndex + 1] : undefined);
	const font = new TrueTypeFont(new Uint8Array(await Bun.file(fontPath).arrayBuffer()));
	const { unitsPerEm, ascender, descender } = font.metrics;
	console.error(`font: ${font.fullName} (${font.version}) upm=${unitsPerEm} asc=${ascender} desc=${descender}`);

	const codepoints = await collectCodepoints();
	const glyphs: Record<string, { glyf: string; stretch?: true }> = {};
	const skipped: string[] = [];
	let advance: number | undefined;
	for (const cp of codepoints) {
		const hex = cp.toString(16);
		const glyphId = font.glyphId(cp);
		if (glyphId === undefined) {
			skipped.push(`${hex} (not in font)`);
			continue;
		}
		// Lift the outline so the layout box is [0, aw] × [0, asc - desc] with
		// y=0 at the descender line: implementations (Ghostty) treat the
		// declared `lh` box as starting at y=0, and centring then places the
		// font's full line box on the cell exactly like native fallback rendering.
		const outline = font
			.outline(glyphId)
			.map(contour => contour.map(pt => ({ x: pt.x, y: pt.y - descender, onCurve: pt.onCurve })))
			.filter(contour => contour.length > 0);
		if (outline.length === 0) {
			skipped.push(`${hex} (empty outline)`);
			continue;
		}
		const pointCount = outline.reduce((sum, contour) => sum + contour.length, 0);
		if (pointCount > MAX_POINTS)
			throw new Error(`U+${hex.toUpperCase()} has ${pointCount} points, over the 64 KiB budget`);
		const aw = font.advanceWidth(glyphId);
		if (advance === undefined) advance = aw;
		else if (aw !== advance)
			throw new Error(`U+${hex.toUpperCase()} advance ${aw} differs from ${advance}; use a Mono face`);

		const bytes = encodeSimpleGlyph(outline);
		// Validate the wire form decodes back to the same points before shipping.
		const decoded = decodeSimpleGlyph(bytes);
		if (JSON.stringify(decoded) !== JSON.stringify(outline))
			throw new Error(`U+${hex.toUpperCase()} failed round-trip`);

		const entry: { glyf: string; stretch?: true } = { glyf: Buffer.from(bytes).toString("base64") };
		if (cp >= POWERLINE_RANGE[0] && cp <= POWERLINE_RANGE[1]) entry.stretch = true;
		glyphs[hex] = entry;
	}
	if (advance === undefined) throw new Error("no glyphs found");

	const bundle = {
		$comment: `Generated by packages/tui/scripts/gen-glyphs.ts from ${font.fullName} (${font.version}). Do not edit; run \`bun run gen:glyphs\`.`,
		upm: unitsPerEm,
		aw: advance,
		lh: ascender - descender,
		glyphs,
	};
	await Bun.write(OUTPUT, `${JSON.stringify(bundle, null, "\t")}\n`);
	const bytes = Object.values(glyphs).reduce((sum, entry) => sum + entry.glyf.length, 0);
	console.error(
		`wrote ${Object.keys(glyphs).length} glyphs (${bytes} base64 bytes) to ${path.relative(REPO_ROOT, OUTPUT)}`,
	);
	if (skipped.length > 0) console.error(`skipped: ${skipped.join(", ")}`);
}

await main();
