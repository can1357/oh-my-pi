/**
 * Corpus suite for screens driven by stage labels: a case builds its tree once,
 * then each stage's label replays a step on the screen's model before the
 * stage's rows (every width, rendered-cell parity) and native tree (unless the
 * corpus recorded none) are compared. Skips when the local corpus is absent.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { createRoot, type JSXNode, resolveChildren, type UiNode } from "@oh-my-pi/pi-tui";
import { paintNode, type StaticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";
import {
	CORPUS_DIR,
	type CorpusCase,
	corpusEnvironment,
	describeTree,
	firstDiff,
	stageNative,
} from "@oh-my-pi/pi-tui/testing/corpus";

/** A screen under test: its tree for a case, and the step each stage label replays. */
export interface StagedScreen {
	readonly tree: JSXNode;
	/** Replays the step named `label` (stage 0 is the initial state); throws for unknown labels. */
	step(label: string, env: StaticEnvironment): void;
}

/** Differences of one stage: `native: …` and `rows@<width>: …` lines. */
export interface StageResult {
	readonly label: string;
	readonly failures: readonly string[];
}

/** The screen's current root (a dynamic root may swap nodes between stages). */
function rootOf(nodes: () => readonly UiNode[]): UiNode {
	const current = nodes();
	if (current.length === 1) return current[0]!;
	throw new Error(`corpus suite: the screen must show one root node, not ${current.length}`);
}

/** Replay every stage of `corpusCase` against the screen `build` makes for it. */
export function checkStagedCase(
	corpusCase: CorpusCase,
	build: (corpusCase: CorpusCase, env: StaticEnvironment) => StagedScreen,
): StageResult[] {
	const env = corpusEnvironment(corpusCase.theme);
	return createRoot(dispose => {
		try {
			const screen = build(corpusCase, env);
			const nodes = resolveChildren(screen.tree);
			return corpusCase.stages.map((stage, index) => {
				if (index > 0) screen.step(stage.label, env);
				const failures: string[] = [];
				const tree = rootOf(nodes);
				const native = stageNative(corpusCase, index);
				if (native !== null) {
					const diff = firstDiff(native, describeTree(tree, env));
					if (diff) failures.push(`native: ${diff}`);
				}
				for (const width of corpusCase.widths) {
					const diff = firstCellDiff(stage.rows[String(width)] ?? [], paintNode(env, tree, width).rows);
					if (diff) failures.push(`rows@${width}: ${diff}`);
				}
				return { label: stage.label, failures };
			});
		} finally {
			dispose();
		}
	});
}

/** Case files of `screen` (`composer/status-line`). */
export function caseFiles(screen: string): string[] {
	const dir = path.join(CORPUS_DIR, screen);
	return fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter(file => file.endsWith(".json"))
				.sort()
		: [];
}

/** One test per stage of every case of `screen`. */
export function stagedSuite(
	screen: string,
	build: (corpusCase: CorpusCase, env: StaticEnvironment) => StagedScreen,
): void {
	const files = caseFiles(screen);
	describe.skipIf(files.length === 0)(`${screen} corpus`, () => {
		for (const file of files) {
			const corpusCase = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, screen, file), "utf8")) as CorpusCase;
			const results = checkStagedCase(corpusCase, build);
			for (const result of results) {
				test(`${file} · ${result.label}`, () => {
					expect(result.failures).toEqual([]);
				});
			}
		}
	});
}
