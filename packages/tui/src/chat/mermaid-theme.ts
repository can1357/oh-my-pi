import { hexToOklch, oklchToHex } from "@oh-my-pi/pi-utils/color";
import { theme } from "../theme";
import { svgFigurePalette } from "./svg-figure";

/** Late-bound paint only: the shared chart/SVG palette and layout remain unchanged. */
export function mermaidFigurePalette(): Record<string, string> {
	const palette = svgFigurePalette();
	const light = theme.isLight;
	const accent = hexToOklch(palette.accent!);
	palette["mermaid-background"] = theme.getBgHex("toolPendingBg");
	palette["mermaid-group"] = oklchToHex({ l: light ? 0.975 : 0.205, c: 0.009, h: accent.h });
	palette["mermaid-border"] = oklchToHex({ l: light ? 0.72 : 0.4, c: 0.01, h: accent.h });
	palette["mermaid-line"] = oklchToHex({ l: light ? 0.45 : 0.68, c: 0.015, h: accent.h });
	palette["mermaid-muted"] = oklchToHex({ l: light ? 0.42 : 0.77, c: 0.015, h: accent.h });
	for (const [name, color] of [
		["node", palette.c1!],
		["decision", palette.c2!],
		["boundary", palette.c3!],
		["storage", palette.c4!],
	] as const) {
		const tone = hexToOklch(color);
		palette[`mermaid-${name}`] = oklchToHex({ l: light ? 0.94 : 0.31, c: light ? 0.025 : 0.05, h: tone.h });
		palette[`mermaid-${name}-border`] = oklchToHex({ l: light ? 0.48 : 0.74, c: Math.min(0.14, tone.c), h: tone.h });
	}
	return palette;
}
