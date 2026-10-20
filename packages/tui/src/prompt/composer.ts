import { getComposerStyle } from "../components/composer/registry";
import { Spacer } from "../components/spacer";
import type { StatusLineComponent } from "../status-line/component";
import { extensionLinkLabels } from "../render/extension-links";
import { LinkHints, type ViewportLink, viewportLinkTargets } from "../render/link-hints";
import type { StatusLineSession } from "../status-line/host";
import { createStartupStatusLine, type StatusLineStartupData, startupComposerState } from "../status-line/startup";
import { isInsideTerminalMultiplexer } from "../terminal-multiplexer";
import { ProcessTerminal, type Terminal } from "../terminal";
import {
	type Component,
	Container,
	type ResizeScrollbackMode,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type TUIOptions,
	type ViewportSize,
} from "../tui";
import { wrapLiteralLine } from "../utils";
import type { DescribeContext, NativeChild, NativeSurface, NativeSurfaceProvider } from "../native/node";
import { sameItems } from "../native/memo";
import { postmortem } from "@oh-my-pi/pi-utils";
import { CustomEditor } from "./custom-editor";
import type { WordCompletionMethod } from "./word-completion";
import { type AnimationFrame, TranscriptContainer } from "../chrome/transcript-container";
import { type VersionUpdate, WelcomeComponent } from "./welcome";
import { ensureThemeSync, getEditorTheme, theme } from "../theme/theme";

const DOUBLE_INTERRUPT_MS = 500;

/** Live settings that affect the composer before and after session adoption. */
export interface ComposerPreferences {
	readonly quiet: boolean;
	readonly composerShape: string;
	readonly showHardwareCursor: boolean;
	readonly maxInlineImages: number;
	readonly resizeScrollback: ResizeScrollbackMode;
	readonly imeSafeCursor: boolean;
	readonly autocompleteMaxVisible: number;
	readonly spellingTypoDetection: boolean;
	readonly spellingAutocomplete: WordCompletionMethod;
	readonly spellingAutocorrect: boolean;
}

/** Settings-schema-compatible defaults used when constructing a dependency-free composer. */
export const COMPOSER_DEFAULTS: ComposerPreferences = {
	quiet: false,
	composerShape: "band",
	showHardwareCursor: true,
	maxInlineImages: 8,
	resizeScrollback: "rebuild",
	imeSafeCursor: false,
	autocompleteMaxVisible: 10,
	spellingTypoDetection: true,
	spellingAutocomplete: "auto",
	spellingAutocorrect: false,
};

/** Welcome data that can be supplied initially or patched as startup resolves it. */
export interface ComposerWelcomeUpdate {
	readonly version?: string;
	/** Background self-update activity after the version label; `null` clears it. */
	readonly versionUpdate?: VersionUpdate | null;
}

/**
 * Status-bar inputs persisted by the last session. The first frame renders
 * them through a startup {@link StatusLineComponent} at the live width until
 * the session-aware status line attaches.
 */
export interface ComposerStatusCache {
	/** ANSI wrapper of the editor border when persisted (session accent or thinking color). */
	readonly borderColor?: {
		readonly prefix: string;
		readonly suffix: string;
	};
	readonly statusLine: StatusLineStartupData;
}

/** Optional dependencies and initial state for a standalone composer. */
export interface ComposerOptions {
	readonly terminal?: Terminal;
	/** Extra TUI construction options (render scheduler injection for tests and `omp render`). */
	readonly tuiOptions?: TUIOptions;
	readonly preferences?: Partial<ComposerPreferences>;
	readonly welcome?: ComposerWelcomeUpdate;
	readonly status?: ComposerStatusCache;
	readonly exit?: (code: number) => void;
	readonly now?: () => number;
}

/** A native dock root described only on terminals whose `hello` advertises `feature`. */
export interface FeatureDockEntry {
	readonly component: Component;
	readonly feature: string;
}

/** How {@link Composer.setRuntimeChildren} lays out the roots below the transcript. */
export interface RuntimeChildrenOptions {
	/**
	 * Dock order on a TSP terminal (no status strip; the composer carries its
	 * facts): the native dock stacks HUD pills, the working row and queued messages over
	 * the composer in its own order, and may add describe-only roots, also
	 * ones only a terminal with a given feature gets. Defaults to the roots
	 * below the transcript in render order.
	 */
	readonly nativeDock?: readonly (Component | FeatureDockEntry)[];
	/**
	 * Below-transcript containers whose children continue `main` on a TSP
	 * terminal, one block each after the transcript's, instead of riding in the
	 * dock: output on its way into the transcript (shell runs deferred until the
	 * next prompt) reads as its tail, and keeps its block when it moves in.
	 */
	readonly nativeTail?: readonly Container[];
	/**
	 * Below-transcript roots that cover the transcript while the user has them
	 * open (a docked report); a popup inside any other root reports its rows
	 * through {@link Component.coveringRows}. Their rows do not count toward retirement: the
	 * transcript rows they cover stay live, clipped off the top of the frame,
	 * and return when they close, instead of going to scrollback and leaving
	 * the screen blank above the input.
	 */
	readonly coveringChrome?: readonly Component[];
	/** Allocate a live HUD and input against the same rendered sibling chrome. */
	readonly allocation?: {
		readonly hud: Component;
		readonly input: Component;
		readonly apply: (viewport: ViewportSize, chromeRows: number, renderInput: () => number) => void;
	};
}

/** Popup rows in `root`'s last render: its own, or those of the children of a plain container. */
function coveringRowsOf(root: Component): number {
	let rows = root.coveringRows?.() ?? 0;
	if (root instanceof Container) for (const child of root.children) rows += child.coveringRows?.() ?? 0;
	return rows;
}

/** Controls the first terminal paint for a composer that does not already own the terminal. */
export interface ComposerStartOptions {
	readonly clearScrollback?: boolean;
	readonly playWelcomeIntro?: boolean;
	/**
	 * Paint without owning stdin: the tty keeps cooked-mode echo/editing so
	 * typing stays visible while startup module loading blocks the event loop.
	 * {@link Composer.enableInput} later switches to raw input and replays the
	 * kernel-buffered keystrokes into the editor.
	 */
	readonly deferInput?: boolean;
}

/**
 * Mount slot below the editor: the startup status line, then the session-aware
 * one. ANSI only: a TSP terminal has no status strip, the composer carries the
 * status line's facts ({@link StatusLineComponent.describeComposerFacts}).
 */
class StatusHost implements Component {
	#component: Component | undefined;

	setComponent(component: Component): void {
		this.#component = component;
	}

	render(width: number): readonly string[] {
		return this.#component?.render(width) ?? [];
	}
}

/** One click target's row span within the mutable viewport (half-open `[start, end)`). */
export interface ViewportClickSpan {
	start: number;
	end: number;
	/** Candidate subagent ids for a span-local row. */
	candidates: (local: number) => string[];
}

/**
 * Row-level click target: maps rendered rows to subagent ids. Implemented by
 * the subagent HUD, whose rows are fixed 1:1 with visible sessions.
 */
export interface ViewportClickRowTarget {
	getClickAgentAtRow(row: number): string | undefined;
}

/**
 * Candidates under a mutable-viewport line: the first span containing it.
 * Pure seam for tests; the caller intersects with the live registry, which
 * decides focusability and recency.
 */
export function routeViewportClick(spans: readonly ViewportClickSpan[], index: number): string[] {
	if (!Number.isInteger(index) || index < 0) return [];
	for (const span of spans) {
		if (index < span.start || index >= span.end) continue;
		return span.candidates(index - span.start);
	}
	return [];
}

/**
 * Called once when link-hint mode ends; `reason` is `"crowded"` when a row held more links than
 * their tags could fit side by side, so no tags were drawn.
 */
export type LinkHintsEnd = (reason?: "crowded") => void;

/**
 * Nested background opens inside a hovered row. The band wraps the line, so a
 * surviving nested open would paint over it for every cell it covers; the
 * matching closes stay and become band resumes via bgFill.
 */
const NESTED_BG_OPEN_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[(?:4[0-7]|10[0-7]|48;[0-9;]*)m`, "g");

/**
 * Candidate resolver for a row-level click target, if the component is one.
 * Shared by root and nested-child hit-testing so both stay in lockstep.
 */
function rowTargetCandidates(target: Component): ((local: number) => string[]) | undefined {
	const rowTarget = target as Partial<ViewportClickRowTarget>;
	if (typeof rowTarget.getClickAgentAtRow !== "function") return undefined;
	return (local: number) => {
		const id = rowTarget.getClickAgentAtRow?.(local);
		return id === undefined ? [] : [id];
	};
}

/**
 * Canonical interactive composer, usable before session/settings exist and updatable in place.
 * It owns the terminal, welcome header, and editor; InteractiveMode later supplies authoritative
 * data and mounts the session-aware runtime children without replacing the visible header.
 */
export class Composer implements TerminalFrameProvider, NativeSurfaceProvider {
	readonly ui: TUI;
	#editor: CustomEditor;
	readonly #header = new Container();
	readonly #bootstrapInputGap = new Spacer(1);
	readonly #statusHost = new StatusHost();
	readonly #exit: (code: number) => void;
	readonly #now: () => number;
	#preferences: ComposerPreferences;
	#welcome: WelcomeComponent | undefined;
	#version = "";
	#versionUpdate: VersionUpdate | null = null;
	#headerBefore: readonly Component[] = [];
	#headerAfter: readonly Component[] = [];
	#runtimeChildren: readonly Component[] = [];
	#nativeDock: readonly (Component | FeatureDockEntry)[] | undefined;
	#nativeTail: readonly Container[] = [];
	#coveringChrome: ReadonlySet<Component> = new Set();
	#allocation: RuntimeChildrenOptions["allocation"];
	/** Cache-driven status line shown until {@link setStatusComponent} mounts the session's. */
	#startupStatus: StatusLineComponent | undefined;
	#runtimeMounted = false;
	// Composer-owned history id space. Transcript batch ids restart across
	// container clears/swaps; the composer translates them into one monotonic
	// sequence the terminal's accepted-id watermark can trust.
	#nextHistoryId = 1;
	#offeredHistory:
		| {
				id: number;
				rows: readonly string[];
				kind: "append" | "replay";
				source:
					| "header"
					| {
							transcript: TranscriptContainer;
							transcriptId?: number;
							header: "none" | "replay";
							/** Recomposed header rows to accept as the new retired-header bytes. */
							headerRows?: readonly string[];
					  };
		  }
		| undefined;
	#historyReplayRequested = false;
	#headerReplayPending = false;
	#historyFlush = false;
	// The welcome header retires to terminal history exactly once, after the
	// intro settles; until then it renders as mutable viewport chrome.
	#headerRetired = false;
	// Exact hard rows accepted into native history. Transient resize-alt
	// paints reflow these rows to match the terminal's own rewrap of history
	// it still holds; a settled replay owns every byte it emits, so it
	// recomposes the header at the replay width and refreshes these rows.
	#retiredHeaderRows: readonly string[] | undefined;
	/** Click spans of the last `renderFrame` viewport, in viewport coordinates. */
	#lastClickSpans: ViewportClickSpan[] = [];
	/** Rows of the last `renderFrame` viewport, before the hover band; read to hit-test extension links. */
	#lastViewportRows: readonly string[] = [];
	/** Click-candidate id under the pointer, painted with the hover band. Id-anchored so it follows streaming rows. */
	#hoveredClickId: string | undefined;
	/** Keyboard link-hint mode: its tags (assigned by the first frame after `startLinkHints`) and what to run when it ends. */
	#linkHints: { hints: LinkHints; onEnd: LinkHintsEnd } | undefined;
	/** Width of the last painted viewport, which `#lastViewportRows` was laid out for. */
	#lastViewportWidth = 0;
	// Hard-row prefix currently above the native viewport. The first resize
	// frame may pull part of it down before the normal buffer is borrowed.
	#retiredHeaderStart = 0;
	#resizeRetiredHeaderStart: number | undefined;
	#lastNormalRows = 0;
	/** Rows the chrome below each below-transcript root took in the last frame (see {@link rowsBelow}). */
	#rowsBelow = new Map<Component, number>();
	#lastInterruptAt = 0;
	/** Last described surface; its arrays are reused while their children are unchanged. */
	#nativeSurface: NativeSurface = { main: [], dock: [] };
	#started = false;
	#stopped = false;
	#transferred = false;

	constructor(options: ComposerOptions = {}) {
		ensureThemeSync();
		// Host-owned hard exit: route through postmortem so a double-Ctrl-C during
		// an open extension-load guard window exits cleanly instead of throwing
		// ExtensionExitError through the guarded process.exit (#11789).
		this.#exit = options.exit ?? (code => postmortem.exitProcess(code));
		this.#now = options.now ?? Date.now;
		this.#preferences = { ...COMPOSER_DEFAULTS, ...options.preferences };
		this.#applyWelcomeUpdate(options.welcome ?? {});

		this.ui = new TUI(
			options.terminal ?? new ProcessTerminal(),
			this.#preferences.showHardwareCursor,
			options.tuiOptions,
		);
		this.ui.setFrameProvider(this);
		this.ui.setMaxInlineImages(this.#preferences.maxInlineImages);
		this.ui.setResizeScrollback(this.#preferences.resizeScrollback);

		this.#editor = new CustomEditor(getEditorTheme());
		this.editor.disableSubmit = true;
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.editor.setImeSafeCursorLayout(this.#preferences.imeSafeCursor);
		this.editor.setAutocompleteMaxVisible(this.#preferences.autocompleteMaxVisible);
		this.editor.setSpellingFeatures({
			typoDetection: this.#preferences.spellingTypoDetection,
			autocomplete: this.#preferences.spellingAutocomplete,
			autocorrect: this.#preferences.spellingAutocorrect,
		});
		try {
			this.editor.setBorderStyle(this.#preferences.composerShape);
		} catch {
			// Extension-defined styles arrive with the session; InteractiveMode reapplies them.
		}
		if (options.status) {
			const { borderColor, statusLine } = options.status;
			if (borderColor) this.editor.borderColor = text => `${borderColor.prefix}${text}${borderColor.suffix}`;
			this.#startupStatus = createStartupStatusLine(statusLine);
			this.#statusHost.setComponent(this.#startupStatus);
			this.#startupStatus.attachToEditor(this.editor, getComposerStyle(this.#preferences.composerShape));
			const state = startupComposerState(statusLine);
			this.editor.composerState = () => state;
		}
		// Emergency controls stay active until InteractiveMode installs configured bindings.
		// They deliberately mirror the interactive editor's contract so a stalled startup
		// never behaves differently from a healthy one: Ctrl+C clears the draft and a second
		// press exits 130 — the unconditional abort, draft or not; Ctrl+D exits 0 on an
		// empty draft and otherwise forward-deletes (see CustomEditor's app.exit handling),
		// so typing while the session loads cannot be lost to a mistyped delete.
		this.editor.setActionKeys("app.clear", ["ctrl+c"]);
		this.editor.setActionKeys("app.exit", ["ctrl+d"]);
		this.editor.onClear = () => this.#handleInterrupt();
		this.editor.onExit = () => this.#requestExit(0);
		this.editor.setShimmerRepaintHandler(() => this.ui.requestComponentRender(this.editor));

		if (!this.#preferences.quiet) this.#ensureWelcome();
		this.#rebuildHeader();
		this.ui.addChild(this.#header);
		this.ui.addChild(this.#bootstrapInputGap);
		this.ui.addChild(this.editor);
		this.ui.addChild(this.#statusHost);
		this.ui.setFocus(this.editor);
	}
	/**
	 * Rows the below-transcript chrome under `root` (editor, status line, …)
	 * took in the last frame, so a root that grows upward can cap itself to
	 * the screen rows left above them; `undefined` before `root` was laid out.
	 */
	rowsBelow(root: Component): number | undefined {
		return this.#rowsBelow.get(root);
	}

	/** Compose the bounded mutable viewport and the next ordered history append. */
	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		if (!this.#started || this.#stopped) return { viewport: [] };
		const width = Math.max(1, viewport.columns);
		const rows = Math.max(0, viewport.rows);
		if (this.#resizeRetiredHeaderStart !== undefined) {
			this.#retiredHeaderStart = this.#resizeRetiredHeaderStart;
			this.#resizeRetiredHeaderStart = undefined;
		}
		this.#lastNormalRows = rows;
		const roots = this.#runtimeMounted
			? [...this.#runtimeChildren, this.#statusHost]
			: [this.#header, this.#bootstrapInputGap, this.editor, this.#statusHost];
		const transcriptIndex = roots.findIndex(root => root instanceof TranscriptContainer);
		if (transcriptIndex < 0) {
			this.#lastClickSpans = [];
			this.#lastViewportRows = [];
			this.#syncLinkHints([], 0);
			const viewport: string[] = [];
			for (const root of roots) {
				viewport.push(...root.render(width));
			}
			return { viewport: viewport.slice(-rows) };
		}
		const transcript = roots[transcriptIndex] as TranscriptContainer;
		const preRoots = this.#renderRoots(roots.slice(0, transcriptIndex), width);
		const afterRoots = roots.slice(transcriptIndex + 1);
		const after: string[] = [];
		const afterSpans: ViewportClickSpan[] = [];
		const ends: { root: Component; end: number }[] = [];
		let coveringRows = 0;
		const allocated = this.#allocateRuntimeRows(afterRoots, width, rows);
		for (const root of afterRoots) {
			const start = after.length;
			const cached = allocated?.get(root);
			if (cached) {
				after.push(...cached.lines);
				for (const span of cached.spans)
					afterSpans.push({ ...span, start: span.start + start, end: span.end + start });
			} else {
				this.#renderBelowRoot(root, width, after, afterSpans);
			}
			coveringRows += this.#coveringChrome.has(root) ? after.length - start : coveringRowsOf(root);
			ends.push({ root, end: after.length });
		}
		this.#rowsBelow = new Map(ends.map(({ root, end }) => [root, after.length - end]));
		// Retirement and the live tail both use the rows the chrome below leaves
		// right now: a row the chrome pushes off screen goes straight to native
		// history, so every transcript row is on screen or in scrollback. Chrome
		// that later shrinks leaves blank rows (see the slack below). Covering
		// chrome is the exception: the rows it covers stay live and are clipped
		// off the top by the `drop` slice below until it closes.
		const chromeRows = after.length - coveringRows;
		// Offer history under capacity pressure only: blocks stay live (and keep
		// reflowing to the current width) while the screen has room. A batch
		// leaves the mutable viewport in the same frame it is appended, so its
		// rows are never painted twice.
		const now = performance.now();
		const frame: AnimationFrame = { now, tick: Math.floor(now / 80) };
		// Retirement measures the same live blocks the viewport lays out below;
		// one open frame renders each of them once for both.
		transcript.beginFrame(frame);
		const history = this.#offerHistory(transcript, width, rows, preRoots.length + chromeRows);
		const headerVisible = !this.#headerRetired && this.#offeredHistory?.source !== "header";
		const headerRows = headerVisible ? this.#header.render(width) : [];
		const before = [...headerRows, ...preRoots];
		// The live tail is laid out against the same height retirement uses, so
		// its compaction allocator (one row per block, no inter-block blanks)
		// engages only when a block genuinely cannot retire.
		const active = transcript.renderViewport(width, Math.max(0, rows - before.length - chromeRows), frame);
		const activeSpans: ViewportClickSpan[] = [];
		for (const span of transcript.getLastViewportSpans()) {
			const ids = (span.component as Partial<{ getClickFocusAgentIds(): string[] }>).getClickFocusAgentIds?.();
			if (!ids || ids.length === 0) continue;
			activeSpans.push({ start: span.start, end: span.end, candidates: () => ids });
		}
		const drop = Math.max(0, before.length + active.length + after.length - rows);
		const mutable = [...before, ...active, ...after].slice(drop);
		// Once a paint reaches the bottom row over committed history, rows above
		// it may already be in native scrollback, which no later frame can pull
		// back down. Keep the input on the bottom row whenever the frame shrinks
		// — a closing dialog, report or HUD, or a live block collapsing. The
		// slack that leaves has to sit somewhere: rows above the live area hold
		// committed history still on screen, so the live rows cannot move up into
		// them, and replaying those rows would duplicate them while clearing
		// history would lose them. Replays position themselves. Without native
		// history the live viewport is the whole document and shrinks in place.
		const filledHistoryRows =
			history?.kind === "replay" || !(history !== undefined || this.ui.hasProviderHistory())
				? undefined
				: this.ui.getFilledHistoryRows();
		const slack =
			filledHistoryRows === undefined
				? 0
				: Math.max(0, rows - Math.min(rows, filledHistoryRows + (history?.rows.length ?? 0)) - mutable.length);
		// Park the slack below the live rows rather than above them. Above, it
		// splits the on-screen history from the live tail and reads as a hole
		// punched into whatever was streaming — a table's rows included — and
		// each slack row is written with no cells, so no repaint, mark or
		// selection can cover it until something scrolls it away. Below, the
		// transcript stays contiguous with the history, the slack reads as the
		// empty tail of a short document, and growth consumes it before any row
		// can scroll.
		if (slack > 0) {
			const at = Math.max(0, Math.min(mutable.length, before.length + active.length - drop));
			mutable.splice(at, 0, ...Array<string>(slack).fill(""));
		}
		const viewportLength = mutable.length;
		const spans: ViewportClickSpan[] = [];
		const shift = (span: ViewportClickSpan, base: number): void => {
			const start = span.start + base;
			const end = Math.min(span.end + base, viewportLength);
			const clamped = Math.max(0, start);
			if (end > clamped) {
				// A clipped head must offset the callback: without the skew the
				// first visible row would hit-test as span-local row 0.
				const skew = clamped - start;
				spans.push({ start: clamped, end, candidates: (local: number) => span.candidates(local + skew) });
			}
		};
		for (const span of activeSpans) shift(span, before.length - drop);
		for (const span of afterSpans) shift(span, slack + before.length + active.length - drop);
		this.#lastClickSpans = spans;
		this.#lastViewportRows = mutable;
		this.#lastViewportWidth = width;
		this.#syncLinkHints(mutable, width);
		if (history !== undefined && this.#offeredHistory?.source === "header") {
			const visibleHeaderRows = Math.max(0, rows - (mutable.length + drop));
			this.#retiredHeaderStart = Math.max(0, history.rows.length - visibleHeaderRows);
		}
		const painted = this.#paintHoverBand(mutable, spans);
		return { history, viewport: this.#linkHints?.hints.paint(painted, width) ?? painted };
	}

	/**
	 * Keep link-hint tags on what `rows` show. The first frame after `startLinkHints` tags its
	 * labels; later frames keep the tags while the tagged labels are still drawn first, in the same
	 * order and columns (rows may scroll, links may be added below), and otherwise end the mode, so a
	 * tag never picks a label no longer drawn under it. Every frame ends the mode as `"crowded"` when
	 * some row has more tag cells than `width` (a resize can narrow it), since tags drawn side by
	 * side could not all be read.
	 */
	#syncLinkHints(rows: readonly string[], width: number): void {
		const state = this.#linkHints;
		if (state === undefined) return;
		const kept = state.hints.tagged ? state.hints.follow(rows) : state.hints.assign(rows) > 0;
		if (!kept) this.#endLinkHints();
		else if (state.hints.crowded(width)) this.#endLinkHints("crowded");
	}

	#endLinkHints(reason?: "crowded"): void {
		const state = this.#linkHints;
		if (state === undefined) return;
		this.#linkHints = undefined;
		state.onEnd(reason);
	}

	/**
	 * Describe the whole surface for a TSP terminal. `main` is the flowing
	 * document: the header (welcome, extras) and every transcript block as its
	 * own component child, then the children of the
	 * {@link RuntimeChildrenOptions.nativeTail} roots. `dock` is the live chrome
	 * below the transcript in render order: pending messages, HUDs, the working
	 * row, the editor and the status line. There is no history/viewport split:
	 * retirement, resize replay and hover bands are ANSI concerns.
	 */
	describeSurface(cx: DescribeContext): NativeSurface {
		if (!this.#started || this.#stopped) return this.#nativeSurface;
		const main: NativeChild[] = [...this.#header.children];
		const dock: NativeChild[] = [];
		if (!this.#runtimeMounted) {
			// The bootstrap gap is row spacing; the terminal owns the dock layout.
			dock.push(this.editor);
		} else {
			const roots = this.#runtimeChildren;
			const transcriptIndex = roots.findIndex(root => root instanceof TranscriptContainer);
			if (transcriptIndex < 0) {
				dock.push(...roots);
			} else {
				const transcript = roots[transcriptIndex] as TranscriptContainer;
				main.push(...roots.slice(0, transcriptIndex), ...transcript.nativeBlocks(cx));
				for (const root of this.#nativeTail) main.push(...root.children);
				const tail: readonly Component[] = this.#nativeTail;
				if (this.#nativeDock) {
					for (const entry of this.#nativeDock) {
						if (!("feature" in entry)) dock.push(entry);
						else if (cx.feature(entry.feature)) dock.push(entry.component);
					}
				} else {
					dock.push(...roots.slice(transcriptIndex + 1).filter(root => !tail.includes(root)));
				}
			}
		}
		const previous = this.#nativeSurface;
		const nextMain = sameItems(previous.main, main) ? previous.main : main;
		const nextDock = sameItems(previous.dock, dock) ? previous.dock : dock;
		if (nextMain !== previous.main || nextDock !== previous.dock) {
			this.#nativeSurface = { main: nextMain, dock: nextDock };
		}
		return this.#nativeSurface;
	}

	/**
	 * Append one below-transcript root's rows to `after`, recording click spans
	 * for its row targets in `after` coordinates.
	 *
	 * Row targets usually nest one level down: chrome roots are plain
	 * containers (the HUD lives inside `subagentContainer`), and
	 * `Container.render` is a pure concatenation, so child spans tile the root
	 * span exactly. Render those children once and share the rows for
	 * composition and measurement — a second render per frame would duplicate
	 * render-time side effects (image placement registration). Roots with a
	 * custom render keep the composed output as the source of truth and measure
	 * up to the last target.
	 */
	#renderBelowRoot(root: Component, width: number, after: string[], spans: ViewportClickSpan[]): void {
		const start = after.length;
		const plainContainer = root instanceof Container && root.render === Container.prototype.render;
		const targets = root instanceof Container ? root.children : [root];
		const resolves = targets.map(rowTargetCandidates);
		const lastTarget = resolves.findLastIndex(resolve => resolve !== undefined);
		if (plainContainer) {
			let offset = start;
			for (let index = 0; index < targets.length; index++) {
				const childLines = targets[index]!.render(width);
				after.push(...childLines);
				if (index > lastTarget) continue;
				const resolve = resolves[index];
				if (resolve !== undefined && childLines.length > 0) {
					spans.push({ start: offset, end: offset + childLines.length, candidates: resolve });
				}
				offset += childLines.length;
			}
			return;
		}
		after.push(...root.render(width));
		if (lastTarget === -1) return;
		let offset = start;
		for (let index = 0; index <= lastTarget; index++) {
			const childLines = targets[index] === root ? after.length - start : targets[index]!.render(width).length;
			const resolve = resolves[index];
			if (resolve !== undefined && childLines > 0) {
				spans.push({ start: offset, end: offset + childLines, candidates: resolve });
			}
			offset += childLines;
		}
	}

	/**
	 * Band the hovered click target's current rows. Id-anchored (not
	 * line-anchored) so the band follows an agent whose rows shift while it
	 * streams; a retired id matches no span and simply paints nothing. Only
	 * the viewport copy is banded — retirement reads unbanded component rows.
	 */
	#paintHoverBand(viewport: string[], spans: readonly ViewportClickSpan[]): string[] {
		const hovered = this.#hoveredClickId;
		if (hovered === undefined) return viewport;
		let banded = false;
		const painted = viewport.map((line, index) => {
			for (const span of spans) {
				if (index < span.start || index >= span.end) continue;
				if (!span.candidates(index - span.start).includes(hovered)) continue;
				banded = true;
				// A wrapping band loses to background opens nested inside the row
				// (live card rows carry the pending-tint bg, which would paint over
				// the band for every cell it covers), so drop nested bg opens
				// first; their closes stay and become band resumes via bgFill.
				return theme.bgFill("selectedBg", line.replace(NESTED_BG_OPEN_PATTERN, ""));
			}
			return line;
		});
		return banded ? painted : viewport;
	}

	/**
	 * Candidate subagent ids under a mutable-viewport line, for click-to-focus.
	 * Empty when the line has no click target (chrome, separators, retired rows
	 * are never in the viewport). Callers intersect with the live registry.
	 */
	viewportClickCandidates(index: number): string[] {
		return routeViewportClick(this.#lastClickSpans, index);
	}

	/**
	 * The extension-owned link label drawn at cell `col` of a mutable-viewport line, or `undefined`.
	 * Only links whose scheme an extension registered match; see `extensionLinkLabels`.
	 */
	viewportLinkAt(index: number, col: number): ViewportLink | undefined {
		const line = this.#lastViewportRows[index];
		if (line === undefined || col < 0) return undefined;
		const label = extensionLinkLabels(line).find(label => col >= label.start && col < label.end);
		return label && { url: label.url, row: index, start: label.start };
	}

	/**
	 * Point the hover band at a click-candidate id (or clear it). Takes effect
	 * on the next frame; callers repaint only when the target actually changes.
	 */
	setHoveredClickId(id: string | undefined): void {
		this.#hoveredClickId = id;
	}

	/** How many extension link labels the last frame drew; a label wrapped across rows counts once. */
	viewportLinkCount(): number {
		return viewportLinkTargets(this.#lastViewportRows).length;
	}

	/**
	 * Enter keyboard link-hint mode: the next frame draws a tag over each extension link label it
	 * shows. `onEnd` runs once when the mode ends: a pick, a cancel, a key no tag starts with, a
	 * repaint that no longer draws the tagged labels where they were, or (`"crowded"`) a row with
	 * too many links for their tags to fit side by side.
	 */
	startLinkHints(onEnd: LinkHintsEnd): void {
		this.#endLinkHints();
		this.#linkHints = { hints: new LinkHints(), onEnd };
	}

	/** Whether link-hint mode is on. */
	get linkHintsActive(): boolean {
		return this.#linkHints !== undefined;
	}

	/**
	 * Type one letter of a tag. Returns the link whose whole tag is now typed, `true` while the
	 * letters still lead to several tags, and `false` when none starts with them. The mode ends on
	 * a pick or a miss.
	 */
	typeLinkHint(letter: string): ViewportLink | boolean {
		const state = this.#linkHints;
		if (state === undefined) return false;
		// A key typed before the tags were first painted picks among the labels last drawn.
		if (!state.hints.tagged) this.#syncLinkHints(this.#lastViewportRows, this.#lastViewportWidth);
		if (this.#linkHints !== state) return false;
		const result = state.hints.type(letter);
		if (result !== true) this.#endLinkHints();
		return result;
	}

	/** Leave link-hint mode without picking a link. */
	cancelLinkHints(): void {
		this.#endLinkHints();
	}

	/** Acknowledges one accepted header, replay, or transcript batch. */
	acknowledgeHistory(id: number): void {
		const offered = this.#offeredHistory;
		if (offered === undefined || offered.id !== id) return;
		if (offered.source === "header") {
			this.#headerRetired = true;
			this.#retiredHeaderRows = offered.rows;
		} else {
			if (offered.source.transcriptId !== undefined) {
				offered.source.transcript.acknowledgeFinalizedBatch(offered.source.transcriptId);
			}
			if (offered.source.header === "replay") {
				this.#headerReplayPending = false;
				if (offered.source.headerRows !== undefined) this.#retiredHeaderRows = offered.source.headerRows;
			}
		}
		this.#offeredHistory = undefined;
		if (this.#historyReplayRequested) this.#startHistoryReplay();
		if (offered.kind === "replay") {
			this.ui.requestRender();
		}
	}

	/** Render the semantic transcript tail while the terminal borrows its resize buffer. */
	renderResizeFrame(viewport: ViewportSize): readonly string[] {
		if (!this.#started || this.#stopped) return [];
		const width = Math.max(1, viewport.columns);
		const rows = Math.max(0, viewport.rows);
		const tail = this.#runtimeMounted
			? this.#renderResizeTail(width, rows)
			: this.#renderRoots([this.#bootstrapInputGap, this.editor, this.#statusHost], width);
		let header: readonly string[];
		if (this.#headerRetired) {
			this.#resizeRetiredHeaderStart ??= Math.max(
				0,
				this.#retiredHeaderStart - Math.max(0, rows - this.#lastNormalRows),
			);
			header = this.#reflowRetiredHeader(width, this.#resizeRetiredHeaderStart);
		} else {
			header = this.#header.render(width);
		}
		const rendered = [...header, ...tail];
		return rendered.length <= rows ? rendered : rendered.slice(rendered.length - rows);
	}

	/** Replays committed presentation without changing logical retirement state. */
	beginHistoryReplay(): void {
		if (this.#offeredHistory !== undefined) {
			this.#historyReplayRequested = true;
			return;
		}
		this.#startHistoryReplay();
	}

	/** Forces every currently eligible finalized prefix to retire before stop. */
	beginHistoryFlush(): void {
		this.#historyFlush = true;
		// A pending replay would re-render and re-stream the entire committed
		// ledger during shutdown; the terminal already holds that history, so
		// flush emits only genuinely un-retired rows. An already offered batch
		// stays valid and is accepted by the flush loop.
		this.#historyReplayRequested = false;
		this.#headerReplayPending = false;
		for (const child of this.#runtimeChildren) {
			if (child instanceof TranscriptContainer) child.cancelReplay();
		}
	}

	#startHistoryReplay(): void {
		this.#headerReplayPending = this.#headerRetired && (this.#retiredHeaderRows?.length ?? 0) > 0;
		this.#historyReplayRequested = false;
		for (const child of this.#runtimeChildren) {
			if (child instanceof TranscriptContainer) child.beginReplay();
		}
	}

	/** Header retires first; replay coalesces it with the complete transcript ledger. */
	#offerHistory(
		transcript: TranscriptContainer,
		width: number,
		rows: number,
		chromeRows: number,
	): { id: number; rows: readonly string[]; kind: "append" | "replay" } | undefined {
		if (this.#offeredHistory !== undefined) {
			this.#rerenderOfferedHistory(width);
			return {
				id: this.#offeredHistory.id,
				rows: this.#offeredHistory.rows,
				kind: this.#offeredHistory.kind,
			};
		}
		if (this.#headerReplayPending) {
			const transcriptReplay = transcript.peekReplayBatch(width);
			// A replay follows a scrollback clear, so the header recomposes at
			// the new width exactly like transcript entries do. An empty
			// recompose (welcome unmounted after retirement) falls back to the
			// committed rows, hard-wrapped the way the terminal would.
			const recomposed = this.#header.render(width);
			const headerRows = recomposed.length > 0 ? [...recomposed, ""] : this.#reflowRetiredHeader(width, 0);
			this.#offeredHistory = {
				id: this.#nextHistoryId++,
				rows: [...headerRows, ...(transcriptReplay?.rows ?? [])],
				kind: "replay",
				source: {
					transcript,
					transcriptId: transcriptReplay?.id,
					header: "replay",
					headerRows,
				},
			};
			return {
				id: this.#offeredHistory.id,
				rows: this.#offeredHistory.rows,
				kind: this.#offeredHistory.kind,
			};
		}
		if (!this.#headerRetired) {
			const welcome = this.#welcome;
			if (welcome !== undefined && !welcome.isTranscriptBlockFinalized()) return undefined;
			// The header stays live viewport chrome until the screen fills; then it
			// retires first so transcript prefixes can follow in order.
			const renderedHeader = this.#header.render(width);
			if (renderedHeader.length > 0) {
				// Only the comparison below reads the height, so the walk stops at
				// the budget instead of rendering every replayed block (#12933).
				const liveRows = transcript.liveRowCount(width, Math.max(0, rows - renderedHeader.length - chromeRows));
				if (!this.#historyFlush && renderedHeader.length + chromeRows + liveRows <= rows) return undefined;
				this.#offeredHistory = {
					id: this.#nextHistoryId++,
					rows: [...renderedHeader, ""],
					kind: "append",
					source: "header",
				};
				return {
					id: this.#offeredHistory.id,
					rows: this.#offeredHistory.rows,
					kind: this.#offeredHistory.kind,
				};
			}
			this.#headerRetired = true;
			this.#retiredHeaderRows = [];
		}
		const batch = this.#historyFlush
			? transcript.peekFlushBatch(width)
			: transcript.peekFinalizedBatch(width, Math.max(0, rows - chromeRows));
		if (batch === undefined) return undefined;
		this.#offeredHistory = {
			id: this.#nextHistoryId++,
			rows: batch.rows,
			kind: batch.kind ?? "append",
			source: { transcript, transcriptId: batch.id, header: "none" },
		};
		return {
			id: this.#offeredHistory.id,
			rows: this.#offeredHistory.rows,
			kind: this.#offeredHistory.kind,
		};
	}

	#rerenderOfferedHistory(width: number): void {
		const offered = this.#offeredHistory;
		if (offered === undefined) return;
		if (offered.source === "header") {
			const rows = this.#header.render(width);
			offered.rows = rows.length > 0 ? [...rows, ""] : [];
			return;
		}
		const transcript = offered.source.transcript.rerenderOfferedBatch(width);
		if (offered.source.header === "none") {
			if (transcript !== undefined) offered.rows = transcript.rows;
			return;
		}
		const recomposed = this.#header.render(width);
		const headerRows = recomposed.length > 0 ? [...recomposed, ""] : this.#reflowRetiredHeader(width, 0);
		offered.source.headerRows = headerRows;
		offered.rows = [...headerRows, ...(transcript?.rows ?? [])];
	}

	/** Render ordinary chrome once, then let the host cap input before selecting HUD rows. */
	#allocateRuntimeRows(
		roots: readonly Component[],
		width: number,
		rows: number,
	): Map<Component, { lines: string[]; spans: ViewportClickSpan[] }> | undefined {
		const allocation = this.#allocation;
		if (!allocation || !roots.includes(allocation.hud) || !roots.includes(allocation.input)) return undefined;
		const rendered = new Map<Component, { lines: string[]; spans: ViewportClickSpan[] }>();
		const render = (root: Component): number => {
			let cached = rendered.get(root);
			if (!cached) {
				cached = { lines: [], spans: [] };
				this.#renderBelowRoot(root, width, cached.lines, cached.spans);
				rendered.set(root, cached);
			}
			return cached.lines.length;
		};
		let chromeRows = 0;
		for (const root of roots) {
			if (root !== allocation.hud && root !== allocation.input) chromeRows += render(root);
		}
		allocation.apply({ columns: width, rows }, chromeRows, () => render(allocation.input));
		render(allocation.input);
		render(allocation.hud);
		return rendered;
	}

	#renderRoots(roots: readonly Component[], width: number): string[] {
		const rows: string[] = [];
		for (const root of roots) rows.push(...root.render(width));
		return rows;
	}
	/**
	 * Mounted-runtime rows for the transient resize buffer. Only the trailing
	 * viewport can survive the caller's bottom slice, so the transcript renders
	 * a bounded tail instead of the full committed ledger, and the chrome above
	 * it renders only when that tail underfills the screen.
	 */
	#renderResizeTail(width: number, rows: number): string[] {
		const roots = [...this.#runtimeChildren, this.#statusHost];
		const transcriptIndex = roots.findIndex(root => root instanceof TranscriptContainer);
		if (transcriptIndex < 0) return this.#renderRoots(roots, width);
		const transcript = roots[transcriptIndex] as TranscriptContainer;
		const afterRoots = roots.slice(transcriptIndex + 1);
		const allocated = this.#allocateRuntimeRows(afterRoots, width, rows);
		const after = allocated
			? afterRoots.flatMap(root => allocated.get(root)!.lines)
			: this.#renderRoots(afterRoots, width);
		const transcriptRows = transcript.renderTail(width, Math.max(0, rows - after.length));
		const pre =
			transcriptRows.length + after.length >= rows ? [] : this.#renderRoots(roots.slice(0, transcriptIndex), width);
		return [...pre, ...transcriptRows, ...after];
	}

	/** Reflow accepted hard rows exactly as the restored terminal buffer will. */
	#reflowRetiredHeader(width: number, start: number): string[] {
		const lines = this.#retiredHeaderRows;
		if (!lines) return [];
		if (isInsideTerminalMultiplexer()) return lines.slice(start);
		const reflowed: string[] = [];
		for (let index = start; index < lines.length; index++) {
			reflowed.push(...wrapLiteralLine(lines[index]!, width));
		}
		return reflowed;
	}

	/** Live editor whose draft survives startup and session adoption. */
	get editor(): CustomEditor {
		return this.#editor;
	}

	/** The welcome component currently mounted in the header, if quiet mode is off. */
	get welcome(): WelcomeComponent | undefined {
		return this.#welcome;
	}

	/** Whether this composer already owns the terminal render/input loop. */
	get started(): boolean {
		return this.#started && !this.#stopped;
	}

	/** Start terminal ownership and optionally begin the welcome intro. */
	start(options: ComposerStartOptions = {}): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		// A TSP terminal keeps (and draws) what is typed until startup releases
		// the held input, standing in for the kernel echo other terminals give.
		this.#editor.nativeTypeahead = options.deferInput === true;
		this.ui.start({ clearScrollback: options.clearScrollback === true, deferInput: options.deferInput === true });
		if (options.playWelcomeIntro !== false) this.playWelcomeIntro();
		// Deferred input identifies the CLI prepaint handoff. Flush the queued
		// forced frame before returning so subsequent dynamic-import evaluation
		// cannot monopolize the event loop ahead of the speculative status chrome.
		if (options.deferInput === true) this.ui.renderNow({ clearScrollback: options.clearScrollback === true });
	}
	/** Take raw-input ownership after a deferred-input start. Idempotent. */
	enableInput(): void {
		if (this.#stopped) return;
		this.ui.enableInput();
	}

	/** Apply settings changes without replacing the editor or welcome component. */
	setPreferences(update: Partial<ComposerPreferences>): void {
		if (this.#stopped) return;
		const wasQuiet = this.#preferences.quiet;
		this.#preferences = { ...this.#preferences, ...update };
		this.editor.setTheme(getEditorTheme());
		try {
			this.editor.setBorderStyle(this.#preferences.composerShape);
		} catch {
			// Extension-defined styles arrive with the session; InteractiveMode reapplies them.
		}
		this.ui.setShowHardwareCursor(this.#preferences.showHardwareCursor);
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.ui.setMaxInlineImages(this.#preferences.maxInlineImages);
		if (update.resizeScrollback !== undefined) this.ui.setResizeScrollback(update.resizeScrollback);
		this.editor.setImeSafeCursorLayout(this.#preferences.imeSafeCursor);
		this.editor.setAutocompleteMaxVisible(this.#preferences.autocompleteMaxVisible);
		this.editor.setSpellingFeatures({
			typoDetection: this.#preferences.spellingTypoDetection,
			autocomplete: this.#preferences.spellingAutocomplete,
			autocorrect: this.#preferences.spellingAutocorrect,
		});
		this.#startupStatus?.attachToEditor(this.editor, getComposerStyle(this.#preferences.composerShape));
		if (this.#preferences.quiet) {
			this.#welcome?.stopIntro();
			this.#welcome = undefined;
		} else {
			this.#ensureWelcome();
			this.#welcome?.invalidate();
			if (wasQuiet && this.#started) this.playWelcomeIntro();
		}
		if (wasQuiet !== this.#preferences.quiet) this.#rebuildHeader();
		this.ui.requestRender();
	}

	/** Patch welcome data in place as version, session, and project discovery complete. */
	updateWelcome(update: ComposerWelcomeUpdate): void {
		if (this.#stopped) return;
		this.#applyWelcomeUpdate(update);
		if (this.#preferences.quiet) return;
		this.#ensureWelcome();
		const welcome = this.#welcome;
		if (!welcome) return;
		if (update.version !== undefined) welcome.setVersion(this.#version);
		if (update.versionUpdate !== undefined) welcome.setVersionUpdate(this.#versionUpdate);
		this.ui.requestRender();
	}

	/** Replace optional header content around the stable welcome scene. */
	setHeaderExtras(before: readonly Component[], after: readonly Component[]): void {
		if (this.#stopped) return;
		this.#headerBefore = before;
		this.#headerAfter = after;
		this.#rebuildHeader();
		this.ui.requestRender();
	}

	/** Update the canonical editor reference after InteractiveMode remounts a custom editor. */
	setEditor(editor: CustomEditor): void {
		this.ui.replaceHeldFocus(this.#editor, editor);
		editor.nativeTypeahead = this.#editor.nativeTypeahead;
		this.#editor = editor;
	}

	/**
	 * End the startup input hold once the app's handlers are wired: the TSP
	 * terminal sends the typing it kept, and the keys the TUI held replay
	 * ({@link TUI.releaseHeldInput}). Idempotent.
	 */
	releaseHeldInput(): void {
		if (this.#editor.nativeTypeahead) {
			this.#editor.nativeTypeahead = false;
			this.ui.requestRender();
		}
		this.ui.releaseHeldInput();
	}

	/**
	 * Mount the session-aware status component into the slot below the editor,
	 * retiring the startup status line; the caller installs the real top-border
	 * provider through its composer-shape sync.
	 */
	setStatusComponent<TSession extends StatusLineSession>(component: StatusLineComponent<TSession>): void {
		if (this.#startupStatus) component.adoptGitStatus(this.#startupStatus);
		this.#disposeStartupStatus();
		this.#statusHost.setComponent(component);
		this.editor.setTopBorderProvider(undefined);
		this.editor.composerFacts = component;
	}

	#disposeStartupStatus(): void {
		this.#startupStatus?.dispose();
		this.#startupStatus = undefined;
	}

	/** Mount or replace session-aware root children while preserving the header and status hosts. */
	setRuntimeChildren(children: readonly Component[], options: RuntimeChildrenOptions = {}): void {
		if (this.#stopped) return;
		this.#nativeDock = options.nativeDock;
		this.#nativeTail = options.nativeTail ?? [];
		this.#coveringChrome = new Set(options.coveringChrome);
		this.#allocation = options.allocation;
		this.ui.removeChild(this.#statusHost);
		if (this.#runtimeMounted) {
			for (const child of this.#runtimeChildren) this.ui.removeChild(child);
		} else {
			this.ui.removeChild(this.#bootstrapInputGap);
			this.ui.removeChild(this.editor);
			this.#runtimeMounted = true;
		}
		this.#runtimeChildren = children;
		for (const child of children) this.ui.addChild(child);
		this.ui.addChild(this.#statusHost);
		this.ui.requestRender();
	}

	/** Play or replay the welcome intro against the stable header render target. */
	playWelcomeIntro(): void {
		this.#welcome?.playIntro(() => this.ui.requestComponentRender(this.#header));
	}

	/** Transfer terminal ownership to InteractiveMode without stopping the composer. */
	transfer(): void {
		if (!this.#started || this.#stopped || this.#transferred) {
			throw new Error("Composer is not available for transfer");
		}
		this.#transferred = true;
	}

	/** Stop a composer that has not transferred terminal ownership. */
	stop(): void {
		if (!this.#started || this.#stopped || this.#transferred) return;
		this.#welcome?.stopIntro();
		this.#disposeStartupStatus();
		this.ui.stop();
		this.#stopped = true;
	}

	#applyWelcomeUpdate(update: ComposerWelcomeUpdate): void {
		if (update.version !== undefined) this.#version = update.version;
		if (update.versionUpdate !== undefined) this.#versionUpdate = update.versionUpdate;
	}

	#ensureWelcome(): void {
		if (this.#welcome) return;
		this.#welcome = new WelcomeComponent(this.#version);
		this.#welcome.setVersionUpdate(this.#versionUpdate);
	}

	#rebuildHeader(): void {
		this.#header.clear();
		for (const component of this.#headerBefore) this.#header.addChild(component);
		if (this.#welcome) {
			this.#header.addChild(new Spacer(1));
			this.#header.addChild(this.#welcome);
			this.#header.addChild(new Spacer(1));
		}
		for (const component of this.#headerAfter) this.#header.addChild(component);
	}

	#handleInterrupt(): void {
		const now = this.#now();
		if (now - this.#lastInterruptAt < DOUBLE_INTERRUPT_MS) {
			this.#requestExit(130);
			return;
		}
		this.editor.setText("");
		this.#lastInterruptAt = now;
	}

	#requestExit(code: number): void {
		// Remains live after transfer until InteractiveMode installs its configured handlers.
		if (this.#stopped) return;
		this.#welcome?.stopIntro();
		if (this.#started) this.ui.stop();
		this.#stopped = true;
		this.#exit(code);
	}
}
