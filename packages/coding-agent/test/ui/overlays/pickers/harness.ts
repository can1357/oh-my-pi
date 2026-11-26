/**
 * Corpus checks for `overlays/<screen>` picker screens.
 *
 * A case records a screen built from fixture data and driven through steps
 * (UI events a Tern terminal would send, raw keys through `handleInput`).
 * The harness mounts the screen's tree, replays each step the way the
 * terminal backend would (keys offer themselves to `onKey` handlers from the
 * focused node up, then to the focused kind's widget; UI events bubble from
 * the node their keypath names), and compares every stage: the described
 * native tree must equal the recorded one, and the painted rows must equal
 * the recorded rows cell by cell unless the stage is a listed deviation
 * (`../../deviations.ts`; some cover only matching rows or rewrite the
 * recorded tree, so the rest of the stage stays checked).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import {
	untrack,
	createRoot,
	type JSXNode,
	resolveChildren,
	type Signal,
	signal,
	type UiEvent,
	type UiNode,
} from "@oh-my-pi/pi-tui";
import { bubbleEvent, bubbleKey, keypathOf, pathTo } from "@oh-my-pi/pi-tui/dispatch";
import type { MouseEvent } from "@oh-my-pi/pi-tui/driver/contract";
import { decodeKey } from "@oh-my-pi/pi-tui/driver/input/keys";
import { decodeMouse } from "@oh-my-pi/pi-tui/driver/input/mouse";
import { paintNode, type StaticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { widgetFor, widgetState, type WidgetContext } from "@oh-my-pi/pi-tui/term/widgets";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";
import {
	CORPUS_DIR,
	type CorpusCase,
	corpusEnvironment,
	describeTree,
	firstDiff,
	stageNative,
} from "@oh-my-pi/pi-tui/testing/corpus";
import { captureStage, deviationsAt, skipsAt } from "../../deviations";

/** What a step may do to the mounted screen. */
export interface Driver {
	readonly root: UiNode;
	readonly env: StaticEnvironment;
	/** The node holding keyboard focus. */
	readonly focused: UiNode | null;
	focus(node: UiNode | null): void;
	/** Feed raw input bytes as one key (through `onKey` handlers, then the focused widget). */
	press(raw: string): void;
	/** Deliver a UI event to the node at `keypath` under the root (bubbling); false when no node has that keypath. */
	emit(event: UiEvent): boolean;
	/**
	 * A pointer event at a cell of the root painted at `width` (default 80),
	 * routed through the painted hit regions as the terminal backend does.
	 */
	mouse(row: number, col: number, mouse: Pick<MouseEvent, "button" | "action">, width?: number): void;
	/** The first node of `kind` (depth-first). */
	find(kind: string, key?: string): UiNode | undefined;
}

/** One mounted case. */
export interface Mounted {
	/** The screen's tree. */
	readonly view: () => JSXNode;
	/** Steps by stage label (raw-key stages `key "…"` are replayed by the harness). */
	readonly steps?: Readonly<Record<string, (driver: Driver) => void | Promise<void>>>;
	/** Settles before the first stage (a screen that loads its data asynchronously). */
	ready?(): Promise<void>;
	/** Node to focus at start (default: the first picker). */
	focus?(driver: Driver): UiNode | null | undefined;
	dispose?(): void;
}

/** A picker screen's corpus suite. */
export interface PickerScreen {
	/** `overlays/<screen>`. */
	readonly dir: string;
	/** Mount a case from its file name (without `.dark.json`) and recorded inputs. */
	mount(caseName: string, corpusCase: CorpusCase): Mounted;
}

// The corpus was captured in UTC (absolute times in tooltips and rows).
process.env.TZ = "UTC";

const KEY_CONTEXT = { kitty: false, backspaceIsCtrl: false };

/** A key event from raw bytes, as the driver decodes it. */
export function keyFromRaw(raw: string) {
	const key = decodeKey(raw, KEY_CONTEXT);
	if (!key) throw new Error(`undecodable key ${JSON.stringify(raw)}`);
	return key;
}

/** Find the node at `keypath` below `root` (`""` is the root). */
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

function findKind(root: UiNode, kind: string, key?: string): UiNode | undefined {
	if (root.kind === kind && (key === undefined || root.key() === key)) return root;
	for (const child of root.children()) {
		const hit = findKind(child, kind, key);
		if (hit) return hit;
	}
	return undefined;
}

function createDriver(rootOf: () => UiNode, env: StaticEnvironment, pageRows: number): Driver {
	const focusSignal: Signal<UiNode | null> = signal<UiNode | null>(null);
	const widgetContext = (pathNodes: readonly UiNode[]): WidgetContext => {
		const node = pathNodes[pathNodes.length - 1]!;
		return {
			emit: event => {
				bubbleEvent(pathNodes, event);
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
			keypath: keypathOf(pathNodes),
			focus: next => focusSignal.set(next),
			pageRows,
		};
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
			// SGR mouse reports arrive through the same input stream: route them as pointer events at width 80.
			const pointer = raw.startsWith("\x1b[<") ? decodeMouse(raw) : null;
			if (pointer) {
				driver.mouse(pointer.row, pointer.col, pointer);
				return;
			}
			const key = keyFromRaw(raw);
			const focused = focusSignal();
			const pathNodes = focused ? pathTo([rootOf()], focused) : [];
			if (bubbleKey(pathNodes, key)) return;
			if (focused && pathNodes.length > 0) widgetFor(focused)?.key?.(focused, key, widgetContext(pathNodes));
		},
		emit(event) {
			const target = nodeAtKeypath(rootOf(), event.key);
			if (!target) return false;
			bubbleEvent(pathTo([rootOf()], target), event);
			return true;
		},
		mouse(row, col, pointer, width = 80) {
			const hits = paintNode(env, rootOf(), width).hits ?? [];
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

/** Result of one stage. */
interface StageResult {
	readonly index: number;
	readonly label: string;
	readonly native: string | null;
	readonly rows: Readonly<Record<string, string | null>>;
	/** Recorded rows left out by listed row masks (`rowsContaining`). */
	readonly masked: number;
}

async function runCase(
	screen: PickerScreen,
	file: string,
): Promise<{ results: StageResult[]; corpusCase: CorpusCase }> {
	const corpusCase = JSON.parse(fs.readFileSync(file, "utf8")) as CorpusCase;
	const caseName = path.basename(file).replace(/\.[a-z]+\.json$/, "");
	const env = corpusEnvironment(corpusCase.theme);
	const results: StageResult[] = [];
	let dispose = (): void => {};
	let nodes: () => readonly UiNode[] = () => [];
	const mounted = createRoot(release => {
		dispose = release;
		const screenCase = screen.mount(caseName, corpusCase);
		// Build the screen once; only what it returns stays reactive.
		nodes = resolveChildren(untrack(screenCase.view));
		return screenCase;
	});
	// A screen may swap its root (a sheet giving way to a form): stages read the current one.
	const currentRoot = (): UiNode => {
		const shown = nodes();
		if (shown.length !== 1) throw new Error(`${caseName}: the view must be one node, got ${shown.length}`);
		return shown[0]!;
	};
	const driver = createDriver(currentRoot, env, 40);
	const refocus = (): void => {
		const target = mounted.focus ? mounted.focus(driver) : findKind(currentRoot(), "picker");
		driver.focus(target ?? null);
	};
	try {
		await mounted.ready?.();
		refocus();
		for (let index = 0; index < corpusCase.stages.length; index++) {
			const stage = corpusCase.stages[index]!;
			if (index > 0) {
				if (driver.focused?.disposed || (driver.focused && pathTo([currentRoot()], driver.focused).length === 0))
					refocus();
				if (stage.label.startsWith("key ")) driver.press(JSON.parse(stage.label.slice(4)) as string);
				else {
					const step = mounted.steps?.[stage.label];
					if (!step) throw new Error(`${caseName}: no step for stage ${JSON.stringify(stage.label)}`);
					// Steps that wait (the old capture awaited a tick) settle before the stage is compared.
					await step(driver);
				}
			}
			const ref = { screen: screen.dir, case: caseName, index, label: stage.label };
			const rows: Record<string, string | null> = {};
			const painted: Record<string, readonly string[]> = {};
			let masked = 0;
			for (const width of corpusCase.widths) {
				let expected = stage.rows[String(width)] ?? [];
				let actual = paintNode(env, currentRoot(), width).rows;
				painted[String(width)] = actual;
				for (const { rowsContaining } of deviationsAt(ref, "rows", width)) {
					if (rowsContaining === undefined) continue;
					const covered = expected.map(row => stripEscapes(row).includes(rowsContaining));
					if (!covered.includes(true)) continue;
					masked += covered.filter(Boolean).length;
					expected = expected.map((row, at) => (covered[at] ? "" : row));
					actual = actual.map((row, at) => (covered[at] ? "" : row));
				}
				rows[String(width)] = firstCellDiff(expected, actual);
			}
			let recorded = stageNative(corpusCase, index);
			for (const { normalize } of deviationsAt(ref, "native")) if (normalize) recorded = normalize(recorded);
			const described = describeTree(currentRoot(), env);
			const native = firstDiff(recorded, described);
			captureStage({
				screen: screen.dir,
				file: path.basename(file),
				index,
				label: stage.label,
				rows: painted,
				native: described,
			});
			results.push({ index, label: stage.label, native, rows, masked });
		}
	} finally {
		mounted.dispose?.();
		dispose();
	}
	return { results, corpusCase };
}

/** Register the corpus suite of a picker screen (skipped without the corpus). */
export function pickerSuite(screen: PickerScreen): void {
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
				const { results } = await runCase(screen, file);
				const nativeFailures: string[] = [];
				const rowFailures: string[] = [];
				for (const result of results) {
					const ref = { screen: screen.dir, case: caseName, index: result.index, label: result.label };
					if (result.native && !skipsAt(ref, "native"))
						nativeFailures.push(`[${result.index}] ${result.label}: ${result.native}`);
					for (const width in result.rows) {
						const diff = result.rows[width];
						if (diff && !skipsAt(ref, "rows", width))
							rowFailures.push(`[${result.index}] ${result.label} @${width}: ${diff}`);
					}
				}
				if (process.env.PICKER_REPORT) {
					const exact = (r: StageResult): boolean => {
						for (const width in r.rows) if (r.rows[width]) return false;
						return r.native === null;
					};
					const passed = results.filter(exact).length;
					const masked = results.filter(r => exact(r) && r.masked > 0).length;
					console.log(
						`${screen.dir}/${caseName}: ${passed}/${results.length} stages exact${masked > 0 ? ` (${masked} with listed rows left out)` : ""}`,
					);
				}
				expect(nativeFailures.slice(0, 5)).toEqual([]);
				expect(rowFailures.slice(0, 5)).toEqual([]);
			});
		}
	});
}
