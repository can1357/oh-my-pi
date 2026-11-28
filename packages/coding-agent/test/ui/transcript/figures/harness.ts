/**
 * Corpus checks for the figure-family screens (`transcript/<screen>`).
 *
 * Like the message harness, but stages may wait (rasters, loads), cases may
 * paint in a kitty terminal (the `kitty` captures: 8×16 px cells) or with
 * hyperlinks, and:
 * - a recorded native of `null` means the screen had no native description
 *   (terminal-only, or a figure the old renderer never described): only rows
 *   are compared;
 * - the old renderer's legacy `rows` fallback (`{ k: "rows", p: { rows } }`)
 *   is the same thing as a `canvas` (described `{ k: "rows", p: { lines } }`).
 *
 * Rows and natives a screen does not match on purpose are listed deviations
 * (`../../deviations.ts`). A listed deviation naming its stages that starts
 * matching fails the test.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Accessor, createRoot, isUiNode, signal, type UiNode } from "@oh-my-pi/pi-tui";
import type { TerminalCapabilities } from "@oh-my-pi/pi-tui/driver/contract";
import { TerminalImages } from "@oh-my-pi/pi-tui/driver/images/store";
import { driverImages } from "@oh-my-pi/pi-tui/term/backend";
import { paintNode, type StaticEnvironment, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";
import { CORPUS_DIR, CORPUS_NOW, type CorpusCase, describeTree, stageNative } from "@oh-my-pi/pi-tui/testing/corpus";
import { CONSERVATIVE_EMOJI } from "@oh-my-pi/pi-tui/theme/contract";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { captureStage, skipsAt } from "../../deviations";
import { canonicalNative, nativeDiff } from "../messages/harness";
import "../../../../src/ui/styles/figures";

/** Kitty capabilities of the `kitty` captures (8×16 px cells). */
export const KITTY: TerminalCapabilities = {
	truecolor: true,
	colors: 16_777_216,
	synchronizedOutput: true,
	hyperlinks: false,
	images: "kitty",
	kittyKeyboard: true,
	bracketedPaste: true,
	background: null,
	dark: true,
	cell: { w: 8, h: 16 },
	multiplexer: null,
	textSizing: false,
	tsp: false,
	emoji: CONSERVATIVE_EMOJI,
};

/** A block under test and how its model moves through the stages. */
export interface FigureDriver {
	readonly node: UiNode | Accessor<UiNode>;
	/** Apply the change a stage label stands for (stage 0 is the initial state); may wait for async work. */
	apply?(label: string, index: number): void | Promise<void>;
	/** Rows the transcript allocates to the block, when it fixes them. */
	height?(): number | undefined;
	/** Wait for the block's async work before the stage is compared (stage 0 included). */
	settle?(): Promise<void>;
}

export interface FigureContext {
	readonly env: StaticEnvironment;
	/** The case paints in a kitty terminal. */
	readonly kitty: boolean;
}

export type FigureBuilder = (corpusCase: CorpusCase, cx: FigureContext) => FigureDriver;

export interface FigureSuiteOptions {
	/** Paint with OSC 8 hyperlinks on. */
	readonly hyperlinks?: boolean;
}

/**
 * `rows` without cursor save/restore (`ESC 7`/`ESC 8`): invisible, but the
 * cell model does not parse them yet (see pi-ui-requests: testing/cells.ts).
 */
function withoutCursorSaves(rows: readonly string[]): string[] {
	return rows.map(row => row.replace(/\x1b[78]/g, ""));
}

/** Results of one screen run (for the deviation report). */
export interface FigureResult {
	readonly screen: string;
	stages: number;
	nativePassed: number;
	rowsPassed: number;
	readonly deviations: string[];
}

const results: FigureResult[] = [];

export function figureResults(): readonly FigureResult[] {
	return results;
}

/** One test per case of `transcript/<screen>`; skipped when the corpus is absent. */
export function figureSuite(screen: string, build: FigureBuilder, options: FigureSuiteOptions = {}): void {
	const dir = path.join(CORPUS_DIR, "transcript", screen);
	const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => file.endsWith(".dark.json")) : [];
	const result: FigureResult = {
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
				const kitty = (corpusCase.inputs as { imageProtocol?: string } | undefined)?.imageProtocol === "kitty";
				const caps = signal(KITTY);
				const env = staticEnvironment(loadThemeSync(corpusCase.theme), {
					now: CORPUS_NOW,
					hyperlinks: options.hyperlinks === true,
					...(kitty
						? {
								images: driverImages(new TerminalImages({ capabilities: caps }), caps),
							}
						: {}),
				});
				const failures: string[] = [];
				const stale: string[] = [];
				const { driver, dispose } = createRoot(dispose => ({
					driver: build(corpusCase, { env, kitty }),
					dispose,
				}));
				try {
					for (let index = 0; index < corpusCase.stages.length; index++) {
						const stage = corpusCase.stages[index]!;
						if (index > 0) await driver.apply?.(stage.label, index);
						if (driver.settle) {
							// Lazy regions create their figures (and start their work) when first resolved.
							describeTree(isUiNode(driver.node) ? driver.node : driver.node(), env);
							await driver.settle();
						}
						result.stages++;
						const node = isUiNode(driver.node) ? driver.node : driver.node();
						const ref = {
							screen: `transcript/${screen}`,
							case: kase,
							index,
							label: stage.label,
						};
						const expected = stageNative(corpusCase, index);
						const described = expected === null ? undefined : describeTree(node, env);
						const native = described === undefined ? null : nativeDiff(canonicalNative(expected), described);
						const nativeWhy = skipsAt(ref, "native");
						if (native && !nativeWhy) failures.push(`stage ${index} (${stage.label}) native: ${native}`);
						else if (native && nativeWhy)
							result.deviations.push(`${kase} stage ${index} (${stage.label}) native: ${nativeWhy.reason}`);
						else {
							result.nativePassed++;
							if (nativeWhy?.stages) stale.push(`${kase}/${index} native`);
						}
						let rowsOk = true;
						const painted: Record<string, readonly string[]> = {};
						for (const width of corpusCase.widths) {
							const actual = createRoot(release => {
								const rows = paintNode(env, node, width, driver.height?.()).rows;
								release();
								return rows;
							});
							painted[String(width)] = actual;
							const diff = firstCellDiff(
								withoutCursorSaves(stage.rows[String(width)] ?? []),
								withoutCursorSaves(actual),
							);
							const why = skipsAt(ref, "rows", width);
							if (diff && !why) {
								rowsOk = false;
								failures.push(`stage ${index} (${stage.label}) @${width}: ${diff}`);
							} else if (diff && why) {
								rowsOk = false;
								result.deviations.push(`${kase} stage ${index} (${stage.label}) @${width}: ${why.reason}`);
							} else if (why?.stages) {
								stale.push(`${kase}/${index}/${width}`);
							}
						}
						captureStage({
							...ref,
							file: `${kase}.dark.json`,
							rows: painted,
							native: described,
							expectedNative: expected === null ? undefined : canonicalNative(expected),
						});
						if (rowsOk) result.rowsPassed++;
					}
				} finally {
					dispose();
				}
				if (failures.length > 0) throw new Error(`\n${failures.join("\n")}`);
				expect(stale).toEqual([]);
			});
		}
	});
}
