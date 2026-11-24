/**
 * Corpus checks: compare a pi-tui tree against a captured stage of today's UI.
 *
 * A corpus case (`packages/tui/test/corpus/<screen>/<case>.<theme>.json`)
 * records, per stage, the terminal rows at several widths and the native
 * (TSP) tree. A reimplemented screen passes a stage when its tree describes
 * to the same native tree and the terminal backend paints the same rows.
 */
import * as path from "node:path";
import type { UiNode } from "../node";
import { untrack } from "../reactive";
import { type PaintEnvironment, paintNode, type StaticEnvironment, staticEnvironment } from "../term/paint";
import { loadThemeSync } from "../theme/loader";
import { setCurrentTheme } from "../theme/runtime";
import "../term/painters";

/** One captured stage. */
export interface CorpusStage {
	readonly label: string;
	readonly rows: Readonly<Record<string, readonly string[]>>;
	/** Expanded native tree; `"same"` repeats the previous stage's. */
	readonly native: unknown;
	readonly cursor?: Readonly<Record<string, { row: number; col: number } | null>>;
	readonly note?: unknown;
}

/** One captured case file. */
export interface CorpusCase {
	readonly screen: string;
	readonly case: string;
	readonly core: boolean;
	readonly theme: string;
	readonly widths: readonly number[];
	readonly inputs?: unknown;
	readonly stages: readonly CorpusStage[];
}

/** Where the corpus lives. */
export const CORPUS_DIR = path.join(import.meta.dir, "../../test/corpus");

/** Load a case by `<screen>/<case>.<theme>` (relative to the corpus) or absolute path. */
export async function loadCase(id: string): Promise<CorpusCase> {
	const file = path.isAbsolute(id) ? id : path.join(CORPUS_DIR, id.endsWith(".json") ? id : `${id}.json`);
	return (await Bun.file(file).json()) as CorpusCase;
}

/** Every case file of a screen (`tools/bash`), optionally one theme. */
export async function listCases(screen: string, theme?: string): Promise<string[]> {
	const glob = new Bun.Glob(`${screen}/*.${theme ?? "*"}.json`);
	const out: string[] = [];
	for await (const file of glob.scan({ cwd: CORPUS_DIR })) out.push(file);
	return out.sort();
}

/** The clock every corpus capture was pinned to (ms since epoch). */
export const CORPUS_NOW = 1_700_000_000_000;

/**
 * A paint environment matching a corpus capture: the case's built-in theme
 * (`dark`/`light`) and the pinned clock. Move the clock with `setNow` to
 * reproduce spinner frames and elapsed times a stage recorded.
 *
 * The theme also becomes the active theme (`currentTheme`), as it was in the
 * captured app: screens that build styled native spans read it, so a case
 * never depends on whichever theme an earlier test file left active.
 */
export function corpusEnvironment(themeName: string): StaticEnvironment {
	const theme = loadThemeSync(themeName);
	setCurrentTheme(theme);
	return staticEnvironment(theme, { now: CORPUS_NOW });
}

/** The native tree of stage `index`, resolving `"same"`. */
export function stageNative(corpusCase: CorpusCase, index: number): unknown {
	for (let i = index; i >= 0; i--) {
		const native = corpusCase.stages[i]!.native;
		if (native !== "same") return native;
	}
	return null;
}

function clean(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(clean);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const v = (value as Record<string, unknown>)[key];
			if (v === undefined || typeof v === "function") continue;
			out[key] = clean(v);
		}
		return out;
	}
	return value;
}

/**
 * The native (TSP) tree a node describes to, in the corpus's expanded form:
 * `{ k, key?, p?, c? }` with props sorted and undefined/function values
 * dropped, without the terminal-only `term` prop; `canvas` becomes a `rows`
 * node painted at `cols`.
 */
export function describeTree(node: UiNode, env: PaintEnvironment, cols = 80): unknown {
	return untrack(() => {
		if (node.kind === "canvas") {
			return { k: "rows", p: { cols, lines: [...paintNode(env, node, cols).rows] } };
		}
		const out: Record<string, unknown> = { k: node.kind };
		const key = node.key();
		if (key !== undefined) out.key = key;
		// `term` carries terminal-only look facts and `prepared` a note to the backend; neither is sent.
		const { term: _term, prepared: _prepared, ...wire } = node.props() as Record<string, unknown>;
		const props = clean(wire) as Record<string, unknown>;
		if (Object.keys(props).length > 0) out.p = props;
		const reveal = node.reveal();
		if (reveal !== undefined) out.reveal = clean(reveal);
		const scroll = node.scroll();
		if (scroll !== undefined) out.scroll = clean(scroll);
		const children = node.children();
		if (children.length > 0) out.c = children.map(child => describeTree(child, env, cols));
		return out;
	});
}

/** A readable first difference between two JSON values, or null when equal. */
export function firstDiff(expected: unknown, actual: unknown, at = "$"): string | null {
	if (Object.is(expected, actual)) return null;
	if (typeof expected !== typeof actual || expected === null || actual === null || typeof expected !== "object") {
		return `${at}: expected ${JSON.stringify(expected)?.slice(0, 300)} got ${JSON.stringify(actual)?.slice(0, 300)}`;
	}
	if (Array.isArray(expected) !== Array.isArray(actual)) return `${at}: array vs object`;
	const keys = new Set([...Object.keys(expected as object), ...Object.keys(actual as object)]);
	for (const key of keys) {
		const diff = firstDiff(
			(expected as Record<string, unknown>)[key],
			(actual as Record<string, unknown>)[key],
			`${at}.${key}`,
		);
		if (diff) return diff;
	}
	return null;
}

/** Result of comparing one stage. */
export interface StageCheck {
	readonly label: string;
	/** Per width: null when equal, else a description of the first differing row. */
	readonly rows: Readonly<Record<string, string | null>>;
	/** Null when the native trees are equal. */
	readonly native: string | null;
}

/**
 * Compare `tree` against stage `index` of `corpusCase`: rows at every
 * recorded width (painted in `env`) and the described native tree.
 */
export function checkStage(corpusCase: CorpusCase, index: number, tree: UiNode, env: PaintEnvironment): StageCheck {
	const stage = corpusCase.stages[index]!;
	const rows: Record<string, string | null> = {};
	for (const width of corpusCase.widths) {
		const expected = stage.rows[String(width)] ?? [];
		const actual = paintNode(env, tree, width).rows;
		let diff: string | null = null;
		const count = Math.max(expected.length, actual.length);
		for (let i = 0; i < count; i++) {
			if (expected[i] === actual[i]) continue;
			diff = `row ${i}/${expected.length} vs ${actual.length}:\n  expected ${JSON.stringify(expected[i])}\n  actual   ${JSON.stringify(actual[i])}`;
			break;
		}
		rows[String(width)] = diff;
	}
	const native = firstDiff(stageNative(corpusCase, index), describeTree(tree, env));
	return { label: stage.label, rows, native };
}

/** Whether a stage check found no difference. */
export function stagePassed(check: StageCheck): boolean {
	return check.native === null && Object.values(check.rows).every(diff => diff === null);
}
