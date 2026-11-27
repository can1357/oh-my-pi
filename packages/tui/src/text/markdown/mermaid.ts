/**
 * Mermaid fences as terminal art. Flowcharts are also laid out top-down and
 * left-to-right; the shortest layout that fits the width wins (the authored
 * one on ties), else the narrowest.
 */
import { type MermaidRenderOptions, renderMermaidAscii } from "@oh-my-pi/pi-natives";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type { Theme } from "../../theme/contract";
import { visibleWidth } from "../width";

const renders = new LRUCache<string, string | null>({
	max: 256,
	maxSize: 4 * 1024 * 1024,
	sizeCalculation: (art, key) => key.length + (art?.length ?? 0),
});

function render(source: string, options: MermaidRenderOptions): string | null {
	const key = `${JSON.stringify(options)}\u0000${source}`;
	const cached = renders.get(key);
	if (cached !== undefined) return cached;
	let art: string | null;
	try {
		art = renderMermaidAscii(source, options);
	} catch {
		art = null;
	}
	renders.set(key, art);
	return art;
}

/** Forced layouts that can differ from the authored one (none for diagrams that ignore direction). */
function forcedDirections(source: string): readonly ("TD" | "LR")[] {
	const header = (source.split("\n", 1)[0] ?? "").trim().toLowerCase();
	if (/^xychart(?:-beta)?(?![a-z0-9_])/.test(header)) return [];
	if (header === "sequencediagram" || header === "classdiagram" || header === "erdiagram") return [];
	const authored = /^(?:graph|flowchart)\s+(td|tb|lr|rl)$/.exec(header)?.[1];
	if (authored === "td" || authored === "tb") return ["LR"];
	if (authored === "lr" || authored === "rl") return ["TD"];
	return ["TD", "LR"];
}

/** Hex of a theme foreground (terminal default resolved), read from the truecolor SGR it emits. */
function foregroundHex(theme: Theme, color: string): string | undefined {
	const match = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(theme.fgResolved(color, "x"));
	if (!match) return undefined;
	return `#${[match[1], match[2], match[3]].map(c => Number(c).toString(16).padStart(2, "0")).join("")}`;
}

function themedOptions(theme: Theme): MermaidRenderOptions {
	const text = foregroundHex(theme, "text");
	const muted = foregroundHex(theme, "muted");
	const accent = foregroundHex(theme, "accent");
	if (!text || !muted || !accent) return { colorMode: "none" };
	return {
		colorMode: "truecolor",
		theme: { fg: text, border: muted, line: muted, arrow: accent, corner: muted, junction: muted },
	};
}

interface Layout {
	readonly rows: string[];
	readonly width: number;
	readonly authored: boolean;
}

function layoutOf(art: string, authored: boolean): Layout {
	const rows = art.split("\n");
	return { rows, width: Math.max(0, ...rows.map(visibleWidth)), authored };
}

/** The rows of a Mermaid diagram fitted to `width`, or undefined when the source does not render. */
export function mermaidRows(source: string, width: number, theme: Theme): string[] | undefined {
	const normalized = source.replace(/\r\n?/g, "\n").trim();
	if (!normalized) return undefined;
	const options = themedOptions(theme);
	const authored = render(normalized, options);
	if (authored === null) return undefined;
	const candidates = [layoutOf(authored, true)];
	for (const direction of forcedDirections(normalized)) {
		const art = render(normalized, { ...options, direction });
		if (art !== null) candidates.push(layoutOf(art, false));
	}
	const fitting = candidates.filter(candidate => candidate.width <= width);
	const better = (a: Layout, b: Layout): boolean => {
		if (fitting.length > 0) {
			if (a.rows.length !== b.rows.length) return a.rows.length < b.rows.length;
			if (a.authored !== b.authored) return a.authored;
			return a.width < b.width;
		}
		if (a.width !== b.width) return a.width < b.width;
		if (a.rows.length !== b.rows.length) return a.rows.length < b.rows.length;
		return a.authored && !b.authored;
	};
	const pool = fitting.length > 0 ? fitting : candidates;
	let best = pool[0]!;
	for (const candidate of pool.slice(1)) if (better(candidate, best)) best = candidate;
	return best.rows;
}
