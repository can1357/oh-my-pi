/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Standalone prompts a CLI command shows before any session exists: pick one
 * item from a list, or type one line of text.
 *
 * The select prompt is a `picker` (child `picker` of a column) with
 * `Select ⏎` / `Close esc`; the program owns the selection and the search:
 * once the list overflows its visible rows, typed text filters it (fuzzy over
 * label, value and description) and the terminal draws the search line under
 * the rows (`omp.standalone` look). The text prompt is a one-field form.
 * {@link selectStandaloneItem} and {@link promptStandaloneText} run either
 * once, below the command's output, on a shell of their own.
 */
import {
	batch,
	computed,
	isUiNode,
	type JSXNode,
	type KeyEvent,
	type Signal,
	signal,
	type UiNode,
	untrack,
} from "@oh-my-pi/pi-tui";
import type { PickerTerm } from "@oh-my-pi/pi-tui/term/painters/picker";
import type { TspPickerAction, TspPickerItem } from "@oh-my-pi/pi-wire";
import { fuzzyFilter } from "../../utils/fuzzy";
import { Form } from "../forms/field";
import { FormModel, TextFieldModel } from "../forms/models";
import { STANDALONE_LOOK } from "../styles/apps/viewer/standalone-picker";
import { withStandaloneShell } from "./fullscreen";
import { closeAction, pickerAction } from "../overlays/pickers/select-sheet";
import { confirmKbd } from "../keys/hints";

/** One choice of a standalone select prompt. */
export interface StandaloneItem {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

/** Options of a standalone select prompt. */
export interface StandaloneSelectOptions {
	/** The item selected at open (marked current). */
	readonly currentValue?: string;
	/** Rows shown at once (default 10); a longer list scrolls and becomes searchable. */
	readonly maxVisible?: number;
	/** What the items are (`models`), for the native picker's copy. */
	readonly noun?: string;
	onPick?(value: string): void;
	onCancel?(): void;
}

const searchText = (item: StandaloneItem): string =>
	item.description ? `${item.label} ${item.value} ${item.description}` : `${item.label} ${item.value}`;

/** State of a standalone select prompt: the search, the matching items and the selection. */
export class StandaloneSelectModel {
	readonly items: readonly StandaloneItem[];
	readonly maxVisible: number;
	readonly noun: string | undefined;
	readonly currentValue: string | undefined;
	readonly query = signal("");
	/** The search caret (UTF-16 offset). */
	readonly cursor = signal(0);
	readonly selected: Signal<string | null>;
	/** The items matching the search, in rank order (all items while it is empty). */
	readonly visible = computed(() => {
		const query = this.query().trim();
		return query ? fuzzyFilter([...this.items], query, searchText) : this.items;
	});
	readonly #options: StandaloneSelectOptions;

	constructor(items: readonly StandaloneItem[], options: StandaloneSelectOptions = {}) {
		this.items = items;
		this.#options = options;
		this.maxVisible = Math.max(1, options.maxVisible ?? 10);
		this.noun = options.noun;
		this.currentValue = options.currentValue;
		const initial = items.some(item => item.value === options.currentValue) ? options.currentValue! : null;
		this.selected = signal(initial ?? items[0]?.value ?? null);
	}

	/** Whether typing filters the list (it holds more items than it shows). */
	get searchable(): boolean {
		return this.items.length > this.maxVisible;
	}

	select(value: string): void {
		if (untrack(this.visible).some(item => item.value === value)) this.selected.set(value);
	}

	/** Replace the search (caret at `cursor`, default the end); the selection stays when it still matches. */
	setQuery(query: string, cursor = query.length): void {
		batch(() => {
			this.query.set(query);
			this.cursor.set(cursor);
			const visible = untrack(this.visible);
			const selected = untrack(this.selected);
			if (!visible.some(item => item.value === selected)) this.selected.set(visible[0]?.value ?? null);
		});
	}

	/** Search keys: printable text inserts at the caret, backspace deletes before it. */
	key(key: KeyEvent): boolean {
		if (!this.searchable || key.kind === "release") return false;
		const query = untrack(this.query);
		const cursor = untrack(this.cursor);
		if (key.id === "backspace") {
			if (cursor === 0) return true;
			const before = Array.from(query.slice(0, cursor));
			before.pop();
			const head = before.join("");
			this.setQuery(head + query.slice(cursor), head.length);
			return true;
		}
		const text = key.text;
		if (!text || key.id.startsWith("ctrl+") || key.id.startsWith("alt+") || text < " ") return false;
		this.setQuery(query.slice(0, cursor) + text + query.slice(cursor), cursor + text.length);
		return true;
	}

	pick(value: string): void {
		if (untrack(this.visible).some(item => item.value === value)) this.#options.onPick?.(value);
	}

	cancel(): void {
		this.#options.onCancel?.();
	}
}

/** Select and Close, on the selector confirm and cancel keys. */
const actions = (): TspPickerAction[] => [
	pickerAction("confirm", "Select", confirmKbd(), { primary: true }),
	closeAction(),
];

/** A standalone select prompt (see the module docs); `title` drops a trailing colon. */
export function StandaloneSelect(props: { readonly title: string; readonly model: StandaloneSelectModel }): JSXNode {
	const model = props.model;
	const items = (): TspPickerItem[] =>
		model.visible().map(item => ({
			id: item.value,
			label: item.label,
			...(item.description ? { detail: item.description } : {}),
		}));
	const term = (): PickerTerm => ({ look: STANDALONE_LOOK, maxRows: model.maxVisible, search: model.searchable });
	return (
		<col>
			<picker
				key="picker"
				title={props.title.replace(/:\s*$/, "")}
				noun={model.noun}
				size="md"
				layout="rows"
				preview="none"
				query={model.query}
				cursor={model.cursor}
				items={items}
				selected={model.selected}
				current={model.currentValue === undefined ? undefined : [model.currentValue]}
				actions={actions()}
				confirm={null}
				term={term}
				onKey={key => model.key(key)}
				onSelect={id => model.select(id)}
				onActivate={id => model.pick(id)}
				onAction={act => {
					if (act === "close" || act === "cancel") model.cancel();
					else if (act === "clear") model.setQuery("");
					else if (act === "confirm") {
						const id = untrack(model.selected);
						if (id !== null) model.pick(id);
					}
				}}
			/>
		</col>
	);
}

/** State of a standalone text prompt. */
export function standaloneTextModel(options: { onSubmit?(value: string): void; onCancel?(): void }): FormModel {
	const onCancel = (): void => options.onCancel?.();
	const field = new TextFieldModel({ onSubmit: options.onSubmit, onCancel, focused: true });
	return new FormModel({ fields: [field], onCancel, focused: true });
}

/** A standalone text prompt: one `> ` field. */
export function StandaloneText(props: { readonly model: FormModel }): JSXNode {
	return <Form model={props.model} fields={[{ spaceBeforeControl: false, spaceAfterControl: false }]} />;
}

/** The first node under `root` (itself included) that `match` accepts, depth first. */
function findNode(root: UiNode, match: (node: UiNode) => boolean): UiNode | undefined {
	if (match(root)) return root;
	for (const child of root.children()) {
		const found = findNode(child, match);
		if (found) return found;
	}
	return undefined;
}

/**
 * Show `view` under the program's output on a shell of its own until it
 * settles a value, keyboard focus on the node `focus` picks.
 */
async function runPrompt<T>(
	title: string,
	build: (finish: (value: T) => void) => JSXNode,
	focus: (node: UiNode) => boolean,
): Promise<T> {
	process.stdout.write(`${title}\n`);
	return withStandaloneShell({}, async shell => {
		const { promise, resolve } = Promise.withResolvers<T>();
		const slot = shell.dock.slot("composer");
		slot.set(() => build(resolve));
		const root = untrack(slot.view);
		const target = isUiNode(root) ? findNode(root, focus) : undefined;
		shell.focus(target ?? null);
		try {
			return await promise;
		} finally {
			slot.clear();
		}
	});
}

/** Pick one of `items` below `title`; resolves with its value, or null when cancelled. */
export function selectStandaloneItem(
	title: string,
	items: readonly StandaloneItem[],
	options: Omit<StandaloneSelectOptions, "onPick" | "onCancel"> = {},
): Promise<string | null> {
	return runPrompt<string | null>(
		title,
		finish => (
			<StandaloneSelect
				title={title}
				model={
					new StandaloneSelectModel(items, {
						...options,
						onPick: value => finish(value),
						onCancel: () => finish(null),
					})
				}
			/>
		),
		node => node.kind === "picker",
	);
}

/** Read one line of text below `title`; resolves with it trimmed, or null when cancelled or empty. */
export function promptStandaloneText(title: string): Promise<string | null> {
	return runPrompt<string | null>(
		title,
		finish => (
			<StandaloneText
				model={standaloneTextModel({
					onSubmit: value => finish(value.trim() || null),
					onCancel: () => finish(null),
				})}
			/>
		),
		node => node.kind === "input",
	);
}
