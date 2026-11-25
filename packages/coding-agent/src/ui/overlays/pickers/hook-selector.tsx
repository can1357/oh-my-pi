/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The option selector extensions and hooks open (`ctx.ui.select`): a list of
 * options (inline markdown, optional descriptions), with radio or checkbox
 * markers, disabled rows, digit quick-select (`1.`…`9.` labels), and
 * type-to-search once the options outgrow the visible rows.
 *
 * A plain list is a `picker` sheet. Inline selectors (shown in the dock so
 * content above stays visible), selectors with a slider (a left/right choice
 * alongside the option, as `tabs`) and timed ones (a countdown in the head)
 * are a `card` holding a `list`.
 *
 * Keys are the selector's own (↑/↓ skip disabled rows and stop at the ends);
 * a pointer pick on the list or Enter selects. A countdown restarts on every
 * key or pick and selects the highlighted option when it runs out.
 */
import {
	batch,
	computed,
	effect,
	For,
	type JSXNode,
	type KeyEvent,
	onCleanup,
	read,
	type Reactive,
	signal,
	type UiEvent,
} from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import type { TspPickerItem, TspSpan } from "@oh-my-pi/pi-wire";
import type { HookSelectorSlider } from "../../../modes/view-model/overlays/hook-selector";
import { fuzzyFilter } from "../../../utils/fuzzy";
import { plainInlineMarkdown } from "../../styles/pickers/common";
import "../../styles/pickers/hook";
import type { HookLookOption, HookLookTerm } from "../../styles/pickers/hook";
import { editLine, type LineState } from "../settings/line-edit";
import { menuCoerce, menuMove } from "./menu";
import { closeAction, PICKER_KEY, pickerAction } from "./select-sheet";
import { actionKbd, cancelKbd, confirmKbd } from "../../keys/hints";
import { matchesSelectCancel, selectKeyId } from "../../../config/keybindings/matchers";

export interface HookSelectorOption {
	label: string;
	description?: string;
}

export type HookSelectorOptionInput = string | HookSelectorOption;

export interface HookSelectorProps {
	/** First line: the heading; further lines: details under it. */
	readonly title: Reactive<string>;
	readonly options: readonly HookSelectorOptionInput[];
	onSelect(label: string): void;
	onCancel(): void;
	readonly initialIndex?: number;
	/** Draw the options inside a rule-framed box. */
	readonly outline?: boolean;
	/** Visible option rows (at least 3; default 12). */
	readonly maxVisible?: number;
	onLeft?(): void;
	onRight?(): void;
	/** Ctrl+G: edit the answer in the external editor. */
	onExternalEditor?(): void;
	/** Replaces the key hints. */
	readonly helpText?: string;
	readonly slider?: HookSelectorSlider;
	/** Options (original indices) that cannot be selected. */
	readonly disabledIndices?: readonly number[];
	/** Radio: the cursor row is filled; checkbox: `checkedIndices` are checked. */
	readonly selectionMarker?: "radio" | "checkbox";
	readonly checkedIndices?: readonly number[];
	/** Leading options that get a marker (default: all). */
	readonly markableCount?: number;
	/** A dock card instead of a picker sheet. */
	readonly inline?: boolean;
	/** Milliseconds until the highlighted option is selected (restarted by every key). */
	readonly timeout?: number;
	onTimeout?(): void;
	onTimeoutStart?(): void;
	onTimeoutReset?(): void;
	/** The clock the countdown runs on (default `Date.now`). */
	now?(): number;
}

const SEARCH_EXCLUDED_KEYS: Readonly<Record<string, true>> = { "ctrl+g": true };

function normalize(option: HookSelectorOptionInput): HookSelectorOption {
	if (typeof option === "string") return { label: option };
	const description = option.description?.trim();
	return description ? { label: option.label, description } : { label: option.label };
}

/** A key hint: keys (each its keycaps, TSP key names) and what they do. */
function hint(keys: readonly string[][], label: string): JSXNode {
	return (
		<row align="center" gap="xs">
			{keys.map(key => (
				<kbd keys={key} />
			))}
			<text spans={[{ t: label, s: "muted" }]} />
		</row>
	);
}

export function HookSelector(props: HookSelectorProps): JSXNode {
	const options = props.options.map(normalize);
	const initialTitle = read(props.title);
	const heading = initialTitle.split(/\r?\n/, 1)[0] ?? "";
	const details = initialTitle.split(/\r?\n/).slice(1);
	const plainTitle = plainInlineMarkdown(heading);
	const disabled = new Set(
		(props.disabledIndices ?? []).filter(index => Number.isInteger(index) && index >= 0 && index < options.length),
	);
	const checked = new Set(
		(props.checkedIndices ?? []).filter(index => Number.isInteger(index) && index >= 0 && index < options.length),
	);
	const markable = Math.max(0, Math.min(props.markableCount ?? options.length, options.length));
	const maxVisible = Math.max(3, props.maxVisible ?? 12);
	const now = (): number => props.now?.() ?? Date.now();
	const slider = props.slider && props.slider.segments.length > 0 ? props.slider : undefined;
	const sliderIndex = signal(slider ? Math.max(0, Math.min(slider.index, slider.segments.length - 1)) : 0);
	// Search opens once every option with its description no longer fits the visible rows.
	const searchable = options.reduce((rows, option) => rows + (option.description ? 2 : 1), 0) > maxVisible;

	const search = signal<LineState>({ text: "", cursor: 0 });
	const visible = computed<readonly number[]>(() => {
		const query = search().text.trim();
		const all = options.map((_, index) => index);
		if (!query) return all;
		return fuzzyFilter(all, query, index => `${options[index]!.label} ${options[index]!.description ?? ""}`);
	});
	const isDisabled = (position: number): boolean => disabled.has(visible()[position] ?? -1);
	/** Position of the cursor in `visible`. */
	const cursor = signal(menuCoerce(options.length, props.initialIndex ?? 0, 1, index => disabled.has(index)));
	const selectedIndex = (): number | undefined => visible()[cursor()];

	// The terminal heading: the title, with the countdown's seconds while one runs. A title set after
	// opening shows whole on one line until the countdown next writes it.
	const heading$ = signal(heading);
	effect(() => {
		const title = read(props.title);
		if (title !== initialTitle) heading$.set(title.replace(/\s+/g, " "));
	});

	// The countdown: restarted by every key and pick; runs out into a pick.
	const timed = (props.timeout ?? 0) > 0;
	let timer: Timer | undefined;
	let ticker: Timer | undefined;
	const startCountdown = (): void => {
		if (!timed) return;
		const timeout = props.timeout!;
		clearTimeout(timer);
		clearInterval(ticker);
		const deadline = now() + timeout;
		const show = (): void => heading$.set(`${heading} (${Math.max(0, Math.ceil((deadline - now()) / 1000))}s)`);
		show();
		ticker = setInterval(show, 1000);
		timer = setTimeout(() => {
			clearInterval(ticker);
			props.onTimeout?.();
			const index = selectedIndex();
			if (index !== undefined && !disabled.has(index)) props.onSelect(options[index]!.label);
			else props.onCancel();
		}, timeout);
	};
	const resetCountdown = (): void => {
		if (!timed) return;
		startCountdown();
		props.onTimeoutReset?.();
	};
	if (timed) {
		props.onTimeoutStart?.();
		startCountdown();
	}
	onCleanup(() => {
		clearTimeout(timer);
		clearInterval(ticker);
	});

	const pick = (): void => {
		const index = selectedIndex();
		if (index !== undefined && !disabled.has(index)) props.onSelect(options[index]!.label);
	};
	const focus = (id: string, confirm: boolean): void => {
		const position = visible().indexOf(Number(id));
		if (position < 0 || !/^\d+$/.test(id) || disabled.has(Number(id))) return;
		resetCountdown();
		cursor.set(position);
		if (confirm) pick();
	};
	const moveSlider = (delta: number): void => {
		if (!slider) return;
		const next = Math.max(0, Math.min(slider.segments.length - 1, sliderIndex() + delta));
		if (next === sliderIndex()) return;
		sliderIndex.set(next);
		slider.onChange?.(next);
	};
	const setQuery = (next: LineState): void =>
		batch(() => {
			const changed = next.text !== search().text;
			search.set(next);
			if (changed) cursor.set(menuCoerce(visible().length, 0, 1, isDisabled));
		});
	const clearSearch = (): void => setQuery({ text: "", cursor: 0 });

	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		resetCountdown();
		if (matchesSelectCancel(key)) {
			props.onCancel();
			return true;
		}
		// Digits pick the option numbered so (checkbox menus only move to it) until a search starts.
		if (search().text.length === 0 && /^[1-9]$/.test(key.id)) {
			const position = visible().findIndex(index => options[index]!.label.startsWith(`${key.id}. `));
			if (position >= 0) {
				if (!isDisabled(position)) {
					cursor.set(position);
					if (props.selectionMarker !== "checkbox") pick();
				}
				return true;
			}
		}
		switch (selectKeyId(key)) {
			case "up":
				cursor.set(menuMove(visible().length, cursor(), -1, isDisabled));
				return true;
			case "down":
				cursor.set(menuMove(visible().length, cursor(), 1, isDisabled));
				return true;
			case "enter":
				pick();
				return true;
			case "left":
				if (slider) moveSlider(-1);
				else props.onLeft?.();
				return true;
			case "right":
				if (slider) moveSlider(1);
				else props.onRight?.();
				return true;
		}
		if (slider && !searchable && (key.id === "h" || key.id === "l")) {
			moveSlider(key.id === "h" ? -1 : 1);
			return true;
		}
		if (props.onExternalEditor && key.id === "ctrl+g") {
			props.onExternalEditor();
			return true;
		}
		if (!searchable || SEARCH_EXCLUDED_KEYS[key.id]) return true;
		const line = search();
		if (line.text.length === 0) {
			// An empty search lets Backspace and a leading space through.
			if (key.id === "backspace") return true;
			if (key.text !== undefined && key.text.trim().length === 0) return true;
		}
		const next = editLine(line, key);
		if (next) setQuery(next);
		return true;
	};
	const onAction = (act: string): void => {
		resetCountdown();
		if (act === "close" || act === "cancel") props.onCancel();
		else if (act === "clear") clearSearch();
		else if (act === "confirm") pick();
	};

	const term = (): HookLookTerm => {
		const lookOptions: HookLookOption[] = visible().map(index => {
			const option = options[index]!;
			const marker =
				props.selectionMarker && index < markable
					? { kind: props.selectionMarker, checked: checked.has(index) }
					: undefined;
			return { label: option.label, description: option.description, disabled: disabled.has(index), marker };
		});
		return {
			look: "omp.hook",
			title: heading$(),
			details,
			slider: slider ? { caption: slider.caption, segments: slider.segments, index: sliderIndex() } : undefined,
			outline: props.outline ?? false,
			options: lookOptions,
			cursor: cursor(),
			total: options.length,
			maxVisible,
			searchable,
			query: search(),
			help: props.helpText,
		};
	};

	const card = props.inline || slider !== undefined || timed;
	if (!card) {
		const items: TspPickerItem[] = options.map((option, index) => ({
			id: String(index),
			label: plainInlineMarkdown(option.label),
			...(option.description ? { detail: plainInlineMarkdown(option.description) } : {}),
			...(disabled.has(index) ? { disabled: true as const } : {}),
		}));
		const showSearch = (): boolean => searchable || search().text.length > 0;
		const selected = (): string | null => {
			const index = selectedIndex();
			return index === undefined ? null : String(index);
		};
		return (
			<col onKey={onKey}>
				<picker
					key={PICKER_KEY}
					title={plainTitle}
					subtitle={details.length > 0 ? stripEscapes(details.join("\n")) : undefined}
					noun="options"
					size="md"
					layout="rows"
					preview="none"
					query={() => (showSearch() ? search().text : null)}
					cursor={() => (showSearch() ? search().cursor : undefined)}
					items={items}
					order={() => (search().text.length > 0 ? visible().map(String) : undefined)}
					selected={selected}
					current={props.selectionMarker === "checkbox" ? [...checked].map(String) : undefined}
					total={options.length}
					empty="No matching options"
					actions={[pickerAction("confirm", "Select", confirmKbd(), { primary: true }), closeAction()]}
					term={term}
					onSelect={id => focus(id, false)}
					onActivate={id => focus(id, true)}
					onAction={onAction}
				/>
			</col>
		);
	}

	const onEvent = (event: UiEvent): void => {
		if (event.type === "action") onAction(event.act);
	};
	const listSelected = (): string | null => {
		const index = selectedIndex();
		return index === undefined || disabled.has(index) ? null : String(index);
	};
	return (
		<card
			role="omp.overlay.hook-select"
			head={timed ? undefined : plainTitle}
			term={term}
			onKey={onKey}
			onEvent={onEvent}
		>
			{timed && (
				<row key="head" gap="sm" align="baseline">
					<text text={plainTitle} />
					<elapsed age={-(props.timeout ?? 0)} format="short" />
				</row>
			)}
			{details.length > 0 && (
				<text key="detail" spans={[{ t: stripEscapes(details.join("\n")), s: "accent" }]} wrap="word" />
			)}
			{slider?.caption && <text key="slider-caption" spans={[{ t: stripEscapes(slider.caption), s: "dim" }]} />}
			{slider && (
				<tabs
					key="slider"
					items={slider.segments.map((segment, i) => ({ id: String(i), label: stripEscapes(segment.label) }))}
					active={() => String(sliderIndex())}
					onSelect={id => {
						const target = Number(id);
						if (!Number.isInteger(target) || id.trim() === "") return;
						resetCountdown();
						moveSlider(target - sliderIndex());
					}}
				/>
			)}
			{() => {
				const detail = slider?.segments[sliderIndex()]?.detail;
				return detail ? (
					<text
						key="slider-detail"
						spans={[
							{ t: "↳ ", s: "dim" },
							{ t: stripEscapes(detail), s: "muted" },
						]}
						wrap="word"
					/>
				) : null;
			}}
			<list
				key="list"
				selected={listSelected}
				filter={() => search().text.trim() || undefined}
				empty="No matching options"
				max={{ lines: maxVisible }}
				// A pointer pick on the card's list does what highlighting the option and pressing Enter does.
				onSelect={id => focus(id, true)}
				onActivate={id => focus(id, true)}
			>
				<For each={visible}>{index => <OptionItem index={index} />}</For>
			</list>
			{() =>
				search().text ? (
					<text key="search" spans={[{ t: "Search: ", s: "dim" }, { t: search().text }]} wrap="none" />
				) : null
			}
			{props.helpText !== undefined ? (
				<text key="hints" spans={[{ t: stripEscapes(props.helpText), s: "dim" }]} wrap="word" />
			) : (
				<row key="hints" role="omp.overlay.hints" gap="md" wrap={true}>
					{hint([actionKbd("tui.select.up", "up"), actionKbd("tui.select.down", "down")], "navigate")}
					{hint([confirmKbd()], "select")}
					{hint([cancelKbd()], "cancel")}
				</row>
			)}
		</card>
	);

	function OptionItem(itemProps: { index: number }): JSXNode {
		const { index } = itemProps;
		const option = options[index]!;
		const isDisabled = disabled.has(index);
		const radio = props.selectionMarker === "radio" && index < markable;
		const label = (): TspSpan[] => {
			const text = plainInlineMarkdown(option.label);
			if (radio) {
				const filled = selectedIndex() === index;
				const marker = currentTheme().symbols.symbol(filled ? "radio.selected" : "radio.unselected");
				return [{ t: `${marker} `, s: filled && !isDisabled ? "accent" : "dim" }, { t: text }];
			}
			if (props.selectionMarker === "checkbox" && index < markable) {
				const on = checked.has(index);
				const marker = currentTheme().symbols.symbol(on ? "checkbox.checked" : "checkbox.unchecked");
				return [{ t: `${marker} `, s: on && !isDisabled ? "success" : "dim" }, { t: text }];
			}
			return [{ t: text }];
		};
		return (
			<item
				key={String(index)}
				label={label}
				detail={option.description ? [{ t: plainInlineMarkdown(option.description), s: "muted" }] : undefined}
				disabled={isDisabled || undefined}
			/>
		);
	}
}
