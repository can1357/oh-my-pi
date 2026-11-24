/**
 * Corpus checks for the `overlays/<screen>` panels (dialogs, dashboards,
 * previews, banners).
 *
 * A case records a screen built from fixture data and driven through steps
 * (UI events a Tern terminal would send, raw keys). The harness mounts the
 * screen's tree, replays each step the way the terminal backend would (keys
 * offer themselves to `onKey` handlers from the focused node up, then to the
 * focused kind's widget; UI events bubble from the node their keypath
 * names), and compares every stage: the described native tree must equal the
 * recorded one (props the screen adds are allowed), and the painted rows
 * must equal the recorded rows cell by cell unless the stage is a listed
 * deviation (`../../deviations.ts`).
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
	stageNative,
} from "@oh-my-pi/pi-tui/testing/corpus";
import { captureStage, skipsAt } from "../../deviations";

/** What a step may do to the mounted screen. */
export interface Driver {
	readonly root: UiNode;
	readonly env: StaticEnvironment;
	/** The node holding keyboard focus. */
	readonly focused: UiNode | null;
	focus(node: UiNode | null): void;
	/** Feed raw input bytes as one key (through `onKey` handlers, then the focused widget); SGR mouse reports go to {@link mouse}. */
	press(raw: string): void;
	/** A pointer event at a cell of the screen painted at `width` (default 80): the widget of the innermost hit under it. */
	mouse(event: MouseEvent, width?: number): void;
	/** Feed a bracketed paste to the focused node path. */
	paste(text: string): void;
	/** Deliver a UI event to the node at its keypath under the root (bubbling; the root when no node has that keypath); false when none has it. */
	emit(event: UiEvent): boolean;
	/** The first node of `kind` (depth-first), optionally with JSX key `key`. */
	find(kind: string, key?: string): UiNode | undefined;
}

/** One mounted case. */
export interface Mounted {
	/** The screen's tree. */
	readonly view: () => JSXNode;
	/** Steps by stage label (raw-key stages `key "…"` are replayed by the harness unless listed here). */
	readonly steps?: Readonly<Record<string, (driver: Driver) => void | Promise<void>>>;
	/** Node to focus at start (default: the root). */
	focus?(driver: Driver): UiNode | null | undefined;
	/** Rows painted per width at a fixed height (fullscreen screens; read per stage); default natural height. */
	readonly height?: number | (() => number | undefined);
	/** Settles before the first stage (work the recording finished before describing it). */
	readonly ready?: Promise<unknown>;
	dispose?(): void;
}

/** A panel screen's corpus suite. */
export interface PanelScreen {
	/** `overlays/<screen>`. */
	readonly dir: string;
	/** Mount a case from its file name (without `.dark.json`) and recorded inputs. */
	mount(caseName: string, corpusCase: CorpusCase): Mounted;
	/** Cases recorded from a native-only face (no terminal rows): rows are not compared. */
	nativeOnly?(caseName: string): boolean;
}

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

function createDriver(
	rootOf: () => UiNode,
	env: StaticEnvironment,
	pageRows: number,
	heightOf: () => number | undefined,
): Driver {
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
			focus: next => driver.focus(next),
			pageRows,
		};
	};
	const focusPath = (): UiNode[] => {
		const focused = focusSignal();
		const root = rootOf();
		const nodes = focused ? pathTo([root], focused) : [];
		return nodes.length > 0 ? nodes : [root];
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
			if (pointer) {
				driver.mouse(pointer);
				return;
			}
			const key = keyFromRaw(raw);
			const nodes = focusPath();
			if (bubbleKey(nodes, key)) return;
			const focused = nodes[nodes.length - 1]!;
			widgetFor(focused)?.key?.(focused, key, widgetContext(nodes));
		},
		paste(text) {
			const nodes = focusPath();
			if (bubblePaste(nodes, { text } as never)) return;
			const focused = nodes[nodes.length - 1]!;
			widgetFor(focused)?.paste?.(focused, { text } as never, widgetContext(nodes));
		},
		mouse(event, width = 80) {
			const root = rootOf();
			const hits = paintNode(env, root, width, heightOf()).hits ?? [];
			for (let i = hits.length - 1; i >= 0; i--) {
				const hit = hits[i]!;
				const row = event.row - hit.row;
				const col = event.col - hit.col;
				if (row < 0 || col < 0 || row >= hit.height || col >= hit.width) continue;
				const nodes = pathTo([root], hit.node);
				if (nodes.length === 0) continue;
				if (widgetFor(hit.node)?.mouse?.(hit.node, event, { row, col }, widgetContext(nodes), hit)) return;
			}
		},
		emit(event) {
			const root = rootOf();
			const target = nodeAtKeypath(root, event.key);
			// A keypath the tree does not have goes to the root (components that route by leaf key).
			bubbleEvent(target ? pathTo([root], target) : [root], event);
			return target !== undefined;
		},
		find(kind, key) {
			return findKind(rootOf(), kind, key);
		},
	};
	return driver;
}

/**
 * The first difference between a recorded native tree and the described one,
 * or null. Props the new tree adds (`p` keys the recording lacks) are allowed.
 */
export function nativeDiff(expected: unknown, actual: unknown, at = "$"): string | null {
	if (Object.is(expected, actual)) return null;
	const show = (v: unknown) => JSON.stringify(v)?.slice(0, 400);
	if (typeof expected !== typeof actual || expected === null || actual === null || typeof expected !== "object") {
		return `${at}: expected ${show(expected)} got ${show(actual)}`;
	}
	if (Array.isArray(expected) !== Array.isArray(actual)) return `${at}: array vs object`;
	if (Array.isArray(expected) && expected.length !== (actual as unknown[]).length) {
		return `${at}: expected ${expected.length} entries, got ${(actual as unknown[]).length}: ${show(actual)}`;
	}
	const additive = at.endsWith(".p");
	const keys = new Set([...Object.keys(expected as object), ...(additive ? [] : Object.keys(actual as object))]);
	for (const key of keys) {
		// Props on a node the recording described without any are additive too.
		if (key === "p" && !additive && (expected as Record<string, unknown>).p === undefined) {
			const diff = nativeDiff({}, (actual as Record<string, unknown>).p, `${at}.p`);
			if (diff) return diff;
			continue;
		}
		const diff = nativeDiff(
			(expected as Record<string, unknown>)[key],
			(actual as Record<string, unknown>)[key],
			`${at}.${key}`,
		);
		if (diff) return diff;
	}
	return null;
}

/** Result of one stage. */
export interface StageResult {
	readonly index: number;
	readonly label: string;
	readonly native: string | null;
	readonly rows: Readonly<Record<string, string | null>>;
	readonly painted: Readonly<Record<string, readonly string[]>>;
}

/** Mount a case and check every stage. */
export async function runCase(screen: PanelScreen, file: string): Promise<StageResult[]> {
	const corpusCase = JSON.parse(fs.readFileSync(file, "utf8")) as CorpusCase;
	const caseName = path.basename(file).replace(/\.[a-z]+\.json$/, "");
	const env = corpusEnvironment(corpusCase.theme);
	const results: StageResult[] = [];
	let disposeRoot: () => void = () => {};
	let mounted!: Mounted;
	let nodes!: () => readonly UiNode[];
	createRoot(dispose => {
		disposeRoot = dispose;
		mounted = screen.mount(caseName, corpusCase);
		nodes = resolveChildren(mounted.view);
	});
	// The view may swap its root node (a folded note is a row, an open one a column).
	const rootOf = (): UiNode => {
		const current = nodes();
		if (current.length !== 1) throw new Error(`${caseName}: the view must be one node, got ${current.length}`);
		return current[0]!;
	};
	const heightOf = () => (typeof mounted.height === "function" ? mounted.height() : mounted.height);
	const driver = createDriver(rootOf, env, 40, heightOf);
	driver.focus((mounted.focus ? mounted.focus(driver) : rootOf()) ?? null);
	try {
		if (mounted.ready) await mounted.ready;
		for (let index = 0; index < corpusCase.stages.length; index++) {
			const stage = corpusCase.stages[index]!;
			if (index > 0) {
				const step = mounted.steps?.[stage.label];
				if (step) await step(driver);
				else if (stage.label.startsWith("key ")) driver.press(JSON.parse(stage.label.slice(4)) as string);
				else throw new Error(`${caseName}: no step for stage ${JSON.stringify(stage.label)}`);
			}
			const rows: Record<string, string | null> = {};
			const painted: Record<string, readonly string[]> = {};
			for (const width of corpusCase.widths) {
				const expected = stage.rows[String(width)] ?? [];
				const actual = paintNode(env, rootOf(), width, heightOf()).rows;
				painted[String(width)] = actual;
				rows[String(width)] = firstCellDiff(expected, actual);
			}
			// A terminal-only face recorded no native tree.
			const expectedNative = stageNative(corpusCase, index);
			const described = expectedNative === null ? undefined : describeTree(rootOf(), env);
			const native = described === undefined ? null : nativeDiff(expectedNative, described);
			captureStage({
				screen: screen.dir,
				file: path.basename(file),
				index,
				label: stage.label,
				rows: painted,
				native: described,
			});
			results.push({ index, label: stage.label, native, rows, painted });
		}
	} finally {
		mounted.dispose?.();
		disposeRoot();
	}
	return results;
}

/** Every case file of `dir` in the corpus (empty without the corpus). */
export function caseFiles(dir: string): string[] {
	const full = path.join(CORPUS_DIR, dir);
	return fs.existsSync(full)
		? fs
				.readdirSync(full)
				.filter(name => name.endsWith(".json"))
				.sort()
				.map(name => path.join(full, name))
		: [];
}

const ESC = /\x1b\[[0-9;:]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Debug aid (`PANEL_SHOW=1`): the first stage whose rows differ, expected beside painted. */
function showFirstFailure(file: string, results: readonly StageResult[]): void {
	const corpusCase = JSON.parse(fs.readFileSync(file, "utf8")) as CorpusCase;
	for (const result of results) {
		for (const width in result.rows) {
			if (!result.rows[width]) continue;
			const expected = corpusCase.stages[result.index]!.rows[width] ?? [];
			const actual = result.painted[width]!;
			const lines = [
				`--- ${path.basename(file)} [${result.index}] ${result.label} @${width}: ${result.rows[width]}`,
			];
			for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
				const e = expected[i]?.replace(ESC, "").trimEnd();
				const a = actual[i]?.replace(ESC, "").trimEnd();
				lines.push(`${e === a ? " " : "E"} ${JSON.stringify(e)}`);
				if (e !== a) lines.push(`A ${JSON.stringify(a)}`);
			}
			if (process.env.PANEL_RAW) lines.push(JSON.stringify(expected), JSON.stringify(actual));
			console.log(lines.join("\n"));
			return;
		}
	}
}
/** Register the corpus suite of a panel screen (skipped without the corpus). */
export function panelSuite(screen: PanelScreen): void {
	const files = caseFiles(screen.dir);
	describe.skipIf(files.length === 0)(screen.dir, () => {
		for (const file of files) {
			const caseName = path.basename(file).replace(/\.[a-z]+\.json$/, "");
			test(caseName, async () => {
				const results = await runCase(screen, file);
				const compareRows = !screen.nativeOnly?.(caseName);
				const nativeFailures: string[] = [];
				const rowFailures: string[] = [];
				for (const result of results) {
					if (result.native) nativeFailures.push(`[${result.index}] ${result.label}: ${result.native}`);
					if (!compareRows) continue;
					const ref = { screen: screen.dir, case: caseName, index: result.index, label: result.label };
					for (const width in result.rows) {
						const diff = result.rows[width];
						if (diff && !skipsAt(ref, "rows", width))
							rowFailures.push(`[${result.index}] ${result.label} @${width}: ${diff}`);
					}
				}
				if (process.env.PANEL_SHOW && compareRows) showFirstFailure(file, results);
				if (process.env.PANEL_REPORT) {
					const exact = (r: StageResult): boolean => Object.values(r.rows).every(d => !d);
					const native = results.filter(r => !r.native).length;
					const rows = results.filter(exact).length;
					console.log(
						`${screen.dir}/${caseName}: native ${native}/${results.length}, rows ${rows}/${results.length}`,
					);
				}
				expect(nativeFailures.slice(0, 5)).toEqual([]);
				expect(rowFailures.slice(0, 5)).toEqual([]);
			});
		}
	});
}
