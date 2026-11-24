/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The small selector sheet (thinking level, queue mode, theme, show images,
 * session account, …): a `picker` docked as child `picker` of a column, with
 * `Select ⏎` / `Close esc` actions.
 *
 * The sheet owns its selection. A Tern terminal (or the terminal backend's
 * `picker` widget) reports what the user did: `select` moves the selection
 * (and previews it through `onHighlight`), `activate` or `confirm` picks the
 * item, `close`/`cancel` cancels. Events addressed to any other keypath are
 * not the sheet's.
 */
import { type Accessor, type JSXNode, read, type Reactive, signal } from "@oh-my-pi/pi-tui";
import type { PickerTerm } from "@oh-my-pi/pi-tui/term/painters/picker";
import type { TspPickerAction, TspPickerColumn, TspPickerItem, TspPickerProps } from "@oh-my-pi/pi-wire";
import { cancelKbd, confirmKbd } from "../../keys/hints";

/** Key of the picker child; its events arrive at this keypath. */
export const PICKER_KEY = "picker";

/** Keycaps as a picker action carries them: Escape is the wire's `esc` keycap. */
export function pickerKeys(keys: readonly string[]): string[] {
	return keys.map(key => (key === "escape" ? "esc" : key));
}

/** A picker action button. */
export function pickerAction(
	id: string,
	label: string,
	key: string | readonly string[] | undefined,
	extra?: Omit<TspPickerAction, "id" | "label" | "keys">,
): TspPickerAction {
	const keys = key === undefined ? undefined : pickerKeys(typeof key === "string" ? [key] : key);
	return { id, label, ...(keys ? { keys } : {}), ...extra };
}

/** The `Close` action every sheet ends its bar with, on the selector cancel key (`tui.select.cancel`). */
export function closeAction(label = "Close"): TspPickerAction {
	return pickerAction("close", label, cancelKbd(), { end: true });
}

/** What a select sheet shows. */
export interface SelectSheetProps {
	readonly title: string;
	readonly subtitle?: Reactive<TspPickerProps["subtitle"]>;
	readonly icon?: string;
	readonly noun?: string;
	readonly items: Reactive<readonly TspPickerItem[]>;
	/** The item selected at open (default: the first). */
	readonly initial?: string;
	readonly current?: readonly string[];
	readonly columns?: readonly TspPickerColumn[];
	/** The primary action's label (default `Select`). */
	readonly confirmLabel?: string;
	/** The search text (omp's filter); absent: no search field. */
	readonly query?: Reactive<string>;
	/** The search caret (UTF-16 offset). */
	readonly cursor?: Reactive<number>;
	/** The terminal look. */
	readonly term?: Reactive<PickerTerm>;
	/** The user picked `id`. */
	onPick(id: string): void;
	onCancel(): void;
	/** The selection moved to `id`. */
	onHighlight?(id: string): void;
}

/** The selection state of a select sheet. */
export interface SelectSheetState {
	readonly selected: Accessor<string | null>;
	select(id: string): void;
}

/** A select sheet (see the module docs). */
export function SelectSheet(props: SelectSheetProps): JSXNode {
	const items = (): readonly TspPickerItem[] => read(props.items);
	const first = items()[0]?.id ?? null;
	const selected = signal<string | null>(
		props.initial !== undefined && items().some(item => item.id === props.initial) ? props.initial : first,
	);
	const has = (id: string): boolean => items().some(item => item.id === id);
	const actions = [
		pickerAction("confirm", props.confirmLabel ?? "Select", confirmKbd(), { primary: true }),
		closeAction(),
	];
	return (
		<col>
			<picker
				key={PICKER_KEY}
				title={props.title}
				subtitle={() => read(props.subtitle)}
				icon={props.icon}
				noun={props.noun ?? "options"}
				size="md"
				layout="rows"
				preview="none"
				query={() => (props.query === undefined ? null : read(props.query))}
				cursor={() => (props.query === undefined ? undefined : (read(props.cursor) ?? 0))}
				items={items}
				selected={selected}
				current={props.current}
				columns={props.columns}
				actions={actions}
				confirm={null}
				term={() => read(props.term)}
				onSelect={id => {
					if (!has(id)) return;
					selected.set(id);
					props.onHighlight?.(id);
				}}
				onActivate={id => {
					if (!has(id)) return;
					selected.set(id);
					props.onPick(id);
				}}
				onAction={act => {
					if (act === "close" || act === "cancel") props.onCancel();
					else if (act === "confirm") {
						const id = selected();
						if (id !== null) props.onPick(id);
					}
				}}
			/>
		</col>
	);
}
