/**
 * Corpus checks for the setup and forms families (`setup/*`, `forms/*`).
 *
 * A case mounts a screen from fixture data; each later stage is a step: a
 * key stage (`key down`, `key "x" (search)`) is decoded and replayed the way
 * the terminal backend routes keys (to `onKey` handlers from the focused
 * node up, then the focused kind's widget); other stages run the case's
 * step for that label (UI events, model calls, clock and screen changes).
 * Every stage compares the described native tree and the painted rows at
 * each recorded width (cell by cell) unless the stage is a listed deviation
 * (`../deviations.ts`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import {
	createRoot,
	type JSXNode,
	resolveChildren,
	type Signal,
	signal,
	type UiEvent,
	type UiNode,
	untrack,
} from "@oh-my-pi/pi-tui";
import { bubbleEvent, bubbleKey, bubblePaste, keypathOf, pathTo } from "@oh-my-pi/pi-tui/dispatch";
import type { MouseEvent } from "@oh-my-pi/pi-tui/driver/contract";
import { decodeKey } from "@oh-my-pi/pi-tui/driver/input/keys";
import { decodeMouse } from "@oh-my-pi/pi-tui/driver/input/mouse";
import { paintNode, type StaticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { type WidgetContext, widgetFor, widgetState } from "@oh-my-pi/pi-tui/term/widgets";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";
import {
	CORPUS_DIR,
	type CorpusCase,
	corpusEnvironment,
	describeTree,
	firstDiff,
	stageNative,
} from "@oh-my-pi/pi-tui/testing/corpus";
import { captureStage, skipsAt } from "../deviations";

process.env.TZ = "UTC";

/** What a step may do to the mounted screen. */
export interface Driver {
	readonly root: UiNode;
	readonly env: StaticEnvironment;
	readonly focused: UiNode | null;
	focus(node: UiNode | null): void;
	/** Raw input bytes: one key, or an SGR mouse report (routed at width 80). */
	press(raw: string): void;
	paste(text: string): void;
	/** A UI event addressed by keypath under the root; false when no node has that keypath. */
	emit(event: UiEvent): boolean;
	/** A pointer event at a cell of the root painted at `width`. */
	mouse(row: number, col: number, mouse: Pick<MouseEvent, "button" | "action">, width?: number): void;
	find(kind: string, key?: string): UiNode | undefined;
}

/** One mounted case. */
export interface Mounted {
	readonly view: () => JSXNode;
	/** Steps by stage label; key stages without one are replayed as keys. */
	readonly steps?: Readonly<Record<string, (driver: Driver) => void | Promise<void>>>;
	/** The node holding focus (re-read before every stage; default: the root). */
	focus?(driver: Driver): UiNode | null | undefined;
	/** Rows the screen paints into (a fullscreen layer), per stage; undefined: natural height. */
	height?(): number | undefined;
	/** Host side effects since the last call (compared with the stage note's events). */
	events?(): readonly string[];
	dispose?(): void;
}

/** A family's corpus suite. */
export interface CorpusScreen {
	/** `<family>/<screen>`. */
	readonly dir: string;
	mount(caseName: string, corpusCase: CorpusCase, env: StaticEnvironment): Mounted;
}

const KEY_CONTEXT = { kitty: false, backspaceIsCtrl: false };

const NAMED_KEYS: Readonly<Record<string, string>> = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	"shift+tab": "\x1b[Z",
	backspace: "\x7f",
	pageup: "\x1b[5~",
	pagedown: "\x1b[6~",
	"ctrl+c": "\x03",
	space: " ",
	"alt+h": "\x1bh",
	"alt+n": "\x1bn",
};

/** Raw bytes of a key stage label (`key down`, `key "x" (search)`, `key 2 during dissolve`), or undefined. */
export function keyOfLabel(label: string): string | undefined {
	if (!label.startsWith("key ")) return undefined;
	const rest = label.slice(4);
	if (rest.startsWith('"')) {
		const end = rest.indexOf('"', 1);
		return JSON.parse(rest.slice(0, end + 1)) as string;
	}
	const token = rest.split(" ")[0]!;
	return NAMED_KEYS[token] ?? ([...token].length === 1 ? token : undefined);
}

export function nodeAtKeypath(root: UiNode, keypath: string): UiNode | undefined {
	if (keypath === "") return root;
	let node: UiNode | undefined = root;
	for (const segment of keypath.split("/")) {
		const children: readonly UiNode[] = node!.children();
		node = children.find(child => child.key() === segment) ?? children[Number(segment)];
		if (!node) return undefined;
		if (node.key() !== undefined && node.key() !== segment) return undefined;
	}
	return node;
}

export function findKind(root: UiNode, kind: string, key?: string): UiNode | undefined {
	if (root.kind === kind && (key === undefined || root.key() === key)) return root;
	for (const child of root.children()) {
		const hit = findKind(child, kind, key);
		if (hit) return hit;
	}
	return undefined;
}

function createDriver(rootOf: () => UiNode, env: StaticEnvironment, height: () => number | undefined): Driver {
	const focusSignal: Signal<UiNode | null> = signal<UiNode | null>(null);
	const widgetContext = (pathNodes: readonly UiNode[]): WidgetContext => {
		const node = pathNodes[pathNodes.length - 1]!;
		return {
			emit: event => void bubbleEvent(pathNodes, event),
			state: <T>(name: string, init: () => T): Signal<T> => {
				const map = widgetState(node);
				let value = map.get(name) as Signal<T> | undefined;
				if (!value) {
					value = signal(init());
					map.set(name, value as Signal<unknown>);
				}
				return value;
			},
			keypath: keypathOf(pathNodes),
			focus: next => driver.focus(next),
			pageRows: 40,
		};
	};
	const focusPath = (): UiNode[] => {
		const focused = focusSignal();
		return focused ? pathTo([rootOf()], focused) : [];
	};
	const driver: Driver = {
		get root() {
			return rootOf();
		},
		env,
		get focused() {
			return focusSignal();
		},
		focus(node) {
			focusSignal.set(node);
			env.setFocus(node);
		},
		press(raw) {
			const pointer = raw.startsWith("\x1b[<") ? decodeMouse(raw) : null;
			if (pointer) return driver.mouse(pointer.row, pointer.col, pointer);
			const key = decodeKey(raw, KEY_CONTEXT);
			if (!key) throw new Error(`undecodable key ${JSON.stringify(raw)}`);
			const pathNodes = focusPath();
			if (bubbleKey(pathNodes, key)) return;
			const focused = focusSignal();
			if (focused && pathNodes.length > 0) widgetFor(focused)?.key?.(focused, key, widgetContext(pathNodes));
		},
		paste(text) {
			const pathNodes = focusPath();
			if (bubblePaste(pathNodes, { text })) return;
			const focused = focusSignal();
			if (focused && pathNodes.length > 0) widgetFor(focused)?.paste?.(focused, { text }, widgetContext(pathNodes));
		},
		emit(event) {
			const target = nodeAtKeypath(rootOf(), event.key);
			if (!target) return false;
			bubbleEvent(pathTo([rootOf()], target), event);
			return true;
		},
		mouse(row, col, pointer, width = 80) {
			const hits = paintNode(env, rootOf(), width, height()).hits ?? [];
			const event: MouseEvent = { row, col, mods: [], ...pointer };
			for (let i = hits.length - 1; i >= 0; i--) {
				const hit = hits[i]!;
				const r = row - hit.row;
				const c = col - hit.col;
				if (r < 0 || c < 0 || r >= hit.height || c >= hit.width) continue;
				const pathNodes = pathTo([rootOf()], hit.node);
				if (pathNodes.length === 0) continue;
				if (widgetFor(hit.node)?.mouse?.(hit.node, event, { row: r, col: c }, widgetContext(pathNodes), hit))
					return;
				if (event.action === "press" && event.button === "left" && hit.act) {
					bubbleEvent(pathNodes, { type: "action", key: keypathOf(pathNodes), act: hit.act, mods: [] });
					return;
				}
				if (event.action === "press" && event.button === "left" && hit.item !== undefined) {
					bubbleEvent(pathNodes, { type: "select", key: keypathOf(pathNodes), item: hit.item });
					return;
				}
			}
		},
		find(kind, key) {
			return findKind(rootOf(), kind, key);
		},
	};
	return driver;
}

/**
 * The first difference between a recorded native tree and ours, ignoring
 * props ours adds (a role, a key fact the old tree left out).
 */
export function nativeDiff(expected: unknown, actual: unknown, at = "$"): string | null {
	if (
		expected &&
		actual &&
		typeof expected === "object" &&
		typeof actual === "object" &&
		!Array.isArray(expected) &&
		!Array.isArray(actual)
	) {
		const e = expected as Record<string, unknown>;
		const a = actual as Record<string, unknown>;
		const keys = new Set([...Object.keys(e), ...Object.keys(a)]);
		for (const key of keys) {
			// Extra props are allowed; extra structure (children, keys, kinds) is not.
			if (!(key in e) && key === "p") continue;
			if (at.endsWith(".p") && !(key in e)) continue;
			const diff = nativeDiff(e[key], a[key], `${at}.${key}`);
			if (diff) return diff;
		}
		return null;
	}
	if (Array.isArray(expected) && Array.isArray(actual) && expected.length === actual.length) {
		for (let i = 0; i < expected.length; i++) {
			const diff = nativeDiff(expected[i], actual[i], `${at}.${i}`);
			if (diff) return diff;
		}
		return null;
	}
	return firstDiff(expected, actual, at);
}

/** Let promises the last step started settle. */
export async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Bun.sleep(1);
}

interface StageResult {
	readonly index: number;
	readonly label: string;
	readonly native: string | null;
	readonly rows: Readonly<Record<string, string | null>>;
	readonly events: string | null;
}

async function runCase(screen: CorpusScreen, file: string): Promise<StageResult[]> {
	const corpusCase = JSON.parse(fs.readFileSync(file, "utf8")) as CorpusCase;
	const caseName = path.basename(file).replace(/\.[a-z]+\.json$/, "");
	const env = corpusEnvironment(corpusCase.theme);
	const results: StageResult[] = [];
	let dispose = (): void => {};
	let nodes: () => readonly UiNode[] = () => [];
	const mounted = createRoot(release => {
		dispose = release;
		const screenCase = screen.mount(caseName, corpusCase, env);
		nodes = resolveChildren(untrack(screenCase.view));
		return screenCase;
	});
	const currentRoot = (): UiNode => {
		const shown = nodes();
		if (shown.length !== 1) throw new Error(`${caseName}: the view must be one node, got ${shown.length}`);
		return shown[0]!;
	};
	const height = (): number | undefined => mounted.height?.();
	const driver = createDriver(currentRoot, env, height);
	const refocus = (): void => {
		const target = mounted.focus ? mounted.focus(driver) : currentRoot();
		if (target !== driver.focused) driver.focus(target ?? null);
	};
	try {
		for (let index = 0; index < corpusCase.stages.length; index++) {
			const stage = corpusCase.stages[index]!;
			refocus();
			if (index > 0) {
				const step = mounted.steps?.[stage.label];
				const raw = keyOfLabel(stage.label);
				const typed = /^type (".*")$/.exec(stage.label);
				// Steps settle themselves when the capture waited; replayed keys let what they started settle.
				if (step) await step(driver);
				else if (raw !== undefined) {
					driver.press(raw);
					await settle();
				} else if (typed) {
					for (const ch of JSON.parse(typed[1]!) as string) driver.press(ch);
					await settle();
				} else throw new Error(`${caseName}: no step for stage ${JSON.stringify(stage.label)}`);
				refocus();
			}
			const rows: Record<string, string | null> = {};
			const painted: Record<string, readonly string[]> = {};
			for (const width of corpusCase.widths) {
				const expected = stage.rows[String(width)] ?? [];
				const actual = paintNode(env, currentRoot(), width, height()).rows;
				painted[String(width)] = actual;
				rows[String(width)] = firstCellDiff(expected, actual);
			}
			const described = describeTree(currentRoot(), env);
			const native = nativeDiff(stageNative(corpusCase, index), described);
			captureStage({
				screen: screen.dir,
				file: path.basename(file),
				index,
				label: stage.label,
				rows: painted,
				native: described,
			});
			let events: string | null = null;
			if (mounted.events) {
				const note = stage.note as { events?: readonly string[] } | readonly string[] | undefined;
				const expected = Array.isArray(note) ? note : ((note as { events?: readonly string[] })?.events ?? []);
				events = firstDiff(expected, [...mounted.events()]);
			}
			results.push({ index, label: stage.label, native, rows, events });
		}
	} finally {
		mounted.dispose?.();
		dispose();
	}
	return results;
}

/** Register the corpus suite of a screen (skipped without the corpus). */
export function corpusSuite(screen: CorpusScreen): void {
	const dir = path.join(CORPUS_DIR, screen.dir);
	const files = fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter(name => name.endsWith(".json"))
				.sort()
				.map(name => path.join(dir, name))
		: [];
	describe.skipIf(files.length === 0)(screen.dir, () => {
		for (const file of files) {
			const caseName = path.basename(file).replace(/\.[a-z]+\.json$/, "");
			test(caseName, async () => {
				const results = await runCase(screen, file);
				const failures: string[] = [];
				for (const result of results) {
					const at = String(result.index);
					const ref = { screen: screen.dir, case: caseName, index: result.index, label: result.label };
					if (result.native && !skipsAt(ref, "native"))
						failures.push(`[${at}] ${result.label} native: ${result.native}`);
					if (result.events) failures.push(`[${at}] ${result.label} events: ${result.events}`);
					for (const width in result.rows) {
						const diff = result.rows[width];
						if (diff && !skipsAt(ref, "rows", width)) failures.push(`[${at}] ${result.label} @${width}: ${diff}`);
					}
				}
				if (process.env.CORPUS_REPORT) {
					const passed = results.filter(r => {
						if (r.native) return false;
						for (const width in r.rows) if (r.rows[width]) return false;
						return true;
					}).length;
					console.log(`PARITY ${screen.dir}/${caseName} ${passed}/${results.length}`);
					for (const r of results) {
						const rowsAt = process.env.CORPUS_ROWS;
						if (rowsAt && r.rows[rowsAt])
							console.log(
								`  rows [${r.index}] ${r.label} @${rowsAt}: ${r.rows[rowsAt]!.replaceAll("\n", " ¶ ").slice(0, 400)}`,
							);
						if (process.env.CORPUS_NATIVE && r.native)
							console.log(`  native [${r.index}] ${r.label}: ${r.native.slice(0, 300)}`);
						const listed = skipsAt(
							{ screen: screen.dir, case: caseName, index: r.index, label: r.label },
							"rows",
						);
						let rowsOk = true;
						for (const width in r.rows) if (r.rows[width]) rowsOk = false;
						if (listed && rowsOk) console.log(`  listed deviation passes: [${r.index}] ${r.label}`);
						if (listed && !rowsOk) console.log(`  deviation: [${r.index}] ${r.label}`);
					}
				}
				expect(failures.slice(0, 6)).toEqual([]);
			});
		}
	});
}
