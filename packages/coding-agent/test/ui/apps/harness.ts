/**
 * Corpus checks for the fullscreen app screens (`apps/<screen>`).
 *
 * A case mounts the screen from the recorded inputs and replays every stage:
 * imperative steps by label (what the old screen's capture called), raw keys
 * (offered to `onKey` handlers from the focused node up, then to the focused
 * kind's widget) and UI events (bubbling from the node their keypath names).
 * Each stage then compares the described native tree (props the new tree adds
 * are allowed) and the painted rows at every recorded width, cell by cell,
 * unless the stage is a listed deviation (`../deviations.ts`).
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
import { bubbleEvent, bubbleKey, keypathOf, pathTo } from "@oh-my-pi/pi-tui/dispatch";
import { decodeKey } from "@oh-my-pi/pi-tui/driver/input/keys";
import { paintNode, releasePaintCache, type StaticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { type WidgetContext, widgetFor, widgetState } from "@oh-my-pi/pi-tui/term/widgets";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";
import {
	CORPUS_DIR,
	type CorpusCase,
	corpusEnvironment,
	describeTree,
	stageNative,
} from "@oh-my-pi/pi-tui/testing/corpus";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { captureStage, skipsAt } from "../deviations";

/** What a step may do to the mounted screen. */
export interface AppDriver {
	readonly root: UiNode;
	readonly env: StaticEnvironment;
	readonly focused: UiNode | null;
	focus(node: UiNode | null): void;
	/** Feed raw input bytes as one key. */
	press(raw: string): void;
	/** Deliver a UI event to the node at its keypath (bubbling); false when no node has that keypath. */
	emit(event: UiEvent): boolean;
}

/** One mounted case. */
export interface AppMount {
	readonly view: () => JSXNode;
	/** Steps by stage label; `key "…"` stages are pressed unless listed. */
	readonly steps?: Readonly<Record<string, (driver: AppDriver) => void | Promise<void>>>;
	/** Node to focus at start (default: the root). */
	focus?(driver: AppDriver): UiNode | null | undefined;
	/** Awaited before the first stage is checked (let a mounted app start up). */
	ready?(): Promise<void>;
	/** Rows painted per width at a fixed height (read per stage); default natural height. */
	readonly height?: number | (() => number | undefined);
	/** Skip the native comparison (the old screen described no tree). */
	readonly rowsOnly?: boolean;
	/**
	 * Lay the root out afresh at every recorded width of every stage (the old
	 * screen rendered each width in turn and its scroll state carried from one
	 * width to the next).
	 */
	readonly fresh?: boolean;
	dispose?(): void;
}

/** An app screen's corpus suite. */
export interface AppScreen {
	/** `apps/<screen>`. */
	readonly dir: string;
	mount(caseName: string, corpusCase: CorpusCase): AppMount;
}

const KEY_CONTEXT = { kitty: false, backspaceIsCtrl: false };

/** Find the node at `keypath` below `root` (`""` is the root). */
export function nodeAtKeypath(root: UiNode, keypath: string): UiNode | undefined {
	if (keypath === "") return root;
	let node: UiNode | undefined = root;
	for (const segment of keypath.split("/")) {
		const children: readonly UiNode[] = node!.children();
		node = children.find(child => child.key() === segment) ?? children[Number(segment)];
		if (!node) return undefined;
	}
	return node;
}

function createDriver(rootOf: () => UiNode, env: StaticEnvironment): AppDriver {
	const focusSignal: Signal<UiNode | null> = signal<UiNode | null>(null);
	const widgetContext = (nodes: readonly UiNode[]): WidgetContext => {
		const node = nodes[nodes.length - 1]!;
		return {
			emit: event => void bubbleEvent(nodes, event),
			state: <T>(name: string, init: () => T): Signal<T> => {
				const map = widgetState(node);
				let value = map.get(name) as Signal<T> | undefined;
				if (!value) {
					value = signal(init());
					map.set(name, value as Signal<unknown>);
				}
				return value;
			},
			keypath: keypathOf(nodes),
			focus: next => driver.focus(next),
			pageRows: 40,
		};
	};
	const focusPath = (): UiNode[] => {
		const focused = focusSignal();
		const root = rootOf();
		const nodes = focused ? pathTo([root], focused) : [];
		return nodes.length > 0 ? nodes : [root];
	};
	const driver: AppDriver = {
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
			const key = decodeKey(raw, KEY_CONTEXT);
			if (!key) throw new Error(`undecodable key ${JSON.stringify(raw)}`);
			const nodes = focusPath();
			const focused = nodes[nodes.length - 1]!;
			if (bubbleKey(nodes, key)) return;
			widgetFor(focused)?.key?.(focused, key, widgetContext(nodes));
		},
		emit(event) {
			const root = rootOf();
			const target = nodeAtKeypath(root, event.key);
			if (!target) return false;
			bubbleEvent(pathTo([root], target), event);
			return true;
		},
	};
	return driver;
}

/** The first difference between a recorded native tree and the described one (added props allowed), or null. */
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
export async function runAppCase(screen: AppScreen, file: string): Promise<StageResult[]> {
	const corpusCase = JSON.parse(fs.readFileSync(file, "utf8")) as CorpusCase;
	const caseName = path.basename(file).replace(/\.[a-z]+\.json$/, "");
	const env = corpusEnvironment(corpusCase.theme);
	// Screens read the active theme for native spans; run the case under its theme.
	const previousTheme = currentTheme();
	setCurrentTheme(loadThemeSync(corpusCase.theme));
	const results: StageResult[] = [];
	let disposeRoot: () => void = () => {};
	let mounted!: AppMount;
	let nodes!: () => readonly UiNode[];
	createRoot(dispose => {
		disposeRoot = dispose;
		mounted = screen.mount(caseName, corpusCase);
		nodes = resolveChildren(mounted.view);
	});
	const rootOf = (): UiNode => {
		const current = nodes();
		if (current.length !== 1) throw new Error(`${caseName}: the view must be one node, got ${current.length}`);
		return current[0]!;
	};
	const driver = createDriver(rootOf, env);
	driver.focus((mounted.focus ? mounted.focus(driver) : rootOf()) ?? null);
	try {
		await mounted.ready?.();
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
				const height = typeof mounted.height === "function" ? mounted.height() : mounted.height;
				if (mounted.fresh) releasePaintCache(rootOf());
				const actual = paintNode(env, rootOf(), width, height).rows;
				painted[String(width)] = actual;
				rows[String(width)] = firstCellDiff(expected, actual);
			}
			const expectedNative = stageNative(corpusCase, index);
			const described = mounted.rowsOnly || expectedNative === null ? undefined : describeTree(rootOf(), env);
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
		setCurrentTheme(previousTheme);
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

/** Debug aid (`APPS_SHOW=1`): the first stage whose rows differ, expected beside painted. */
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
			if (process.env.APPS_RAW) lines.push(JSON.stringify(expected), JSON.stringify(actual));
			console.log(lines.join("\n"));
			return;
		}
	}
}

/** Register the corpus suite of an app screen (skipped without the corpus). */
export function appSuite(screen: AppScreen): void {
	const files = caseFiles(screen.dir);
	describe.skipIf(files.length === 0)(screen.dir, () => {
		for (const file of files) {
			const caseName = path.basename(file).replace(/\.[a-z]+\.json$/, "");
			test(caseName, async () => {
				const results = await runAppCase(screen, file);
				const nativeFailures: string[] = [];
				const rowFailures: string[] = [];
				for (const result of results) {
					const ref = { screen: screen.dir, case: caseName, index: result.index, label: result.label };
					if (result.native && !skipsAt(ref, "native")) {
						nativeFailures.push(`[${result.index}] ${result.label}: ${result.native}`);
					}
					for (const width in result.rows) {
						const diff = result.rows[width];
						if (diff && !skipsAt(ref, "rows", width))
							rowFailures.push(`[${result.index}] ${result.label} @${width}: ${diff}`);
					}
				}
				if (process.env.APPS_SHOW) showFirstFailure(file, results);
				if (process.env.APPS_REPORT) {
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
