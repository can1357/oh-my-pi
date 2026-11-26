/**
 * Replays overlay corpus cases (`overlays/<screen>/<case>.<theme>`) against a
 * pi-tui screen: keys go through the terminal backend's order (`onKey` up
 * the focus path, then the focused kind's widget), mouse reports resolve
 * through the painted block's hits, native events bubble from the root.
 * Each stage compares the native tree (additive props allowed) and the rows
 * at every recorded width (rendered-cell parity).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { bubbleEvent, bubbleKey, keypathOf, pathTo } from "@oh-my-pi/pi-tui/dispatch";
import { decodeKey } from "@oh-my-pi/pi-tui/driver/input/keys";
import { decodeMouse } from "@oh-my-pi/pi-tui/driver/input/mouse";
import type { KeyEvent, UiEvent, UiNode } from "@oh-my-pi/pi-tui";
import { batch, signal, type Signal } from "@oh-my-pi/pi-tui";
import { type PaintEnvironment, paintNode, type StaticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { widgetFor, widgetState, type WidgetContext } from "@oh-my-pi/pi-tui/term/widgets";
import {
	CORPUS_DIR,
	type CorpusCase,
	corpusEnvironment,
	describeTree,
	stageNative,
} from "@oh-my-pi/pi-tui/testing/corpus";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";

/** Whether the overlay corpus is present (it is local-only). */
export function hasCorpus(screen: string): boolean {
	return fs.existsSync(path.join(CORPUS_DIR, "overlays", screen));
}

/** Case files of an overlay screen. */
export function caseFiles(screen: string): string[] {
	const dir = path.join(CORPUS_DIR, "overlays", screen);
	return fs
		.readdirSync(dir)
		.filter(file => file.endsWith(".json"))
		.sort()
		.map(file => path.join(dir, file));
}

/** First difference of `actual` from `expected`, letting `actual` carry extra props. */
export function nativeDiff(expected: unknown, actual: unknown, at = "$"): string | null {
	if (Object.is(expected, actual)) return null;
	if (typeof expected !== "object" || expected === null || typeof actual !== "object" || actual === null)
		return `${at}: expected ${JSON.stringify(expected)?.slice(0, 300)} got ${JSON.stringify(actual)?.slice(0, 300)}`;
	if (Array.isArray(expected) !== Array.isArray(actual)) return `${at}: array vs object`;
	if (Array.isArray(expected) && expected.length !== (actual as unknown[]).length)
		return `${at}: length ${expected.length} vs ${(actual as unknown[]).length}: ${JSON.stringify(actual).slice(0, 400)}`;
	const e = expected as Record<string, unknown>;
	const a = actual as Record<string, unknown>;
	for (const key in e) {
		const diff = nativeDiff(e[key], a[key], `${at}.${key}`);
		if (diff) return diff;
	}
	// Extra props are allowed; extra children or kinds are not.
	for (const key in a)
		if (!(key in e) && key !== "p" && key !== "reveal" && key !== "scroll") return `${at}: unexpected ${key}`;
	return null;
}

/** A screen under test: its root node. */
export interface Driven {
	readonly root: UiNode;
	/** Height the screen is painted at (fullscreen overlays: 40). */
	readonly height?: number;
	/** Keys go here instead of the focus path (screens driven by a controller). */
	readonly key?: (key: KeyEvent) => void;
	/** Native events go here instead of bubbling from the root. */
	readonly event?: (event: UiEvent) => void;
}

/** Stage results of one case. */
export interface CaseResult {
	readonly passed: number;
	readonly total: number;
	readonly failures: string[];
}

function widgetContext(root: UiNode, node: UiNode): WidgetContext {
	const path = pathTo([root], node);
	return {
		emit: (event: UiEvent) => {
			bubbleEvent(path, event);
		},
		state: <T>(name: string, init: () => T): Signal<T> => {
			const map = widgetState(node);
			let value = map.get(name) as Signal<T> | undefined;
			if (!value) {
				value = signal(init());
				map.set(name, value as Signal<unknown>);
			}
			return value;
		},
		keypath: keypathOf(path),
		focus: () => {},
		pageRows: 38,
	};
}

/** Deliver raw input bytes the way the terminal backend would. */
export function sendInput(env: PaintEnvironment, driven: Driven, raw: string, geometryWidth: number): void {
	const root = driven.root;
	batch(() => {
		const mouse = decodeMouse(raw);
		if (mouse) {
			const block = paintNode(env, root, geometryWidth, driven.height);
			const hits = block.hits ?? [];
			for (let i = hits.length - 1; i >= 0; i--) {
				const hit = hits[i]!;
				const row = mouse.row - hit.row;
				const col = mouse.col - hit.col;
				if (row < 0 || col < 0 || row >= hit.height || col >= hit.width) continue;
				const widget = widgetFor(hit.node);
				if (widget?.mouse?.(hit.node, mouse, { row, col }, widgetContext(root, hit.node), hit)) return;
				if (mouse.action === "press" && mouse.button === "left" && hit.item !== undefined) {
					const path = pathTo([root], hit.node);
					bubbleEvent(path, { type: "select", key: keypathOf(path), item: hit.item });
				}
				return;
			}
			return;
		}
		const key = decodeKey(raw, { kitty: false, backspaceIsCtrl: false });
		if (!key) return;
		if (driven.key) {
			driven.key(key);
			return;
		}
		if (bubbleKey([root], key)) return;
		widgetFor(root)?.key?.(root, key, widgetContext(root, root));
	});
}

/** Apply a stage label's step (`key …`, `event …`, `sleep N`; `render` only painted). */
export async function applyStep(
	env: PaintEnvironment,
	driven: Driven,
	label: string,
	geometryWidth: number,
	custom?: (label: string) => Promise<boolean> | boolean,
): Promise<void> {
	if (custom && (await custom(label))) return;
	if (label.startsWith("key ")) {
		sendInput(env, driven, JSON.parse(label.slice(4)) as string, geometryWidth);
	} else if (label.startsWith("event ")) {
		const event = JSON.parse(label.slice(6)) as UiEvent;
		batch(() => (driven.event ? driven.event(event) : bubbleEvent([driven.root], event)));
	} else if (label.startsWith("sleep ")) {
		await Bun.sleep(Number(label.slice(6)));
	}
}

/** Compare the screen against stage `index`. */
export function checkStage(corpus: CorpusCase, index: number, env: PaintEnvironment, driven: Driven): string[] {
	const failures: string[] = [];
	const stage = corpus.stages[index]!;
	const expectedNative = stageNative(corpus, index);
	if (expectedNative !== null) {
		const diff = nativeDiff(expectedNative, describeTree(driven.root, env));
		if (diff) failures.push(`native: ${diff}`);
	}
	for (const width of corpus.widths) {
		const expected = stage.rows[String(width)] ?? [];
		const actual = paintNode(env, driven.root, width, driven.height).rows;
		const diff = firstCellDiff(expected, actual);
		if (diff) failures.push(`w${width}: ${diff}`);
	}
	return failures;
}

/** Replay a whole case. */
export async function runCase(
	file: string,
	build: (corpus: CorpusCase, env: StaticEnvironment) => Driven,
	custom?: (label: string, driven: Driven) => Promise<boolean> | boolean,
): Promise<CaseResult> {
	const corpus = (await Bun.file(file).json()) as CorpusCase;
	const env = corpusEnvironment(corpus.theme);
	const driven = build(corpus, env);
	const failures: string[] = [];
	let passed = 0;
	// Every snapshot painted all widths in order, so pointer reports resolved against the widest paint.
	const geometry = corpus.widths[corpus.widths.length - 1]!;
	for (let i = 0; i < corpus.stages.length; i++) {
		const stage = corpus.stages[i]!;
		if (i > 0) await applyStep(env, driven, stage.label, geometry, label => custom?.(label, driven) ?? false);
		const stageFailures = checkStage(corpus, i, env, driven);
		if (stageFailures.length === 0) passed++;
		else failures.push(`[${i}] ${stage.label}: ${stageFailures[0]}`);
	}
	return { passed, total: corpus.stages.length, failures };
}
