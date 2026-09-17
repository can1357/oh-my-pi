/**
 * Generic selector component for hooks.
 * Displays a list of string options with keyboard navigation.
 */
import {
	Container,
	Ellipsis,
	extractPrintableText,
	fuzzyFilter,
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
} from "@oh-my-pi/pi-tui";
import { getMarkdownTheme, type ThemeColor, theme } from "../../modes/theme/theme";
import {
	matchesAppExternalEditor,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectUp,
} from "../../modes/utils/keybinding-matchers";
import { CountdownTimer } from "./countdown-timer";
import { OverlayPanel } from "./overlay-box";
import { renderSegmentTrack } from "./segment-track";

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
}

export interface HookSelectorOption {
	label: string;
	description?: string;
	/** Exact substring of `label` painted in the success color by the TUI
	 *  renderer (e.g. the tool name in the session-approval menu). */
	labelHighlight?: string;
}

export type HookSelectorOptionInput = string | HookSelectorOption;

function normalizeHookSelectorOption(option: HookSelectorOptionInput): HookSelectorOption {
	if (typeof option === "string") return { label: option };
	const normalized: HookSelectorOption = option.description?.trim()
		? { label: option.label, description: option.description.trim() }
		: { label: option.label };
	const highlight = option.labelHighlight?.trim();
	if (highlight && option.label.includes(highlight)) {
		normalized.labelHighlight = highlight;
	}
	return normalized;
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

export class HookSelectorComponent extends OverlayPanel {
	#options: HookSelectorOption[];
	#filteredOptions: FilteredOption[];
	#searchQuery = "";
	#selectedIndex: number;
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
	constructor(
		title: string,
		options: HookSelectorOptionInput[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: HookSelectorOptions,
	) {
		super(title.split(/\r?\n/, 1)[0] ?? "");

		this.#options = options.map(normalizeHookSelectorOption);
		this.#filteredOptions = this.#options.map((option, index) => ({ option, index }));
		this.#disabledIndices = new Set(
			(opts?.disabledIndices ?? []).filter(
				index => Number.isInteger(index) && index >= 0 && index < this.#options.length,
			),
		);
		this.#selectionMarker = opts?.selectionMarker;
		this.#checkedIndices = new Set(
			(opts?.checkedIndices ?? []).filter(
				index => Number.isInteger(index) && index >= 0 && index < this.#options.length,
			),
		);
		this.#markableCount = Math.max(0, Math.min(opts?.markableCount ?? this.#options.length, this.#options.length));
		this.#selectedIndex = this.#coerceSelectedIndex(opts?.initialIndex ?? 0);
		this.#maxVisible = Math.max(3, opts?.maxVisible ?? 12);
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#baseTitle = this.title;
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
					const selected = this.#filteredOptions[this.#selectedIndex];
					if (selected && !this.#isDisabled(selected.index)) {
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
		const controlsHint = opts?.helpText ?? "up/down navigate  enter select  esc cancel";
		this.addChild(new Text(theme.fg("dim", controlsHint), 0, 0));
		this.addChild(new Spacer(1));

		this.#updateList();
	}

	#isDisabled(index: number): boolean {
		return this.#disabledIndices.has(index);
	}

	/** Clamp `index` into range, then walk forward (and finally backward) to the
	 *  nearest enabled option so the cursor never lands on a disabled row. */
	#coerceSelectedIndex(index: number): number {
		if (this.#filteredOptions.length === 0) return -1;
		const maxIndex = this.#filteredOptions.length - 1;
		const clamped = Math.max(0, Math.min(index, maxIndex));
		const clampedOption = this.#filteredOptions[clamped];
		if (clampedOption && !this.#isDisabled(clampedOption.index)) return clamped;
		for (let i = clamped + 1; i <= maxIndex; i++) {
			const option = this.#filteredOptions[i];
			if (option && !this.#isDisabled(option.index)) return i;
		}
		for (let i = clamped - 1; i >= 0; i--) {
			const option = this.#filteredOptions[i];
			if (option && !this.#isDisabled(option.index)) return i;
		}
		return clamped;
	}

	/** Move the cursor by `delta`, skipping disabled rows, stopping at the first
	 *  enabled option reached or at the list edge. */
	#moveSelection(delta: number): void {
		if (this.#filteredOptions.length === 0) return;
		const maxIndex = this.#filteredOptions.length - 1;
		let index = this.#selectedIndex;
		while (true) {
			const next = Math.max(0, Math.min(index + delta, maxIndex));
			if (next === index) return;
			index = next;
			const option = this.#filteredOptions[index];
			if (option && !this.#isDisabled(option.index)) {
				this.#selectedIndex = index;
				this.#updateList();
				return;
			}
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
		const label = this.#renderLabel(option, textColor, isDisabled, mdTheme);
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

	/** Render an option label, painting `labelHighlight` (validated at
	 *  normalization: non-empty exact substring of the label) in the success
	 *  color — e.g. the tool name in the session-approval menu — while the rest
	 *  keeps `base`. Disabled rows stay uniformly dim, like the marker prefix. */
	#renderLabel(option: HookSelectorOption, base: ThemeColor, isDisabled: boolean, mdTheme: MarkdownTheme): string {
		const highlight = option.labelHighlight;
		if (!highlight) {
			return renderInlineMarkdown(option.label, mdTheme, t => theme.fg(base, t));
		}
		const highlightColor: ThemeColor = isDisabled ? "dim" : "success";
		const parts = option.label.split(highlight);
		let rendered = renderInlineMarkdown(parts[0] ?? "", mdTheme, t => theme.fg(base, t));
		for (let i = 1; i < parts.length; i++) {
			rendered += renderInlineMarkdown(highlight, mdTheme, t => theme.fg(highlightColor, t));
			rendered += renderInlineMarkdown(parts[i] ?? "", mdTheme, t => theme.fg(base, t));
		}
		return rendered;
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

	#getVisibleOptionRange(
		total: number,
		renderWidth?: number,
		mdTheme: MarkdownTheme = getMarkdownTheme(),
		compact = false,
	): { startIndex: number; endIndex: number } {
		if (total === 0) return { startIndex: 0, endIndex: 0 };

		// In compact mode every option contributes only its label rows; the
		// highlighted option's description is layered on afterwards (see
		// #updateList), so the window is sized to keep as many labels visible as
		// possible rather than letting one long description swallow the budget.
		const descMode: number | "full" = compact ? 0 : "full";
		const rowBudget = Math.max(1, this.#maxVisible);
		const selectedIndex = Math.max(0, Math.min(this.#selectedIndex, total - 1));
		let startIndex = selectedIndex;
		let endIndex = selectedIndex + 1;
		let rows = this.#optionRowCount(
			this.#filteredOptions[selectedIndex]!.option,
			renderWidth,
			true,
			mdTheme,
			descMode,
		);
		let beforeRows = 0;
		const targetBeforeRows = Math.max(0, Math.floor((rowBudget - rows) / 2));

		while (startIndex > 0) {
			const cost = this.#optionRowCount(
				this.#filteredOptions[startIndex - 1]!.option,
				renderWidth,
				false,
				mdTheme,
				descMode,
			);
			if (beforeRows + cost > targetBeforeRows || rows + cost > rowBudget) break;
			startIndex--;
			beforeRows += cost;
			rows += cost;
		}

		while (endIndex < total) {
			const cost = this.#optionRowCount(
				this.#filteredOptions[endIndex]!.option,
				renderWidth,
				false,
				mdTheme,
				descMode,
			);
			if (rows + cost > rowBudget) break;
			endIndex++;
			rows += cost;
		}

		while (startIndex > 0) {
			const cost = this.#optionRowCount(
				this.#filteredOptions[startIndex - 1]!.option,
				renderWidth,
				false,
				mdTheme,
				descMode,
			);
			if (rows + cost > rowBudget) break;
			startIndex--;
			rows += cost;
		}

		return { startIndex, endIndex };
	}

	#updateList(renderWidth = this.#lastRenderWidth): void {
		const rows: SelectorRow[] = [];
		const total = this.#filteredOptions.length;
		const mdTheme = getMarkdownTheme();
		// Compact mode kicks in exactly when the fully-expanded list (all
		// descriptions) would overflow the row budget — the same condition that
		// enables search. There we collapse every option to its label and show
		// only the highlighted option's description, so the whole menu stays
		// visible on short terminals instead of collapsing to a single entry.
		const compact = this.#isSearchEnabled(renderWidth, mdTheme);
		const { startIndex, endIndex } = this.#getVisibleOptionRange(total, renderWidth, mdTheme, compact);

		let selectedDescRows = 0;
		if (compact && renderWidth !== undefined) {
			let labelRows = 0;
			for (let i = startIndex; i < endIndex; i++) {
				const filtered = this.#filteredOptions[i];
				if (filtered === undefined) continue;
				labelRows += this.#optionRowCount(filtered.option, renderWidth, i === this.#selectedIndex, mdTheme, 0);
			}
			// Reserve one row for the status line; give the remainder to the
			// highlighted option's description.
			selectedDescRows = Math.max(0, Math.max(1, this.#maxVisible) - labelRows - 1);
		}

		for (let i = startIndex; i < endIndex; i++) {
			const filtered = this.#filteredOptions[i];
			if (filtered === undefined) continue;
			const isSelected = i === this.#selectedIndex;
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
		return this.#isSearchEnabled(renderWidth, mdTheme) || this.#searchQuery.length > 0;
	}

	#renderStatusLine(total: number): string {
		const selectedCount = total === 0 ? 0 : this.#selectedIndex + 1;
		const count =
			this.#searchQuery.trim() && total !== this.#options.length
				? `${selectedCount}/${total} of ${this.#options.length}`
				: `${selectedCount}/${total}`;
		const suffix = this.#searchQuery.trim() ? `  Search: ${this.#searchQuery}` : "  Type to search";
		return theme.fg("dim", `  (${count})${suffix}`);
	}

	#setSearchQuery(query: string): void {
		this.#searchQuery = query;
		const indexedOptions = this.#options.map((option, index) => ({ option, index }));
		this.#filteredOptions = query.trim()
			? fuzzyFilter(indexedOptions, query, item => `${item.option.label} ${item.option.description ?? ""}`)
			: indexedOptions;
		this.#selectedIndex = this.#coerceSelectedIndex(0);
		this.#updateList();
	}

	#handleSearchInput(keyData: string): boolean {
		if (!this.#isSearchEnabled()) return false;

		if (matchesKey(keyData, "backspace")) {
			if (this.#searchQuery.length === 0) return false;
			const chars = [...this.#searchQuery];
			chars.pop();
			this.#setSearchQuery(chars.join(""));
			return true;
		}

		const printableText = extractPrintableText(keyData);
		if (printableText === undefined) return false;
		if (this.#searchQuery.length === 0 && printableText.trim().length === 0) return false;

		this.#setSearchQuery(this.#searchQuery + printableText);
		return true;
	}

	/** Jump to (and, for single-select menus, immediately confirm) the option
	 *  whose label starts with the pressed digit and a period. Numbered options
	 *  can follow unnumbered rows, as in `/review` after a detected PR. Once
	 *  type-to-search is active, digits stay searchable. Checkbox menus only
	 *  move the cursor — confirmation stays on `enter`. */
	#handleQuickSelect(keyData: string): boolean {
		if (this.#searchQuery.length > 0 || keyData.length !== 1 || keyData < "1" || keyData > "9") return false;
		const targetIndex = this.#filteredOptions.findIndex(({ option }) => option.label.startsWith(`${keyData}. `));
		if (targetIndex < 0) return false;
		const target = this.#filteredOptions[targetIndex];
		if (!target || this.#isDisabled(target.index)) return true;
		this.#selectedIndex = targetIndex;
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

		if (this.#handleSearchInput(keyData)) {
			return;
		}

		if (matchesSelectUp(keyData) || (!this.#isSearchEnabled() && matchesKey(keyData, "k"))) {
			this.#moveSelection(-1);
		} else if (matchesSelectDown(keyData) || (!this.#isSearchEnabled() && matchesKey(keyData, "j"))) {
			this.#moveSelection(1);
		} else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#filteredOptions[this.#selectedIndex];
			if (selected && !this.#isDisabled(selected.index)) this.#onSelectCallback(selected.option.label);
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
}
