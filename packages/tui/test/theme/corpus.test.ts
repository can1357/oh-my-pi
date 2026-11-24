/**
 * Theme bytes against the corpus: for each span token below, some corpus
 * stage holds a span with exactly that token whose text the recorded rows
 * draw with exactly the bytes `theme.style(token, text)` produces. That pins
 * the SGR of each color key (and the color/attribute nesting) to what today's
 * terminal output shows, in dark and light.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { builtinThemes, createTheme, type ResolvedTheme } from "@oh-my-pi/pi-tui/theme/index";

const CORPUS = path.join(import.meta.dir, "../corpus");

const KEYS: Record<"dark" | "light", readonly string[]> = {
	dark: [
		"muted",
		"dim",
		"accent",
		"success",
		"error",
		"warning",
		"toolOutput",
		"customMessageLabel",
		"thinkingHigh",
		"statusLineCost",
		"statusLineModel",
		"statusLinePath",
		"statusLineGitDirty",
		"strong",
		"em",
		"path",
		"path dim",
		"ins num",
		"del num",
		"mono dim",
		"mono accent",
		"dim em",
		"accent strong",
		"muted strong",
		"success strong",
		"customMessageLabel strong",
		"toolTitle strong",
	],
	light: [
		"muted",
		"dim",
		"accent",
		"success",
		"error",
		"warning",
		"toolOutput",
		"thinkingHigh",
		"strong",
		"path",
		"path dim",
		"dim mono",
		"toolTitle strong",
	],
};

interface Span {
	readonly t: string;
	readonly s: string;
}

function collectSpans(node: unknown, out: Span[]): void {
	if (Array.isArray(node)) {
		for (const child of node) collectSpans(child, out);
		return;
	}
	if (typeof node !== "object" || node === null) return;
	const record = node as Record<string, unknown>;
	if (typeof record.t === "string" && typeof record.s === "string") out.push({ t: record.t, s: record.s });
	for (const key in record) collectSpans(record[key], out);
}

interface CorpusStage {
	readonly native: unknown;
	readonly rows: Record<string, readonly string[]>;
}

/** Token → a fixture where the theme's bytes for one of its spans appear verbatim. */
async function matchCorpus(themeName: "dark" | "light", theme: ResolvedTheme): Promise<Map<string, string>> {
	const wanted = new Set(KEYS[themeName]);
	const found = new Map<string, string>();
	for await (const file of new Bun.Glob(`**/*.${themeName}.json`).scan(CORPUS)) {
		let data: { stages?: readonly CorpusStage[] };
		try {
			data = await Bun.file(path.join(CORPUS, file)).json();
		} catch {
			continue; // a fixture being recaptured right now
		}
		let native: unknown;
		for (const stage of data.stages ?? []) {
			if (stage.native !== "same") native = stage.native;
			const spans: Span[] = [];
			collectSpans(native, spans);
			let rows: string | undefined;
			for (const { t, s } of spans) {
				if (!wanted.has(s) || found.has(s) || t.trim().length < 2) continue;
				rows ??= Object.values(stage.rows).flat().join("\n");
				if (rows.includes(theme.style(s, t))) found.set(s, file);
			}
		}
		if (found.size === wanted.size) break;
	}
	return found;
}

for (const themeName of ["dark", "light"] as const) {
	describe(`${themeName} theme bytes match the corpus`, () => {
		let found: Map<string, string>;
		beforeAll(async () => {
			found = await matchCorpus(themeName, createTheme(builtinThemes()[themeName]!));
		});

		for (const token of KEYS[themeName]) {
			it(token, () => {
				expect(found.has(token), `no corpus span "${token}" drawn with this theme's bytes`).toBe(true);
			});
		}
	});
}
