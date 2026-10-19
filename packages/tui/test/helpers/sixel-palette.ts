/**
 * Shared SIXEL helpers for tests that inspect encoder output.
 *
 * icy_sixel emits palette entries as `#<index>;2;<r>;<g>;<b>`, where each
 * channel is a 0..100 percentage. A uniform translucent image therefore
 * produces exactly one palette color. The parser returns that triple or
 * `undefined`; assertion shape is left to each test, since `expect`
 * imports stay local to the calling test file.
 */

const SIXEL_PALETTE = /#\d+;2;(\d+);(\d+);(\d+)/;

/**
 * Parse the first `#N;2;R;G;B` palette introducer in the joined SIXEL
 * payload and return the three percentages as a tuple. Returns `undefined`
 * when no palette entry is found.
 */
export function parseSixelPalettePercent(rows: readonly string[]): [number, number, number] | undefined {
	const match = SIXEL_PALETTE.exec(rows.join(""));
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}
