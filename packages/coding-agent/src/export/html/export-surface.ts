// Export-surface color math shared by the HTML export pipeline and the theme
// resolver. Extracted from index.ts so `modes/theme/theme.ts` can guard derived
// colors against the surface the exported CSS actually paints.

/** Parse a color string to RGB values. */
export function parseColor(color: string): { r: number; g: number; b: number } | undefined {
	const hexMatch = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (hexMatch) {
		return {
			r: Number.parseInt(hexMatch[1], 16),
			g: Number.parseInt(hexMatch[2], 16),
			b: Number.parseInt(hexMatch[3], 16),
		};
	}
	const rgbMatch = color.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
	if (rgbMatch) {
		return {
			r: Number.parseInt(rgbMatch[1], 10),
			g: Number.parseInt(rgbMatch[2], 10),
			b: Number.parseInt(rgbMatch[3], 10),
		};
	}
	return undefined;
}

/** Calculate relative luminance of a color (0-1, higher = lighter). */
export function getLuminance(r: number, g: number, b: number): number {
	const toLinear = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Adjust color brightness. */
export function adjustBrightness(color: string, factor: number): string {
	const parsed = parseColor(color);
	if (!parsed) return color;
	const adjust = (c: number) => Math.min(255, Math.max(0, Math.round(c * factor)));
	return `rgb(${adjust(parsed.r)}, ${adjust(parsed.g)}, ${adjust(parsed.b)})`;
}

/** Derive export background colors from a base color. */
export function deriveExportColors(baseColor: string): { pageBg: string; cardBg: string; infoBg: string } {
	const parsed = parseColor(baseColor);
	if (!parsed) {
		return { pageBg: "rgb(24, 24, 30)", cardBg: "rgb(30, 30, 36)", infoBg: "rgb(60, 55, 40)" };
	}

	const luminance = getLuminance(parsed.r, parsed.g, parsed.b);
	if (luminance > 0.5) {
		return {
			pageBg: adjustBrightness(baseColor, 0.96),
			cardBg: baseColor,
			infoBg: `rgb(${Math.min(255, parsed.r + 10)}, ${Math.min(255, parsed.g + 5)}, ${Math.max(0, parsed.b - 20)})`,
		};
	}
	return {
		pageBg: adjustBrightness(baseColor, 0.7),
		cardBg: adjustBrightness(baseColor, 0.85),
		infoBg: `rgb(${Math.min(255, parsed.r + 20)}, ${Math.min(255, parsed.g + 15)}, ${parsed.b})`,
	};
}

/**
 * Per-channel sRGB mix mirroring CSS `color-mix(in srgb, a W%, b)`. Returns a
 * hex string (the format `relativeLuminance` accepts); returns `b` unchanged
 * when either input is unparseable.
 */
export function mixSrgb(a: string, b: string, weightOfA: number): string {
	const pa = parseColor(a);
	const pb = parseColor(b);
	if (!pa || !pb) return b;
	const channel = (x: number, y: number) => Math.round(x * weightOfA + y * (1 - weightOfA));
	const toHex = (c: number) => c.toString(16).padStart(2, "0");
	return `#${toHex(channel(pa.r, pb.r))}${toHex(channel(pa.g, pb.g))}${toHex(channel(pa.b, pb.b))}`;
}

/**
 * Effective backdrop of an exported `.user-message`: the template paints
 * `color-mix(in srgb, var(--accent) 6%, transparent)` over `--body-bg` — the
 * export `pageBg` when the theme defines one, else the background derived
 * from the TUI bubble color.
 */
export function exportUserMessageSurface(accent: string, pageBg: string | undefined, userMessageBg: string): string {
	const bodyBg = pageBg ?? deriveExportColors(userMessageBg || "#343541").pageBg;
	return mixSrgb(accent, bodyBg, 0.06);
}
