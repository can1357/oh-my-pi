/**
 * Generic selector component for hooks.
 * Displays a list of string options with keyboard navigation.
 */
import {
	Container,
	Ellipsis,
	extractPrintableText,
	type MarkdownTheme,
	matchesKey,
	padding,
	renderInlineMarkdown,
	replaceTabs,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../index";
import { getMarkdownTheme, type ThemeColor, theme } from "../theme/theme";
import {
	matchesAppExternalEditor,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectUp,
} from "../keybinding-matchers";
import { CountdownTimer } from "../chrome/countdown-timer";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { formatKeyHint } from "../app-keybindings";
import { OverlayPanel } from "../chrome/overlay-box";
import { renderSegmentTrack } from "../chrome/segment-track";
import { Input } from "../components/input";
import { MenuSelection, getMenuWindow } from "../components/menu-selection";
import type { KeyName } from "../key-hint-format";
import { node, span } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, hintsRow, overlayCard } from "../native/overlay";
import { plainText } from "../native/spans";
import { CLOSE_ACTION, dockedPicker, PICKER_KEY, pickerAction, pickerEvent, pickerQuery } from "../native/picker";
import type { TspPickerItem } from "@oh-my-pi/pi-wire";

/** One segment of a {@link HookSelectorSlider} — a label and an optional
 *  detail line (e.g. the resolved model name) shown beneath the track while
 *  the segment is active. Segment colors come from the track's theme palette,
 *  assigned by position. */
export interface HookSelectorSliderSegment {
	label: string;
	/** Secondary line rendered under the track when this segment is selected. */
	detail?: string;
}

/**
 * A horizontal left/right selector rendered above the option list. Unlike the
 * up/down option cursor, the slider is moved with the left/right arrows from
 * any list position, letting the caller capture an orthogonal choice (e.g. the
 * model tier to continue execution with) alongside the selected option.
 */
export interface HookSelectorSlider {
	/** Dim caption rendered before the slider track (e.g. "continue with"). */
	caption?: string;
	segments: HookSelectorSliderSegment[];
	/** Initially highlighted segment index. */
	index: number;
	/** Invoked with the new index whenever the slider moves. */
	onChange?: (index: number) => void;
}

export interface HookSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onTimeout?: () => void;
	onTimeoutStart?: () => void;
	onTimeoutReset?: () => void;
	initialIndex?: number;
	outline?: boolean;
	maxVisible?: number;
	onLeft?: () => void;
	onRight?: () => void;
	onExternalEditor?: () => void;
	helpText?: string;
	slider?: HookSelectorSlider;
	/** Indices into the original options that cannot be selected: they render
	 *  dimmed, are skipped during navigation, and reject enter/timeout. */
	disabledIndices?: readonly number[];
	/** Render a leading radio/checkbox marker before each markable option,
	 *  matching the ask transcript. "radio" fills the marker on the cursor row
	 *  (single-choice); "checkbox" reflects {@link checkedIndices} per row
	 *  (multi-select). Options at or beyond {@link markableCount} keep the plain
	 *  cursor prefix — used for trailing control rows like "Other"/"Done". */
	selectionMarker?: "radio" | "checkbox";
	/** For `selectionMarker: "checkbox"`: original-indices currently checked. */
	checkedIndices?: readonly number[];
	/** Number of leading options (original order) that receive a selection
	 *  marker. Defaults to every option when {@link selectionMarker} is set. */
	markableCount?: number;
	/** Describe as a card in the dock (the composer slot) instead of a picker
	 *  sheet, so dock content above it (e.g. a `/omfg` candidate rule) stays
	 *  visible and the transcript stays scrollable on native surfaces. */
	inline?: boolean;
}

export interface HookSelectorOption {
	label: string;
	description?: string;
}

export type HookSelectorOptionInput = string | HookSelectorOption;

function normalizeHookSelectorOption(option: HookSelectorOptionInput): HookSelectorOption {
	if (typeof option === "string") return { label: option };
	if (option.description?.trim()) {
		return { label: option.label, description: option.description.trim() };
	}
	return { label: option.label };
}

function splitLeadingSpacesForWrap(line: string, width: number): { indent: string; body: string } {
	let indentLength = 0;
	while (indentLength < line.length && line.charCodeAt(indentLength) === 32) {
		indentLength += 1;
	}
	const maxIndentLength = Math.max(0, width - 1);
	const clampedIndentLength = Math.min(indentLength, maxIndentLength);
	return {
		indent: line.slice(0, clampedIndentLength),
		body: line.slice(indentLength),
	};
}

/** One row fed to {@link OutlinedList} or the plain list container. `highlight`
 *  causes the row (and its wrapped continuations, plus trailing padding) to be
 *  painted with the theme's `selectedBg` band — the focus cue that survives
 *  themes where `accent` fg is close to the terminal foreground. */
type SelectorRow = { text: string; highlight: boolean };

/** Paint `content` with the `selectedBg` background, applied AFTER any inner
 *  ANSI styling so the band spans padding as well as content. */
function paintSelectedRow(content: string): string {
	return theme.bg("selectedBg", content);
}

class OutlinedList extends Container {
	#rows: SelectorRow[] = [];

	setLines(rows: readonly SelectorRow[]): void {
		this.#rows = rows.slice();
		this.invalidate();
	}

	override render(width: number): readonly string[] {
		const borderColor = (text: string) => theme.fg("border", text);
		const horizontal = borderColor(theme.boxRound.horizontal.repeat(Math.max(1, width)));
		const innerWidth = Math.max(1, width - 2);
		const content: string[] = [];
		for (const row of this.#rows) {
			const normalized = replaceTabs(row.text);
			const { indent, body } = splitLeadingSpacesForWrap(normalized, innerWidth);
			const wrapped = wrapTextWithAnsi(body, Math.max(1, innerWidth - visibleWidth(indent)));
			for (const wrappedBody of wrapped.length > 0 ? wrapped : [""]) {
				const wrappedLine = `${indent}${wrappedBody}`;
				const pad = Math.max(0, innerWidth - visibleWidth(wrappedLine));
				const filled = `${wrappedLine}${padding(pad)}`;
				const painted = row.highlight ? paintSelectedRow(filled) : filled;
				content.push(`${borderColor(theme.boxRound.vertical)}${painted}${borderColor(theme.boxRound.vertical)}`);
			}
		}
		return [horizontal, ...content, horizontal];
	}
}

/** A filtered option paired with its index into the original options array, so
 *  disabled-index lookups survive fuzzy filtering and reordering. */
type FilteredOption = { option: HookSelectorOption; index: number };

/** Plain text of an extension-supplied inline-markdown string: markers rendered away, no ANSI. */
function plainInline(source: string, mdTheme: MarkdownTheme): string {
	return plainText(renderInlineMarkdown(source, mdTheme));
}

const ENTER_KEYS: readonly KeyName[] = ["enter"];

interface HookSelectorNativeMemo {
	items: readonly FilteredOption[];
	selected: string | undefined;
	query: string;
	slider: number;
	countdown: NativeNode | undefined;
	node: NativeNode;
}

export class HookSelectorComponent extends OverlayPanel {
	#options: HookSelectorOption[];
	#menu: MenuSelection<FilteredOption>;
	/** The type-to-search field; its value drives `#menu`'s query. */
	#search = Object.assign(new Input(), { prompt: "" });
	#disabledIndices: Set<number>;
	#selectionMarker: "radio" | "checkbox" | undefined;
	#checkedIndices: Set<number>;
	#markableCount: number;
	#maxVisible: number;
	#listContainer: Container | undefined;
	#outlinedList: OutlinedList | undefined;
	#onSelectCallback: (option: string) => void;
	#onCancelCallback: () => void;
	#baseTitle: string;
	#countdown: CountdownTimer | undefined;
	#onLeftCallback: (() => void) | undefined;
	#onRightCallback: (() => void) | undefined;
	#onExternalEditorCallback: (() => void) | undefined;
	#onTimeoutResetCallback: (() => void) | undefined;
	#slider: HookSelectorSlider | undefined;
	#sliderIndex: number = 0;
	#sliderComponent: Text | undefined;
	#lastRenderWidth: number | undefined;
	readonly #detailLines: readonly string[];
	readonly #inline: boolean;
	readonly #helpText: string | undefined;
	/** Described option rows by original index; `marker` is the radio state baked into the label. */
	readonly #nativeItems = new Map<number, { marker: boolean; node: NativeNode }>();
	/** Title/detail/hint nodes, fixed for the dialog's lifetime. */
	#nativeStatic: { title: string; detail: NativeNode | undefined; hints: NativeNode } | undefined;
	#nativeMemo: HookSelectorNativeMemo | undefined;
	/** Every option as a picker row, by original index (built once; filtering only changes `order`). */
	#pickerItems: readonly TspPickerItem[] | undefined;
	#pickerMemo:
		| {
				items: readonly FilteredOption[];
				selected: string | undefined;
				query: string;
				cursor: number;
				node: NativeNode;
		  }
		| undefined;
	constructor(
		title: string,
		options: HookSelectorOptionInput[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: HookSelectorOptions,
	) {
		super(title.split(/\r?\n/, 1)[0] ?? "", "omp.overlay.hook-select");

		this.#options = options.map(normalizeHookSelectorOption);
		this.#disabledIndices = new Set(
			(opts?.disabledIndices ?? []).filter(
				index => Number.isInteger(index) && index >= 0 && index < this.#options.length,
			),
		);
		this.#menu = new MenuSelection<FilteredOption>(
			this.#options.map((option, index) => ({ option, index })),
			{
				getKey: filtered => String(filtered.index),
				getSearchText: filtered => `${filtered.option.label} ${filtered.option.description ?? ""}`,
				isDisabled: filtered => this.#disabledIndices.has(filtered.index),
			},
		);
		this.#menu.setSelectedIndex(opts?.initialIndex ?? 0);
		this.#selectionMarker = opts?.selectionMarker;
		this.#checkedIndices = new Set(
			(opts?.checkedIndices ?? []).filter(
				index => Number.isInteger(index) && index >= 0 && index < this.#options.length,
			),
		);
		this.#markableCount = Math.max(0, Math.min(opts?.markableCount ?? this.#options.length, this.#options.length));
		this.#maxVisible = Math.max(3, opts?.maxVisible ?? 12);
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#baseTitle = this.title;
		this.#detailLines = title.split(/\r?\n/).slice(1);
		this.#helpText = opts?.helpText;
		this.#inline = opts?.inline ?? false;
		this.#onLeftCallback = opts?.onLeft;
		this.#onRightCallback = opts?.onRight;
		this.#onExternalEditorCallback = opts?.onExternalEditor;
		this.#onTimeoutResetCallback = opts?.onTimeoutReset;
		if (opts?.slider && opts.slider.segments.length > 0) {
			this.#slider = opts.slider;
			this.#sliderIndex = Math.max(0, Math.min(opts.slider.index, opts.slider.segments.length - 1));
		}

		this.addChild(new Spacer(1));
		for (const line of title.split(/\r?\n/).slice(1)) {
			this.addChild(new Text(theme.fg("accent", line), 0, 0));
		}
		this.addChild(new Spacer(1));

		if (this.#slider) {
			this.#sliderComponent = new Text(this.#renderSliderLine(), 0, 0);
			this.addChild(this.#sliderComponent);
			this.addChild(new Spacer(1));
		}

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			opts.onTimeoutStart?.();
			this.#countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				s => (this.title = `${this.#baseTitle} (${s}s)`),
				() => {
					opts?.onTimeout?.();
					// Auto-select current option on timeout (typically the first/recommended option)
					const selected = this.#menu.selectedItem;
					if (selected && !this.#menu.isDisabled(selected)) {
						this.#onSelectCallback(selected.option.label);
					} else {
						this.#onCancelCallback();
					}
				},
			);
		}

		if (opts?.outline) {
			this.#outlinedList = new OutlinedList();
			this.addChild(this.#outlinedList);
		} else {
			this.#listContainer = new Container();
			this.addChild(this.#listContainer);
		}
		this.addChild(new Spacer(1));
		const controlsHint =
			opts?.helpText ??
			`${editorKeys("tui.select.up", "tui.select.down")} navigate  ${formatKeyHint("enter")} select  ${editorKey("tui.select.cancel")} cancel`;
		this.addChild(new Text(theme.fg("dim", controlsHint), 0, 0));
		this.addChild(new Spacer(1));

		this.#updateList();
	}

	#isDisabled(index: number): boolean {
		return this.#disabledIndices.has(index);
	}

	/** Move the cursor by `delta`, skipping disabled rows, stopping at the first
	 *  enabled option reached or at the list edge. */
	#moveSelection(delta: number): void {
		if (this.#menu.move(delta, false)) {
			this.#updateList();
		}
	}

	#renderOptionLines(
		option: HookSelectorOption,
		isSelected: boolean,
		isDisabled: boolean,
		mdTheme: MarkdownTheme,
		descRows: number | "full",
		renderWidth?: number,
		index?: number,
	): string[] {
		const textColor = isDisabled ? "dim" : isSelected ? "accent" : "text";
		const prefixColor = isDisabled ? "dim" : "accent";
		const label = renderInlineMarkdown(option.label, mdTheme, t => theme.fg(textColor, t));
		const marker = index !== undefined ? this.#renderMarkerPrefix(index, isSelected, isDisabled) : undefined;
		const prefix = marker ?? (isSelected ? theme.fg(prefixColor, `${theme.nav.cursor} `) : "  ");
		const lines = [prefix + label];
		if (option.description && descRows !== 0) {
			const descriptionColor: ThemeColor = isDisabled ? "dim" : "muted";
			if (descRows === "full") {
				const description = renderInlineMarkdown(option.description, mdTheme, t => theme.fg(descriptionColor, t));
				lines.push(`    ${description}`);
			} else {
				lines.push(
					...this.#wrapDescriptionRows(option.description, descRows, descriptionColor, mdTheme, renderWidth),
				);
			}
		}
		return lines;
	}

	/** Styled leading marker (`"<glyph> "`) for a markable option row, or
	 *  `undefined` when no marker applies (control rows beyond `markableCount`,
	 *  or when {@link selectionMarker} is unset) so the caller falls back to the
	 *  classic cursor prefix. Radio fills on the cursor row; checkbox reflects
	 *  the per-row checked state, with the cursor row drawn in accent. */
	#renderMarkerPrefix(index: number, isSelected: boolean, isDisabled: boolean): string | undefined {
		if (this.#selectionMarker === undefined || index >= this.#markableCount) return undefined;
		if (this.#selectionMarker === "radio") {
			const glyph = isSelected ? theme.radio.selected : theme.radio.unselected;
			const color = isDisabled ? "dim" : isSelected ? "accent" : "dim";
			return theme.fg(color, `${glyph} `);
		}
		const checked = this.#checkedIndices.has(index);
		const glyph = checked ? theme.checkbox.checked : theme.checkbox.unchecked;
		const color = isDisabled ? "dim" : isSelected ? "accent" : checked ? "success" : "dim";
		return theme.fg(color, `${glyph} `);
	}

	/** Wrap an option description into indented rows, truncating to `maxRows`
	 *  with an ellipsis. Pre-wrapping (rather than emitting one long line that the
	 *  list re-wraps) lets compact mode bound how much of the highlighted option's
	 *  detail is shown, so every option label stays on screen on short terminals. */
	#wrapDescriptionRows(
		description: string,
		maxRows: number,
		color: ThemeColor,
		mdTheme: MarkdownTheme,
		renderWidth = this.#lastRenderWidth,
	): string[] {
		if (maxRows <= 0) return [];
		const indent = "    ";
		const innerWidth = Math.max(1, (renderWidth ?? 80) - 2);
		const bodyWidth = Math.max(1, innerWidth - indent.length);
		const colored = renderInlineMarkdown(description, mdTheme, t => theme.fg(color, t));
		const wrapped = wrapTextWithAnsi(colored, bodyWidth);
		if (wrapped.length <= maxRows) return wrapped.map(row => indent + row);
		const kept = wrapped.slice(0, maxRows);
		kept[maxRows - 1] = truncateToWidth(wrapped.slice(maxRows - 1).join(" "), bodyWidth, Ellipsis.Unicode);
		return kept.map(row => indent + row);
	}

	#renderedLineRowCount(line: string, renderWidth: number): number {
		const normalized = replaceTabs(line);
		if (this.#outlinedList) {
			const innerWidth = Math.max(1, renderWidth - 2);
			const { indent, body } = splitLeadingSpacesForWrap(normalized, innerWidth);
			const wrapped = wrapTextWithAnsi(body, Math.max(1, innerWidth - visibleWidth(indent)));
			return Math.max(1, wrapped.length);
		}
		const wrapped = wrapTextWithAnsi(normalized, Math.max(1, renderWidth - 2));
		return Math.max(1, wrapped.length);
	}

	#optionRowCount(
		option: HookSelectorOption,
		renderWidth: number | undefined,
		isSelected: boolean,
		mdTheme: MarkdownTheme,
		descRows: number | "full",
	): number {
		if (renderWidth === undefined) return option.description && descRows !== 0 ? 2 : 1;
		let rows = 0;
		for (const line of this.#renderOptionLines(option, isSelected, false, mdTheme, descRows, renderWidth)) {
			rows += this.#renderedLineRowCount(line, renderWidth);
		}
		return rows;
	}

	#totalOptionRows(options: HookSelectorOption[], renderWidth?: number, mdTheme?: MarkdownTheme): number {
		const themeForRows = mdTheme ?? getMarkdownTheme();
		let rows = 0;
		for (const option of options) {
			rows += this.#optionRowCount(option, renderWidth, false, themeForRows, "full");
		}
		return rows;
	}

	/**
	 * Visual row budget for the option window. In compact mode every option
	 * contributes only its label rows; the highlighted option's description is
	 * layered on afterwards (see #updateList), so the window is sized to keep
	 * as many labels visible as possible rather than letting one long
	 * description swallow the budget.
	 */
	#windowRowCounts(
		items: readonly FilteredOption[],
		renderWidth: number | undefined,
		mdTheme: MarkdownTheme,
		compact: boolean,
	): number[] {
		const descMode: number | "full" = compact ? 0 : "full";
		return items.map((filtered, i) =>
			this.#optionRowCount(filtered.option, renderWidth, i === this.#menu.selectedIndex, mdTheme, descMode),
		);
	}

	#updateList(renderWidth = this.#lastRenderWidth): void {
		const rows: SelectorRow[] = [];
		const items = this.#menu.visibleItems;
		const total = items.length;
		const mdTheme = getMarkdownTheme();
		// Compact mode kicks in exactly when the fully-expanded list (all
		// descriptions) would overflow the row budget — the same condition that
		// enables search. There we collapse every option to its label and show
		// only the highlighted option's description, so the whole menu stays
		// visible on short terminals instead of collapsing to a single entry.
		const compact = this.#isSearchEnabled(renderWidth, mdTheme);
		const { startIndex, endIndex } =
			total === 0
				? { startIndex: 0, endIndex: 0 }
				: getMenuWindow(
						this.#windowRowCounts(items, renderWidth, mdTheme, compact),
						this.#menu.selectedIndex,
						Math.max(1, this.#maxVisible),
					);

		let selectedDescRows = 0;
		if (compact && renderWidth !== undefined) {
			let labelRows = 0;
			for (let i = startIndex; i < endIndex; i++) {
				const filtered = items[i];
				if (filtered === undefined) continue;
				labelRows += this.#optionRowCount(filtered.option, renderWidth, i === this.#menu.selectedIndex, mdTheme, 0);
			}
			// Reserve one row for the status line; give the remainder to the
			// highlighted option's description.
			selectedDescRows = Math.max(0, Math.max(1, this.#maxVisible) - labelRows - 1);
		}

		for (let i = startIndex; i < endIndex; i++) {
			const filtered = items[i];
			if (filtered === undefined) continue;
			const isSelected = i === this.#menu.selectedIndex;
			const isDisabled = this.#isDisabled(filtered.index);
			const descMode: number | "full" = compact ? (isSelected ? selectedDescRows : 0) : "full";
			// Highlight the whole option block (label + wrapped description rows)
			// so the focus band reads as one continuous bar rather than a stripe
			// under the label alone. Disabled rows never claim focus even if the
			// index momentarily lands on one during initial coercion.
			const highlight = isSelected && !isDisabled;
			for (const text of this.#renderOptionLines(
				filtered.option,
				isSelected,
				isDisabled,
				mdTheme,
				descMode,
				renderWidth,
				filtered.index,
			)) {
				rows.push({ text, highlight });
			}
		}

		if (total === 0) {
			rows.push({ text: theme.fg("dim", "  No matching options"), highlight: false });
		}

		if (startIndex > 0 || endIndex < total || this.#shouldRenderSearchStatus(renderWidth, mdTheme)) {
			rows.push({ text: this.#renderStatusLine(total), highlight: false });
		}
		if (this.#outlinedList) {
			this.#outlinedList.setLines(rows);
			return;
		}
		this.#listContainer?.clear();
		for (const row of rows) {
			const bgFn = row.highlight ? paintSelectedRow : undefined;
			this.#listContainer?.addChild(new Text(row.text, 1, 0, bgFn));
		}
	}

	/** Render the slider block in the style of the status line: each option is a
	 *  distinctly colored segment, the active one filled as a powerline chip
	 *  (its accent as the background, a luminance-matched label, flanked by
	 *  triangle caps) and the rest shown as plain colored labels joined by a thin
	 *  separator. Edge arrows brighten while there is room to move. When the
	 *  active segment carries a `detail` (e.g. the resolved model name) a muted
	 *  second line is appended. Returns one or two `\n`-joined lines. */
	#renderSliderLine(): string {
		const slider = this.#slider;
		if (!slider) return "";
		const segments = slider.segments;
		const active = this.#sliderIndex;
		const track = renderSegmentTrack(segments, active);

		const leftArrow = theme.fg(active > 0 ? "accent" : "dim", "◂");
		const rightArrow = theme.fg(active < segments.length - 1 ? "accent" : "dim", "▸");
		const caption = slider.caption ? `${theme.fg("dim", slider.caption)}  ` : "";
		const trackLine = `${caption}${leftArrow}  ${track}  ${rightArrow}`;
		const detail = segments[active]?.detail;
		if (!detail) return trackLine;
		return `${trackLine}\n  ${theme.fg("dim", "↳")} ${theme.fg("muted", detail)}`;
	}

	/** Move the slider by `delta`, clamped to the segment range, refresh the
	 *  rendered track, and notify the caller only when the index actually moves. */
	#moveSlider(delta: number): void {
		const slider = this.#slider;
		if (!slider) return;
		const next = Math.max(0, Math.min(slider.segments.length - 1, this.#sliderIndex + delta));
		if (next === this.#sliderIndex) return;
		this.#sliderIndex = next;
		this.#sliderComponent?.setText(this.#renderSliderLine());
		slider.onChange?.(next);
	}

	#isSearchEnabled(renderWidth = this.#lastRenderWidth, mdTheme?: MarkdownTheme): boolean {
		return this.#totalOptionRows(this.#options, renderWidth, mdTheme) > this.#maxVisible;
	}

	#shouldRenderSearchStatus(renderWidth = this.#lastRenderWidth, mdTheme?: MarkdownTheme): boolean {
		return this.#isSearchEnabled(renderWidth, mdTheme) || this.#menu.query.length > 0;
	}

	#renderStatusLine(total: number): string {
		const selectedCount = total === 0 ? 0 : this.#menu.selectedIndex + 1;
		const count =
			this.#menu.query.trim() && total !== this.#options.length
				? `${selectedCount}/${total} of ${this.#options.length}`
				: `${selectedCount}/${total}`;
		if (!this.#menu.query.trim()) return theme.fg("dim", `  (${count})  Type to search`);
		const field = this.#search.render(visibleWidth(this.#search.getValue()) + 1)[0] ?? "";
		return `${theme.fg("dim", `  (${count})  Search: `)}${field}`;
	}

	/** Applies the search field's value to the filter. */
	#syncSearchQuery(): void {
		this.#menu.setQuery(this.#search.getValue(), false);
		this.#updateList();
	}

	/** Feeds keys the selector does not bind to the search field. Backspace on an empty query and a leading space bubble. */
	#handleSearchInput(keyData: string): boolean {
		if (!this.#isSearchEnabled()) return false;
		const before = this.#search.getValue();
		if (before.length === 0) {
			if (matchesKey(keyData, "backspace")) return false;
			const printableText = extractPrintableText(keyData);
			if (printableText !== undefined && printableText.trim().length === 0) return false;
		}
		const cursorBefore = this.#search.getCursor();
		if (!this.#search.handleInput(keyData)) return false;
		if (this.#search.getValue() !== before) this.#syncSearchQuery();
		else if (this.#search.getCursor() !== cursorBefore) this.#updateList();
		return true;
	}

	/** Jump to (and, for single-select menus, immediately confirm) the option
	 *  whose label starts with the pressed digit and a period. Numbered options
	 *  can follow unnumbered rows, as in `/review` after a detected PR. Once
	 *  type-to-search is active, digits stay searchable. Checkbox menus only
	 *  move the cursor — confirmation stays on `enter`. */
	#handleQuickSelect(keyData: string): boolean {
		if (this.#menu.query.length > 0 || keyData.length !== 1 || keyData < "1" || keyData > "9") return false;
		const targetIndex = this.#menu.visibleItems.findIndex(({ option }) => option.label.startsWith(`${keyData}. `));
		if (targetIndex < 0) return false;
		const target = this.#menu.visibleItems[targetIndex];
		if (!target || this.#isDisabled(target.index)) return true;
		this.#menu.setSelectedIndex(targetIndex);
		this.#updateList();
		if (this.#selectionMarker !== "checkbox") this.#onSelectCallback(target.option.label);
		return true;
	}

	handleInput(keyData: string): void {
		if (this.#countdown) {
			this.#countdown.reset();
			this.#onTimeoutResetCallback?.();
		}

		if (matchesSelectCancel(keyData)) {
			this.#onCancelCallback();
			return;
		}

		if (this.#handleQuickSelect(keyData)) {
			return;
		}

		if (matchesSelectUp(keyData) || (!this.#isSearchEnabled() && matchesKey(keyData, "k"))) {
			this.#moveSelection(-1);
		} else if (matchesSelectDown(keyData) || (!this.#isSearchEnabled() && matchesKey(keyData, "j"))) {
			this.#moveSelection(1);
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#menu.selectedItem;
			if (selected && !this.#menu.isDisabled(selected)) this.#onSelectCallback(selected.option.label);
		} else if (
			matchesKey(keyData, "left") ||
			(this.#slider && !this.#isSearchEnabled() && matchesKey(keyData, "h"))
		) {
			if (this.#slider) this.#moveSlider(-1);
			else this.#onLeftCallback?.();
		} else if (
			matchesKey(keyData, "right") ||
			(this.#slider && !this.#isSearchEnabled() && matchesKey(keyData, "l"))
		) {
			if (this.#slider) this.#moveSlider(1);
			else this.#onRightCallback?.();
		} else if (this.#onExternalEditorCallback && matchesAppExternalEditor(keyData)) {
			this.#onExternalEditorCallback();
		} else {
			this.#handleSearchInput(keyData);
		}
	}

	override render(width: number): readonly string[] {
		const renderWidth = Math.max(1, width - 4);
		if (this.#lastRenderWidth !== renderWidth) {
			this.#lastRenderWidth = renderWidth;
			this.#updateList(renderWidth);
		}
		return super.render(width);
	}

	override dispose(): void {
		this.#countdown?.dispose();
	}

	/** The options as a `picker md` sheet: every option by original index, filtering sends only `order`. */
	#describePicker(): NativeNode {
		const items = this.#menu.visibleItems;
		const selected = this.#menu.selectedKey;
		const query = this.#menu.query;
		const cursor = this.#search.getCursor();
		const memo = this.#pickerMemo;
		if (
			memo &&
			memo.items === items &&
			memo.selected === selected &&
			memo.query === query &&
			memo.cursor === cursor
		) {
			return memo.node;
		}
		const mdTheme = getMarkdownTheme();
		const fixed = this.#describeStatic(mdTheme);
		this.#pickerItems ??= this.#options.map((option, index) => ({
			id: String(index),
			label: plainInline(option.label, mdTheme),
			...(option.description ? { detail: plainInline(option.description, mdTheme) } : {}),
			...(this.#isDisabled(index) ? { disabled: true as const } : {}),
		}));
		const checkbox = this.#selectionMarker === "checkbox";
		const result = dockedPicker({
			title: fixed.title,
			...(this.#detailLines.length > 0 ? { subtitle: plainText(this.#detailLines.join("\n")) } : {}),
			noun: "options",
			size: "md",
			layout: "rows",
			preview: "none",
			...pickerQuery(this.#isSearchEnabled() || query.length > 0 ? this.#search : null),
			items: this.#pickerItems,
			...(query.length > 0 ? { order: items.map(filtered => String(filtered.index)) } : {}),
			selected: selected ?? null,
			...(checkbox ? { current: [...this.#checkedIndices].map(String) } : {}),
			total: this.#options.length,
			empty: "No matching options",
			actions: [pickerAction("confirm", "Select", "enter", { primary: true }), CLOSE_ACTION],
		});
		this.#pickerMemo = { items, selected, query, cursor, node: result };
		return result;
	}

	/**
	 * A plain option list is a picker sheet. Otherwise (inline, slider, or
	 * countdown) a card headed by the title (plus the countdown `elapsed` when a
	 * timeout runs), the extra title lines, the slider as `tabs`, the options as
	 * a `list` keyed by original option index, the search query while typing,
	 * and the key hints.
	 */
	override describe(cx: DescribeContext): NativeNode {
		if (cx.supports("picker") && !this.#inline && !this.#slider && !this.#countdown) return this.#describePicker();
		const items = this.#menu.visibleItems;
		const selected = this.#menu.selectedKey;
		const query = this.#menu.query;
		const countdown = this.#countdown?.describe();
		const memo = this.#nativeMemo;
		if (
			memo &&
			memo.items === items &&
			memo.selected === selected &&
			memo.query === query &&
			memo.slider === this.#sliderIndex &&
			memo.countdown === countdown
		) {
			return memo.node;
		}

		const mdTheme = getMarkdownTheme();
		const fixed = this.#describeStatic(mdTheme);
		const children: NativeChild[] = [];
		if (countdown) {
			children.push(
				node("row", { gap: "sm", align: "baseline" }, [node("text", { text: fixed.title }), countdown], "head"),
			);
		}
		if (fixed.detail) children.push(fixed.detail);
		if (this.#slider) children.push(...this.#describeSlider(this.#slider));

		const selectedItem = this.#menu.selectedItem;
		const rows: NativeNode[] = [];
		for (const filtered of items) {
			rows.push(this.#describeOption(filtered, filtered === selectedItem, mdTheme));
		}
		children.push(
			node(
				"list",
				{
					selected: selectedItem && !this.#menu.isDisabled(selectedItem) ? (selected ?? null) : null,
					filter: query.trim() || undefined,
					empty: "No matching options",
					max: { lines: this.#maxVisible },
				},
				rows,
				"list",
			),
		);
		if (query) {
			children.push(
				node("text", { spans: [span("Search: ", "dim"), span(query)], wrap: "none" }, undefined, "search"),
			);
		}
		children.push(fixed.hints);

		const root = overlayCard(this.nativeRole, countdown ? undefined : fixed.title, children);
		this.#nativeMemo = { items, selected, query, slider: this.#sliderIndex, countdown, node: root };
		return root;
	}

	/** Pointer pick of an option does what highlighting it and pressing Enter does; a tab pick moves the slider. */
	handleNativeEvent(event: NativeUiEvent): void {
		const ev = pickerEvent(event, PICKER_KEY);
		if (ev?.kind === "action") {
			this.#resetCountdown();
			if (ev.act === "close" || ev.act === "cancel") this.#onCancelCallback();
			else if (ev.act === "clear") {
				this.#search.setValue("");
				this.#syncSearchQuery();
			} else if (ev.act === "confirm") {
				const selected = this.#menu.selectedItem;
				if (selected && !this.#menu.isDisabled(selected)) this.#onSelectCallback(selected.option.label);
			}
			return;
		}
		if (ev?.kind === "select") {
			const index = this.#menu.visibleItems.findIndex(filtered => String(filtered.index) === ev.item);
			const target = this.#menu.visibleItems[index];
			if (!target || this.#menu.isDisabled(target)) return;
			this.#resetCountdown();
			this.#menu.setSelectedIndex(index);
			this.#updateList();
			return;
		}
		if (event.type !== "select" && event.type !== "activate") return;
		if (event.key === "slider") {
			const target = Number(event.item);
			if (!Number.isInteger(target)) return;
			this.#resetCountdown();
			this.#moveSlider(target - this.#sliderIndex);
			return;
		}
		if (event.key !== "list" && ev?.kind !== "activate") return;
		const index = this.#menu.visibleItems.findIndex(filtered => String(filtered.index) === event.item);
		const target = this.#menu.visibleItems[index];
		if (!target || this.#menu.isDisabled(target)) return;
		this.#resetCountdown();
		this.#menu.setSelectedIndex(index);
		this.#updateList();
		this.#onSelectCallback(target.option.label);
	}

	#resetCountdown(): void {
		if (!this.#countdown) return;
		this.#countdown.reset();
		this.#onTimeoutResetCallback?.();
	}

	#describeStatic(mdTheme: MarkdownTheme): { title: string; detail: NativeNode | undefined; hints: NativeNode } {
		if (this.#nativeStatic) return this.#nativeStatic;
		const detail =
			this.#detailLines.length > 0
				? node(
						"text",
						{ spans: [span(plainText(this.#detailLines.join("\n")), "accent")], wrap: "word" },
						undefined,
						"detail",
					)
				: undefined;
		const hints =
			this.#helpText !== undefined
				? node("text", { spans: [span(plainText(this.#helpText), "dim")], wrap: "word" }, undefined, "hints")
				: hintsRow([
						actionHint(["tui.select.up", "tui.select.down"], "navigate"),
						{ keys: ENTER_KEYS, label: "select" },
						actionHint("tui.select.cancel", "cancel"),
					]);
		this.#nativeStatic = { title: plainInline(this.#baseTitle, mdTheme), detail, hints };
		return this.#nativeStatic;
	}

	/** Caption, a `tabs` strip of the segments (active = slider index), and the active segment's detail. */
	#describeSlider(slider: HookSelectorSlider): NativeNode[] {
		const out: NativeNode[] = [];
		if (slider.caption) {
			out.push(node("text", { spans: [span(plainText(slider.caption), "dim")] }, undefined, "slider-caption"));
		}
		out.push(
			node(
				"tabs",
				{
					items: slider.segments.map((segment, i) => ({ id: String(i), label: plainText(segment.label) })),
					active: String(this.#sliderIndex),
				},
				undefined,
				"slider",
			),
		);
		const detail = slider.segments[this.#sliderIndex]?.detail;
		if (detail) {
			out.push(
				node(
					"text",
					{ spans: [span("↳ ", "dim"), span(plainText(detail), "muted")], wrap: "word" },
					undefined,
					"slider-detail",
				),
			);
		}
		return out;
	}

	/** One option `item`; radio rows re-describe only when their filled state flips. */
	#describeOption(filtered: FilteredOption, isSelected: boolean, mdTheme: MarkdownTheme): NativeNode {
		const { option, index } = filtered;
		const radio = this.#selectionMarker === "radio" && index < this.#markableCount;
		const marker = radio && isSelected;
		const cached = this.#nativeItems.get(index);
		if (cached && cached.marker === marker) return cached.node;

		const disabled = this.#isDisabled(index);
		const label = plainInline(option.label, mdTheme);
		let glyph: string | undefined;
		let glyphColor = "dim";
		if (radio) {
			glyph = marker ? theme.radio.selected : theme.radio.unselected;
			if (marker && !disabled) glyphColor = "accent";
		} else if (this.#selectionMarker === "checkbox" && index < this.#markableCount) {
			const checked = this.#checkedIndices.has(index);
			glyph = checked ? theme.checkbox.checked : theme.checkbox.unchecked;
			if (checked && !disabled) glyphColor = "success";
		}
		const described = node(
			"item",
			{
				label: glyph ? [span(`${glyph} `, glyphColor), span(label)] : [span(label)],
				detail: option.description ? [span(plainInline(option.description, mdTheme), "muted")] : undefined,
				disabled: disabled || undefined,
			},
			undefined,
			String(index),
		);
		this.#nativeItems.set(index, { marker, node: described });
		return described;
	}
}
