/**
 * Fullscreen plan-review overlay. The overlay owns its entire content: the plan
 * is split into sections (preamble + one per heading), each rendered through its
 * own {@link Markdown} and windowed by a {@link ScrollView}, while the approval
 * options (plus the optional model-tier slider) sit beneath inside the same
 * outlined box — one self-contained surface in the spirit of the `/copy` picker.
 *
 * When the terminal is wide enough and the plan has ≥2 headings, a Contents
 * sidebar appears: it tracks the scrolled section with an accent "glow", and —
 * when focused — lets the operator jump between sections, delete a section
 * (with undo), and annotate sections with feedback that feeds the Refine loop.
 *
 * Focus regions (`toc`/`body`/`actions`) cycle with Tab/Shift+Tab; arrows move
 * within the focused region and step left into the sidebar. The default focus is
 * `actions`, so the muscle memory of the old single-target overlay carries over:
 * ↑/↓ select options, Enter confirms, ←/→ drives the slider when there is no
 * sidebar, g/G + PgUp/PgDn scroll, and the external-editor key opens the plan.
 */
import {
	type Component,
	Ellipsis,
	Input,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	routeSgrMouseInput,
	ScrollView,
	truncateToWidth,
	visibleWidth,
} from "@pk-nerdsaver-ai/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme";
import {
	matchesAppExternalEditor,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import type { HookSelectorSlider } from "./hook-selector";
import {
	bottomBorder,
	divider,
	dividerSplit,
	fit,
	row,
	splitBodyWidth,
	splitRow,
	topBorder,
	topBorderSplit,
} from "./overlay-box";
import { joinPlanSections, parsePlanSections, sectionDeletionSpan } from "./plan-toc";
import { renderSegmentTrack } from "./segment-track";

/** Title shown in the overlay's top border. */
const OVERLAY_TITLE = "Plan Review";
/** Minimum plan-body rows kept visible even on short terminals. */
const MIN_BODY_ROWS = 3;
/** Sidebar gates: enough headings, a wide terminal, and a usable body column. */
const SIDEBAR_MIN_HEADINGS = 2;
const SIDEBAR_MIN_TOTAL_WIDTH = 64;
const SIDEBAR_MIN_BODY_WIDTH = 40;

type Focus = "toc" | "body" | "actions";

interface OverlaySection {
	level: number;
	title: string;
	raw: string;
	md: Markdown;
	annotations: string[];
}

/** Undo snapshot: joined plan text, annotations aligned by section, and the
 *  accumulated deleted-section feedback at the time of the snapshot. */
interface UndoEntry {
	text: string;
	annotations: string[][];
	deleted: string[];
}

export interface PlanReviewOverlayCallbacks {
	/** Invoked with the chosen option label (never a disabled one). */
	onPick: (label: string) => void;
	/** Invoked on Esc / cancel. */
	onCancel: () => void;
	/** Invoked when the external-editor key is pressed (overlay stays open). */
	onExternalEditor?: () => void;
	/** Invoked when the external-editor key edits the active annotation draft. */
	onAnnotationExternalEditor?: (draft: string, commit: (text: string | null) => void) => void;
	/** Invoked with the new full plan text after an in-overlay delete/undo. */
	onPlanEdited?: (content: string) => void;
	/** Invoked with the Refine feedback markdown whenever annotations change. */
	onFeedbackChange?: (feedback: string) => void;
}

export interface PlanReviewOverlayOptions {
	/** Prompt rendered above the options (e.g. "Plan mode - next step"). */
	promptTitle?: string;
	options: string[];
	/** Indices into `options` that render dimmed and cannot be selected. */
	disabledIndices?: number[];
	/** Trailing footer hint (cancel hint); the overlay prepends dynamic help. */
	helpText?: string;
	/** Initially highlighted option index. */
	initialIndex?: number;
	/** Optional model-tier slider rendered between the plan body and options. */
	slider?: HookSelectorSlider;
	/** Display label for the external-editor key, surfaced in the footer help. */
	externalEditorLabel?: string;
}

/** Default trailing footer hint when the caller supplies none. */
const DEFAULT_HELP_SUFFIX = "esc cancel";

export class PlanReviewOverlay implements Component {
	#mdTheme: MarkdownTheme;
	#scrollView: ScrollView;
	#sections: OverlaySection[] = [];
	#toc: number[] = [];
	/** Shallowest level among ToC entries, used to flatten indentation. */
	#tocBaseLevel = 1;
	#sectionOffsets: number[] = [];
	#undo: UndoEntry[] = [];
	/** Titles of sections deleted in the overlay, surfaced as Refine feedback. */
	#deleted: string[] = [];

	#options: string[];
	#disabled: Set<number>;
	#helpSuffix: string;
	#externalEditorLabel: string | undefined;
	#promptTitle: string | undefined;
	#selectedIndex: number;
	#slider: HookSelectorSlider | undefined;
	#sliderIndex: number;

	#focus: Focus = "actions";
	#tocCursor = 0;
	#sidebarShown = false;
	#pendingScrollToToc = false;

	// Click hit-testing, rebuilt every render. Keys are 0-based rendered-line
	// indices (== screen rows, since the fullscreen overlay paints from row 0).
	#optionClickRows = new Map<number, number>();
	#tocClickRows = new Map<number, number>();
	#bodyClickRows = new Set<number>();
	/** Exclusive 0-based column bound below which a region-row click targets the sidebar. */
	#sidebarClickMaxCol = 0;
	/** Option index the pointer is currently hovering, or undefined. Updated from
	 *  motion mouse reports and cleared when the pointer leaves the option rows. */
	#hoveredOption: number | undefined;

	#annotating = false;
	#input: Input;

	constructor(
		planContent: string,
		options: PlanReviewOverlayOptions,
		private readonly callbacks: PlanReviewOverlayCallbacks,
	) {
		this.#mdTheme = getMarkdownTheme();
		this.#scrollView = new ScrollView([], {
			height: MIN_BODY_ROWS,
			scrollbar: "auto",
			ellipsis: Ellipsis.Omit,
			theme: { track: t => theme.fg("dim", t), thumb: t => theme.fg("accent", t) },
		});
		this.#options = options.options;
		this.#disabled = new Set(
			(options.disabledIndices ?? []).filter(i => Number.isInteger(i) && i >= 0 && i < this.#options.length),
		);
		this.#helpSuffix = options.helpText ?? DEFAULT_HELP_SUFFIX;
		this.#externalEditorLabel = options.externalEditorLabel;
		this.#promptTitle = options.promptTitle;
		this.#selectedIndex = this.#coerceIndex(options.initialIndex ?? 0);
		if (options.slider && options.slider.segments.length > 0) {
			this.#slider = options.slider;
			this.#sliderIndex = Math.max(0, Math.min(options.slider.index, options.slider.segments.length - 1));
		} else {
			this.#sliderIndex = 0;
		}
		this.#input = new Input();
		this.#input.setUseTerminalCursor(false);
		this.#input.onSubmit = value => this.#submitAnnotation(value);
		this.#input.onEscape = () => this.#exitAnnotate();
		this.#setSections(planContent);
	}

	invalidate(): void {
		for (const section of this.#sections) section.md.invalidate();
	}

	/** Swap the displayed plan (e.g. after an external-editor round-trip) and
	 *  reset scroll/focus so the operator starts at the top. Does not emit
	 *  `onPlanEdited` (the editor round-trip already persisted the file). */
	setPlanContent(planContent: string): void {
		this.#setSections(planContent);
		this.#scrollView.scrollToTop();
		this.#tocCursor = 0;
		// A wholesale external-editor swap supersedes prior in-overlay deletions.
		this.#deleted = [];
		this.#undo = [];
		this.#recomputeFeedback();
	}

	#setSections(planContent: string): void {
		this.#sections = parsePlanSections(planContent).map(section => ({
			level: section.level,
			title: section.title,
			raw: section.raw,
			md: new Markdown(section.raw, 1, 0, this.#mdTheme),
			annotations: [] as string[],
		}));
		this.#rebuildToc();
		this.#tocCursor = Math.min(this.#tocCursor, Math.max(0, this.#toc.length - 1));
	}

	#rebuildToc(): void {
		const headings: number[] = [];
		for (let i = 0; i < this.#sections.length; i++) {
			if (this.#sections[i]!.level >= 1) headings.push(i);
		}
		// Drop the plan's title from the ToC: a single shallowest heading at the
		// top of the document is the plan name itself ("we know it's the plan"),
		// so listing it adds noise. Plans with several top-level sections keep
		// them all.
		let minLevel = Number.POSITIVE_INFINITY;
		for (const i of headings) minLevel = Math.min(minLevel, this.#sections[i]!.level);
		const topLevel = headings.filter(i => this.#sections[i]!.level === minLevel);
		const titleIndex = topLevel.length === 1 && headings[0] === topLevel[0] ? topLevel[0] : -1;
		this.#toc = headings.filter(i => i !== titleIndex);
		this.#tocBaseLevel = this.#toc.length > 0 ? Math.min(...this.#toc.map(i => this.#sections[i]!.level)) : 1;
	}

	/** Clamp `index` to range, then walk to the nearest enabled option so the
	 *  cursor never rests on a disabled row. */
	#coerceIndex(index: number): number {
		const max = this.#options.length - 1;
		if (max < 0) return -1;
		const clamped = Math.max(0, Math.min(index, max));
		if (!this.#disabled.has(clamped)) return clamped;
		for (let i = clamped + 1; i <= max; i++) if (!this.#disabled.has(i)) return i;
		for (let i = clamped - 1; i >= 0; i--) if (!this.#disabled.has(i)) return i;
		return clamped;
	}

	/** First enabled option index (or -1 when none), used to detect the "top". */
	#firstEnabledIndex(): number {
		for (let i = 0; i < this.#options.length; i++) if (!this.#disabled.has(i)) return i;
		return -1;
	}

	/** Move the option cursor by `delta`, skipping disabled rows, stopping at the
	 *  list edge. */
	#moveSelection(delta: number): void {
		const max = this.#options.length - 1;
		if (max < 0) return;
		let index = this.#selectedIndex;
		while (true) {
			const next = Math.max(0, Math.min(index + delta, max));
			if (next === index) return;
			index = next;
			if (!this.#disabled.has(index)) {
				this.#selectedIndex = index;
				return;
			}
		}
	}

	/** Step the slider by `delta`, clamped to its edges (narrow-terminal mode). */
	#moveSlider(delta: number): void {
		const slider = this.#slider;
		if (!slider) return;
		const next = Math.max(0, Math.min(slider.segments.length - 1, this.#sliderIndex + delta));
		if (next === this.#sliderIndex) return;
		this.#sliderIndex = next;
		slider.onChange?.(next);
	}

	#confirmSelection(): void {
		const index = this.#selectedIndex;
		if (index >= 0 && index < this.#options.length && !this.#disabled.has(index)) {
			this.callbacks.onPick(this.#options[index]!);
		}
	}

	handleInput(keyData: string): void {
		if (keyData.startsWith("\x1b[<") && this.#handleMouse(keyData)) return;
		if (this.#annotating) {
			if (this.callbacks.onAnnotationExternalEditor && matchesAppExternalEditor(keyData)) {
				this.callbacks.onAnnotationExternalEditor(this.#input.getValue(), text => {
					if (text !== null) this.#submitAnnotation(text);
				});
				return;
			}
			this.#input.handleInput(keyData);
			return;
		}
		if (matchesSelectCancel(keyData)) {
			this.callbacks.onCancel();
			return;
		}
		if (this.callbacks.onExternalEditor && matchesAppExternalEditor(keyData)) {
			this.callbacks.onExternalEditor();
			return;
		}
		if (matchesKey(keyData, "tab") || keyData === "\t") {
			this.#cycleRegion(1);
			return;
		}
		if (matchesKey(keyData, "shift+tab") || keyData === "\x1b[Z") {
			this.#cycleRegion(-1);
			return;
		}
		switch (this.#focus) {
			case "actions":
				this.#handleActions(keyData);
				return;
			case "body":
				this.#handleBody(keyData);
				return;
			case "toc":
				this.#handleToc(keyData);
				return;
		}
	}

	/**
	 * Hit-test an SGR mouse report (`\x1b[<b;x;yM/m`) against the click maps the
	 * last render recorded. Returns true when consumed. The fullscreen overlay
	 * paints from screen row 0, so a 1-based mouse row maps directly to the
	 * rendered-line index. Wheel scrolls the body; pointer motion lights up the
	 * hovered option row; a left click on an option activates it (select +
	 * confirm), on a ToC row jumps to that section, and on the body column focuses
	 * the body.
	 */
	#handleMouse(data: string): boolean {
		return routeSgrMouseInput(data, event => {
			if (event.wheel !== null) {
				// Scroll wheel: three rows per notch.
				this.#scrollView.scroll(event.wheel * 3);
				return true;
			}
			if (event.release) return true;
			if (event.motion) {
				// Motion (hover or drag): light up the option row under the pointer so a
				// mouse user gets the same affordance the keyboard cursor gives. Any
				// non-option row clears the highlight.
				this.#setHoveredOption(this.#optionClickRows.get(event.row));
				return true;
			}
			if (!event.leftClick) return true;
			const optionIndex = this.#optionClickRows.get(event.row);
			if (optionIndex !== undefined) {
				if (!this.#disabled.has(optionIndex)) {
					this.#focus = "actions";
					this.#selectedIndex = optionIndex;
					this.#confirmSelection();
				}
				return true;
			}
			const tocPos = this.#tocClickRows.get(event.row);
			if (tocPos !== undefined && event.col < this.#sidebarClickMaxCol) {
				this.#focus = "toc";
				this.#tocCursor = tocPos;
				this.#scrubBodyToToc();
				return true;
			}
			if (this.#bodyClickRows.has(event.row)) {
				this.#setFocus("body");
			}
			return true;
		});
	}

	/** Set the hovered option from a hit-tested row, ignoring disabled rows and
	 *  non-option rows (both clear the highlight). */
	#setHoveredOption(index: number | undefined): void {
		this.#hoveredOption = index !== undefined && !this.#disabled.has(index) ? index : undefined;
	}

	#cycleRegion(direction: number): void {
		// Sidebar is skipped from the cycle when it is not shown.
		const regions: Focus[] = this.#sidebarShown ? ["toc", "body", "actions"] : ["body", "actions"];
		const current = regions.indexOf(this.#focus);
		const base = current < 0 ? regions.length - 1 : current;
		this.#setFocus(regions[(base + direction + regions.length) % regions.length]!);
	}

	#setFocus(focus: Focus): void {
		this.#focus = focus;
		if (focus === "toc") this.#tocCursor = this.#deriveTocCursorFromScroll();
	}

	#handleActions(data: string): void {
		// Left/right always drive the slider. The sidebar sits beside the body
		// (above this row), not the slider, so stealing left for it would strand
		// the operator unable to step the model tier back — reach the ToC via Tab.
		const isLeft = matchesKey(data, "left") || (this.#slider !== undefined && data === "h");
		const isRight = matchesKey(data, "right") || (this.#slider !== undefined && data === "l");
		if (isLeft) {
			this.#moveSlider(-1);
			return;
		}
		if (isRight) {
			this.#moveSlider(1);
			return;
		}
		if (matchesSelectUp(data) || data === "k") {
			if (this.#selectedIndex === this.#firstEnabledIndex()) this.#setFocus("body");
			else this.#moveSelection(-1);
			return;
		}
		if (matchesSelectDown(data) || data === "j") {
			this.#moveSelection(1);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#confirmSelection();
			return;
		}
		this.#handleBodyScroll(data);
	}

	#handleBody(data: string): void {
		if (matchesKey(data, "left") || data === "h") {
			if (this.#sidebarShown) this.#setFocus("toc");
			return;
		}
		if (
			matchesKey(data, "right") ||
			data === "l" ||
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			data === "\n"
		) {
			this.#setFocus("actions");
			return;
		}
		// Vertical nav flows between regions at the edges: scrolling off the bottom
		// drops into the actions ("next step"); scrolling off the top steps back up
		// to the ToC.
		if (matchesSelectUp(data) || data === "k") {
			if (this.#scrollView.getScrollOffset() <= 0 && this.#sidebarShown) this.#setFocus("toc");
			else this.#scrollView.scroll(-1);
			return;
		}
		if (matchesSelectDown(data) || data === "j") {
			if (this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset()) this.#setFocus("actions");
			else this.#scrollView.scroll(1);
			return;
		}
		this.#handleBodyScroll(data);
	}

	/**
	 * Shared scroll dispatch for body + actions focus. Delegates standard keys
	 * (Arrows, Shift+Arrow fast-scroll, PgUp/PgDn, Home/End) to the ScrollView,
	 * then adds the vim g/G jumps. Plain Arrow/k/j are consumed by the callers
	 * before this runs, so here it only ever sees the paging/fast keys.
	 */
	#handleBodyScroll(data: string): void {
		if (this.#scrollView.handleScrollKey(data)) return;
		if (data === "g") this.#scrollView.scrollToTop();
		else if (data === "G") this.#scrollView.scrollToBottom();
	}

	#handleToc(data: string): void {
		if (matchesSelectUp(data) || data === "k") {
			this.#moveTocCursor(-1);
			return;
		}
		if (matchesSelectDown(data) || data === "j") {
			// Past the last section, fall through to the actions ("next step").
			if (this.#tocCursor >= this.#toc.length - 1) this.#setFocus("actions");
			else this.#moveTocCursor(1);
			return;
		}
		if (
			matchesKey(data, "right") ||
			data === "l" ||
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			data === "\n"
		) {
			this.#setFocus("body");
			return;
		}
		if (data === "d" || matchesKey(data, "delete")) {
			this.#deleteSelectedSection();
			return;
		}
		if (data === "a") {
			this.#startAnnotate();
			return;
		}
		if (data === "u") {
			this.#undoLast();
			return;
		}
	}

	#moveTocCursor(delta: number): void {
		if (this.#toc.length === 0) return;
		const next = Math.max(0, Math.min(this.#toc.length - 1, this.#tocCursor + delta));
		if (next === this.#tocCursor) return;
		this.#tocCursor = next;
		this.#scrubBodyToToc();
	}

	/** Scroll the body so the selected ToC section's heading sits at the top. */
	#scrubBodyToToc(): void {
		const sectionIndex = this.#toc[this.#tocCursor];
		if (sectionIndex === undefined) return;
		const offset = this.#sectionOffsets[sectionIndex];
		if (offset !== undefined) this.#scrollView.setScrollOffset(offset);
	}

	/** Greatest ToC position whose section starts at or above the scroll offset. */
	#deriveTocCursorFromScroll(): number {
		if (this.#toc.length === 0) return 0;
		const scrollOffset = this.#scrollView.getScrollOffset();
		let current = 0;
		for (let i = 0; i < this.#sections.length; i++) {
			if ((this.#sectionOffsets[i] ?? 0) <= scrollOffset) current = i;
			else break;
		}
		let pos = 0;
		for (let p = 0; p < this.#toc.length; p++) {
			if (this.#toc[p]! <= current) pos = p;
			else break;
		}
		return pos;
	}

	#pushUndo(): void {
		this.#undo.push({
			text: joinPlanSections(this.#sections),
			annotations: this.#sections.map(section => [...section.annotations]),
			deleted: [...this.#deleted],
		});
	}

	#deleteSelectedSection(): void {
		const sectionIndex = this.#toc[this.#tocCursor];
		if (sectionIndex === undefined) return;
		const span = sectionDeletionSpan(this.#sections, sectionIndex);
		if (span.length === 0) return;
		this.#pushUndo();
		// Record the removed headings so the Refine feedback can ask the model to
		// drop them, then splice from the bottom up so earlier indices stay valid.
		for (const i of span) {
			const section = this.#sections[i]!;
			if (section.level >= 1 && section.title) this.#deleted.push(section.title);
		}
		for (let i = span.length - 1; i >= 0; i--) this.#sections.splice(span[i]!, 1);
		this.#rebuildToc();
		this.#tocCursor = Math.min(this.#tocCursor, Math.max(0, this.#toc.length - 1));
		this.#pendingScrollToToc = true;
		this.callbacks.onPlanEdited?.(joinPlanSections(this.#sections));
		this.#recomputeFeedback();
	}

	#undoLast(): void {
		const entry = this.#undo.pop();
		if (!entry) return;
		this.#setSections(entry.text);
		for (let i = 0; i < this.#sections.length; i++) {
			this.#sections[i]!.annotations = entry.annotations[i] ? [...entry.annotations[i]!] : [];
		}
		this.#deleted = [...entry.deleted];
		this.#tocCursor = Math.min(this.#tocCursor, Math.max(0, this.#toc.length - 1));
		this.#pendingScrollToToc = true;
		this.callbacks.onPlanEdited?.(joinPlanSections(this.#sections));
		this.#recomputeFeedback();
	}

	#startAnnotate(): void {
		if (this.#toc[this.#tocCursor] === undefined) return;
		this.#annotating = true;
		this.#input.setValue("");
	}

	#submitAnnotation(value: string): void {
		this.#annotating = false;
		const note = value.trim();
		const sectionIndex = this.#toc[this.#tocCursor];
		if (note && sectionIndex !== undefined) {
			this.#pushUndo();
			this.#sections[sectionIndex]!.annotations.push(note);
			this.#recomputeFeedback();
		}
		this.#input.setValue("");
	}

	#exitAnnotate(): void {
		this.#annotating = false;
		this.#input.setValue("");
	}

	#recomputeFeedback(): void {
		const annotated = this.#sections.filter(section => section.level >= 1 && section.annotations.length > 0);
		if (annotated.length === 0 && this.#deleted.length === 0) {
			this.callbacks.onFeedbackChange?.("");
			return;
		}
		let feedback = "Refinement feedback on the plan:\n";
		if (this.#deleted.length > 0) {
			feedback += "\nRemove these sections:\n";
			for (const title of this.#deleted) feedback += `- ${title}\n`;
		}
		for (const section of annotated) {
			feedback += `\n## ${section.title}\n`;
			for (const note of section.annotations) feedback += this.#formatAnnotationFeedback(note);
		}
		this.callbacks.onFeedbackChange?.(feedback);
	}

	#formatAnnotationFeedback(note: string): string {
		if (!note.includes("\n")) return `- ${note}\n`;
		const fence = this.#markdownFenceFor(note);
		return `${fence}md\n${note}\n${fence}\n`;
	}

	#markdownFenceFor(text: string): string {
		let fence = "```";
		while (text.includes(fence)) fence += "`";
		return fence;
	}

	#renderSliderLines(): string[] {
		const slider = this.#slider;
		if (!slider) return [];
		const active = this.#sliderIndex;
		const track = renderSegmentTrack(slider.segments, active);
		const leftArrow = theme.fg(active > 0 ? "accent" : "dim", "◂");
		const rightArrow = theme.fg(active < slider.segments.length - 1 ? "accent" : "dim", "▸");
		const caption = slider.caption ? `${theme.fg("dim", slider.caption)}  ` : "";
		const trackLine = `${caption}${leftArrow}  ${track}  ${rightArrow}`;
		const detail = slider.segments[active]?.detail;
		if (!detail) return [trackLine];
		return [trackLine, `  ${theme.fg("dim", "↳")} ${theme.fg("muted", detail)}`];
	}

	#renderOptionLines(): string[] {
		const active = this.#focus === "actions";
		return this.#options.map((label, i) => {
			const selected = i === this.#selectedIndex;
			const isDisabled = this.#disabled.has(i);
			const hovered = !isDisabled && i === this.#hoveredOption;
			// The cursor marks the selected option; it dims when actions are not the
			// focused region so the active region's highlight stays unambiguous.
			const cursor = selected ? theme.fg(active ? "accent" : "dim", `${theme.nav.cursor} `) : "  ";
			let text = isDisabled
				? theme.fg("dim", label)
				: selected && active
					? theme.bold(theme.fg("accent", label))
					: theme.fg("text", label);
			// A pointer hovering an option paints a highlight band behind its label,
			// distinct from the keyboard selection (cursor glyph + bold accent) which
			// stays where it is. One space of padding gives the band a button shape.
			if (hovered) text = theme.bg("selectedBg", ` ${text} `);
			return cursor + text;
		});
	}

	#buildHelp(): string {
		const sep = " · ";
		const parts: string[] = [];
		switch (this.#focus) {
			case "actions":
				parts.push("↑↓ select", "⏎ confirm");
				if (this.#slider) parts.push("◂▸ model");
				break;
			case "toc":
				parts.push("↑↓ section", "⏎ open", "a annotate", "d delete", "u undo");
				break;
			case "body":
				parts.push("↑↓ scroll", "⇧ faster", "pgup/pgdn", "g/G ends");
				break;
		}
		parts.push("tab regions");
		if (this.#externalEditorLabel && this.#focus !== "toc") parts.push(`${this.#externalEditorLabel} editor`);
		parts.push(this.#helpSuffix);
		return parts.join(sep);
	}

	/** Build the concatenated body lines and record each section's start row. */
	#buildBody(bodyContentWidth: number): string[] {
		const lines: string[] = [];
		const offsets: number[] = new Array(this.#sections.length);
		for (let i = 0; i < this.#sections.length; i++) {
			const section = this.#sections[i]!;
			offsets[i] = lines.length;
			const rendered = section.md.render(bodyContentWidth);
			if (section.level >= 1 && section.annotations.length > 0 && rendered.length > 0) {
				lines.push(rendered[0]!);
				for (const note of section.annotations) {
					const noteLines = note.split(/\r?\n/);
					for (let j = 0; j < noteLines.length; j++) {
						const prefix =
							j === 0
								? `${theme.fg("warning", "▎ ")}${theme.fg("dim", "note: ")}`
								: `${theme.fg("warning", "▎ ")}${theme.fg("dim", "      ")}`;
						lines.push(`${prefix}${theme.fg("accent", noteLines[j] ?? "")}`);
					}
				}
				for (let k = 1; k < rendered.length; k++) lines.push(rendered[k]!);
			} else {
				for (const line of rendered) lines.push(line);
			}
		}
		this.#sectionOffsets = offsets;
		return lines;
	}

	#sidebarWidthFor(width: number): number {
		return Math.max(18, Math.min(30, Math.round(width * 0.24)));
	}

	#sidebarVisible(width: number): boolean {
		if (this.#toc.length < SIDEBAR_MIN_HEADINGS) return false;
		if (width < SIDEBAR_MIN_TOTAL_WIDTH) return false;
		return splitBodyWidth(width, this.#sidebarWidthFor(width)) >= SIDEBAR_MIN_BODY_WIDTH;
	}

	/** Sidebar lines plus, per row, the ToC position shown there (for clicks). */
	#renderSidebarLines(
		regionRows: number,
		sidebarWidth: number,
	): { lines: string[]; posForRow: (number | undefined)[] } {
		// No "Contents" label and no plan-title entry: the box title already says
		// "Plan Review", so the sidebar is just the bare list of sections, VS
		// Code-style. Window the entries around the cursor.
		const lines: string[] = [];
		const posForRow: (number | undefined)[] = [];
		const slots = Math.max(0, regionRows);
		const total = this.#toc.length;
		let start = 0;
		if (total > slots) {
			start = Math.max(0, Math.min(this.#tocCursor - Math.floor(slots / 2), total - slots));
		}
		for (let r = 0; r < slots; r++) {
			const p = start + r;
			lines.push(p < total ? this.#renderTocEntry(p, sidebarWidth) : "");
			posForRow.push(p < total ? p : undefined);
		}
		return { lines, posForRow };
	}

	#renderTocEntry(p: number, width: number): string {
		const section = this.#sections[this.#toc[p]!]!;
		const highlighted = p === this.#tocCursor;
		const selected = highlighted && this.#focus === "toc";
		const glow = highlighted && this.#focus !== "toc";
		// Compact, VS Code-like rows: a single-column gutter, one space of indent
		// per nesting level, then the title and an annotation marker.
		const indent = " ".repeat(Math.max(0, section.level - this.#tocBaseLevel));
		const ann = section.annotations.length > 0 ? " ✎" : "";
		const avail = Math.max(0, width - 1 - indent.length - visibleWidth(ann));
		const title = truncateToWidth(section.title || "(untitled)", avail, Ellipsis.Unicode);
		const body = indent + title + ann;
		// Single-column gutter glyph: a cursor `›` on the focused selection, an
		// accent bar `▎` on the current scrolled section, otherwise blank. The
		// glyph keeps the cursor legible even where the selection background is
		// subtle; the focused row also gets the full-row highlight.
		const gutter = selected ? "›" : glow ? "▎" : " ";
		const line = gutter + body;
		if (selected) return theme.bg("selectedBg", theme.bold(fit(line, width)));
		if (glow) return theme.fg("accent", line);
		return theme.fg("muted", line);
	}

	#renderFooterLines(innerWidth: number): string[] {
		if (this.#annotating) {
			const section = this.#sections[this.#toc[this.#tocCursor]!];
			const title = section?.title ?? "";
			const caption = `${theme.fg("dim", "Annotate")} ${theme.fg("accent", `‹${title}›`)}`;
			const hintParts = ["enter save", "esc cancel"];
			if (this.#externalEditorLabel) hintParts.push(`${this.#externalEditorLabel} editor`);
			return [caption, this.#input.render(innerWidth)[0] ?? "", theme.fg("dim", hintParts.join(" · "))];
		}
		return [theme.fg("dim", this.#buildHelp())];
	}

	render(width: number): readonly string[] {
		const termHeight = process.stdout.rows || 40;
		const sidebarShown = this.#sidebarVisible(width);
		this.#sidebarShown = sidebarShown;
		const sidebarWidth = sidebarShown ? this.#sidebarWidthFor(width) : 0;
		const innerWidth = Math.max(1, width - 4);
		const bodyContentWidth = sidebarShown ? splitBodyWidth(width, sidebarWidth) : innerWidth;

		const sliderLines = this.#renderSliderLines();
		const optionLines = this.#renderOptionLines();
		const promptLines = this.#promptTitle ? [theme.bold(theme.fg("accent", this.#promptTitle))] : [];
		const footerLines = this.#renderFooterLines(innerWidth);

		// Chrome rows: top border, two dividers, bottom border, plus the
		// prompt/slider/option/footer rows between them.
		const chrome = 4 + promptLines.length + sliderLines.length + optionLines.length + footerLines.length;
		const regionRows = Math.max(MIN_BODY_ROWS, termHeight - chrome);

		const bodyLines = this.#buildBody(bodyContentWidth);
		this.#scrollView.setLines(bodyLines);
		this.#scrollView.setHeight(regionRows);
		if (this.#pendingScrollToToc) {
			this.#pendingScrollToToc = false;
			this.#scrubBodyToToc();
		}
		if (this.#focus !== "toc") this.#tocCursor = this.#deriveTocCursorFromScroll();
		const body = this.#scrollView.render(bodyContentWidth);

		this.#optionClickRows.clear();
		this.#tocClickRows.clear();
		this.#bodyClickRows.clear();
		this.#sidebarClickMaxCol = sidebarShown ? sidebarWidth + 3 : 0;

		const out: string[] = [];
		if (sidebarShown) {
			const { lines: sidebar, posForRow } = this.#renderSidebarLines(regionRows, sidebarWidth);
			out.push(topBorderSplit(width, OVERLAY_TITLE, sidebarWidth));
			for (let i = 0; i < regionRows; i++) {
				const pos = posForRow[i];
				if (pos !== undefined) this.#tocClickRows.set(out.length, pos);
				this.#bodyClickRows.add(out.length);
				out.push(splitRow(sidebar[i] ?? "", body[i] ?? "", width, sidebarWidth));
			}
			out.push(dividerSplit(width, sidebarWidth));
		} else {
			out.push(topBorder(width, OVERLAY_TITLE));
			for (const line of body) {
				this.#bodyClickRows.add(out.length);
				out.push(row(line, width));
			}
			out.push(divider(width));
		}
		for (const line of promptLines) out.push(row(line, width));
		for (const line of sliderLines) out.push(row(line, width));
		for (let i = 0; i < optionLines.length; i++) {
			this.#optionClickRows.set(out.length, i);
			out.push(row(optionLines[i]!, width));
		}
		out.push(divider(width));
		for (const line of footerLines) out.push(row(line, width));
		out.push(bottomBorder(width));
		return out;
	}
}
