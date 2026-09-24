import type { MermaidRenderOptions } from "@oh-my-pi/pi-natives";
import * as mermaidAscii from "@oh-my-pi/pi-utils/mermaid-ascii";

/**
 * Options controlling how fenced Mermaid source is resolved to terminal ASCII.
 * Extends the raw render options (theme, color mode, spacing, `useAscii`) with a
 * viewport-fitting hint.
 */
export interface MermaidResolveOptions extends MermaidRenderOptions {
	/**
	 * Maximum display width (terminal columns) the diagram should occupy.
	 * Flowcharts are also rendered top-down and left-to-right. A resize picks
	 * the shortest variant that fits; if none fit, the narrowest, which the
	 * caller may still clip. Omit to keep the source's own layout.
	 */
	maxWidth?: number;
}

// Memoizes rendered ASCII (and failures) keyed on the render options + the
// layout-direction variant + source. Width selection happens per call against
// the cached renders, so a terminal resize re-decides without re-rendering.
const cache = new Map<string, string | null>();

/** Display columns, ignoring ANSI so themed diagrams are measured as drawn. */
const DISPLAY_WIDTH = { countAnsiEscapeCodes: false } as const;

function asciiDisplayWidth(ascii: string): number {
	let max = 0;
	for (const line of ascii.split("\n")) {
		const width = Bun.stringWidth(line, DISPLAY_WIDTH);
		if (width > max) max = width;
	}
	return max;
}

interface LayoutCandidate {
	ascii: string;
	width: number;
	height: number;
	authored: boolean;
}

function measureLayout(ascii: string, authored: boolean): LayoutCandidate {
	return { ascii, width: asciiDisplayWidth(ascii), height: ascii.split("\n").length, authored };
}

function renderVariant(
	source: string,
	baseOptions: MermaidRenderOptions,
	baseKey: string,
	direction: "TD" | "LR" | null,
): string | null {
	const key = `${baseKey}\x00${direction ?? ""}\x00${source}`;
	const cached = cache.get(key);
	if (cached !== undefined) return cached;

	const ascii = mermaidAscii.renderMermaidAsciiSafe(source, direction ? { ...baseOptions, direction } : baseOptions);
	cache.set(key, ascii);
	return ascii;
}

const FORCED_DIRECTIONS = ["TD", "LR"] as const;
type ForcedDirection = (typeof FORCED_DIRECTIONS)[number];

/**
 * Forced TD/LR renders that can differ from the authored one. Sequence, class,
 * ER, and xychart ignore direction, so they get none; header match mirrors
 * native `detect_diagram_kind`, including its JavaScript `\w` boundary
 * (`[A-Za-z0-9_]`). A `graph`/`flowchart` header already authored in one of
 * the forced layouts (`TD`/`TB` lay out as TD, `LR`/`RL` as LR) skips that
 * variant: the native override replaces the header direction, so the render
 * would be byte-identical to the authored one.
 */
function forcedDirections(source: string): readonly ForcedDirection[] {
	const header = (source.split("\n", 1)[0] ?? "").trim().toLowerCase();
	for (const prefix of ["xychart-beta", "xychart"] as const) {
		if (!header.startsWith(prefix)) continue;
		const next = header.charCodeAt(prefix.length);
		const wordChar =
			(next >= 48 && next <= 57) || (next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 95;
		if (!wordChar) return [];
	}
	if (header === "sequencediagram" || header === "classdiagram" || header === "erdiagram") return [];
	const authored = /^(?:graph|flowchart)\s+(td|tb|lr|rl)$/.exec(header)?.[1];
	if (authored === "td" || authored === "tb") return ["LR"];
	if (authored === "lr" || authored === "rl") return ["TD"];
	return FORCED_DIRECTIONS;
}

/**
 * Resolve mermaid ASCII from fenced block source text.
 * Returns null when rendering fails, while memoizing failures to avoid repeated work.
 */
export function resolveMermaidAscii(source: string, options?: MermaidResolveOptions): string | null {
	const normalizedSource = source.replace(/\r\n?/g, "\n").trim();
	if (!normalizedSource) return null;

	const { maxWidth, ...rest } = options ?? {};
	// Default to uncolored output; callers opt into a themed palette explicitly.
	const baseOptions: MermaidRenderOptions = { colorMode: "none", ...rest };
	const baseKey = JSON.stringify(baseOptions);

	const base = renderVariant(normalizedSource, baseOptions, baseKey, null);
	if (base === null) return null;
	if (maxWidth === undefined) return base;

	// Width selection is against cached renders, so a later resize re-decides
	// without drawing again. Only forced layouts that can differ from the
	// authored one are rendered (see `forcedDirections`).
	const candidates = [measureLayout(base, true)];
	for (const direction of forcedDirections(normalizedSource)) {
		const variant = renderVariant(normalizedSource, baseOptions, baseKey, direction);
		if (variant !== null) candidates.push(measureLayout(variant, false));
	}

	const fitting = candidates.filter(candidate => candidate.width <= maxWidth);
	const pool = fitting.length > 0 ? fitting : candidates;
	let best = pool[0]!;
	for (let i = 1; i < pool.length; i++) {
		const next = pool[i]!;
		if (fitting.length > 0) {
			if (next.height !== best.height) {
				if (next.height < best.height) best = next;
				continue;
			}
			if (next.authored !== best.authored) {
				if (next.authored) best = next;
				continue;
			}
			if (next.width < best.width) best = next;
			continue;
		}
		if (next.width !== best.width) {
			if (next.width < best.width) best = next;
			continue;
		}
		if (next.height !== best.height) {
			if (next.height < best.height) best = next;
			continue;
		}
		if (next.authored) best = next;
	}
	return best.ascii;
}

/**
 * Clear the mermaid cache.
 */
export function clearMermaidCache(): void {
	cache.clear();
}
