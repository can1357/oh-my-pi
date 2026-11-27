/**
 * SIXEL encoding.
 *
 * SIXEL has binary transparency, so partially transparent pixels are
 * blended against the terminal background before quantization (fully
 * transparent ones stay transparent); a new background therefore needs a
 * new encode. The default encoder (`encodeSixelAsync` from
 * `@oh-my-pi/pi-natives`) decodes, resizes, blends and dithers off the
 * JavaScript thread.
 */
import type { TerminalCapabilities } from "../contract";

/** Encode image bytes as a SIXEL sequence of `widthPx`×`heightPx`, blended against `background` (`0xRRGGBB`). */
export type SixelEncoder = (
	bytes: Uint8Array,
	widthPx: number,
	heightPx: number,
	background: number,
) => Promise<string>;

/**
 * The color transparency blends against: the OSC 11 background when the
 * terminal reported a trusted one, else black for a dark terminal and white
 * for a light one.
 */
export function sixelBackground(capabilities: Pick<TerminalCapabilities, "background" | "dark">): number {
	const bg = capabilities.background;
	if (bg) return ((bg.r & 0xff) << 16) | ((bg.g & 0xff) << 8) | (bg.b & 0xff);
	return capabilities.dark ? 0x000000 : 0xffffff;
}
