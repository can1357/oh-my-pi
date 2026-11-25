/** Terminal color reports (OSC 10/11 replies) and the dark/light decision. */

export interface Rgb {
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

function channel(hex: string): number | null {
	if (!/^[0-9a-f]{1,4}$/i.test(hex)) return null;
	const max = 16 ** hex.length - 1;
	return Math.round((Number.parseInt(hex, 16) / max) * 255);
}

/**
 * Parse an X11 color spec as terminals report it: `rgb:R/G/B` or
 * `rgba:R/G/B/A` with 1–4 hex digits per channel, or `#RRGGBB`.
 */
export function parseColorSpec(spec: string): Rgb | null {
	const text = spec.trim();
	const x11 = /^rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(?:\/[0-9a-f]+)?$/i.exec(text);
	if (x11) {
		const [r, g, b] = [channel(x11[1]!), channel(x11[2]!), channel(x11[3]!)];
		return r === null || g === null || b === null ? null : { r, g, b };
	}
	const hash = /^#([0-9a-f]{6})$/i.exec(text);
	if (hash) {
		const value = Number.parseInt(hash[1]!, 16);
		return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
	}
	return null;
}

/** Whether a background reads as dark (Rec. 709 relative luminance below one half). */
export function isDarkBackground({ r, g, b }: Rgb): boolean {
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}
