/**
 * Corpus replay for the composer: build a {@link Composer} from a case's
 * inputs, drive it through the stages by label (keys decoded from the raw
 * sequences the capture fed, pastes, API steps), dispatching input the way
 * the terminal backend does (`onKey`/`onPaste` handlers up the focus path,
 * then the focused kind's widget), and compare every stage.
 */
import type { KeyEvent, UiEvent, UiNode } from "@oh-my-pi/pi-tui";
import { bubbleEvent, bubbleKey, bubblePaste, keypathOf, pathTo } from "@oh-my-pi/pi-tui/dispatch";
import { decodeKey } from "@oh-my-pi/pi-tui/driver/input/keys";
import { type PaintEnvironment, paintNode, type StaticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { widgetFor, widgetState } from "@oh-my-pi/pi-tui/term/widgets";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";
import { type CorpusCase, describeTree, stageNative } from "@oh-my-pi/pi-tui/testing/corpus";
import { type Signal, signal } from "@oh-my-pi/pi-tui";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	Composer,
	type ComposerOptions,
	chipLabel,
} from "../../../src/ui/composer";

/** Raw sequences of the capture's named keys (kitty keyboard protocol active). */
export const KEYS: Record<string, string> = {
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	home: "\x1b[H",
	end: "\x1b[F",
	wordLeft: "\x1bb",
	wordRight: "\x1bf",
	ctrlLeft: "\x1b[1;5D",
	ctrlRight: "\x1b[1;5C",
	enter: "\r",
	shiftEnter: "\x1b[13;2u",
	altEnter: "\x1b\r",
	ctrlJ: "\n",
	backspace: "\x7f",
	delete: "\x1b[3~",
	ctrlW: "\x17",
	ctrlU: "\x15",
	ctrlK: "\x0b",
	ctrlY: "\x19",
	altY: "\x1by",
	ctrlA: "\x01",
	ctrlE: "\x05",
	tab: "\t",
	esc: "\x1b",
};

/** A key event as the driver decodes `raw`. */
export function key(raw: string): KeyEvent {
	const event = decodeKey(raw, { kitty: true, backspaceIsCtrl: false });
	if (!event) throw new Error(`undecodable key ${JSON.stringify(raw)}`);
	return event;
}

/** Feed a key to the focused `field` under `root` as the terminal backend routes it. */
export function sendKey(root: UiNode, field: UiNode, event: KeyEvent): boolean {
	const path = pathTo([root], field);
	if (bubbleKey(path, event)) return true;
	return widgetFor(field)?.key?.(field, event, widgetContext(path)) ?? false;
}

/** Feed a bracketed paste. */
export function sendPaste(root: UiNode, field: UiNode, text: string): void {
	const path = pathTo([root], field);
	if (bubblePaste(path, { text })) return;
	widgetFor(field)?.paste?.(field, { text }, widgetContext(path));
}

function widgetContext(path: readonly UiNode[]) {
	const node = path[path.length - 1]!;
	return {
		emit: (event: UiEvent) => void bubbleEvent(path, event),
		state: <T>(name: string, init: () => T) => {
			const map = widgetState(node);
			let value = map.get(name);
			if (!value) {
				value = signal<unknown>(init());
				map.set(name, value);
			}
			return value as Signal<T>;
		},
		keypath: keypathOf(path),
		focus: () => {},
		pageRows: 28,
	};
}

// ── The capture's completion fixture ─────────────────────────────────────────

interface ProviderInputs {
	readonly commands: AutocompleteItem[];
	readonly files: AutocompleteItem[];
}

/** `/name` at the first line's start lists commands, `@path` lists files (prefix, or contained for files). */
export function fixtureProvider(inputs: ProviderInputs): AutocompleteProvider {
	const match = (lines: string[], line: number, col: number) => {
		const before = (lines[line] ?? "").slice(0, col);
		const slash = line === 0 ? /^\/(\S*)$/.exec(before) : null;
		if (slash) return { kind: "slash" as const, prefix: `/${slash[1]}` };
		const at = /(?:^|\s)@(\S*)$/.exec(before);
		if (at) return { kind: "file" as const, prefix: `@${at[1]}` };
		return null;
	};
	return {
		async getSuggestions(lines, line, col) {
			const m = match(lines, line, col);
			if (!m) return null;
			const q = m.prefix.slice(1).toLowerCase();
			const pool = m.kind === "slash" ? inputs.commands : inputs.files;
			const items = pool.filter(
				i => i.value.toLowerCase().startsWith(q) || (m.kind === "file" && i.value.toLowerCase().includes(q)),
			);
			return items.length ? { items, prefix: m.prefix } : null;
		},
		applyCompletion(lines, line, col, item, prefix) {
			const text = lines[line] ?? "";
			const insert = `${prefix[0]}${item.value}${item.value.endsWith("/") ? "" : " "}`;
			const start = col - prefix.length;
			const next = [...lines];
			next[line] = text.slice(0, start) + insert + text.slice(col);
			return { lines: next, cursorLine: line, cursorCol: start + insert.length };
		},
	};
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEKmBhQAAA9+AQBHYLp7wAAAABJRU5ErkJggg==";
const IMAGE = { type: "image", data: PNG, mimeType: "image/png" } as const;
const BIG_PASTE = Array.from({ length: 14 }, (_, i) => `line ${i + 1}: const value${i} = ${i * 7};`).join("\n");

/** Editor case inputs (`composer/editor`). */
interface EditorInputs {
	readonly options: {
		readonly focused?: boolean;
		readonly text?: string;
		readonly placeholder?: string;
		readonly disableSubmit?: boolean;
		readonly vim?: boolean;
		readonly history?: string[];
		readonly borderStyle?: string;
		readonly paddingX?: number;
		readonly maxVisible?: number;
	};
	readonly autocompleteProvider?: ProviderInputs;
}

/** The composer a `composer/editor` case describes, focused when the case says so. */
export function editorComposer(corpusCase: CorpusCase, env: StaticEnvironment): Composer {
	const inputs = corpusCase.inputs as EditorInputs;
	const o = inputs.options;
	const options: ComposerOptions = {
		text: o.text,
		history: o.history,
		placeholder: o.placeholder,
		disableSubmit: o.disableSubmit,
		vim: o.vim,
		shape: o.borderStyle,
		paddingX: o.paddingX,
		autocompleteMaxVisible: o.maxVisible,
		autocomplete: inputs.autocompleteProvider ? fixtureProvider(inputs.autocompleteProvider) : undefined,
		onSubmit: () => {},
	};
	const composer = new Composer(options);
	env.setFocus(o.focused === false ? null : composer.field);
	return composer;
}

/** Apply the step a stage label names. */
export async function applyStage(composer: Composer, env: StaticEnvironment, label: string): Promise<void> {
	const root = composer.node;
	const field = composer.field;
	const typed = /^type (".*")$/.exec(label);
	if (typed) {
		for (const ch of JSON.parse(typed[1]!) as string) sendKey(root, field, key(ch));
	} else if (label.startsWith("key ")) {
		const raw = KEYS[label.slice(4)];
		if (raw === undefined) throw new Error(`unknown key ${label}`);
		sendKey(root, field, key(raw));
	} else {
		switch (label) {
			case "bracketed paste 14 lines":
				sendPaste(root, field, BIG_PASTE);
				break;
			case "bracketed paste 1200 chars":
				sendPaste(root, field, "x".repeat(1200));
				break;
			case "bracketed paste short":
				sendPaste(root, field, "short paste");
				break;
			case "text attachment":
				composer.insertTextAttachment("line1\nline2\tx\nline3\n日本語のテキスト");
				break;
			case "image atom":
				composer.insertAtom(chipLabel("image", 1), "[Image #1, 2x2]", { kind: "image", image: IMAGE });
				break;
			case "video atom":
				composer.insertAtom(chipLabel("video", 2), "[Video #2, 2x2]", { kind: "video", image: { ...IMAGE } });
				break;
			case "focus":
				env.setFocus(field);
				break;
			case "unfocused":
				env.setFocus(null);
				break;
			case "clearDraft(history)":
				composer.clearDraft();
				break;
			case "shell bash":
				composer.setState({ running: false, shell: { kind: "bash" } });
				break;
			case "shell bash excluded":
				composer.setState({ running: false, shell: { kind: "bash", excluded: true } });
				break;
			case "shell python":
				composer.setText("$print(1)");
				composer.setState({ running: false, shell: { kind: "python" } });
				break;
			case "running":
				composer.setText("queued follow-up");
				composer.setState({ running: true });
				break;
			case "faint":
				composer.setFaint(true);
				break;
			case "top border status":
				composer.setStatus({ content: "status ▸ model", width: 14 });
				break;
			case "empty":
				composer.setText("");
				break;
			default:
				throw new Error(`unknown stage ${label}`);
		}
	}
	await settle();
}

/** Let pending completions resolve (they run on microtasks), as the capture's settle did. */
export async function settle(): Promise<void> {
	for (let i = 0; i < 16; i++) await Promise.resolve();
}

/** Differences between a stage and the tree: native (props may add, never change), rows and cursor per width. */
export function compareStage(corpusCase: CorpusCase, index: number, tree: UiNode, env: PaintEnvironment): string[] {
	const stage = corpusCase.stages[index]!;
	const problems: string[] = [];
	const native = subsetDiff(stageNative(corpusCase, index), describeTree(tree, env), "$");
	if (native) problems.push(`native ${native}`);
	for (const width of corpusCase.widths) {
		const block = paintNode(env, tree, width);
		const rows = firstCellDiff(stage.rows[String(width)] ?? [], block.rows);
		if (rows) problems.push(`w${width} ${rows}`);
		const expected = stage.cursor?.[String(width)] ?? null;
		const actual = block.cursor ?? null;
		if (JSON.stringify(expected) !== JSON.stringify(actual))
			problems.push(`w${width} cursor expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
	}
	return problems;
}

/** First difference, where `actual` props (`p`) may carry extra entries. */
export function subsetDiff(expected: unknown, actual: unknown, at: string): string | null {
	if (Object.is(expected, actual)) return null;
	if (typeof expected !== "object" || expected === null || typeof actual !== "object" || actual === null)
		return `${at}: expected ${JSON.stringify(expected)?.slice(0, 200)} got ${JSON.stringify(actual)?.slice(0, 200)}`;
	if (Array.isArray(expected) !== Array.isArray(actual)) return `${at}: array vs object`;
	const e = expected as Record<string, unknown>;
	const a = actual as Record<string, unknown>;
	const additive = at.endsWith(".p");
	for (const k in e) {
		const diff = subsetDiff(e[k], a[k], `${at}.${k}`);
		if (diff) return diff;
	}
	if (!additive)
		for (const k in a) if (!(k in e)) return `${at}.${k}: unexpected ${JSON.stringify(a[k])?.slice(0, 200)}`;
	return null;
}
