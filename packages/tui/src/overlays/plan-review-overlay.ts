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
 * ↑/↓ select options, Enter confirms, ←/→ drives the slider, g/G + PgUp/PgDn
 * scroll, and the external-editor key opens the plan.
 *
 * The options are the approval choices, then Save (writes a copy, the review
 * stays open); while the plan has feedback (annotations, deleted sections) a
 * Refine option leads them and is preselected.
 *
 * Under Tern the plan is one editable, commentable `doc` (double-click edits it
 * in place, a text selection takes a comment) above a dock: an Approve split
 * button (Refine while the plan has comments) whose menu holds every approval
 * choice, the model chip, Save and Cancel. Enter runs the main button, ←/→ pick
 * the model. Terminals without those kinds get one `md` per section and the
 * options as a horizontal bar (←/→ select, Shift+←/→ drive the slider).
 */
import {
	type Component,
	Ellipsis,
	Editor,
	getWidthConfigEpoch,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	replaceTabs,
	routeSgrMouseInput,
	ScrollView,
	truncateToWidth,
	visibleWidth,
} from "../index";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { sanitizeStatusText } from "../chrome/shared";
import { getEditorTheme, getMarkdownTheme, getThemeEpoch, theme } from "../theme/theme";
import {
	matchesAppExternalEditor,
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectUp,
} from "../keybinding-matchers";
import type { HookSelectorSlider } from "./hook-selector";
import {
	bottomBorder,
	divider,
	dividerSplit,
	row,
	splitBodyWidth,
	splitRow,
	topBorder,
	topBorderSplit,
} from "../chrome/overlay-box";
import { joinPlanSections, parsePlanSections, sectionDeletionSpan, stripInlineMarkdown } from "./plan-toc";
import { padToWidth } from "../render/utils";
import { renderSegmentTrack } from "../chrome/segment-track";
import { formatKeyHint, formatKeyHints } from "../app-keybindings";
import { boundKeys, editorKey, editorKeys } from "../chrome/keybinding-hints";
import type { KeyName } from "../key-hint-format";
import { col, item, keyed, keyNames, md, node, row as rowNode, span, text } from "../native/describe";
import { type DescribeContext, leafKey, type NativeChild, type NativeNode, type NativeUiEvent } from "../native/node";
import { actionButton, actionHint, hintsRow, itemIndex, type NativeHint, selectList } from "../native/overlay";
import { isNativeRendering } from "../native/state";
import type { TspDocComment, TspMenuItem } from "@oh-my-pi/pi-wire";
import { getKeybindings } from "../keybindings";

/** Title shown in the overlay's top border. */
const OVERLAY_TITLE = "Plan Review";
/** Native sheet title when the plan has no title heading of its own. */
const NATIVE_TITLE = "Plan review";
/** Minimum plan-body rows kept visible even on short terminals. */
const MIN_BODY_ROWS = 3;
/** Visible rows for the in-overlay annotation editor before it scrolls. */
const MAX_ANNOTATION_EDITOR_ROWS = 6;
/** Sidebar gates: enough headings, a wide terminal, and a usable body column. */
const SIDEBAR_MIN_HEADINGS = 2;
const SIDEBAR_MIN_TOTAL_WIDTH = 64;
const SIDEBAR_MIN_BODY_WIDTH = 40;
/** Persisted line-context cap; render-time captions clamp again to the viewport. */
const MAX_ANNOTATION_CONTEXT_WIDTH = 120;
/** Oldest delete/annotate undo snapshots are dropped past this depth (each holds the full plan text). */
const MAX_UNDO_ENTRIES = 100;
/** Label of the Save option and button. */
const SAVE_LABEL = "Save";
/** Leading heading/list/quote markers stripped from a quote before matching it against rendered rows. */
const QUOTE_MARKER_RE = /^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)*/;
/** An ATX heading line: the title's source is group 2 (offset after group 1). */
const HEADING_LINE_RE = /^(#{1,6}[ \t]+)(.+?)[ \t]*#*[ \t]*$/;

type Focus = "toc" | "body" | "actions";

/**
 * What an annotation is attached to: its whole section, one rendered line, or a
 * quote of the plan source (a native comment on a selection). A quote's `at` is
 * the UTF-16 offset of its first char in the section's source (the quote may run
 * past the section's end).
 */
type AnnotationTarget =
	| { kind: "section" }
	| { kind: "line"; row: number; context: string; contextTruncated: boolean }
	| { kind: "quote"; quote: string; at: number };

interface OverlayAnnotation {
	/** Stable per overlay (`c<n>`): the native document's comment id. */
	id: string;
	note: string;
	target: AnnotationTarget;
}

interface OverlaySection {
	level: number;
	title: string;
	raw: string;
	md: Markdown;
	annotations: OverlayAnnotation[];
}

interface LineAnchorContext {
	text: string;
	truncated: boolean;
}

interface BodyRowAnchor {
	sectionIndex: number;
	row: number;
	context: string;
	contextTruncated: boolean;
}

interface AnnotationSelection {
	sectionIndex: number;
	annotationIndex: number;
}

interface AnnotationChooser {
	entries: AnnotationSelection[];
	selected: number;
}

/** Described plan body and Contents entries, rebuilt when sections or annotations change. */
interface NativePlanContent {
	sections: OverlaySection[];
	rev: number;
	/** One `md` per section (terminals without `doc`). */
	body: NativeNode[];
	toc: NativeNode[];
	/** The plan as the native document shows it: the source minus the title heading line. */
	docText: string;
	/** Every annotation as a comment on the document. */
	comments: TspDocComment[];
}

/**
 * Where the title heading line sits in the plan source: the document omits it
 * (the sheet's head shows the title) and puts it back into what it reports.
 */
interface TitleLine {
	/** Offset of the line in the plan source (and of the same point in the document). */
	start: number;
	/** The heading line, newline included. */
	line: string;
}

/** Serializable annotations retained by the plan-review owner between overlays. */
export interface PlanReviewAnnotationState {
	annotations: Array<{
		section: {
			index: number;
			title: string;
			/** Heading ancestry from the document root, when emitted by this overlay. */
			path?: string[];
			/** Hash of the section source, used to reject ambiguous moved headings. */
			contentHash?: string;
		};
		/** A quote's `at` is the offset of its first char in the section's source. */
		target:
			| { kind: "section" }
			| { kind: "line"; row: number; context: string; contextTruncated?: boolean }
			| { kind: "quote"; quote: string; at: number };
		note: string;
	}>;
}

/** One approval choice of the review. */
export interface PlanReviewOverlayChoice {
	/** What `onPick` reports. */
	readonly id: string;
	readonly label: string;
	/** The native approve menu row's second line (falls back to {@link meta}). */
	readonly detail?: string;
	/** Short dim text after the label in the option list (a context size); the menu row's detail without `detail`. */
	readonly meta?: string;
	/** Why it can't be chosen now: the option dims and is skipped. */
	readonly disabled?: string;
}

/** A row of the option list: Refine (while the plan has feedback), an approval choice, or Save. */
type OptionEntry =
	| { readonly kind: "refine"; readonly id: string; readonly label: string }
	| { readonly kind: "approve"; readonly choice: PlanReviewOverlayChoice }
	| { readonly kind: "save" };

/** Undo snapshot: joined plan text, annotations aligned by section, and the
 *  accumulated deleted-section feedback at the time of the snapshot. */
interface UndoEntry {
	text: string;
	annotations: OverlayAnnotation[][];
	deleted: string[];
}

/** Concatenated plan body rows and their anchors, reused while every render input is unchanged. */
interface BodyLayout {
	width: number;
	annotationRev: number;
	themeEpoch: number;
	widthEpoch: number;
	/** Each section's `Markdown.render` result the layout was built from (compared by identity). */
	rendered: readonly (readonly string[])[];
	lines: readonly string[];
	anchors: BodyRowAnchor[];
	offsets: number[];
}

/** Line contexts per rendered-lines array; `Markdown.render` returns a stable array per (text, width). */
const lineContextCache = new WeakMap<readonly string[], readonly LineAnchorContext[]>();
/** Match keys per context list, so resolving several annotations normalizes each row once. */
const normalizedContextCache = new WeakMap<readonly LineAnchorContext[], readonly string[]>();

function lineContexts(rendered: readonly string[]): readonly LineAnchorContext[] {
	let contexts = lineContextCache.get(rendered);
	if (!contexts) {
		contexts = rendered.map(line => {
			const sanitized = sanitizeStatusText(line);
			const truncated = visibleWidth(sanitized) > MAX_ANNOTATION_CONTEXT_WIDTH;
			const text = truncateToWidth(sanitized, MAX_ANNOTATION_CONTEXT_WIDTH, Ellipsis.Unicode);
			return { text: text || "(blank line)", truncated };
		});
		lineContextCache.set(rendered, contexts);
	}
	return contexts;
}

function normalizeLineContext(context: LineAnchorContext): string {
	const normalized = sanitizeStatusText(context.text).replace(/\s+/g, " ").trim();
	return context.truncated && normalized.endsWith("…") ? normalized.slice(0, -1) : normalized;
}

/** Row in `contexts` nearest `storedRow` whose text matches the stored context, or -1. */
function resolveLineRow(
	storedRow: number,
	storedContext: LineAnchorContext,
	contexts: readonly LineAnchorContext[],
): number {
	if (contexts.length === 0) return -1;
	const targetRow = Math.max(0, Math.floor(storedRow));
	const normalizedStoredContext = normalizeLineContext(storedContext);
	if (!normalizedStoredContext) return -1;
	let normalizedContexts = normalizedContextCache.get(contexts);
	if (!normalizedContexts) {
		normalizedContexts = contexts.map(normalizeLineContext);
		normalizedContextCache.set(contexts, normalizedContexts);
	}
	let best = -1;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let row = 0; row < normalizedContexts.length; row++) {
		const normalizedContext = normalizedContexts[row]!;
		if (
			normalizedContext !== normalizedStoredContext &&
			!normalizedContext.includes(normalizedStoredContext) &&
			!normalizedStoredContext.includes(normalizedContext)
		) {
			continue;
		}
		const distance = Math.abs(row - targetRow);
		if (distance < bestDistance) {
			best = row;
			bestDistance = distance;
		}
	}
	return best;
}

/** The occurrence of `quote` in `text` nearest `around`, or -1. */
function nearestOccurrence(text: string, quote: string, around: number): number {
	if (!quote) return -1;
	let best = -1;
	for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
		if (best < 0 || Math.abs(at - around) < Math.abs(best - around)) best = at;
		if (at > around) break;
	}
	return best;
}

/** Index of the section whose source holds `offset` (`starts` ascending, the first 0); 0 for an empty plan. */
function sectionAt(starts: readonly number[], offset: number): number {
	let index = 0;
	for (let i = 1; i < starts.length; i++) {
		if (starts[i]! <= offset) index = i;
		else break;
	}
	return index;
}

/** A quote collapsed to one line, as the feedback and captions show it. */
function quoteLine(quote: string): string {
	return quote.replace(/\s+/g, " ").trim();
}

/** What an annotation is on, as the annotation chooser lists it. */
function annotationWhere(target: AnnotationTarget): string {
	if (target.kind === "line") return `line ${target.context}`;
	return target.kind === "quote" ? `“${quoteLine(target.quote)}”` : "section";
}

/**
 * The row of `contexts` (a section's rendered rows) showing `quote`: the first
 * whose text holds the start of the quote's first line with its Markdown
 * markers stripped; row 0 (the section's top) when none does.
 */
function quoteRow(contexts: readonly LineAnchorContext[], quote: string): number {
	const firstLine = quote.split("\n").find(line => line.trim() !== "") ?? "";
	const probe = normalizeLineContext({
		text: stripInlineMarkdown(firstLine.replace(QUOTE_MARKER_RE, "")).slice(0, 40),
		truncated: false,
	});
	if (!probe) return 0;
	const row = contexts.findIndex(context => normalizeLineContext(context).includes(probe));
	return Math.max(0, row);
}

export interface PlanReviewOverlayCallbacks {
	/** Invoked with the chosen choice id (never a disabled one); the overlay locks until it is hidden. */
	onPick: (id: string) => void;
	/** Invoked on Esc / cancel. */
	onCancel: () => void;
	/**
	 * Save: invoked with the current full plan text; the review stays open and keeps its state.
	 * When set, the option list ends with Save and the native dock shows a Save button.
	 */
	onSave?: (content: string) => void;
	/** Invoked with the current full plan text when the copy hotkey is pressed. */
	onCopyPlan?: (content: string) => void | Promise<void>;
	/** Invoked when the external-editor key is pressed (overlay stays open). */
	onExternalEditor?: () => void;
	/** Open a one-off execution model picker without closing the review. */
	onCustomModel?: () => void;
	/** Invoked when the external-editor key edits the active annotation draft. */
	onAnnotationExternalEditor?: (draft: string, commit: (text: string | null) => void) => void;
	/** Invoked with the new full plan text after an in-overlay delete/undo or an in-place native edit. */
	onPlanEdited?: (content: string) => void;
	/** Invoked with the Refine feedback markdown whenever annotations change. */
	onFeedbackChange?: (feedback: string) => void;
	/** Invoked with a serializable annotation snapshot whenever annotations change. */
	onAnnotationStateChange?: (state: PlanReviewAnnotationState) => void;
}

export interface PlanReviewOverlayOptions {
	/** Prompt rendered above the options (e.g. "Plan mode - next step"). */
	promptTitle?: string;
	/** Approval choices, in order; the first enabled one is the native Approve button's click. */
	options: readonly PlanReviewOverlayChoice[];
	/**
	 * Refine: offered while the plan has feedback (annotations, deleted sections), first and preselected
	 * in the option list and as the native main button; picking it reports `id`.
	 */
	refine?: { readonly id: string; readonly label: string };
	/** Trailing footer hint (cancel hint); the overlay prepends dynamic help. */
	helpText?: string;
	/** Initially highlighted option index. */
	initialIndex?: number;
	/** Optional model-tier slider rendered between the plan body and options. */
	slider?: HookSelectorSlider;
	/** Display label for the external-editor key, surfaced in the footer help. */
	externalEditorLabel?: string;
	/** Serializable annotations restored into this overlay instance. */
	annotationState?: PlanReviewAnnotationState;
}

export class PlanReviewOverlay implements Component {
	#mdTheme: MarkdownTheme;
	#scrollView: ScrollView;
	#sections: OverlaySection[] = [];
	#toc: number[] = [];
	/** Section holding the plan's title heading (dropped from the ToC; the native sheet title), or -1. */
	#titleIndex = -1;
	/** Memoized {@link nativeOverlay} for the current title. */
	#nativeOverlay: { title: string; props: NonNullable<Component["nativeOverlay"]> } | undefined;
	/** Shallowest level among ToC entries, used to flatten indentation. */
	#tocBaseLevel = 1;
	#sectionOffsets: number[] = [];
	/** Rendered body row to underlying plan row; callouts retain their owner's anchor. */
	#bodyRowAnchors: BodyRowAnchor[] = [];
	/** Memoized {@link #buildBody} result. */
	#bodyLayout: BodyLayout | undefined;
	/** Lines last handed to the scroll view; unchanged layouts skip the copy and keep its render cache. */
	#scrollLines: readonly string[] | undefined;
	#undo: UndoEntry[] = [];
	/** Titles of sections deleted in the overlay, surfaced as Refine feedback. */
	#deleted: string[] = [];

	#choices: readonly PlanReviewOverlayChoice[];
	#refine: { readonly id: string; readonly label: string } | undefined;
	/** The plan has annotations or deleted sections: Refine is offered. */
	#hasFeedback = false;
	/** Memoized {@link #entries} for the current {@link #hasFeedback}. */
	#entryCache: { feedback: boolean; entries: readonly OptionEntry[] } | undefined;
	/** Bumped by {@link setChoices} so the memoized native root redraws the options. */
	#choicesRev = 0;
	#helpSuffix: string | undefined;
	#externalEditorLabel: string | undefined;
	#promptTitle: string | undefined;
	/** Index into {@link #entries}. */
	#selectedIndex: number;
	#slider: HookSelectorSlider | undefined;
	#sliderIndex = 0;

	#focus: Focus = "actions";
	#tocCursor = 0;
	#sidebarShown = false;
	#pendingScrollToToc = false;
	/** Last meaningful relative body position, retained while a frame cannot scroll. */
	#scrollProgress = 0;

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

	// Once a choice fires, the promise-based caller resolves but keeps this
	// overlay mounted while it runs slow async approval work (e.g. context
	// compaction). Lock input and switch to a "submitting" indicator so the
	// overlay stops looking interactive and repeat Enter/Esc are not silently
	// swallowed with zero feedback (#5926).
	#committed = false;
	/** Label of the committed choice, shown while the async approval settles. */
	#committedLabel: string | undefined;
	#annotating = false;
	#editor: Editor;
	#annotationTarget: BodyRowAnchor | { sectionIndex: number; row: null; context: null } | undefined;
	#editingAnnotation: AnnotationSelection | undefined;
	#annotationChooser: AnnotationChooser | undefined;

	/** Bumped on every section/annotation change (all of them funnel through {@link #recomputeFeedback}). */
	#annotationRev = 0;
	#nativeContent: NativePlanContent | undefined;
	#nativeSig = "";
	#nativeRoot: NativeNode | undefined;
	/** Content the memoized root was built from. */
	#nativeRootContent: NativePlanContent | undefined;
	/**
	 * The section the last Contents jump targets under a native surface, which
	 * scrolls the body itself: `n` counts the jumps, so each one reveals it again.
	 */
	#jump: { section: number; n: number } | undefined;
	/** The last describe drew the plan as a native `doc` (in-place edits, comments). */
	#nativeDoc = false;
	/** The last describe drew the native dock (split Approve button, model chip, Save, Cancel). */
	#nativeDock = false;
	/** Last annotation id handed out ({@link #newAnnotationId}). */
	#annotationSeq = 0;

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
		this.#choices = options.options;
		this.#refine = options.refine;
		this.#helpSuffix = options.helpText;
		this.#externalEditorLabel = options.externalEditorLabel;
		this.#promptTitle = options.promptTitle;
		this.#selectedIndex = this.#coerceIndex(options.initialIndex ?? 0);
		if (options.slider) this.setSlider(options.slider);
		this.#editor = new Editor(getEditorTheme());
		this.#editor.setBorderVisible(false);
		this.#editor.setPromptGutter("> ");
		this.#editor.setUseTerminalCursor(false);
		this.#editor.onSubmit = value => this.#submitAnnotation(value);
		this.#setSections(planContent);
		this.#restoreAnnotationState(options.annotationState);
		if (Array.isArray(options.annotationState?.annotations) && options.annotationState.annotations.length > 0) {
			this.#recomputeFeedback();
		}
	}

	#newAnnotationId(): string {
		this.#annotationSeq++;
		return `c${this.#annotationSeq}`;
	}

	invalidate(): void {
		for (const section of this.#sections) section.md.invalidate();
	}

	/** Swap the displayed plan (e.g. after an external-editor round-trip) and
	 *  reset scroll/focus so the operator starts at the top. Does not emit
	 *  `onPlanEdited` (the editor round-trip already persisted the file). */
	setPlanContent(planContent: string): void {
		const annotations = this.#annotationState();
		this.#setSections(planContent);
		this.#restoreAnnotationState(annotations);
		this.#scrollView.scrollToTop();
		this.#scrollProgress = 0;
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
			annotations: [],
		}));
		this.#rebuildToc();
		this.#tocCursor = Math.min(this.#tocCursor, Math.max(0, this.#toc.length - 1));
	}
	#cloneAnnotation(annotation: OverlayAnnotation): OverlayAnnotation {
		return { id: annotation.id, note: annotation.note, target: { ...annotation.target } };
	}

	/** Offset of each section's first char in the plan source. */
	#sectionStarts(): number[] {
		const starts: number[] = [];
		let offset = 0;
		for (const section of this.#sections) {
			starts.push(offset);
			offset += section.raw.length;
		}
		return starts;
	}

	/** The plan source exactly as the sections hold it (no trailing-newline normalization). */
	#source(): string {
		let source = "";
		for (const section of this.#sections) source += section.raw;
		return source;
	}

	/** The title heading line the native document omits, when the plan has a title. */
	#titleLine(): TitleLine | undefined {
		const section = this.#sections[this.#titleIndex];
		if (!section) return undefined;
		const newline = section.raw.indexOf("\n");
		const line = newline < 0 ? section.raw : section.raw.slice(0, newline + 1);
		return { start: this.#sectionStarts()[this.#titleIndex]!, line };
	}

	/** A plan-source offset as an offset into the native document (inside the title line: where it was). */
	#docOffset(offset: number, title: TitleLine | undefined): number {
		if (!title || offset < title.start) return offset;
		return offset < title.start + title.line.length ? title.start : offset - title.line.length;
	}

	#sectionPaths(): string[][] {
		const stack: Array<{ level: number; title: string }> = [];
		return this.#sections.map(section => {
			if (section.level < 1) return [];
			while (stack.length > 0 && stack[stack.length - 1]!.level >= section.level) stack.pop();
			stack.push({ level: section.level, title: section.title });
			return stack.map(entry => entry.title);
		});
	}

	#sectionContentHash(section: OverlaySection): string {
		return `${section.raw.length}:${Bun.hash(section.raw).toString(16)}`;
	}

	#annotationState(): PlanReviewAnnotationState {
		const annotations: PlanReviewAnnotationState["annotations"] = [];
		const sectionPaths = this.#sectionPaths();
		for (let sectionIndex = 0; sectionIndex < this.#sections.length; sectionIndex++) {
			const section = this.#sections[sectionIndex]!;
			for (const annotation of section.annotations) {
				annotations.push({
					section: {
						index: sectionIndex,
						title: section.title,
						path: sectionPaths[sectionIndex]!,
						contentHash: this.#sectionContentHash(section),
					},
					target: { ...annotation.target },
					note: annotation.note,
				});
			}
		}
		return { annotations };
	}

	#restoreAnnotationState(state: PlanReviewAnnotationState | undefined): void {
		if (!state || !Array.isArray(state.annotations)) return;
		const sectionPaths = this.#sectionPaths();
		const contentHashes = this.#sections.map(section => this.#sectionContentHash(section));
		const starts = this.#sectionStarts();
		const source = this.#source();
		for (const entry of state.annotations) {
			if (
				!entry ||
				typeof entry.note !== "string" ||
				!entry.section ||
				!entry.target ||
				typeof entry.section.title !== "string"
			) {
				continue;
			}
			const note = entry.note.trim();
			if (!note) continue;
			const storedIndex = Number.isInteger(entry.section.index) ? entry.section.index : -1;
			const storedPath = entry.section.path;
			let matchingSections: number[];
			if (
				Array.isArray(storedPath) &&
				storedPath.every(segment => typeof segment === "string") &&
				typeof entry.section.contentHash === "string"
			) {
				matchingSections = [];
				for (let i = 0; i < this.#sections.length; i++) {
					const path = sectionPaths[i]!;
					if (
						this.#sections[i]!.title === entry.section.title &&
						contentHashes[i] === entry.section.contentHash &&
						path.length === storedPath.length &&
						path.every((segment, pathIndex) => segment === storedPath[pathIndex])
					) {
						matchingSections.push(i);
					}
				}
			} else {
				matchingSections =
					storedIndex >= 0 &&
					storedIndex < this.#sections.length &&
					this.#sections[storedIndex]!.title === entry.section.title
						? [storedIndex]
						: [];
			}
			if (matchingSections.length === 0) continue;
			const sectionIndex = matchingSections.reduce((best, candidate) =>
				Math.abs(candidate - storedIndex) < Math.abs(best - storedIndex) ? candidate : best,
			);
			const section = this.#sections[sectionIndex]!;
			if (entry.target.kind === "section") {
				if (section.level >= 1) {
					section.annotations.push({ id: this.#newAnnotationId(), note, target: { kind: "section" } });
				}
				continue;
			}
			if (entry.target.kind === "quote") {
				const { quote, at } = entry.target;
				if (typeof quote !== "string" || !quote || !Number.isFinite(at)) continue;
				// The quote where it was, else its nearest occurrence (possibly in another section).
				const stored = starts[sectionIndex]! + Math.max(0, Math.trunc(at));
				const found = source.startsWith(quote, stored) ? stored : nearestOccurrence(source, quote, stored);
				if (found < 0) continue;
				const owner = sectionAt(starts, found);
				this.#sections[owner]!.annotations.push({
					id: this.#newAnnotationId(),
					note,
					target: { kind: "quote", quote, at: found - starts[owner]! },
				});
				continue;
			}
			if (
				entry.target.kind !== "line" ||
				!Number.isFinite(entry.target.row) ||
				typeof entry.target.context !== "string"
			) {
				continue;
			}
			const contexts = lineContexts(section.md.render(MAX_ANNOTATION_CONTEXT_WIDTH));
			const row = resolveLineRow(
				entry.target.row,
				{ text: entry.target.context, truncated: entry.target.contextTruncated === true },
				contexts,
			);
			if (row < 0) continue;
			const context = contexts[row]!;
			section.annotations.push({
				id: this.#newAnnotationId(),
				note,
				target: {
					kind: "line",
					row,
					context: context.text,
					contextTruncated: context.truncated,
				},
			});
		}
	}

	/**
	 * Replace the plan source with `next` (an in-place native edit), keeping every
	 * annotation: offsets outside the edited span move with the text around them;
	 * a quote touching the edit is found again nearest where it was; section and
	 * line notes follow their heading (same title and ancestry), a line note whose
	 * row is gone becomes a note on its section, and a note whose heading is gone
	 * lands on the section now at its old place.
	 */
	#replaceText(next: string): void {
		const previous = this.#source();
		const oldStarts = this.#sectionStarts();
		const oldPaths = this.#sectionPaths();
		const carried = this.#sections.flatMap((section, index) =>
			section.annotations.map(annotation => ({ annotation, section, index })),
		);
		// The edit is the span between the common prefix and suffix of the two sources.
		const limit = Math.min(previous.length, next.length);
		let prefix = 0;
		while (prefix < limit && previous.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
		let suffix = 0;
		while (
			suffix < limit - prefix &&
			previous.charCodeAt(previous.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
		) {
			suffix++;
		}
		const delta = next.length - previous.length;
		const editEnd = previous.length - suffix;
		const mapOffset = (offset: number): number =>
			offset <= prefix ? offset : offset >= editEnd ? offset + delta : prefix;

		this.#setSections(next);
		const starts = this.#sectionStarts();
		const paths = this.#sectionPaths();
		for (const { annotation, section: oldSection, index } of carried) {
			const target = annotation.target;
			if (target.kind === "quote") {
				const oldAt = oldStarts[index]! + target.at;
				const untouched = oldAt + target.quote.length <= prefix || oldAt >= editEnd;
				const found = untouched ? mapOffset(oldAt) : nearestOccurrence(next, target.quote, mapOffset(oldAt));
				// Not found: keep it where its text was; the document shows it orphaned.
				const at = found >= 0 ? found : Math.min(mapOffset(oldAt), next.length);
				const owner = sectionAt(starts, at);
				this.#sections[owner]?.annotations.push({ ...annotation, target: { ...target, at: at - starts[owner]! } });
				continue;
			}
			const mappedStart = mapOffset(oldStarts[index]!);
			const oldPath = oldPaths[index]!;
			let owner = -1;
			for (let i = 0; i < this.#sections.length; i++) {
				const path = paths[i]!;
				if (
					this.#sections[i]!.title !== oldSection.title ||
					this.#sections[i]!.level !== oldSection.level ||
					path.length !== oldPath.length ||
					!path.every((segment, pathIndex) => segment === oldPath[pathIndex])
				) {
					continue;
				}
				if (owner < 0 || Math.abs(starts[i]! - mappedStart) < Math.abs(starts[owner]! - mappedStart)) owner = i;
			}
			if (owner < 0) owner = sectionAt(starts, mappedStart);
			const section = this.#sections[owner];
			if (!section) continue;
			if (target.kind === "line") {
				const contexts = lineContexts(section.md.render(MAX_ANNOTATION_CONTEXT_WIDTH));
				const row = resolveLineRow(
					target.row,
					{ text: target.context, truncated: target.contextTruncated },
					contexts,
				);
				if (row >= 0) {
					const context = contexts[row]!;
					section.annotations.push({
						...annotation,
						target: { kind: "line", row, context: context.text, contextTruncated: context.truncated },
					});
					continue;
				}
			}
			section.annotations.push({ ...annotation, target: { kind: "section" } });
		}
	}

	/**
	 * The native document's edited source: the plan with its title heading line
	 * put back (where it was, or on top when the text before it changed). The
	 * annotations follow ({@link #replaceText}); undo snapshots predate the edit
	 * and are dropped; the owner gets the full text.
	 */
	#applyDocText(text: string): void {
		const title = this.#titleLine();
		let next = text;
		if (title) {
			const at = text.startsWith(this.#source().slice(0, title.start)) ? title.start : 0;
			const rest = text.slice(at);
			const line = rest && !title.line.endsWith("\n") ? `${title.line}\n` : title.line;
			next = text.slice(0, at) + line + rest;
		}
		if (next === this.#source()) return;
		this.#replaceText(next);
		this.#undo = [];
		this.callbacks.onPlanEdited?.(joinPlanSections(this.#sections));
		this.#recomputeFeedback();
	}

	/** A comment on the native document's `quote` at document offset `at`, filed under the section holding it. */
	#addQuoteAnnotation(quote: string, at: number, note: string): void {
		const trimmed = note.trim();
		if (!trimmed || !quote) return;
		// Document offsets past the omitted title line sit one title line further into the source.
		const title = this.#titleLine();
		const docAt = Math.max(0, Math.trunc(at));
		const offset = Math.min(title && docAt >= title.start ? docAt + title.line.length : docAt, this.#source().length);
		const starts = this.#sectionStarts();
		const owner = sectionAt(starts, offset);
		const section = this.#sections[owner];
		if (!section) return;
		this.#pushUndo();
		section.annotations.push({
			id: this.#newAnnotationId(),
			note: trimmed,
			target: { kind: "quote", quote, at: offset - starts[owner]! },
		});
		this.#recomputeFeedback();
	}

	/** Set (or, blank, delete) the note of annotation `id`. */
	#setAnnotationNote(id: string, note: string): void {
		for (const section of this.#sections) {
			const index = section.annotations.findIndex(annotation => annotation.id === id);
			if (index < 0) continue;
			const trimmed = note.trim();
			if (trimmed === section.annotations[index]!.note) return;
			this.#pushUndo();
			if (trimmed) section.annotations[index]!.note = trimmed;
			else section.annotations.splice(index, 1);
			this.#recomputeFeedback();
			return;
		}
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
		this.#titleIndex = titleIndex ?? -1;
		this.#toc = headings.filter(i => i !== titleIndex);
		this.#tocBaseLevel = this.#toc.length > 0 ? Math.min(...this.#toc.map(i => this.#sections[i]!.level)) : 1;
	}

	/** The option list: Refine while the plan has feedback, the approval choices, then Save. */
	#entries(): readonly OptionEntry[] {
		const feedback = this.#hasFeedback && this.#refine !== undefined;
		if (this.#entryCache?.feedback === feedback) return this.#entryCache.entries;
		const entries: OptionEntry[] = [];
		if (feedback && this.#refine) entries.push({ kind: "refine", ...this.#refine });
		for (const choice of this.#choices) entries.push({ kind: "approve", choice });
		if (this.callbacks.onSave) entries.push({ kind: "save" });
		this.#entryCache = { feedback, entries };
		return entries;
	}

	#isDisabled(index: number): boolean {
		const entry = this.#entries()[index];
		return entry?.kind === "approve" && entry.choice.disabled !== undefined;
	}

	/** Clamp `index` to range, then walk to the nearest enabled option so the
	 *  cursor never rests on a disabled row. */
	#coerceIndex(index: number): number {
		const max = this.#entries().length - 1;
		if (max < 0) return -1;
		const clamped = Math.max(0, Math.min(index, max));
		if (!this.#isDisabled(clamped)) return clamped;
		for (let i = clamped + 1; i <= max; i++) if (!this.#isDisabled(i)) return i;
		for (let i = clamped - 1; i >= 0; i--) if (!this.#isDisabled(i)) return i;
		return clamped;
	}

	/** First enabled option index (or -1 when none), used to detect the "top". */
	#firstEnabledIndex(): number {
		const count = this.#entries().length;
		for (let i = 0; i < count; i++) if (!this.#isDisabled(i)) return i;
		return -1;
	}

	/** Move the option cursor by `delta`, skipping disabled rows, stopping at the
	 *  list edge. */
	#moveSelection(delta: number): void {
		const max = this.#entries().length - 1;
		if (max < 0) return;
		let index = this.#selectedIndex;
		while (true) {
			const next = Math.max(0, Math.min(index + delta, max));
			if (next === index) return;
			index = next;
			if (!this.#isDisabled(index)) {
				this.#selectedIndex = index;
				return;
			}
		}
	}

	/** Track Refine coming and going: it arrives preselected; when it leaves, the cursor keeps its option. */
	#setHasFeedback(hasFeedback: boolean): void {
		if (hasFeedback === this.#hasFeedback) return;
		this.#hasFeedback = hasFeedback;
		if (!this.#refine) return;
		this.#selectedIndex = hasFeedback ? 0 : this.#coerceIndex(Math.max(0, this.#selectedIndex - 1));
		this.#hoveredOption = undefined;
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

	/** Replace the execution model control without notifying its change handler. */
	setSlider(slider: HookSelectorSlider): void {
		if (this.#committed) return;
		this.#slider = slider.segments.length
			? {
					...slider,
					segments: slider.segments.map(({ label, detail }) => ({
						label: sanitizeStatusText(label),
						detail: detail === undefined ? undefined : sanitizeStatusText(detail),
					})),
				}
			: undefined;
		this.#sliderIndex = Math.max(0, Math.min(slider.index, slider.segments.length - 1));
		this.#nativeRoot = undefined;
	}

	/** Synchronize an external tier pick with the displayed slider before committing. */
	setSliderIndex(index: number): void {
		if (this.#committed || !this.#slider) return;
		this.#moveSlider(index - this.#sliderIndex);
	}

	/** Replace the approval choices (e.g. re-measured for a new slider tier); the cursor leaves a now-disabled row. */
	setChoices(choices: readonly PlanReviewOverlayChoice[]): void {
		this.#choices = choices;
		this.#entryCache = undefined;
		this.#choicesRev++;
		this.#selectedIndex = this.#coerceIndex(this.#selectedIndex);
		if (this.#hoveredOption !== undefined && this.#isDisabled(this.#hoveredOption)) this.#hoveredOption = undefined;
	}

	/**
	 * Commit an external answer through the same input-locking path as Enter: an
	 * enabled approval choice, or Refine (offered or not: the caller brings its own
	 * feedback). False when nothing was committed.
	 */
	selectOption(id: string): boolean {
		if (this.#committed) return false;
		if (this.#refine?.id === id) {
			this.#commit(id, this.#refine.label);
			return true;
		}
		const choice = this.#choices.find(candidate => candidate.id === id);
		if (!choice || choice.disabled !== undefined) return false;
		this.#commit(choice.id, choice.label);
		return true;
	}

	#commit(id: string, label: string): void {
		this.#committed = true;
		this.#committedLabel = label;
		this.callbacks.onPick(id);
	}

	/** Run the option at `index`: Save keeps the review open, the others commit. */
	#runEntry(index: number): void {
		const entry = this.#entries()[index];
		if (!entry || this.#isDisabled(index)) return;
		if (entry.kind === "save") this.#save();
		else if (entry.kind === "refine") this.#commit(entry.id, entry.label);
		else this.#commit(entry.choice.id, entry.choice.label);
	}

	#save(): void {
		this.callbacks.onSave?.(joinPlanSections(this.#sections));
	}

	/** The native main button: Refine while the plan has feedback, else the first enabled approval choice. */
	#runMainAction(): void {
		if (this.#hasFeedback && this.#refine) {
			this.#commit(this.#refine.id, this.#refine.label);
			return;
		}
		const choice = this.#choices.find(candidate => candidate.disabled === undefined);
		if (choice) this.#commit(choice.id, choice.label);
	}

	handleInput(keyData: string): void {
		if (this.#committed) return;
		if (keyData.startsWith("\x1b[<") && this.#handleMouse(keyData)) return;
		if (this.#annotationChooser) {
			this.#handleAnnotationChooser(keyData);
			return;
		}
		if (this.#annotating) {
			if (this.callbacks.onAnnotationExternalEditor && matchesAppExternalEditor(keyData)) {
				this.callbacks.onAnnotationExternalEditor(this.#editor.getExpandedText(), text => {
					if (text !== null && this.#annotating) this.#editor.setText(text);
				});
				return;
			}
			if (matchesSelectCancel(keyData)) {
				this.#exitAnnotate();
				return;
			}
			this.#editor.handleInput(keyData);
			return;
		}
		if (this.callbacks.onCustomModel && getKeybindings().matches(keyData, "app.model.select")) {
			this.callbacks.onCustomModel();
			return;
		}
		if (matchesSelectCancel(keyData)) {
			this.#committed = true;
			this.callbacks.onCancel();
			return;
		}
		if (this.#nativeDock && isNativeRendering()) {
			this.#handleDockKeys(keyData);
			return;
		}
		if (this.#focus !== "actions" && keyData === "u") {
			this.#undoLast();
			return;
		}
		if (this.#focus !== "actions" && keyData === "e") {
			this.#editCurrentAnnotation();
			return;
		}
		if (this.callbacks.onExternalEditor && matchesAppExternalEditor(keyData)) {
			this.callbacks.onExternalEditor();
			return;
		}
		if (this.callbacks.onCopyPlan && keyData === "c") {
			void this.callbacks.onCopyPlan(joinPlanSections(this.#sections));
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
				this.#captureScrollProgress();
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
				if (!this.#isDisabled(optionIndex)) {
					this.#focus = "actions";
					this.#selectedIndex = optionIndex;
					this.#runEntry(this.#selectedIndex);
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
		this.#hoveredOption = index !== undefined && !this.#isDisabled(index) ? index : undefined;
	}

	/**
	 * Keys under the native dock: Enter runs the main button (Approve, or Refine
	 * while the plan has feedback), ←/→ pick the model, ↑/↓ walk the Contents,
	 * `d` deletes its section and `u` undoes. Without the native document (whose
	 * selections take comments) `a`/`e` annotate the Contents section.
	 */
	#handleDockKeys(data: string): void {
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#runMainAction();
			return;
		}
		if (matchesKey(data, "left")) {
			this.#moveSlider(-1);
			return;
		}
		if (matchesKey(data, "right")) {
			this.#moveSlider(1);
			return;
		}
		if (data === "u") {
			this.#undoLast();
			return;
		}
		if (!this.#sidebarShown) return;
		this.#focus = "toc";
		if (matchesSelectUp(data) || matchesKey(data, "k")) this.#moveTocCursor(-1);
		else if (matchesSelectDown(data) || matchesKey(data, "j")) this.#moveTocCursor(1);
		else if (data === "d" || matchesKey(data, "delete")) this.#deleteSelectedSection();
		else if (!this.#nativeDoc && data === "a") this.#startSectionAnnotate();
		else if (!this.#nativeDoc && data === "e") this.#editCurrentAnnotation();
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
		if (isNativeRendering()) {
			this.#handleNativeActions(data);
			return;
		}
		// Left/right always drive the slider. The sidebar sits beside the body
		// (above this row), not the slider, so stealing left for it would strand
		// the operator unable to step the model tier back — reach the ToC via Tab.
		const isLeft = matchesKey(data, "left") || (this.#slider !== undefined && matchesKey(data, "h"));
		const isRight = matchesKey(data, "right") || (this.#slider !== undefined && matchesKey(data, "l"));
		if (isLeft) {
			this.#moveSlider(-1);
			return;
		}
		if (isRight) {
			this.#moveSlider(1);
			return;
		}
		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			if (this.#selectedIndex === this.#firstEnabledIndex()) this.#setFocus("body");
			else this.#moveSelection(-1);
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			this.#moveSelection(1);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#runEntry(this.#selectedIndex);
			return;
		}
		this.#handleBodyScroll(data);
	}

	/** Tern lays the options out as a horizontal decision bar: ←/→ step through
	 *  it, ↑ returns to the body above, and the model slider moves to Shift+←/→. */
	#handleNativeActions(data: string): void {
		if (matchesKey(data, "shift+left")) {
			this.#moveSlider(-1);
			return;
		}
		if (matchesKey(data, "shift+right")) {
			this.#moveSlider(1);
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "h")) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "l")) {
			this.#moveSelection(1);
			return;
		}
		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			this.#setFocus("body");
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "j")) return;
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#runEntry(this.#selectedIndex);
			return;
		}
		this.#handleBodyScroll(data);
	}

	#handleBody(data: string): void {
		if (data === "a") {
			this.#startBodyAnnotate();
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "h")) {
			if (this.#sidebarShown) this.#setFocus("toc");
			return;
		}
		if (
			matchesKey(data, "right") ||
			matchesKey(data, "l") ||
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
		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			if (this.#scrollView.getScrollOffset() <= 0 && this.#sidebarShown) {
				this.#setFocus("toc");
			} else {
				this.#scrollView.scroll(-1);
				this.#captureScrollProgress();
			}
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			if (this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset()) {
				this.#setFocus("actions");
			} else {
				this.#scrollView.scroll(1);
				this.#captureScrollProgress();
			}
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
		if (this.#scrollView.handleScrollKey(data)) {
			if (matchesKey(data, "home")) this.#scrollProgress = 0;
			else if (matchesKey(data, "end")) this.#scrollProgress = 1;
			else this.#captureScrollProgress();
			return;
		}
		if (data === "g") {
			this.#scrollView.scrollToTop();
			this.#scrollProgress = 0;
		} else if (data === "G") {
			this.#scrollView.scrollToBottom();
			this.#scrollProgress = 1;
		}
	}

	#handleToc(data: string): void {
		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			this.#moveTocCursor(-1);
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			// Past the last section, fall through to the actions ("next step").
			if (this.#tocCursor >= this.#toc.length - 1) this.#setFocus("actions");
			else this.#moveTocCursor(1);
			return;
		}
		if (
			matchesKey(data, "right") ||
			matchesKey(data, "l") ||
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
			this.#startSectionAnnotate();
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
		this.#jump = { section: sectionIndex, n: (this.#jump?.n ?? 0) + 1 };
		const offset = this.#sectionOffsets[sectionIndex];
		if (offset !== undefined) {
			this.#scrollView.setScrollOffset(offset);
			this.#captureScrollProgress();
		}
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
		if (this.#undo.length >= MAX_UNDO_ENTRIES) this.#undo.shift();
		this.#undo.push({
			text: joinPlanSections(this.#sections),
			annotations: this.#sections.map(section =>
				section.annotations.map(annotation => this.#cloneAnnotation(annotation)),
			),
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
			this.#sections[i]!.annotations =
				entry.annotations[i]?.map(annotation => this.#cloneAnnotation(annotation)) ?? [];
		}
		this.#deleted = [...entry.deleted];
		this.#tocCursor = Math.min(this.#tocCursor, Math.max(0, this.#toc.length - 1));
		this.#pendingScrollToToc = true;
		this.callbacks.onPlanEdited?.(joinPlanSections(this.#sections));
		this.#recomputeFeedback();
	}

	#startSectionAnnotate(): void {
		const sectionIndex = this.#toc[this.#tocCursor];
		if (sectionIndex === undefined) return;
		this.#startAnnotate({ sectionIndex, row: null, context: null });
	}

	#startBodyAnnotate(): void {
		const maxRow = this.#bodyRowAnchors.length - 1;
		if (maxRow < 0) return;
		const topRow = Math.max(0, Math.min(maxRow, Math.floor(this.#scrollView.getScrollOffset())));
		this.#startAnnotate(this.#bodyRowAnchors[topRow]!);
	}

	#startAnnotate(target: BodyRowAnchor | { sectionIndex: number; row: null; context: null }): void {
		this.#annotationTarget = target;
		this.#editingAnnotation = undefined;
		this.#annotating = true;
		this.#editor.setText("");
	}

	#startExistingAnnotation(selection: AnnotationSelection): void {
		const section = this.#sections[selection.sectionIndex];
		const annotation = section?.annotations[selection.annotationIndex];
		if (!section || !annotation) return;
		this.#annotationChooser = undefined;
		this.#editingAnnotation = selection;
		this.#annotationTarget =
			annotation.target.kind === "line"
				? {
						sectionIndex: selection.sectionIndex,
						row: annotation.target.row,
						context: annotation.target.context,
						contextTruncated: annotation.target.contextTruncated,
					}
				: { sectionIndex: selection.sectionIndex, row: null, context: null };
		this.#annotating = true;
		this.#editor.setText(annotation.note);
	}

	#annotationMatchesBodyAnchor(annotation: OverlayAnnotation, anchor: BodyRowAnchor): boolean {
		if (annotation.target.kind === "section") return true;
		if (
			annotation.target.kind === "line" &&
			annotation.target.row === anchor.row &&
			annotation.target.context === anchor.context
		) {
			return true;
		}
		const seenRows = new Set<number>();
		const sectionAnchors: LineAnchorContext[] = [];
		for (const candidate of this.#bodyRowAnchors) {
			if (candidate.sectionIndex !== anchor.sectionIndex || seenRows.has(candidate.row)) continue;
			seenRows.add(candidate.row);
			sectionAnchors.push({ text: candidate.context, truncated: candidate.contextTruncated });
		}
		const resolvedRow =
			annotation.target.kind === "quote"
				? quoteRow(sectionAnchors, annotation.target.quote)
				: resolveLineRow(
						annotation.target.row,
						{ text: annotation.target.context, truncated: annotation.target.contextTruncated },
						sectionAnchors,
					);
		return resolvedRow === anchor.row;
	}

	#annotationCandidates(): AnnotationSelection[] {
		if (this.#focus === "toc") {
			const sectionIndex = this.#toc[this.#tocCursor];
			const section = sectionIndex === undefined ? undefined : this.#sections[sectionIndex];
			if (!section || section.annotations.length === 0) return [];
			return section.annotations.map((_, annotationIndex) => ({ sectionIndex, annotationIndex }));
		}
		if (this.#focus !== "body") return [];
		const maxRow = this.#bodyRowAnchors.length - 1;
		if (maxRow < 0) return [];
		const topRow = Math.max(0, Math.min(maxRow, Math.floor(this.#scrollView.getScrollOffset())));
		const anchor = this.#bodyRowAnchors[topRow];
		const section = anchor ? this.#sections[anchor.sectionIndex] : undefined;
		if (!anchor || !section) return [];
		const entries: AnnotationSelection[] = [];
		for (const [annotationIndex, annotation] of section.annotations.entries()) {
			if (this.#annotationMatchesBodyAnchor(annotation, anchor)) {
				entries.push({ sectionIndex: anchor.sectionIndex, annotationIndex });
			}
		}
		return entries;
	}

	#editCurrentAnnotation(): void {
		const entries = this.#annotationCandidates();
		if (entries.length === 0) return;
		if (entries.length === 1) {
			this.#startExistingAnnotation(entries[0]!);
			return;
		}
		this.#annotationChooser = { entries, selected: 0 };
	}

	#handleAnnotationChooser(data: string): void {
		const chooser = this.#annotationChooser;
		if (!chooser) return;
		if (matchesSelectCancel(data)) {
			this.#annotationChooser = undefined;
			return;
		}
		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			chooser.selected = (chooser.selected - 1 + chooser.entries.length) % chooser.entries.length;
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			chooser.selected = (chooser.selected + 1) % chooser.entries.length;
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			const selection = chooser.entries[chooser.selected];
			this.#annotationChooser = undefined;
			if (selection) this.#startExistingAnnotation(selection);
		}
	}

	#submitAnnotation(value: string): void {
		const note = value.trim();
		const target = this.#annotationTarget;
		const editing = this.#editingAnnotation;
		this.#annotating = false;
		this.#annotationTarget = undefined;
		this.#editingAnnotation = undefined;
		this.#editor.setText("");
		if (editing) {
			const section = this.#sections[editing.sectionIndex];
			const annotation = section?.annotations[editing.annotationIndex];
			if (!section || !annotation) return;
			this.#pushUndo();
			if (note) annotation.note = note;
			else section.annotations.splice(editing.annotationIndex, 1);
			this.#recomputeFeedback();
			return;
		}
		if (!note || !target) return;
		const section = this.#sections[target.sectionIndex];
		if (!section) return;
		this.#pushUndo();
		section.annotations.push({
			id: this.#newAnnotationId(),
			note,
			target:
				target.row === null
					? { kind: "section" }
					: {
							kind: "line",
							row: target.row,
							context: target.context,
							contextTruncated: target.contextTruncated,
						},
		});
		this.#recomputeFeedback();
	}

	#exitAnnotate(): void {
		this.#annotating = false;
		this.#annotationTarget = undefined;
		this.#editingAnnotation = undefined;
		this.#editor.setText("");
	}

	#recomputeFeedback(): void {
		this.#annotationRev++;
		this.callbacks.onAnnotationStateChange?.(this.#annotationState());
		const annotated = this.#sections.filter(section => section.annotations.length > 0);
		this.#setHasFeedback(annotated.length > 0 || this.#deleted.length > 0);
		if (!this.#hasFeedback) {
			this.callbacks.onFeedbackChange?.("");
			return;
		}
		let feedback = "Refinement feedback on the plan:\n";
		if (this.#deleted.length > 0) {
			feedback += "\nRemove these sections:\n";
			for (const title of this.#deleted) feedback += `- ${title}\n`;
		}
		for (const section of annotated) {
			feedback += `\n## ${section.title || "Plan preamble"}\n`;
			for (const annotation of section.annotations) {
				if (annotation.target.kind === "line") feedback += `> Line: ${annotation.target.context}\n`;
				else if (annotation.target.kind === "quote") feedback += `> "${quoteLine(annotation.target.quote)}"\n`;
				feedback += this.#formatAnnotationFeedback(annotation.note);
			}
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

	#renderSliderLines(width: number): string[] {
		const slider = this.#slider;
		if (!slider) return [];
		const active = this.#sliderIndex;
		const track = renderSegmentTrack(slider.segments, active);
		const leftArrow = theme.fg(active > 0 ? "accent" : "dim", "◂");
		const rightArrow = theme.fg(active < slider.segments.length - 1 ? "accent" : "dim", "▸");
		const caption = slider.caption ? `${theme.fg("dim", slider.caption)}  ` : "";
		const trackLine = `${caption}${leftArrow}  ${track}  ${rightArrow}`;
		const detail = slider.segments[active]?.detail;
		if (!detail) return [truncateToWidth(trackLine, width)];
		return [
			truncateToWidth(trackLine, width),
			truncateToWidth(`  ${theme.fg("dim", "↳")} ${theme.fg("muted", detail)}`, width),
		];
	}

	/** An option's label and, for an approval choice with one, its dim `meta`. */
	#entryLabel(entry: OptionEntry): { label: string; meta?: string } {
		if (entry.kind === "approve") return { label: entry.choice.label, meta: entry.choice.meta };
		return { label: entry.kind === "refine" ? entry.label : SAVE_LABEL };
	}

	#renderOptionLines(): string[] {
		const active = this.#focus === "actions";
		return this.#entries().map((entry, i) => {
			const { label, meta } = this.#entryLabel(entry);
			const selected = i === this.#selectedIndex;
			const isDisabled = this.#isDisabled(i);
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
			if (meta) text += ` ${theme.fg("dim", `(${meta})`)}`;
			if (hovered) text = theme.bg("selectedBg", ` ${text} `);
			return cursor + text;
		});
	}

	#buildHelp(): string {
		const sep = " · ";
		const parts: string[] = [];
		const upDown = editorKeys("tui.select.up", "tui.select.down");
		const enter = formatKeyHint("enter");
		switch (this.#focus) {
			case "actions":
				parts.push(`${upDown} select`, `${enter} confirm`);
				if (this.#slider) parts.push(`${formatKeyHints(["left", "right"])} model`);
				break;
			case "toc":
				parts.push(
					`${upDown} section`,
					`${enter} open`,
					`${formatKeyHint("a")} annotate`,
					`${formatKeyHint("e")} edit`,
					`${formatKeyHint("d")} delete`,
					`${formatKeyHint("u")} undo`,
				);
				break;
			case "body":
				parts.push(
					`${upDown} scroll`,
					`${formatKeyHint("shift")} faster`,
					formatKeyHints(["pageUp", "pageDown"]),
					`${formatKeyHints(["g", "shift+g"])} ends`,
					`${formatKeyHint("a")} annotate`,
					`${formatKeyHint("e")} edit`,
					`${formatKeyHint("u")} undo`,
				);
				break;
		}
		if (this.callbacks.onCustomModel && editorKey("app.model.select"))
			parts.push(`${editorKey("app.model.select")} custom model`);
		if (this.callbacks.onCopyPlan) parts.push(`${formatKeyHint("c")} copy`);
		parts.push(`${formatKeyHint("tab")} regions`);
		if (this.#externalEditorLabel && this.#focus !== "toc") parts.push(`${this.#externalEditorLabel} editor`);
		parts.push(this.#helpSuffix ?? `${editorKey("tui.select.cancel")} cancel`);
		return parts.join(sep);
	}

	/**
	 * Retain relative progress across reflow frames. A non-scrollable intermediate
	 * frame has no meaningful offset, so it must not erase the last scroll position.
	 */
	#captureScrollProgress(): void {
		const maxOffset = this.#scrollView.getMaxScrollOffset();
		if (maxOffset > 0) this.#scrollProgress = this.#scrollView.getScrollOffset() / maxOffset;
	}

	#layoutBody(lines: readonly string[], height: number): void {
		this.#captureScrollProgress();
		if (lines !== this.#scrollLines) {
			this.#scrollView.setLines(lines);
			this.#scrollLines = lines;
		}
		this.#scrollView.setHeight(height);
		const maxOffset = this.#scrollView.getMaxScrollOffset();
		if (maxOffset > 0) this.#scrollView.setScrollOffset(Math.round(this.#scrollProgress * maxOffset));
	}

	/**
	 * Build the concatenated body lines and map each rendered row back to a plan
	 * anchor. Memoized on width, annotation revision, theme/width epochs and each
	 * section's rendered-lines identity, so steady frames and scrolling reuse it.
	 */
	#buildBody(bodyContentWidth: number): readonly string[] {
		const themeEpoch = getThemeEpoch();
		const widthEpoch = getWidthConfigEpoch();
		const cached = this.#bodyLayout;
		if (
			cached?.width === bodyContentWidth &&
			cached.annotationRev === this.#annotationRev &&
			cached.themeEpoch === themeEpoch &&
			cached.widthEpoch === widthEpoch &&
			cached.rendered.length === this.#sections.length &&
			this.#sections.every((section, i) => section.md.render(bodyContentWidth) === cached.rendered[i])
		) {
			this.#sectionOffsets = cached.offsets;
			this.#bodyRowAnchors = cached.anchors;
			return cached.lines;
		}
		const lines: string[] = [];
		const anchors: BodyRowAnchor[] = [];
		const renderedSections: (readonly string[])[] = [];
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const offsets: number[] = new Array(this.#sections.length);
		for (let sectionIndex = 0; sectionIndex < this.#sections.length; sectionIndex++) {
			const section = this.#sections[sectionIndex]!;
			offsets[sectionIndex] = lines.length;
			const rendered = section.md.render(bodyContentWidth);
			renderedSections.push(rendered);
			const contexts = lineContexts(rendered);
			// Resolve each note's row once; notes on one row keep their array order.
			let notesByRow: Map<number, OverlayAnnotation[]> | undefined;
			for (const annotation of section.annotations) {
				const target = annotation.target;
				const annotationRow =
					target.kind === "section"
						? 0
						: target.kind === "quote"
							? quoteRow(contexts, target.quote)
							: resolveLineRow(
									target.row,
									{ text: target.context, truncated: target.contextTruncated },
									contexts,
								);
				if (annotationRow < 0) continue;
				notesByRow ??= new Map();
				const notes = notesByRow.get(annotationRow);
				if (notes) notes.push(annotation);
				else notesByRow.set(annotationRow, [annotation]);
			}
			for (let row = 0; row < rendered.length; row++) {
				const context = contexts[row]!;
				const anchor = {
					sectionIndex,
					row,
					context: context.text,
					contextTruncated: context.truncated,
				};
				lines.push(rendered[row]!);
				anchors.push(anchor);
				const notes = notesByRow?.get(row);
				if (!notes) continue;
				for (const annotation of notes) {
					this.#appendAnnotationCallout(lines, anchors, annotation, anchor, bodyContentWidth);
				}
			}
		}
		this.#sectionOffsets = offsets;
		this.#bodyRowAnchors = anchors;
		this.#bodyLayout = {
			width: bodyContentWidth,
			annotationRev: this.#annotationRev,
			themeEpoch,
			widthEpoch,
			rendered: renderedSections,
			lines,
			anchors,
			offsets,
		};
		return lines;
	}

	/** A note under its anchor row; a quote note leads with the quoted text. */
	#appendAnnotationCallout(
		lines: string[],
		anchors: BodyRowAnchor[],
		annotation: OverlayAnnotation,
		anchor: BodyRowAnchor,
		bodyContentWidth: number,
	): void {
		if (annotation.target.kind === "quote") {
			const prefix = theme.fg("warning", "▎ ");
			const quote = `“${replaceTabs(sanitizeText(quoteLine(annotation.target.quote)))}”`;
			const available = Math.max(0, bodyContentWidth - visibleWidth(prefix));
			lines.push(`${prefix}${theme.fg("muted", truncateToWidth(quote, available, Ellipsis.Unicode))}`);
			anchors.push(anchor);
		}
		const noteLines = annotation.note.split(/\r?\n/);
		for (let i = 0; i < noteLines.length; i++) {
			const prefix =
				i === 0
					? `${theme.fg("warning", "▎ ")}${theme.fg("dim", "note: ")}`
					: `${theme.fg("warning", "▎ ")}${theme.fg("dim", "      ")}`;
			const available = Math.max(0, bodyContentWidth - visibleWidth(prefix));
			const displayLine = truncateToWidth(
				replaceTabs(sanitizeText(noteLines[i] ?? "")),
				available,
				Ellipsis.Unicode,
			);
			lines.push(truncateToWidth(`${prefix}${theme.fg("accent", displayLine)}`, bodyContentWidth));
			anchors.push(anchor);
		}
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
		if (selected) return theme.bg("selectedBg", theme.bold(width > 0 ? padToWidth(line, width) : ""));
		if (glow) return theme.fg("accent", line);
		return theme.fg("muted", line);
	}
	#renderAnnotationChooserLines(innerWidth: number, maxRows = Number.POSITIVE_INFINITY): string[] {
		const chooser = this.#annotationChooser;
		if (!chooser || maxRows <= 0) return [];
		const optionLimit = Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows) - 2) : chooser.entries.length;
		const start =
			optionLimit >= chooser.entries.length
				? 0
				: Math.max(
						0,
						Math.min(chooser.selected - Math.floor(optionLimit / 2), chooser.entries.length - optionLimit),
					);
		const lines = [theme.bold(theme.fg("accent", "Edit annotation"))];
		for (let windowIndex = 0; windowIndex < optionLimit; windowIndex++) {
			const optionIndex = start + windowIndex;
			const selection = chooser.entries[optionIndex];
			if (!selection) continue;
			const section = this.#sections[selection.sectionIndex];
			const annotation = section?.annotations[selection.annotationIndex];
			if (!section || !annotation) continue;
			const target = annotationWhere(annotation.target);
			const note = sanitizeStatusText(annotation.note);
			const marker = optionIndex === chooser.selected ? theme.fg("accent", "› ") : "  ";
			const label = `${marker}${sanitizeStatusText(section.title || "Plan preamble")} · ${target} · ${note}`;
			lines.push(truncateToWidth(label, innerWidth, Ellipsis.Unicode));
		}
		if (!Number.isFinite(maxRows) || maxRows >= 2) {
			const upDown = editorKeys("tui.select.up", "tui.select.down");
			lines.push(
				theme.fg(
					"dim",
					`${upDown} choose · ${formatKeyHint("enter")} edit · ${editorKey("tui.select.cancel")} cancel`,
				),
			);
		}
		return lines.slice(0, Math.max(0, Math.floor(maxRows)));
	}

	#renderFooterLines(innerWidth: number, maxChooserRows = Number.POSITIVE_INFINITY): string[] {
		if (this.#annotationChooser) return this.#renderAnnotationChooserLines(innerWidth, maxChooserRows);
		if (this.#annotating) {
			const target = this.#annotationTarget;
			const section = target ? this.#sections[target.sectionIndex] : undefined;
			const title = sanitizeStatusText(section?.title || "Plan preamble");
			const location =
				target?.row === null
					? `‹${title}›`
					: `‹${title}› · ${truncateToWidth(target?.context ?? "", Math.max(1, innerWidth - 16), Ellipsis.Unicode)}`;
			const caption = truncateToWidth(
				`${theme.fg("dim", "Annotate")} ${theme.fg("accent", location)}`,
				innerWidth,
				Ellipsis.Unicode,
			);
			const hintParts = [
				`${editorKey("tui.input.submit")} save`,
				`${editorKey("tui.input.newLine")} newline`,
				`${editorKey("tui.select.cancel")} cancel`,
			];
			if (this.#editingAnnotation) hintParts.push("empty deletes");
			if (this.#externalEditorLabel) hintParts.push(`${this.#externalEditorLabel} editor`);
			this.#editor.setMaxHeight(Math.max(1, Math.min(MAX_ANNOTATION_EDITOR_ROWS, (process.stdout.rows || 40) - 12)));
			this.#editor.focused = true;
			return [caption, ...this.#editor.render(innerWidth), theme.fg("dim", hintParts.join(" · "))];
		}
		return [theme.fg("dim", this.#buildHelp())];
	}

	/** The native sheet: large glass, titled by the plan's own title heading (the body never repeats it). */
	get nativeOverlay(): NonNullable<Component["nativeOverlay"]> {
		const heading = this.#sections[this.#titleIndex]?.title;
		const title = heading ? sanitizeStatusText(heading) : NATIVE_TITLE;
		if (this.#nativeOverlay?.title !== title) {
			this.#nativeOverlay = {
				title,
				props: { role: "omp.overlay.planReview", size: "lg", anchor: "center", head: title },
			};
		}
		return this.#nativeOverlay.props;
	}

	describe(cx: DescribeContext): NativeNode {
		const doc = cx.supports("doc");
		const dock = cx.supports("buttons") && cx.supports("menu");
		this.#nativeDoc = doc;
		this.#nativeDock = dock;
		const content = this.#describeContent();
		// The terminal lays out the sidebar; it is shown whenever the Contents has
		// enough entries, which is also what Tab cycling consults. The document's
		// comment margin takes its place while the plan has comments.
		this.#sidebarShown = this.#toc.length >= SIDEBAR_MIN_HEADINGS && !(doc && content.comments.length > 0);
		if (this.#annotating) this.#editor.focused = true;
		const chooser = this.#annotationChooser;
		const target = this.#annotationTarget;
		const sig = [
			doc ? "doc" : "md",
			dock ? "dock" : "list",
			this.#sidebarShown,
			this.#hasFeedback,
			this.#focus,
			this.#tocCursor,
			this.#jump?.n ?? 0,
			this.#selectedIndex,
			this.#sliderIndex,
			this.#choicesRev,
			this.#committed ? `committed:${this.#committedLabel ?? ""}` : "",
			this.#annotating
				? `annotating:${target?.sectionIndex}:${target?.row}:${target?.context}:${this.#editingAnnotation !== undefined}`
				: "",
			chooser
				? `chooser:${chooser.selected}:${chooser.entries.map(e => `${e.sectionIndex}.${e.annotationIndex}`).join()}`
				: "",
		].join("|");
		if (this.#nativeRoot && sig === this.#nativeSig && content === this.#nativeRootContent) return this.#nativeRoot;

		const children: NativeChild[] = [];
		if (!dock && !this.#committed && !this.#annotating && !chooser) children.push(this.#describeCancelTool());
		const bodyCol = doc ? this.#describeDocBody(content) : this.#describeMdBody(content);
		if (this.#sidebarShown) {
			const tocSection = this.#toc[this.#tocCursor];
			const toc = selectList("toc", content.toc, {
				selected: tocSection === undefined ? null : `h${tocSection}`,
				role: "omp.plan.toc",
				tone: !dock && this.#focus === "toc" ? "accent" : undefined,
			});
			const sidebar = node("col", { max: { w: "32ch" }, shrink: 0 }, [toc], "sidebar");
			children.push(keyed(rowNode([sidebar, bodyCol], { gap: "lg", align: "start" }), "split"));
		} else {
			children.push(bodyCol);
		}
		if (!dock && this.#promptTitle) {
			children.push(keyed(text([span(this.#promptTitle, "muted")], { role: "omp.plan.prompt" }), "prompt"));
		}
		if (this.#committed) {
			const label = this.#committedLabel ? `${this.#committedLabel} — submitting…` : "Submitting…";
			children.push(node("spinner", { label: [span(label, "accent strong")] }, undefined, "options"));
			children.push(
				keyed(
					text([span("Applying your selection — this can take a moment while context is prepared.", "dim")], {
						wrap: "word",
					}),
					"footer",
				),
			);
		} else if (dock) {
			children.push(this.#describeDock());
			children.push(...this.#describeFooter());
		} else {
			children.push(...this.#describeSlider());
			// The decision bar: Tern lays the list out as buttons, the first one the hero.
			const optionItems = this.#entries().map((entry, i) => {
				const { label, meta } = this.#entryLabel(entry);
				return item(`o${i}`, {
					label: meta ? `${label} (${meta})` : label,
					disabled: this.#isDisabled(i) || undefined,
					hint: i === this.#selectedIndex ? ["enter"] : undefined,
				});
			});
			children.push(
				selectList("options", optionItems, {
					selected: this.#selectedIndex >= 0 ? `o${this.#selectedIndex}` : null,
					role: "omp.plan.options",
					tone: this.#focus === "actions" ? "accent" : undefined,
				}),
			);
			children.push(...this.#describeFooter());
		}

		this.#nativeSig = sig;
		this.#nativeRootContent = content;
		// The sheet is the frame: a borderless column, titled by `nativeOverlay`.
		this.#nativeRoot = col(children, { gap: "md" });
		return this.#nativeRoot;
	}

	/** The plan as one editable, commentable document; a Contents pick scrolls its heading to the top. */
	#describeDocBody(content: NativePlanContent): NativeNode {
		const jump = this.#jump;
		let heading = 0;
		if (jump) {
			for (let i = 0; i < Math.min(jump.section, this.#sections.length); i++) {
				if (this.#sections[i]!.level >= 1 && i !== this.#titleIndex) heading++;
			}
		}
		const docNode = node(
			"doc",
			{
				role: "omp.plan.doc",
				text: content.docText,
				edit: true,
				comment: true,
				comments: content.comments,
				...(jump ? { jump: { heading, n: jump.n } } : {}),
			},
			undefined,
			"doc",
		);
		return node("col", { role: "omp.plan.body", grow: 1 }, [docNode], "body");
	}

	/** One `md` per section with its note callouts (terminals without `doc`); a Contents pick reveals its section. */
	#describeMdBody(content: NativePlanContent): NativeNode {
		const jump = this.#jump;
		const body = jump
			? content.body.map((section): NativeNode =>
					section.key === `s${jump.section}` ? { ...section, reveal: { at: "start", n: jump.n } } : section,
				)
			: content.body;
		return node(
			"col",
			{ role: "omp.plan.body", grow: 1, gap: "md", tone: this.#focus === "body" ? "accent" : undefined },
			body,
			"body",
		);
	}

	/**
	 * The decision dock: the Approve split button (Refine while the plan has
	 * feedback) whose menu holds every approval choice, the model chip and custom
	 * model action, then Save and Cancel.
	 */
	#describeDock(): NativeNode {
		const refine = this.#hasFeedback && this.#refine !== undefined;
		const main = node(
			"button",
			{
				text: refine ? "Refine" : "Approve",
				variant: "primary",
				keys: ["enter"],
				actions: { click: refine ? "refine" : "approve" },
			},
			undefined,
			"main",
		);
		const menuItems: TspMenuItem[] = this.#choices.map(choice => {
			const detail = choice.detail ?? choice.meta;
			return {
				id: choice.id,
				label: choice.label,
				...(detail ? { detail } : {}),
				...(choice.disabled !== undefined ? { disabled: choice.disabled || true } : {}),
			};
		});
		const more = node(
			"menu",
			{ trigger: "primary", icon: "chev", title: "Approve options", align: "start", items: menuItems },
			undefined,
			"more",
		);
		const children: NativeNode[] = [
			node("buttons", { variant: "split", role: "omp.plan.approve" }, [main, more], "approve"),
		];
		const slider = this.#slider;
		if (slider || this.callbacks.onCustomModel) {
			const active = slider?.segments[this.#sliderIndex];
			children.push(
				node(
					"menu",
					{
						role: "omp.plan.model",
						text: active?.detail ?? active?.label ?? "Custom model…",
						caret: true,
						title: "Model that executes the plan",
						items: [
							...(slider?.segments.map((segment, i) => ({
								id: `tier:${i}`,
								label: segment.label,
								...(segment.detail ? { detail: segment.detail } : {}),
								radio: "tier",
								checked: i === this.#sliderIndex,
							})) ?? []),
							...(this.callbacks.onCustomModel ? [{ id: "custom-model", label: "Custom model…" }] : []),
						],
					},
					undefined,
					"model",
				),
			);
		}
		children.push(node("spacer", { grow: 1 }));
		if (this.callbacks.onSave) {
			children.push(
				node("button", { role: "omp.btn", text: SAVE_LABEL, actions: { click: "save" } }, undefined, "save"),
			);
		}
		const cancelKey = getKeybindings().getKeys("tui.select.cancel")[0];
		children.push(
			node(
				"button",
				{
					role: "omp.btn",
					text: "Cancel",
					...(cancelKey ? { keys: keyNames(cancelKey) } : {}),
					actions: { click: "cancel" },
				},
				undefined,
				"cancel",
			),
		);
		return node("row", { role: "omp.plan.dock", gap: "sm", align: "center" }, children, "dock");
	}

	/** A head Cancel button running the cancel key's path (terminals without the dock). */
	#describeCancelTool(): NativeNode {
		const cancelKey = getKeybindings().getKeys("tui.select.cancel")[0];
		return node(
			"row",
			{ role: "omp.plan.tools", gap: "sm", align: "center", justify: "end" },
			[actionButton("Cancel", "cancel", cancelKey ? { keys: cancelKey } : {})],
			"tools",
		);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#committed) return;
		switch (event.type) {
			case "docChange":
				this.#applyDocText(event.text);
				return;
			case "comment":
				this.#addQuoteAnnotation(event.quote, event.at, event.note);
				return;
			case "commentNote":
				this.#setAnnotationNote(event.comment, event.note);
				return;
			case "uncomment":
				this.#setAnnotationNote(event.comment, "");
				return;
			case "action":
				// While a note is drafted in omp's editor, the draft owns the sheet.
				if (!this.#annotating && !this.#annotationChooser) this.#handleNativeAction(event.key, event.act);
				return;
		}
		if (event.type !== "select" && event.type !== "activate") return;
		const activate = event.type === "activate";
		switch (leafKey(event.key)) {
			case "toc": {
				const pos = this.#toc.indexOf(itemIndex(event.item, "h"));
				if (pos < 0) return;
				this.#focus = "toc";
				this.#tocCursor = pos;
				this.#scrubBodyToToc();
				if (activate) this.#setFocus("body");
				return;
			}
			case "options": {
				const index = itemIndex(event.item, "o");
				if (index < 0 || index >= this.#entries().length || this.#isDisabled(index)) return;
				this.#focus = "actions";
				this.#selectedIndex = index;
				if (activate) this.#runEntry(this.#selectedIndex);
				return;
			}
			case "tabs": {
				const index = itemIndex(event.item, "t");
				if (index >= 0) this.#moveSlider(index - this.#sliderIndex);
				return;
			}
			case "chooser": {
				const chooser = this.#annotationChooser;
				const index = itemIndex(event.item, "c");
				if (!chooser || index < 0 || index >= chooser.entries.length) return;
				chooser.selected = index;
				if (activate) {
					this.#annotationChooser = undefined;
					this.#startExistingAnnotation(chooser.entries[index]!);
				}
				return;
			}
		}
	}

	/**
	 * A dock or head-tool click: the main button, an approval choice from its
	 * menu, a model tier from the model chip, Save or Cancel.
	 */
	#handleNativeAction(key: string, act: string): void {
		switch (leafKey(key)) {
			case "more": {
				const choice = this.#choices.find(candidate => candidate.id === act);
				if (choice && choice.disabled === undefined) this.#commit(choice.id, choice.label);
				return;
			}
			case "model": {
				if (act === "custom-model") {
					this.callbacks.onCustomModel?.();
					return;
				}
				const index = itemIndex(act, "tier:");
				if (index >= 0) this.#moveSlider(index - this.#sliderIndex);
				return;
			}
		}
		switch (act) {
			case "custom-model":
				this.callbacks.onCustomModel?.();
				return;
			case "approve": {
				const choice = this.#choices.find(candidate => candidate.disabled === undefined);
				if (choice) this.#commit(choice.id, choice.label);
				return;
			}
			case "refine":
				if (this.#hasFeedback && this.#refine) this.#commit(this.#refine.id, this.#refine.label);
				return;
			case "save":
				this.#save();
				return;
			case "cancel":
				this.#committed = true;
				this.callbacks.onCancel();
				return;
		}
	}

	/**
	 * Where a section or line note sits in the native document: a quote of the
	 * plan source and its plan offset. A line note quotes its line when the
	 * source has the rendered text verbatim; otherwise (and for section notes)
	 * the note quotes the section's heading title, or its first line of text
	 * when the heading is the sheet's title or there is none (the preamble).
	 */
	#noteAnchor(sectionIndex: number, start: number, target: AnnotationTarget): { quote: string; at: number } {
		const raw = this.#sections[sectionIndex]!.raw;
		if (target.kind === "line") {
			const line =
				target.contextTruncated && target.context.endsWith("…") ? target.context.slice(0, -1) : target.context;
			const probe = line
				.replace(/^[\s•◦▪‣·*+>-]+/, "")
				.replace(/^\d+[.)]\s+/, "")
				.trim();
			const found = probe ? raw.indexOf(probe) : -1;
			if (found >= 0) return { quote: probe, at: start + found };
		}
		const newline = raw.indexOf("\n");
		const isTitle = sectionIndex === this.#titleIndex;
		const heading = isTitle ? null : HEADING_LINE_RE.exec(newline < 0 ? raw : raw.slice(0, newline));
		if (heading) return { quote: heading[2]!, at: start + heading[1]!.length };
		const bodyStart = isTitle ? (newline < 0 ? raw.length : newline + 1) : 0;
		const firstLine = /\S[^\n]*/.exec(raw.slice(bodyStart));
		if (!firstLine) return { quote: "", at: start };
		return { quote: firstLine[0].trimEnd(), at: start + bodyStart + firstLine.index };
	}

	/** Plan body (one `md` per section, annotation callouts after it), the document's text and comments, and Contents items. */
	#describeContent(): NativePlanContent {
		const cached = this.#nativeContent;
		if (cached && cached.sections === this.#sections && cached.rev === this.#annotationRev) return cached;
		const body: NativeNode[] = [];
		for (const [sectionIndex, section] of this.#sections.entries()) {
			const key = `s${sectionIndex}`;
			// The title heading is the sheet's title; the body keeps only what follows it.
			const newline = section.raw.indexOf("\n");
			const source =
				sectionIndex !== this.#titleIndex ? section.raw : newline < 0 ? "" : section.raw.slice(newline + 1);
			const hasText = sectionIndex !== this.#titleIndex || source.trim() !== "";
			if (section.annotations.length === 0) {
				if (hasText) body.push(keyed(md(source), key));
				continue;
			}
			const children: NativeNode[] = hasText ? [keyed(md(source), "md")] : [];
			for (const [n, annotation] of section.annotations.entries()) {
				// A margin note: the anchored line quoted, then the note, on one ink-pen bar.
				const note: NativeNode[] = [];
				if (annotation.target.kind !== "section") {
					const quoted =
						annotation.target.kind === "line"
							? annotation.target.context
							: `“${quoteLine(annotation.target.quote)}”`;
					note.push(text([span(quoted, "muted")], { truncate: "end", lines: 1 }));
				}
				note.push(text(sanitizeText(annotation.note), { wrap: "word" }));
				children.push(node("col", { role: "omp.plan.note", gap: "xs" }, note, `n${n}`));
			}
			body.push(keyed(col(children, { gap: "sm" }), key));
		}
		const toc = this.#toc.map(sectionIndex => {
			const section = this.#sections[sectionIndex]!;
			const count = section.annotations.length;
			return item(`h${sectionIndex}`, {
				label: section.title || "(untitled)",
				value: count > 0 ? [span(`✎${count}`, "warning")] : undefined,
				role: `omp.plan.toc.depth${section.level - this.#tocBaseLevel}`,
			});
		});
		const title = this.#titleLine();
		const source = this.#source();
		const docText = title ? source.slice(0, title.start) + source.slice(title.start + title.line.length) : source;
		const comments: TspDocComment[] = [];
		const starts = this.#sectionStarts();
		for (const [sectionIndex, section] of this.#sections.entries()) {
			for (const annotation of section.annotations) {
				const target = annotation.target;
				const anchor =
					target.kind === "quote"
						? { quote: target.quote, at: starts[sectionIndex]! + target.at }
						: this.#noteAnchor(sectionIndex, starts[sectionIndex]!, target);
				comments.push({
					id: annotation.id,
					quote: anchor.quote,
					at: this.#docOffset(anchor.at, title),
					note: annotation.note,
				});
			}
		}
		this.#nativeContent = { sections: this.#sections, rev: this.#annotationRev, body, toc, docText, comments };
		return this.#nativeContent;
	}

	#describeSlider(): NativeNode[] {
		const slider = this.#slider;
		if (!slider && !this.callbacks.onCustomModel) return [];
		const track: NativeChild[] = [];
		if (slider?.caption) track.push(text([span(slider.caption, "dim")]));
		if (slider) {
			const tabs = node(
				"tabs",
				{
					items: slider.segments.map((segment, i) => ({ id: `t${i}`, label: segment.label })),
					active: `t${this.#sliderIndex}`,
					actions: { click: "select" },
					role: "omp.plan.strategy",
				},
				undefined,
				"tabs",
			);
			track.push(tabs);
		}
		if (this.callbacks.onCustomModel) track.push(actionButton("Custom model…", "custom-model"));
		// A role of its own: Tern's sheet lets only the role-less split row (Contents + body) shrink and scroll.
		const out = [keyed(rowNode(track, { role: "omp.plan.slider", gap: "sm", align: "center" }), "slider")];
		const detail = slider?.segments[this.#sliderIndex]?.detail;
		if (detail) out.push(keyed(text([span("↳ ", "dim"), span(detail, "muted")], { wrap: "word" }), "sliderDetail"));
		return out;
	}

	#describeFooter(): NativeChild[] {
		const chooser = this.#annotationChooser;
		if (chooser) {
			const entries = chooser.entries.map((selection, i) => {
				const section = this.#sections[selection.sectionIndex];
				const annotation = section?.annotations[selection.annotationIndex];
				const where = annotation ? annotationWhere(annotation.target) : "section";
				return item(`c${i}`, {
					label: sanitizeStatusText(annotation?.note ?? ""),
					detail: `${sanitizeStatusText(section?.title || "Plan preamble")} · ${where}`,
				});
			});
			return [
				keyed(text([span("Edit annotation", "accent strong")]), "chooserHead"),
				selectList("chooser", entries, { selected: `c${chooser.selected}` }),
				hintsRow(
					[
						actionHint(["tui.select.up", "tui.select.down"], "choose"),
						{ keys: ["enter"], label: "edit" },
						actionHint("tui.select.cancel", "cancel"),
					],
					"chooserHints",
				),
			];
		}
		if (this.#annotating) {
			const target = this.#annotationTarget;
			const title = sanitizeStatusText(this.#sections[target?.sectionIndex ?? -1]?.title || "Plan preamble");
			const location = target?.row === null ? `‹${title}›` : `‹${title}› · ${target?.context ?? ""}`;
			const hints: (NativeHint | undefined)[] = [
				actionHint("tui.input.submit", "save"),
				actionHint("tui.input.newLine", "newline"),
				actionHint("tui.select.cancel", "cancel"),
			];
			if (this.#editingAnnotation) hints.push({ keys: [], label: "empty deletes" });
			if (this.#externalEditorLabel) hints.push({ keys: [], label: `${this.#externalEditorLabel} editor` });
			// The feedback field, inline under the plan: its caption names the anchor, omp's editor holds the text.
			return [
				node(
					"col",
					{ role: "omp.plan.feedback", gap: "xs" },
					[
						keyed(
							text([span("Note on ", "muted"), span(location, "accent")], { truncate: "end" }),
							"annotateHead",
						),
						this.#editor,
						hintsRow(hints, "annotateHints"),
					],
					"feedback",
				),
			];
		}
		return [hintsRow(this.#nativeHelpHints())];
	}

	/** {@link #buildHelp} as keycap hints. */
	#nativeHelpHints(): (NativeHint | undefined)[] {
		const upDown = (label: string) => actionHint(["tui.select.up", "tui.select.down"], label);
		const key = (keys: KeyName | readonly KeyName[], label: string): NativeHint => ({
			keys: typeof keys === "string" ? [keys] : keys,
			label,
		});
		const hints: (NativeHint | undefined)[] = [];
		if (this.callbacks.onCustomModel)
			hints.push(key(boundKeys("app.model.select", ["alt+m"])[0] ?? "alt+m", "custom model"));
		if (this.#nativeDock) {
			// The dock's buttons carry their own keycaps (Enter, Esc); the hints name the rest.
			if (this.#slider) hints.push(key(["left", "right"], "model"));
			if (this.#sidebarShown) {
				hints.push(upDown("section"), key("d", "delete section"));
				if (!this.#nativeDoc) hints.push(key("a", "annotate"), key("e", "edit"));
			}
			hints.push(key("u", "undo"));
			if (this.#nativeDoc) {
				hints.push({ keys: [], label: "double-click to edit" }, { keys: [], label: "select text to comment" });
			}
			return hints;
		}
		switch (this.#focus) {
			case "actions":
				hints.push(key(["left", "right"], "select"), key("enter", "confirm"));
				if (this.#slider) hints.push(key(["shift+left", "shift+right"], "model"));
				break;
			case "toc":
				hints.push(
					upDown("section"),
					key("enter", "open"),
					key("a", "annotate"),
					key("e", "edit"),
					key("d", "delete"),
					key("u", "undo"),
				);
				break;
			case "body":
				hints.push(
					upDown("scroll"),
					key("shift", "faster"),
					key(["pageUp", "pageDown"], "page"),
					key(["g", "shift+g"], "ends"),
					key("a", "annotate"),
					key("e", "edit"),
					key("u", "undo"),
				);
				break;
		}
		hints.push(key("tab", "regions"));
		hints.push(this.#helpSuffix ? { keys: [], label: this.#helpSuffix } : actionHint("tui.select.cancel", "cancel"));
		return hints;
	}

	render(width: number): readonly string[] {
		const termHeight = process.stdout.rows || 40;
		const sidebarShown = this.#sidebarVisible(width);
		this.#sidebarShown = sidebarShown;
		const sidebarWidth = sidebarShown ? this.#sidebarWidthFor(width) : 0;
		const innerWidth = Math.max(1, width - 4);
		const bodyContentWidth = sidebarShown ? splitBodyWidth(width, sidebarWidth) : innerWidth;

		const committed = this.#committed;
		const sliderLines = committed ? [] : this.#renderSliderLines(innerWidth);
		const submittingLabel = this.#committedLabel ? `${this.#committedLabel} — submitting…` : "Submitting…";
		const optionLines = committed ? [theme.bold(theme.fg("accent", submittingLabel))] : this.#renderOptionLines();
		const promptLines = this.#promptTitle ? [theme.bold(theme.fg("accent", this.#promptTitle))] : [];
		const baseChrome = 4 + promptLines.length + sliderLines.length + optionLines.length;
		const chooserFooterRows = this.#annotationChooser
			? Math.max(0, termHeight - baseChrome - MIN_BODY_ROWS)
			: Number.POSITIVE_INFINITY;
		const footerLines = committed
			? [theme.fg("dim", "Applying your selection — this can take a moment while context is prepared.")]
			: this.#renderFooterLines(innerWidth, chooserFooterRows);

		// Chrome rows: top border, two dividers, bottom border, plus the
		// prompt/slider/option/footer rows between them.
		const chrome = baseChrome + footerLines.length;
		const regionRows = this.#annotationChooser
			? Math.max(0, termHeight - chrome)
			: Math.max(MIN_BODY_ROWS, termHeight - chrome);

		const bodyLines = this.#buildBody(bodyContentWidth);
		this.#layoutBody(bodyLines, regionRows);
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
			if (!committed) this.#optionClickRows.set(out.length, i);
			out.push(row(optionLines[i]!, width));
		}
		out.push(divider(width));
		for (const line of footerLines) out.push(row(line, width));
		out.push(bottomBorder(width));
		return out;
	}
}
