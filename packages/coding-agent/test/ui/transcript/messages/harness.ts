/**
 * Corpus checks for `transcript/<screen>` message blocks.
 *
 * A screen test builds the block for a case, then replays the case's stage
 * labels as model changes. Each stage is compared twice: the described tree
 * against the recorded native tree (the recorded props must all be there;
 * extra props are allowed), and the terminal rows at every recorded width
 * against the recorded rows, cell by cell.
 *
 * Rows a screen does not match on purpose are listed deviations
 * (`../../deviations.ts`); one naming its stages and widths that starts
 * matching fails the test so the list stays honest.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type Accessor,
	createRoot,
	isUiNode,
	type JSXNode,
	resolveChildren,
	setNativeRenderingForTest,
	type UiNode,
} from "@oh-my-pi/pi-tui";
import { paintNode, type StaticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";
import {
	CORPUS_DIR,
	type CorpusCase,
	corpusEnvironment,
	describeTree,
	stageNative,
} from "@oh-my-pi/pi-tui/testing/corpus";
import "../../../../src/ui/styles/messages";
import { captureStage, skipsAt } from "../../deviations";

/** The single node a component renders. */
export function single(node: JSXNode): UiNode {
	if (isUiNode(node)) return node;
	throw new Error("expected the component to render one node");
}

/** The node a dynamic component (a region) currently renders. */
export function region(node: JSXNode): Accessor<UiNode> {
	const nodes = resolveChildren(node);
	return () => {
		const list = nodes();
		if (list.length !== 1) throw new Error(`expected one node, the region holds ${list.length}`);
		return list[0]!;
	};
}

/** A block under test and how its model moves through the stages. */
export interface StageDriver {
	/** The block's node (an accessor when the block is a region whose node changes). */
	readonly node: UiNode | Accessor<UiNode>;
	/** Apply the change a stage label stands for (stage 0 is the initial state). */
	apply?(label: string, index: number): void;
	/** The viewport rows the transcript allocates to the block, when it fixes them. */
	height?(): number | undefined;
}

/** Builds the block of a case. */
export type CaseBuilder = (corpusCase: CorpusCase, env: StaticEnvironment) => StageDriver;

/** The first place `actual` lacks or changes something `expected` records (extra props are fine). */
export function nativeDiff(expected: unknown, actual: unknown, at = "$"): string | null {
	if (Object.is(expected, actual)) return null;
	if (
		typeof expected !== "object" ||
		expected === null ||
		typeof actual !== "object" ||
		actual === null ||
		Array.isArray(expected) !== Array.isArray(actual)
	) {
		return `${at}: expected ${JSON.stringify(expected)?.slice(0, 400)} got ${JSON.stringify(actual)?.slice(0, 400)}`;
	}
	if (Array.isArray(expected)) {
		const other = actual as unknown[];
		if (expected.length !== other.length) {
			return `${at}: expected ${expected.length} items, got ${other.length}: ${JSON.stringify(other)?.slice(0, 400)}`;
		}
		for (let i = 0; i < expected.length; i++) {
			const diff = nativeDiff(expected[i], other[i], `${at}[${i}]`);
			if (diff) return diff;
		}
		return null;
	}
	const want = expected as Record<string, unknown>;
	const got = actual as Record<string, unknown>;
	// A node's props may grow; its shape (kind, key, children) and every recorded prop may not change.
	if (typeof want.k === "string") {
		const wantProps = (want.p ?? {}) as Record<string, unknown>;
		const gotProps = (got.p ?? {}) as Record<string, unknown>;
		for (const key in wantProps) {
			const diff = nativeDiff(wantProps[key], gotProps[key], `${at}.p.${key}`);
			if (diff) return diff;
		}
		for (const key in want) {
			if (key === "p") continue;
			const diff = nativeDiff(want[key], got[key], `${at}.${key}`);
			if (diff) return diff;
		}
		for (const key in got) {
			if (key !== "p" && !(key in want))
				return `${at}.${key}: unexpected ${JSON.stringify(got[key])?.slice(0, 400)}`;
		}
		return null;
	}
	for (const key in want) {
		const diff = nativeDiff(want[key], got[key], `${at}.${key}`);
		if (diff) return diff;
	}
	for (const key in got) {
		if (!(key in want)) return `${at}.${key}: unexpected ${JSON.stringify(got[key])?.slice(0, 400)}`;
	}
	return null;
}

/** The recorded tree with the capture's legacy `rows` fallback (a component without a description) written as a canvas describes. */
export function canonicalNative(native: unknown): unknown {
	if (Array.isArray(native)) return native.map(canonicalNative);
	if (!native || typeof native !== "object") return native;
	const node = native as Record<string, unknown> & {
		k?: string;
		p?: Record<string, unknown>;
	};
	if (node.k === "rows" && Array.isArray(node.p?.rows)) return { k: "rows", p: { lines: node.p.rows } };
	const out: Record<string, unknown> = {};
	for (const key in node) out[key] = key === "c" ? canonicalNative(node[key]) : node[key];
	return out;
}

/** Results of one screen run (for the deviation report). */
export interface ScreenResult {
	readonly screen: string;
	stages: number;
	nativePassed: number;
	rowsPassed: number;
	readonly deviations: string[];
}

const results: ScreenResult[] = [];

/** Every result recorded so far in this process. */
export function screenResults(): readonly ScreenResult[] {
	return results;
}

/** One test per case of `transcript/<screen>`; skipped when the corpus is absent. */
export function screenSuite(screen: string, build: CaseBuilder): void {
	const dir = path.join(CORPUS_DIR, "transcript", screen);
	const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => file.endsWith(".dark.json")) : [];
	const result: ScreenResult = {
		screen,
		stages: 0,
		nativePassed: 0,
		rowsPassed: 0,
		deviations: [],
	};
	results.push(result);
	describe.skipIf(files.length === 0)(`transcript/${screen}`, () => {
		for (const file of files.sort()) {
			const kase = file.replace(/\.dark\.json$/, "");
			test(kase, async () => {
				const corpusCase = (await Bun.file(path.join(dir, file)).json()) as CorpusCase;
				const env = corpusEnvironment(corpusCase.theme);
				const failures: string[] = [];
				const stale: string[] = [];
				createRoot(dispose => {
					const driver = build(corpusCase, env);
					corpusCase.stages.forEach((stage, index) => {
						if (index > 0) driver.apply?.(stage.label, index);
						result.stages++;
						const node = isUiNode(driver.node) ? driver.node : driver.node();
						const ref = {
							screen: `transcript/${screen}`,
							case: kase,
							index,
							label: stage.label,
						};
						// Described as a native host would: nodes that read `nativeRendering` take their native shape.
						setNativeRenderingForTest(true);
						let described: unknown;
						try {
							described = describeTree(node, env);
						} finally {
							setNativeRenderingForTest(false);
						}
						const native = nativeDiff(canonicalNative(stageNative(corpusCase, index)), described);
						if (native) failures.push(`stage ${index} (${stage.label}) native: ${native}`);
						else result.nativePassed++;
						let rowsOk = true;
						const painted: Record<string, readonly string[]> = {};
						for (const width of corpusCase.widths) {
							const expected = stage.rows[String(width)] ?? [];
							const actual = paintNode(env, node, width, driver.height?.()).rows;
							painted[String(width)] = actual;
							const diff = firstCellDiff(expected, actual);
							const why = skipsAt(ref, "rows", width);
							if (diff && !why) {
								rowsOk = false;
								failures.push(`stage ${index} (${stage.label}) @${width}: ${diff}`);
							} else if (diff && why) {
								rowsOk = false;
								result.deviations.push(`${kase} stage ${index} (${stage.label}) @${width}: ${why.reason}`);
							} else if (why?.stages && why.widths) {
								stale.push(`${kase}/${index}/${width}`);
							}
						}
						captureStage({
							screen: ref.screen,
							file: `${kase}.dark.json`,
							index,
							label: stage.label,
							rows: painted,
							native: described,
						});
						if (rowsOk) result.rowsPassed++;
					});
					dispose();
				});
				if (failures.length > 0) throw new Error(`\n${failures.join("\n")}`);
				expect(stale).toEqual([]);
			});
		}
	});
}
