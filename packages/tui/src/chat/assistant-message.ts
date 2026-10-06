import type { AssistantMessage, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { type Component, Container } from "../tui";
import { Image, type ImageBudget } from "../components/image";
import { ImageProtocol, TERMINAL } from "../terminal-capabilities";
import { Markdown, type MarkdownTheme } from "../components/markdown";
import { Spacer } from "../components/spacer";
import { Text } from "../components/text";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import type {
	AssistantTextDisplayRenderer,
	AssistantTextDisplayResult,
	AssistantThinkingRenderer,
} from "./extension-types";
import { ensureThemeSync, getMarkdownTheme, getThemeEpoch, theme } from "../theme";
import { card, col, elapsed, node, span, text } from "../native/describe";
import { hasTranscriptActions, runTranscriptAction } from "./transcript-actions";
import type { NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { isNativeRendering } from "../native/state";
import { NativeImageCache } from "../native/blobs";
import { Memo } from "../native/memo";
import { EMPTY_LINK_TARGETS, resolveImageOptions } from "../render/render-utils";
import { WidthAwareText } from "../render";
import { cachedPngConversion, convertImageToPngShared, imagePayloadKey } from "./image-loading";
import { canonicalizeMessage, formatThinkingForDisplay, hasDisplayableThinking } from "./thinking-display";
import { resolveAssistantErrorPresentation } from "./transcript-render-helpers";
import { type CacheInvalidation, CacheInvalidationMarkerComponent } from "./cache-invalidation-marker";
import { formatErrorBlock } from "../chrome/error-block";
import { type ServedModelMismatch, ServedModelMarkerComponent } from "./served-model-marker";
import { isReactionTarget, type ReactionSplit, type ReactionTarget, splitReaction } from "./reaction";
import { isRowPrefix, type TranscriptStableRow, trimBlankEdges } from "../chrome/transcript-container";
import { formatTurnUsage, type TurnUsageSummary } from "../overlays/usage-row";
import { FigureMarkdown } from "./figure-markdown";
import { svgFigureRendering } from "./svg-figure";
import { hasSvgFence } from "./svg-source";
import { describeTableChart, hasChartTable, lookupTableChart, splitTableCharts } from "./table-chart";

/**
 * Max wrapped rows of a turn-ending provider error rendered inline in the
 * transcript. Bounds pathological error bodies — e.g. a proxy 502 whose body
 * is a full HTML page — so they can't flood the scrollback, while a long
 * single-line body wraps to the width instead of being cut at a fixed column.
 * Full text is still kept in the persisted session.
 */
const MAX_TRANSCRIPT_ERROR_ROWS = 8;
const EMPTY_STABLE_RENDER: readonly string[] = [];
const TEXT_DISPLAY_FAILURE = "文本显示失败：未获得完整的显示文本。";

/** The native head of a finished thinking block: "Thought for 12s", or "Thought" when it was never seen streaming. */
function thoughtLabel(clock: { start: number; end?: number } | undefined): string {
	if (clock?.end === undefined) return "Thought";
	const ms = clock.end - clock.start;
	return `Thought for ${ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : formatDuration(ms)}`;
}

type ThinkingContentBlock = Extract<AssistantMessage["content"][number], { type: "thinking" }>;
/** Renders one text or thinking block: Markdown, or {@link FigureMarkdown} for text holding a ```svg fence. */
type ProseBlock = Markdown | FigureMarkdown;
/** A streamed block the fast path updates in place. */
interface FastPathItem {
	md: ProseBlock;
	contentIndex: number;
	blockType: "text" | "thinking";
	lastText: string;
}
type DisplayThinkingContentBlock = ThinkingContentBlock & { rawThinking?: string };
type StablePartKind = "thinking" | "text";
type StablePart = { kind: StablePartKind; text: string } | { kind: "spacer" };

/**
 * One published prefix of the block's finished content. Later snapshots extend
 * earlier ones part-wise (only the final part may grow), so rendered stable
 * rows only ever gain a suffix — the append-only transcript contract that lets
 * them retire into native scrollback mid-stream.
 */
interface StableSnapshot {
	// Earlier parts are immutable; only the final part needs a historical offset.
	readonly partCount: number;
	readonly lastTextLength: number;
}

/**
 * Stable-row renders at one width. `rows` renders snapshot `newest`; every
 * count in `ends` renders byte-identically to `rows.slice(0, end)` — checked
 * against `rows` when recorded — so an earlier prefix is a slice of the newest
 * render instead of a re-render, and one row array stays resident per width.
 */
interface StableRowLedger {
	newest: number;
	rows: readonly string[];
	readonly ends: Map<number, number>;
	/** Rendered rows of parts a snapshot has closed (full text final), by part index. */
	readonly parts: (
		| { readonly kind: StablePartKind; readonly text: string; readonly rows: readonly string[] }
		| undefined
	)[];
}

/** One Markdown instance reused while a stable part's text grows between renders. */
interface StablePartRenderer {
	readonly index: number;
	readonly kind: StablePartKind;
	readonly md: Markdown;
}

/** Theme inputs cached stable renders were produced with; any change drops them. */
interface StableRenderInputs {
	readonly prose: MarkdownTheme;
	readonly markdown: MarkdownTheme;
	readonly color: ((text: string) => string) | undefined;
}

function isSnapshotExtension(previous: readonly StablePart[], current: readonly StablePart[]): boolean {
	if (previous.length > current.length) return false;
	for (let index = 0; index < previous.length; index++) {
		const before = previous[index]!;
		const after = current[index]!;
		if (before.kind !== after.kind) return false;
		if (before.kind === "spacer" || after.kind === "spacer") continue;
		const isLast = index === previous.length - 1;
		if (isLast ? !after.text.startsWith(before.text) : after.text !== before.text) return false;
	}
	return true;
}

function resolveThinkingDisplay(block: ThinkingContentBlock, proseOnly: boolean): { text: string; visible: boolean } {
	const rawThinking = (block as DisplayThinkingContentBlock).rawThinking;
	// When rawThinking is set, `block.thinking` is already the formatted display
	// text that buildDisplayMessage produced (then revealed/sliced by the
	// streaming controller) — re-running the formatter would double-process it,
	// and the growing revealed slice would never hit the per-tick memo. Only
	// format raw (non-display) thinking blocks.
	const formatted = rawThinking !== undefined ? block.thinking : formatThinkingForDisplay(block.thinking, proseOnly);
	return {
		text: formatted.trim(),
		visible: hasDisplayableThinking(rawThinking ?? block.thinking, formatted),
	};
}

/**
 * Frames for the streaming "thinking" pulse rendered in place of a hidden
 * thinking block while the model is still producing it. A single fixed-width
 * starburst cycles through facets (✻ ✼ ❉ ❊ ✺ ✹ ✸ ✶) so the indicator animates
 * in place without shifting the line or the trailing speed badge. The dwell per
 * frame eases between {@link THINKING_DOTS_FRAME_MS_MIN} and
 * {@link THINKING_DOTS_FRAME_MS_MAX} across each revolution (see
 * {@link AssistantMessageComponent.thinkingDotsFrameDelay}).
 */
const THINKING_DOTS_FRAMES = ["✻", "✼", "❉", "❊", "✺", "✹", "✸", "✶"] as const;
/**
 * Pulse cadence bounds (ms). Each frame's dwell eases between these on a
 * raised-cosine "breath" — quickest at the cycle start, slowest at its midpoint —
 * so the starburst accelerates and slows instead of ticking at one fixed rate.
 * Mean ≈ 150ms, snappier than the previous flat 320ms.
 */
const THINKING_DOTS_FRAME_MS_MIN = 70;
const THINKING_DOTS_FRAME_MS_MAX = 230;

/** Rolling window (ms) over which streaming-rate observations are averaged. */
const SPEED_WINDOW_MS = 3000;
/** Color/clamp ceiling: a rate at or above this maps to the full accent color. */
const SPEED_MAX = 200;

/**
 * Session-wide streaming-speed gauge. Only one thinking indicator animates at a
 * time, so a single shared instance accumulates instantaneous tok/s observations
 * and reports their windowed average — smoothing the jumpy per-delta numbers.
 * Each thinking block resets the gauge on its first live sample (see
 * {@link AssistantMessageComponent.updateContent}) so the average reflects only
 * the active block, never a previous turn's trailing rate. Components feed it
 * deltas (not cumulative totals), so a fresh turn restarting its token count at
 * zero never produces a spike.
 */
class SpeedTracker {
	#observations: Array<{ time: number; rate: number }> = [];

	#prune(now: number): void {
		const threshold = now - SPEED_WINDOW_MS;
		while (this.#observations.length > 0 && this.#observations[0]!.time < threshold) {
			this.#observations.shift();
		}
	}

	/** Record one instantaneous tok/s reading, clamped to {@link SPEED_MAX} so a
	 *  single oversized delta (e.g. a buffered reflow tick) can't poison the
	 *  windowed average. Non-finite/negative rates ignored. */
	observe(rate: number, now = performance.now()): void {
		if (!Number.isFinite(rate) || rate < 0) return;
		this.#observations.push({ time: now, rate: Math.min(rate, SPEED_MAX) });
		this.#prune(now);
	}

	/** Windowed-average tok/s; 0 once observations age out of the window. */
	getSpeed(now = performance.now()): number {
		this.#prune(now);
		if (this.#observations.length === 0) return 0;
		let sum = 0;
		for (const o of this.#observations) sum += o.rate;
		return sum / this.#observations.length;
	}

	reset(): void {
		this.#observations = [];
	}
}

/** One gauge for the whole session — see {@link SpeedTracker}. */
const sharedSpeedTracker = new SpeedTracker();

/** Test-only: clear the shared gauge so observations don't leak across cases. */
export function resetThinkingSpeedTracker(): void {
	sharedSpeedTracker.reset();
}

/**
 * Linear-interpolate two `#rrggbb` colors in sRGB space. `t` clamps to [0,1]:
 * `t = 0` → `from`, `t = 1` → `to`. Drives the streaming speed badge, fading
 * from a dim gray toward the theme accent as tok/s rises.
 */
function lerpHex(from: string, to: string, t: number): string {
	const k = t < 0 ? 0 : t > 1 ? 1 : t;
	const fr = Number.parseInt(from.slice(1, 3), 16);
	const fg = Number.parseInt(from.slice(3, 5), 16);
	const fb = Number.parseInt(from.slice(5, 7), 16);
	const tr = Number.parseInt(to.slice(1, 3), 16);
	const tg = Number.parseInt(to.slice(3, 5), 16);
	const tb = Number.parseInt(to.slice(5, 7), 16);
	const r = Math.round(fr + (tr - fr) * k);
	const g = Math.round(fg + (tg - fg) * k);
	const b = Math.round(fb + (tb - fb) * k);
	return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

/**
 * Renders an assistant message; streaming content remains mutable until the
 * provider finalizes it because later deltas can revise earlier Markdown.
 * The exception is the leading run of visible thinking blocks: raw thinking
 * only ever appends, so its frozen Markdown prefix publishes as append-only
 * stable rows ({@link AppendOnlyTranscriptBlock}) and can retire into native
 * scrollback while the block still streams — a long reasoning trace is no
 * longer clipped to the mutable viewport.
 */
export class AssistantMessageComponent extends Container {
	readonly transcriptBlockMode = "appendOnly" as const;
	#contentContainer: Container;
	#markerSlot: Container;
	#cacheMarker?: CacheInvalidationMarkerComponent;
	#servedModelMarker?: ServedModelMarkerComponent;
	#lastMessage?: AssistantMessage;
	#emergencyText?: ProseBlock;
	#toolImagesByCallId = new Map<string, ImageContent[]>();
	/**
	 * Payload keys ({@link imagePayloadKey}) whose Kitty PNG conversion this
	 * component already awaits, so a re-delivered image neither re-encodes nor
	 * schedules a second {@link updateContent} cascade. The conversions
	 * themselves are shared process-wide by {@link convertImageToPngShared}.
	 */
	#kittyConversionsAwaited = new Set<string>();
	/**
	 * Conversions this component displays, held so a later re-render (theme
	 * invalidation) still finds them after the bounded shared cache evicts them.
	 */
	#kittyConverted = new Map<string, ImageContent>();
	#showImages = true;
	#showToolResultImages = true;
	#transcriptBlockFinalized: boolean;
	/** See {@link setMidStreamPublication}; the wire's `stream-revision` axis decides it. */
	#midStreamPublication = true;
	/**
	 * When true, the turn-ending `Error: …` line for `stopReason === "error"` is
	 * suppressed because the same error is currently shown in the pinned banner
	 * above the editor (see `EventController` + `ErrorBannerComponent`). Avoids
	 * rendering the identical error twice (inline + banner) at the error moment.
	 * Restored to `false` when the banner is cleared at the next turn so the
	 * transcript keeps the error in history.
	 */
	#errorPinned = false;
	/**
	 * Whether the inline turn-ending error block renders its full body instead of
	 * the {@link MAX_TRANSCRIPT_ERROR_ROWS}-capped preview. Toggled by
	 * {@link setExpanded} so Ctrl+O (tool-output expansion) reveals a long
	 * provider error whose tail would otherwise be unreachable in the live TUI.
	 */
	#errorExpanded = false;
	/** The deduplicated message the native error frame shows (its "Copy error" copies it). */
	#errorText: string | undefined;
	/** A TTSR rule aborted this text; the turn re-streams below it. */
	#rewound = false;
	/** The turn's totals when this answer ends it; a TSP terminal shows them under the answer. */
	#turnUsage: TurnUsageSummary | undefined;
	/**
	 * True when the current {@link updateContent} message carries a truncatable
	 * inline provider error (the `#appendErrorBlock` path) — set whether or not
	 * the inline block was actually drawn, so it stays true even while the error
	 * is suppressed under a pinned banner. Gates {@link setExpanded} so toggling
	 * expansion only re-renders assistant turns that carry such an error, not
	 * every message in the transcript.
	 */
	#hasTruncatableError = false;
	/**
	 * Monotonic content version reported to the transcript container via
	 * {@link getTranscriptBlockVersion}. Bumped by {@link updateContent} — the
	 * choke point every mutator funnels through, including post-finalize changes
	 * such as `setErrorPinned(false)` restoring the inline error at the next
	 * turn's `agent_start`, late tool-result images, and async Kitty conversions.
	 */
	#blockVersion = 0;
	/** Whether the last updateContent carried an in-flight streaming partial; such
	 *  renders bypass the markdown module LRU (see Markdown.transientRenderCache). */
	#lastUpdateTransient = false;
	// Fast-path state: reuse Markdown children when message shape is stable during streaming.
	#fastPathKey: string | undefined;
	#fastPathItems: FastPathItem[] | undefined;
	/**
	 * Text blocks whose ```svg fences are lifted into figures, by content index.
	 * Kept across slow-path rebuilds so a figure keeps its raster (and its
	 * in-flight one) instead of starting over on every update.
	 */
	#figureBlocks = new Map<number, FigureMarkdown>();
	/** Live "thinking" pulse shown in place of a hidden thinking block while it
	 *  streams; undefined when not animating. Driven by {@link #thinkingDotsTimer}. */
	#thinkingDots: Text | undefined;
	#thinkingDotsTimer: NodeJS.Timeout | undefined;
	#thinkingDotsFrame = 0;
	/** Previous cumulative provider token count + timestamp, for deriving this
	 *  block's instantaneous streaming rate fed into {@link sharedSpeedTracker}.
	 *  Undefined until the first thinking update of this block. */
	#lastTokenCount: number | undefined;
	#lastTokenTime = 0;
	/** Published width-independent stable prefixes; grows only, never retracts. */
	#stableSnapshots: StableSnapshot[] = [];
	#stableParts: readonly StablePart[] = [];
	#nextStableRowId = 0;
	#transcriptStableRows: TranscriptStableRow[] = [];
	/**
	 * Verified stable-row renders per width ({@link StableRowLedger}). The
	 * container asks for several counts per frame (emitted, offered end,
	 * projected) and each publication re-checks the previous prefix; the ledger
	 * answers all of them from the newest render. A few widths cover resizes.
	 * Cleared on reset, finalize, and theme change.
	 */
	#stableLedgers = new LRUCache<number, StableRowLedger>({ max: 4 });
	/** Prefixes handed out as ledger slices or rendered off-ledger, by `${count}:${width}`. */
	#stableRenderCache = new LRUCache<string, readonly string[]>({ max: 8 });
	/** Reused for the growing final part of each publication candidate. */
	#stableHeadRenderer: StablePartRenderer | undefined;
	/** Reused for final parts of published snapshots rendered off-ledger (reflow, replay). */
	#stableReplayRenderer: StablePartRenderer | undefined;
	#stableRenderInputs: StableRenderInputs | undefined;
	/** Provider-reported tokens in the live thinking block — reasoning tokens when
	 *  the provider streams them, else total output — shown dimmed beside the
	 *  speed badge. 0 when no thinking is streaming. */
	#thinkingTokens = 0;
	/** Whether this block has observed a positive provider-token delta — i.e. it is
	 *  genuinely streaming tokens right now. Gates the numeric speed badge so the
	 *  session-wide {@link sharedSpeedTracker} can't surface a previous turn's rate
	 *  on a fresh block that has no live token throughput of its own. */
	#thinkingRateLive = false;

	#textColorTransform?: (text: string) => string;
	#linkTargets: ReadonlyMap<string, string> = EMPTY_LINK_TARGETS;
	#markdownTheme: MarkdownTheme | undefined;
	/** Block this reply reacts to; undefined when the preceding block takes no reactions. */
	#reactionTarget: ReactionTarget | undefined;
	/** Reaction lifted from the reply's opening emoji, once resolved. */
	#reaction: string | undefined;
	/** Display-only text projections and reactions; #lastMessage remains the source. */
	#displayedMessage: AssistantMessage | undefined;
	#projectedTextBlocks = new Set<number>();
	#pendingTextDisplayBlocks = new Set<number>();
	/** Thinking-extension components per content index, recorded when the slow path mounts them. */
	#thinkingExtensions = new Map<number, Component[]>();
	/** Collapse state of thinking sections toggled in the terminal, by content index; cleared by {@link setHideThinkingBlock}. */
	#thinkingCollapsed = new Map<number, boolean>();
	/** When each thinking block was seen streaming and when it stopped (native "Thought for 12s"), by content index. */
	#thinkingClock = new Map<number, { start: number; end?: number; tokens: number }>();
	#nativeViewVersion = 0;
	readonly #native = new Memo();
	/** Markdown nodes by key, reused while their text and streaming flag are unchanged. */
	#nativeParts = new Map<string, { text: string; stream: boolean; node: NativeNode }>();
	readonly #nativeImages = new NativeImageCache();
	/** Smart table chart picks a TSP describe is waiting on. */
	readonly #chartPicks = new Set<Promise<void>>();

	setTextColorTransform(transform?: (text: string) => string): void {
		this.#textColorTransform = transform;
	}

	#getProseTheme(): MarkdownTheme {
		if (this.#markdownTheme) return this.#markdownTheme;
		const base = getMarkdownTheme();
		const snapshot = this.#linkTargets;
		const markdownTheme = snapshot.size > 0 ? { ...base, resolveLink: (href: string) => snapshot.get(href) } : base;
		this.#markdownTheme = markdownTheme;
		return markdownTheme;
	}

	/**
	 * Install resolved destinations for model-authored prose links. A fresh
	 * theme object is required whenever the map changes because Markdown's
	 * render cache keys themes by object identity.
	 */
	setLinkTargets(targets: ReadonlyMap<string, string>): void {
		if (
			targets === this.#linkTargets ||
			(targets.size === this.#linkTargets.size &&
				[...targets].every(([href, target]) => this.#linkTargets.get(href) === target))
		) {
			return;
		}
		this.#linkTargets = targets;
		this.#markdownTheme = undefined;
		this.#fastPathKey = undefined;
		this.#fastPathItems = undefined;
		for (const block of this.#figureBlocks.values()) block.restyle();
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	/**
	 * Choose the block this reply reacts to from the transcript it is about to
	 * join: the nearest preceding reaction-capable block (the user's bubble),
	 * looking past turn attachments such as file mentions or injected notices
	 * but never past an earlier reply — a continuation after tool calls has
	 * nothing to react to. Call before adding this component. An
	 * already-resolved reaction is re-applied, and a message rendered verbatim
	 * for lack of a target is re-rendered with its reaction stripped.
	 */
	pickReactionTarget(transcript: readonly Component[]): void {
		this.#reactionTarget = undefined;
		for (let index = transcript.length - 1; index >= 0; index--) {
			const block = transcript[index]!;
			if (isReactionTarget(block)) {
				this.#reactionTarget = block;
				break;
			}
			if (block instanceof AssistantMessageComponent) break;
		}
		if (this.#reaction !== undefined) this.#reactionTarget?.setReaction(this.#reaction);
		if (this.#lastMessage && this.#openingText(this.#lastMessage)?.split.emoji !== undefined) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	/** The reply's first non-empty text block with its reaction split, if any. */
	#openingText(message: AssistantMessage): { index: number; block: TextContent; split: ReactionSplit } | undefined {
		const index = message.content.findIndex(content => content.type === "text" && content.text.length > 0);
		const block = message.content[index];
		if (block?.type !== "text") return undefined;
		return { index, block, split: splitReaction(block.text) };
	}

	/**
	 * Display form of `message` with the reaction handled: stripped and
	 * forwarded to the target once resolved, withheld entirely while a streaming
	 * prefix could still become one, and left verbatim when there is no target.
	 */
	#displayMessage(message: AssistantMessage, transient: boolean): AssistantMessage {
		const opening = this.#openingText(message);
		if (!opening) return message;
		const { index, block, split } = opening;
		let text: string;
		if (split.emoji !== undefined) {
			if (this.#reaction !== split.emoji) {
				this.#reaction = split.emoji;
				this.#reactionTarget?.setReaction(split.emoji);
			}
			if (!this.#reactionTarget) return message;
			text = split.body;
		} else if (split.pending && transient) {
			text = "";
		} else {
			return message;
		}
		const content = message.content.slice();
		content[index] = { ...block, text };
		return { ...message, content };
	}

	#projectTextDisplay(source: AssistantMessage, display: AssistantMessage, transient: boolean): AssistantMessage {
		this.#projectedTextBlocks.clear();
		this.#pendingTextDisplayBlocks.clear();
		if (this.#textDisplayRenderers.length === 0) return display;
		let content: AssistantMessage["content"] | undefined;
		const opening = this.#reactionTarget ? this.#openingText(source) : undefined;
		for (let index = 0; index < source.content.length; index++) {
			const block = source.content[index]!;
			if (block.type !== "text") continue;
			let result: AssistantTextDisplayResult | undefined;
			for (const renderer of this.#textDisplayRenderers) {
				try {
					result = renderer(block.text, { message: source, blockIndex: index, transient });
				} catch {
					// Display failures must be visible, not fall back to potentially private source prose.
					result = { text: TEXT_DISPLAY_FAILURE };
				}
				if (result !== undefined) break;
			}
			if (result === undefined) continue;
			this.#projectedTextBlocks.add(index);
			const pending = result.pending === true && transient;
			if (pending) this.#pendingTextDisplayBlocks.add(index);
			let text = result.pending === true && !transient ? TEXT_DISPLAY_FAILURE : result.text;
			if (opening?.index === index && opening.split.emoji !== undefined) {
				const reaction = splitReaction(text);
				if (reaction.emoji !== undefined) text = reaction.body;
			}
			const displayedBlock = display.content[index]!;
			if (displayedBlock.type !== "text" || displayedBlock.text === text) continue;
			// Reaction handling may already own a shallow display copy; reuse it.
			content ??= display === source ? display.content.slice() : display.content;
			content[index] = { ...displayedBlock, text };
		}
		return content && display === source ? { ...display, content } : display;
	}

	/** Pending prose cannot be sealed merely because a following tool call started. */
	hasPendingTextDisplay(): boolean {
		return this.#pendingTextDisplayBlocks.size > 0;
	}
	#hideThinkingBlock: boolean;
	readonly #onImageUpdate?: () => void;
	readonly #thinkingRenderers: readonly AssistantThinkingRenderer[];
	readonly #textDisplayRenderers: readonly AssistantTextDisplayRenderer[];
	readonly #imageBudget?: ImageBudget;
	#proseOnlyThinking: boolean;
	#expandThinkingBlocks: boolean;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		onImageUpdate?: () => void,
		thinkingRenderers: readonly AssistantThinkingRenderer[] = [],
		imageBudget?: ImageBudget,
		proseOnlyThinking = true,
		linkTargets?: ReadonlyMap<string, string>,
		textDisplayRenderers: readonly AssistantTextDisplayRenderer[] = [],
		expandThinkingBlocks = false,
	) {
		super();
		this.#hideThinkingBlock = hideThinkingBlock;
		this.#onImageUpdate = onImageUpdate;
		this.#thinkingRenderers = thinkingRenderers;
		this.#textDisplayRenderers = textDisplayRenderers;
		this.#imageBudget = imageBudget;
		this.#proseOnlyThinking = proseOnlyThinking;
		this.#expandThinkingBlocks = expandThinkingBlocks;

		ensureThemeSync();
		this.#transcriptBlockFinalized = message !== undefined;
		if (linkTargets?.size) this.#linkTargets = linkTargets;

		// Container for text/thinking content.
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		// Cache-miss usage arrives only at message end. Keep its divider after
		// streamed content so rows already emitted to native history remain a
		// prefix of this append-only block.
		this.#markerSlot = new Container();
		this.addChild(this.#markerSlot);

		if (message) {
			this.updateContent(message);
		}
	}

	/**
	 * Show or clear the trailing cache-invalidation divider. Set at `message_end`
	 * (live) or during rebuild, once the turn's usage is known and compared
	 * against the previous turn's cache footprint.
	 */
	setCacheInvalidation(info: CacheInvalidation | undefined): void {
		this.#cacheMarker = info ? new CacheInvalidationMarkerComponent(info) : undefined;
		this.#refreshMarkers();
	}

	/** Mark this answer as the end of a turn with the turn's totals (native only: ANSI keeps them in the status line). */
	setTurnUsage(summary: TurnUsageSummary | undefined): void {
		this.#turnUsage = summary;
		this.#nativeViewVersion++;
	}

	/**
	 * Show or clear the trailing served-model divider. Set once the turn's
	 * signed thinking block (or router report) has named the model that actually
	 * answered, when it differs from the one requested.
	 */
	setServedModelMismatch(info: ServedModelMismatch | undefined): void {
		this.#servedModelMarker = info ? new ServedModelMarkerComponent(info) : undefined;
		this.#refreshMarkers();
	}

	#refreshMarkers(): void {
		this.#markerSlot.clear();
		if (this.#servedModelMarker) this.#markerSlot.addChild(this.#servedModelMarker);
		if (this.#cacheMarker) this.#markerSlot.addChild(this.#cacheMarker);
		this.#blockVersion++;
	}

	override invalidate(): void {
		super.invalidate();
		// Theme/symbol changes arrive via invalidate(). Fast-path children captured
		// their theme at construction, so drop them and force the teardown path to
		// rebuild with the current theme. Streaming updates call updateContent()
		// directly and keep the fast path.
		this.#markdownTheme = undefined;
		this.#fastPathKey = undefined;
		this.#fastPathItems = undefined;
		for (const block of this.#figureBlocks.values()) block.restyle();
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.#hideThinkingBlock = hide;
		this.#thinkingCollapsed.clear();
	}

	/**
	 * Allow or withhold retiring finished lines into native scrollback while the
	 * turn is still streaming. Wires the `stream-revision` axis marks as able to
	 * revise already-streamed text must withhold it: published bytes go to
	 * terminal history once and cannot be retracted, so a later revision would
	 * leave the reader with a stale copy. Withholding costs only reachability —
	 * the block still retires whole when the turn ends.
	 */
	setMidStreamPublication(allowed: boolean): void {
		this.#midStreamPublication = allowed;
	}

	setProseOnlyThinking(proseOnly: boolean): void {
		this.#proseOnlyThinking = proseOnly;
	}

	/**
	 * Keep finished thinking sections expanded instead of folding them to "Thought for 12s".
	 * Sections the user folded or unfolded by hand keep that choice.
	 */
	setExpandThinkingBlocks(expand: boolean): void {
		if (this.#expandThinkingBlocks === expand) return;
		this.#expandThinkingBlocks = expand;
		this.#nativeViewVersion++;
	}

	override dispose(): void {
		this.#stopThinkingAnimation();
		super.dispose();
	}

	/**
	 * Whether to render the animated "thinking" pulse in place of the suppressed
	 * reasoning: only while this block is still streaming (not yet finalized — the
	 * in-flight message always carries `stopReason: "stop"`, so finalization is the
	 * only reliable live signal), thinking is hidden, no tool call has started, and
	 * the active tail block is a thinking block (the model is reasoning right now).
	 * Once text starts, a tool call streams, or the block is sealed, the pulse ends.
	 */
	#shouldAnimateThinking(message: AssistantMessage): boolean {
		return this.#hideThinkingBlock && this.#thinkingTailIndex(message) !== undefined;
	}

	/**
	 * Content index of the thinking block the model is producing right now:
	 * the block is still streaming (not finalized), no tool call has started,
	 * and the tail visible block is thinking. Undefined otherwise.
	 */
	#thinkingTailIndex(message: AssistantMessage): number | undefined {
		if (this.#transcriptBlockFinalized) return undefined;
		let tail: "text" | "thinking" | undefined;
		let tailIndex = -1;
		for (let index = 0; index < message.content.length; index++) {
			const content = message.content[index]!;
			if (content.type === "toolCall") return undefined;
			if (content.type === "text" && canonicalizeMessage(content.text)) {
				tail = "text";
				tailIndex = index;
			} else if (content.type === "thinking" && canonicalizeMessage(content.thinking)) {
				tail = "thinking";
				tailIndex = index;
			}
		}
		return tail === "thinking" ? tailIndex : undefined;
	}

	#thinkingDotsLabel(): string {
		const glyph = THINKING_DOTS_FRAMES[this.#thinkingDotsFrame % THINKING_DOTS_FRAMES.length] ?? "…";
		const coloredGlyph = theme.fg("thinkingText", glyph);
		const thinkingLabel = theme.fg("muted", " Thinking");
		const rate = Math.min(SPEED_MAX, sharedSpeedTracker.getSpeed());
		// The numeric badge ("<total> · <rate> toks/s") only renders while this block
		// is genuinely streaming provider tokens. A block that has observed no token
		// delta (e.g. a provider that reports usage only at turn end) or whose rate
		// has decayed to zero (a streaming lull) drops it entirely — the persistent
		// text label keeps the pulse descriptive for terminals and screen readers.
		// The liveness flag also stops the session-wide gauge from leaking a previous
		// turn's rate onto a fresh token-less block.
		if (!this.#thinkingRateLive || rate < 0.05) return coloredGlyph + thinkingLabel;
		// Total provider tokens, dimmed, sit next to the pulse.
		const totalSpan = this.#thinkingTokens > 0 ? theme.fg("dim", ` · ${formatNumber(this.#thinkingTokens)}`) : "";
		// Speed badge color: dim gray at rest, brightening toward the theme accent as
		// streaming speed climbs (gray → bright accent). Ease (sqrt) so typical
		// mid-stream rates already read as clearly accent-tinted instead of staying
		// gray until the rarely-hit SPEED_MAX ceiling.
		const ratio = Math.sqrt(rate / SPEED_MAX);
		const hex = lerpHex(theme.getColorHex("dim"), theme.getAccentColorHex(), ratio);
		const rateText = ` · ${rate.toFixed(1)} toks/s`;
		const rateSpan = theme.getColorMode() === "truecolor" ? chalk.hex(hex)(rateText) : theme.fg("muted", rateText);
		return coloredGlyph + thinkingLabel + totalSpan + rateSpan;
	}

	#startThinkingAnimation(): void {
		// A native terminal clocks the described starburst itself.
		if (this.#thinkingDotsTimer || isNativeRendering()) return;
		this.#scheduleThinkingFrame();
	}

	/** Eased dwell (ms) for the current pulse frame: a raised cosine over the
	 *  8-frame cycle, continuous across the wrap, so the rotation breathes rather
	 *  than advancing at a fixed interval. */
	#thinkingDotsFrameDelay(): number {
		const phase = (1 - Math.cos((2 * Math.PI * this.#thinkingDotsFrame) / THINKING_DOTS_FRAMES.length)) / 2;
		return THINKING_DOTS_FRAME_MS_MIN + (THINKING_DOTS_FRAME_MS_MAX - THINKING_DOTS_FRAME_MS_MIN) * phase;
	}

	/** Self-rescheduling timeout (not a fixed interval) so each frame can pick its
	 *  own eased dwell. */
	#scheduleThinkingFrame(): void {
		this.#thinkingDotsTimer = setTimeout(() => this.#advanceThinkingDots(), this.#thinkingDotsFrameDelay());
		this.#thinkingDotsTimer.unref?.();
	}

	#advanceThinkingDots(): void {
		this.#thinkingDotsTimer = undefined;
		if (!this.#thinkingDots || isNativeRendering()) {
			this.#stopThinkingAnimation();
			return;
		}
		this.#thinkingDotsFrame = (this.#thinkingDotsFrame + 1) % THINKING_DOTS_FRAMES.length;
		if (this.#thinkingDots.setText(this.#thinkingDotsLabel())) {
			this.#onImageUpdate?.();
		}
		this.#scheduleThinkingFrame();
	}

	#stopThinkingAnimation(): void {
		if (this.#thinkingDotsTimer) {
			clearTimeout(this.#thinkingDotsTimer);
			this.#thinkingDotsTimer = undefined;
		}
		this.#thinkingDotsFrame = 0;
	}

	/**
	 * Toggle suppression of the inline `Error: …` line while the same error is
	 * pinned in the banner above the editor. Re-renders so the change is visible.
	 */
	setErrorPinned(pinned: boolean): void {
		if (this.#errorPinned === pinned) return;
		this.#errorPinned = pinned;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	/**
	 * Expand or collapse the inline turn-ending error block so Ctrl+O
	 * (tool-output expansion) can reveal a long provider error's hidden tail.
	 * Only re-renders when the current message carries a truncatable error, so
	 * toggling expansion across the transcript skips ordinary turns. Works even
	 * while the error is pinned in the banner: the inline block is drawn (in full)
	 * when expanded so the complete body is reachable without sending a message.
	 */
	setExpanded(expanded: boolean): void {
		if (this.#errorExpanded === expanded) return;
		this.#errorExpanded = expanded;
		if (this.#hasTruncatableError && this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#transcriptBlockFinalized;
	}

	/** Whether a figure still waits for the raster of its final source; the transcript holds retirement meanwhile. */
	isTranscriptBlockPending(): boolean {
		for (const block of this.#figureBlocks.values()) if (block.pending) return true;
		return false;
	}

	override render(width: number): readonly string[] {
		const rows = super.render(width);
		this.#publishStableSnapshot(rows, width);
		return rows;
	}

	/**
	 * A `col` (role `omp.assistant`) of `md` nodes keyed by content index, so
	 * streamed deltas reach the terminal as `text append` on the same node;
	 * the tail block carries `stream: true` until the message finalizes.
	 * Thinking blocks are quiet collapsible `section`s: a muted "Thinking…"
	 * shimmer while live, then "Thought for 12s"; tokens and rate ride in the
	 * head's `title`. With `hideThinkingBlock` only the live head shows (collapsed)
	 * and a finished thought emits nothing.
	 */
	override describe(): NativeNode {
		const tail = this.#displayedMessage ? this.#thinkingTailIndex(this.#displayedMessage) : undefined;
		const rate =
			tail !== undefined && this.#lastUpdateTransient && this.#thinkingRateLive
				? Math.round(Math.min(SPEED_MAX, sharedSpeedTracker.getSpeed()) * 10) / 10
				: 0;
		const key = [
			this.#blockVersion,
			this.#transcriptBlockFinalized,
			this.#hideThinkingBlock,
			this.#showImages,
			this.#showToolResultImages,
			this.#errorExpanded,
			this.#nativeViewVersion,
			rate,
			getThemeEpoch(),
		];
		return this.#native.get(key, () => this.#describeMessage(tail, rate));
	}

	/**
	 * A TTSR rule rewound this partial answer: a native terminal dims it and
	 * tags it `↺ rewound` (the ANSI render leaves it as it stopped).
	 */
	markRewound(): void {
		if (this.#rewound) return;
		this.#rewound = true;
		this.#nativeViewVersion++;
	}

	/** Mirrors a thinking section collapsed or expanded in the terminal. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action") {
			this.#handleErrorAction(event.act);
			return;
		}
		if (event.type !== "toggle" || !event.key.startsWith("k")) return;
		const index = Number(event.key.slice(1));
		if (!Number.isInteger(index)) return;
		this.#thinkingCollapsed.set(index, event.collapsed);
		this.#nativeViewVersion++;
	}

	#describeMessage(thinkingTail: number | undefined, rate: number): NativeNode {
		const message = this.#displayedMessage;
		const previousParts = this.#nativeParts;
		const parts = new Map<string, { text: string; stream: boolean; node: NativeNode }>();
		// `slot` identifies the node across rebuilds; `key` is its sibling key inside its parent.
		const markdown = (slot: string, key: string, source: string, stream: boolean): NativeNode => {
			const cached = previousParts.get(slot);
			const entry =
				cached?.text === source && cached.stream === stream
					? cached
					: {
							text: source,
							stream,
							node: node("md", stream ? { text: source, stream: true } : { text: source }, undefined, key),
						};
			parts.set(slot, entry);
			return entry.node;
		};
		const children: NativeChild[] = [];
		if (message) {
			const live = !this.#transcriptBlockFinalized && this.#lastUpdateTransient;
			let tailIndex = -1;
			for (let index = 0; index < message.content.length; index++) {
				const content = message.content[index]!;
				if (
					(content.type === "text" && canonicalizeMessage(content.text)) ||
					(content.type === "thinking" && canonicalizeMessage(content.thinking))
				) {
					tailIndex = index;
				}
			}
			for (let index = 0; index < message.content.length; index++) {
				const content = message.content[index]!;
				const streaming = live && (index === tailIndex || this.#pendingTextDisplayBlocks.has(index));
				if (content.type === "text" && canonicalizeMessage(content.text)) {
					const source = content.text.trim();
					if (!this.#showImages || !hasChartTable(source)) {
						children.push(markdown(`t${index}`, `t${index}`, source, streaming));
						continue;
					}
					// A chart follows its table as an SVG image node; the prose splits around it.
					const segments = splitTableCharts(source, streaming);
					segments.forEach((segment, part) => {
						const slot = part === 0 ? `t${index}` : `t${index}.${part}`;
						if (segment.kind === "markdown") {
							children.push(
								markdown(slot, slot, segment.text.trim(), streaming && part === segments.length - 1),
							);
							return;
						}
						const chart = lookupTableChart(segment.table);
						if (chart instanceof Promise) this.#awaitChart(chart);
						else if (chart) children.push(describeTableChart(chart, slot));
					});
				} else if (content.type === "thinking") {
					const display = resolveThinkingDisplay(content, this.#proseOnlyThinking);
					if (!display.visible) continue;
					const thinkingLive = streaming && thinkingTail === index;
					const clock = this.#thinkingClock.get(index);
					if (thinkingLive) {
						if (clock) clock.tokens = this.#thinkingTokens || clock.tokens;
						else this.#thinkingClock.set(index, { start: performance.now(), tokens: this.#thinkingTokens });
					} else if (clock && clock.end === undefined) {
						clock.end = performance.now();
					}
					// Hidden (Ctrl+T): only the live "Thinking…" head shows; a finished thought leaves nothing.
					if (this.#hideThinkingBlock && !thinkingLive) continue;
					const tokens = thinkingLive ? this.#thinkingTokens : (clock?.tokens ?? 0);
					const title = tokens > 0 ? `${formatNumber(tokens)} tokens` : undefined;
					// Live: starburst · "Thinking…" · ticking timer · tok/s. Done: "Thought for 12s".
					const head = thinkingLive
						? node(
								"row",
								{ gap: "sm", title },
								[
									node("spinner", { style: "starburst", role: "omp.thinking.spin" }),
									text([span("Thinking…", "muted")]),
									elapsed(performance.now() - (this.#thinkingClock.get(index)?.start ?? performance.now())),
									...(rate >= 0.05 ? [node("rate", { value: rate, unit: "tok/s" })] : []),
								],
								"head",
							)
						: node("text", { spans: [span(thoughtLabel(clock), "muted")], title }, undefined, "head");
					const body = markdown(`k${index}`, "body", display.text, streaming);
					children.push(
						node(
							"section",
							{
								// `.live` while streaming: the body clamps to its tail under a fade.
								role: thinkingLive ? "omp.thinking.live" : "omp.thinking",
								collapsible: true,
								// Open while it streams; a finished thought folds to its "Thought for 12s" line unless the user keeps thinking expanded.
								collapsed:
									this.#thinkingCollapsed.get(index) ??
									(this.#hideThinkingBlock || (!thinkingLive && !this.#expandThinkingBlocks)),
								// Tern's fold head sums it into "Worked for 12s".
								took: clock?.end === undefined ? undefined : Math.max(0, Math.round(clock.end - clock.start)),
							},
							[head, body],
							`k${index}`,
						),
					);
					if (!this.#hideThinkingBlock) children.push(...(this.#thinkingExtensions.get(index) ?? []));
				} else if (content.type === "image" && content.data && content.mimeType && this.#showImages) {
					children.push(this.#nativeImages.get(`i${index}`, content.data, content.mimeType));
				}
			}
			if (this.#showImages && this.#showToolResultImages) {
				for (const [toolCallId, images] of this.#toolImagesByCallId) {
					images.forEach((image, index) => {
						children.push(this.#nativeImages.get(`r${toolCallId}:${index}`, image.data, image.mimeType));
					});
				}
			}
			const errorNode = this.#describeError(message);
			if (errorNode) children.push(errorNode);
		}
		this.#nativeParts = parts;
		children.push(...this.#markerSlot.children);
		if (this.#rewound) {
			children.push(
				node(
					"badge",
					{ text: "↺ rewound", tone: "muted", role: "omp.assistant.rewound-tag" },
					undefined,
					"rewound",
				),
			);
		}
		if (this.#turnUsage) {
			const usage = formatTurnUsage(this.#turnUsage);
			children.push(
				node(
					"row",
					{ role: "omp.turn.usage", gap: "xs", align: "center", title: usage.title },
					[
						node("icon", { name: "time" }, undefined, "icon"),
						node("text", { text: usage.text }, undefined, "text"),
					],
					"turn-usage",
				),
			);
		}
		return col(children, { role: this.#rewound ? "omp.assistant.rewound" : "omp.assistant" });
	}

	/**
	 * Turn-ending error, recovered-retry note or abort label. A failed request
	 * is one error frame (head: "Request failed" + the HTTP status chip; body:
	 * the message once; then Retry / Copy error / Switch model), and stays in
	 * the transcript: unlike ANSI, the pinned banner does not hide it natively.
	 * A recovered attempt is an inline row that discloses the original error.
	 */
	#describeError(message: AssistantMessage): NativeNode | undefined {
		const presentation = resolveAssistantErrorPresentation(message);
		if (presentation.kind === "compact-recovered") {
			const attempt = message.retryRecovery?.attempt ?? 1;
			const body = [message.errorMessage?.trim(), presentation.text].filter(
				(line, index, all): line is string => !!line && all.indexOf(line) === index,
			);
			return node(
				"section",
				{
					role: "omp.assistant.recovered",
					head: [span(`↻ Recovered after ${attempt} ${attempt === 1 ? "retry" : "retries"}`, "muted")],
					collapsible: true,
					collapsed: true,
				},
				[text([span(body.join("\n"), "mono")], { wrap: "word" })],
				"error",
			);
		}
		if (presentation.kind !== "full" || message.content.some(content => content.type === "toolCall"))
			return undefined;
		if (message.stopReason === "aborted") {
			return text([span(presentation.text, "error")], { wrap: "word", key: "error", role: "omp.assistant.abort" });
		}
		const lines = presentation.text
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.length > 0);
		// "500 upstream overloaded" → chip "500", then the message once: a
		// line the next one repeats with more detail is dropped.
		const code = /^(\d{3})\s+/.exec(lines[0] ?? "");
		if (code) lines[0] = lines[0]!.slice(code[0].length);
		const detail = lines.filter((line, index) => !lines.slice(index + 1).some(next => next.startsWith(line)));
		const errorText = detail.join("\n") || "Unknown error";
		const children: NativeChild[] = [
			node(
				"row",
				{ gap: "sm" },
				[
					text([span("Request failed", "error strong")]),
					...(code ? [node("badge", { text: code[1]!, tone: "error", role: "omp.error.code" })] : []),
				],
				"head",
			),
			text([span(errorText, "mono")], {
				wrap: "word",
				lines: this.#errorExpanded ? undefined : MAX_TRANSCRIPT_ERROR_ROWS,
				role: "omp.error.message",
				key: "message",
			}),
		];
		if (message.stopReason === "error" && hasTranscriptActions()) {
			const button = (act: string, label: string, keys: readonly string[], title: string): NativeNode =>
				node(
					"row",
					{ gap: "xs", role: "omp.error.action", actions: { click: act }, title },
					keys.length > 0 ? [text(label), node("kbd", { keys })] : [text(label)],
					act,
				);
			children.push(
				node(
					"row",
					{ gap: "sm", role: "omp.error.actions" },
					[
						button("retry", "Retry", ["F5"], "Retry the failed turn"),
						button("copy-error", "Copy error", [], "Copy the error message"),
						button("switch-model", "Switch model", ["⌥P"], "Pick another model for this session"),
					],
					"actions",
				),
			);
		}
		this.#errorText = errorText;
		return card({ role: "omp.error", tone: "error", key: "error" }, children);
	}

	/** Error frame action clicks: omp's own retry, clipboard and model-picker paths. */
	#handleErrorAction(act: string): void {
		if (act === "retry") runTranscriptAction({ act: "retry" });
		else if (act === "switch-model") runTranscriptAction({ act: "switch-model" });
		else if (act === "copy-error" && this.#errorText) runTranscriptAction({ act: "copy", text: this.#errorText });
	}

	/** Width-independent stable identities for the streamed leading thinking run. */
	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return this.#transcriptStableRows;
	}

	/**
	 * Drop every published thinking stable row. Called by the transcript
	 * container during a visibility-driven destructive replay so the head no
	 * longer re-emits reasoning captured while thinking was visible. Safe only
	 * because the paired display reset clears the scrollback those rows occupied
	 * — see {@link AppendOnlyTranscriptBlock.resetTranscriptStableRows}.
	 */
	resetTranscriptStableRows(): void {
		this.#stableSnapshots = [];
		this.#stableParts = [];
		this.#transcriptStableRows = [];
		this.#dropStableRenders();
	}

	renderTranscriptStableRows(count: number, width: number): readonly string[] {
		const index = Math.min(Math.trunc(count), this.#stableSnapshots.length);
		if (index <= 0) return EMPTY_STABLE_RENDER;
		this.#syncStableRenderInputs();
		const ledger = this.#stableLedgers.get(width);
		if (ledger?.newest === index) return ledger.rows;
		const key = `${index}:${width}`;
		const cached = this.#stableRenderCache.get(key);
		if (cached) return cached;
		const end = ledger?.ends.get(index);
		let rows: readonly string[];
		if (ledger !== undefined && end !== undefined) {
			rows = ledger.rows.slice(0, end);
		} else {
			const snapshot = this.#stableSnapshots[index - 1]!;
			rows = this.#renderStableParts(
				this.#stableParts,
				snapshot.partCount,
				snapshot.lastTextLength,
				width,
				"replay",
			);
			if (this.#recordStableRows(index, width, rows)) return rows;
		}
		this.#stableRenderCache.set(key, rows);
		return rows;
	}

	/**
	 * Publish the block's finished prefix as stable transcript rows so a long
	 * stream can retire into native scrollback mid-turn instead of being clipped
	 * to the live viewport until the turn ends. Finished means bytes that can no
	 * longer change: closed child blocks, plus the streaming child's frozen
	 * Markdown prefix. Published bytes may already sit in terminal history, so
	 * every guard skips publication and nothing ever retracts it.
	 */
	#publishStableSnapshot(rendered: readonly string[], width: number): void {
		if (!this.#midStreamPublication) return;
		const parts = this.#currentStableSnapshot();
		if (!parts) return;
		const last = parts.at(-1);
		if (!last || last.kind === "spacer") return;
		const snapshot = { partCount: parts.length, lastTextLength: last.text.length };
		const previous = this.#stableSnapshots.at(-1);
		// An unmoved boundary publishes nothing whether or not it still extends
		// the last snapshot, so most frames skip the whole-document comparison.
		if (previous?.partCount === snapshot.partCount && previous.lastTextLength === snapshot.lastTextLength) return;
		if (previous && !isSnapshotExtension(this.#stableParts, parts)) return;
		this.#syncStableRenderInputs();
		const currentRows = this.#renderStableParts(parts, parts.length, last.text.length, width, "head");
		// The container verifies stable rows against the blank-trimmed render.
		if (!isRowPrefix(currentRows, trimBlankEdges(rendered))) return;
		const previousRows = previous
			? this.renderTranscriptStableRows(this.#stableSnapshots.length, width)
			: EMPTY_STABLE_RENDER;
		if (!isRowPrefix(previousRows, currentRows)) return;
		// Each stable row must add at least one physical row at every width.
		if (currentRows.length === previousRows.length) return;
		this.#stableParts = parts;
		this.#stableSnapshots.push(snapshot);
		this.#transcriptStableRows.push({ key: `thinking:${this.#nextStableRowId++}` });
		this.#recordStableRows(this.#stableSnapshots.length, width, currentRows);
	}

	/**
	 * Width-independent parts eligible for publication right now: the leading
	 * run of finished blocks, ending inside the streaming block at Markdown's
	 * frozen boundary. Undefined whenever any prefix byte could still change
	 * (finalized or non-transient renders, marker rows, extension components,
	 * hidden thinking, or no frozen prefix yet).
	 */
	#currentStableSnapshot(): readonly StablePart[] | undefined {
		if (this.#transcriptBlockFinalized || !this.#lastUpdateTransient) return undefined;
		if (this.#markerSlot.children.length > 0) return undefined;
		const items = this.#fastPathItems;
		if (!items || items.length === 0) return undefined;
		const parts: StablePart[] = [];
		let itemIndex = 0;
		for (const child of this.#contentContainer.children) {
			const item = items[itemIndex];
			if (item?.md === child) {
				const md = item.md;
				// Projected prose can be replaced at the terminal event, even when its
				// source block already closed. Never publish it into immutable history.
				if (item.blockType === "text" && this.#projectedTextBlocks.has(item.contentIndex)) break;
				if (md instanceof FigureMarkdown) {
					// Plain Markdown reproduces only the prose ahead of the first figure.
					if (md.leadingProse) parts.push({ kind: item.blockType, text: md.leadingProse });
					break;
				}
				if (itemIndex === items.length - 1) {
					// Streaming child: publish Markdown's frozen prefix, and only
					// once non-blank content exists past it — the block's last
					// non-blank line is still being written (thinking's prose fold
					// may rewrite it) and must stay out of published bytes.
					const raw = md.getLastRenderStableText();
					const frozen = raw.trim();
					if (frozen.length > 0 && /\S/.test(item.lastText.slice(raw.length))) {
						parts.push({ kind: item.blockType, text: frozen });
					}
					break;
				}
				// Closed child: only the streaming tail may mutate in place, so
				// everything before it is final.
				parts.push({ kind: item.blockType, text: item.lastText });
				itemIndex++;
				continue;
			}
			if (child instanceof Spacer) {
				parts.push({ kind: "spacer" });
				continue;
			}
			// Unknown child (thinking extension, pulse, image, error row): stop.
			break;
		}
		while (parts.at(-1)?.kind === "spacer") parts.pop();
		if (parts.length === 0) return undefined;
		return parts;
	}

	/**
	 * Render the first `partCount` stable parts, the final one cut to
	 * `lastLength`. Rows match fresh Markdown renders of each part byte for
	 * byte — {@link #createMarkdown} builds the live children too — but a
	 * closed part renders once per width, and the growing final part reuses one
	 * Markdown instance so its already-frozen blocks are not re-lexed.
	 */
	#renderStableParts(
		parts: readonly StablePart[],
		partCount: number,
		lastLength: number,
		width: number,
		role: "head" | "replay",
	): readonly string[] {
		const ledger = this.#stableLedger(width);
		const rows: string[] = [];
		const lastIndex = partCount - 1;
		for (let index = 0; index < partCount; index++) {
			const part = parts[index]!;
			if (part.kind === "spacer") {
				rows.push("");
				continue;
			}
			const closed = index < lastIndex;
			const text = closed || lastLength === part.text.length ? part.text : part.text.slice(0, lastLength);
			const cached = ledger.parts[index];
			let partRows: readonly string[];
			if (cached?.kind === part.kind && cached.text === text) {
				partRows = cached.rows;
			} else {
				partRows = this.#renderStablePart(index, part.kind, text, width, closed ? undefined : role);
				if (closed) ledger.parts[index] = { kind: part.kind, text, rows: partRows };
			}
			for (const row of partRows) rows.push(row);
		}
		return rows;
	}

	/**
	 * Render one part's Markdown. `role` names the instance reused for a final
	 * part as its text grows; a closed part continues whichever instance was
	 * already growing it, else renders once. Finalized blocks keep no instance.
	 */
	#renderStablePart(
		index: number,
		kind: StablePartKind,
		text: string,
		width: number,
		role: "head" | "replay" | undefined,
	): readonly string[] {
		// Trim like the live children, dropping the trailing blank line a frozen
		// prefix still carries.
		const trimmed = text.trim();
		if (this.#transcriptBlockFinalized) return this.#createMarkdown(kind, trimmed).render(width);
		const head = this.#stableHeadRenderer;
		const replay = this.#stableReplayRenderer;
		const renderer = role === "head" ? head : role === "replay" ? replay : head?.index === index ? head : replay;
		if (renderer?.index === index && renderer.kind === kind) {
			renderer.md.setText(trimmed);
			return renderer.md.render(width);
		}
		const md = this.#createMarkdown(kind, trimmed);
		if (role === "head") this.#stableHeadRenderer = { index, kind, md };
		else if (role === "replay") this.#stableReplayRenderer = { index, kind, md };
		return md.render(width);
	}

	/** Markdown for a text or thinking block; live children and stable-row renders share it so stable rows prefix the block render. */
	#createMarkdown(kind: StablePartKind, text: string): Markdown {
		return kind === "text"
			? new Markdown(
					text,
					1,
					0,
					this.#getProseTheme(),
					this.#textColorTransform ? { color: this.#textColorTransform } : undefined,
					0,
				)
			: new Markdown(text, 1, 0, getMarkdownTheme(), {
					color: (value: string) => theme.fg("thinkingText", value),
					italic: true,
				});
	}

	/**
	 * Whether `text` holds a ```svg fence this terminal draws as a figure, or a
	 * table it draws a chart under. Native (TSP) terminals receive the fence
	 * verbatim in the `md` node and draw it themselves, and get charts as image
	 * nodes from {@link describe}; image-less terminals keep fences as code and
	 * tables as tables.
	 */
	#liftsFigures(text: string): boolean {
		return (
			this.#showImages &&
			TERMINAL.imageProtocol !== null &&
			!isNativeRendering() &&
			((svgFigureRendering() && hasSvgFence(text)) || hasChartTable(text))
		);
	}

	/** Re-describe once a smart table chart pick lands. */
	#awaitChart(pick: Promise<void>): void {
		if (this.#chartPicks.has(pick)) return;
		this.#chartPicks.add(pick);
		void pick.then(() => {
			this.#chartPicks.delete(pick);
			this.#blockVersion++;
			this.#onImageUpdate?.();
		});
	}

	/**
	 * The component for text block `index`: Markdown, or a {@link FigureMarkdown}
	 * when it holds a ```svg fence to lift or a table to chart — taken over from
	 * `previous` so its figures keep their rasters across rebuilds.
	 */
	#proseBlock(index: number, text: string, previous: ReadonlyMap<number, FigureMarkdown>): ProseBlock {
		if (!this.#liftsFigures(text)) return this.#createMarkdown("text", text);
		let block = previous.get(index);
		if (block) {
			block.setText(text);
		} else {
			block = new FigureMarkdown(text, {
				markdown: value => this.#createMarkdown("text", value),
				budget: this.#imageBudget,
				onChange: () => {
					this.#blockVersion++;
					this.#onImageUpdate?.();
				},
			});
		}
		this.#figureBlocks.set(index, block);
		return block;
	}

	#stableLedger(width: number): StableRowLedger {
		let ledger = this.#stableLedgers.get(width);
		if (ledger === undefined) {
			ledger = { newest: 0, rows: EMPTY_STABLE_RENDER, ends: new Map(), parts: [] };
			this.#stableLedgers.set(width, ledger);
		}
		return ledger;
	}

	/**
	 * Remember `rows` as snapshot `index`'s render at `width`. A newer snapshot
	 * becomes the ledger's newest render — keeping earlier counts only when it
	 * extends their rows; an older one that prefixes the newest keeps just its
	 * row count. Returns whether `rows` is now the newest render.
	 */
	#recordStableRows(index: number, width: number, rows: readonly string[]): boolean {
		const ledger = this.#stableLedger(width);
		if (index > ledger.newest) {
			if (!isRowPrefix(ledger.rows, rows)) ledger.ends.clear();
			ledger.newest = index;
			ledger.rows = rows;
			ledger.ends.set(index, rows.length);
			return true;
		}
		if (index < ledger.newest && isRowPrefix(rows, ledger.rows)) ledger.ends.set(index, rows.length);
		return false;
	}

	/** Drop cached stable renders once the themes they were rendered with change. */
	#syncStableRenderInputs(): void {
		const prose = this.#getProseTheme();
		const markdown = getMarkdownTheme();
		const color = this.#textColorTransform;
		const inputs = this.#stableRenderInputs;
		if (inputs?.prose === prose && inputs.markdown === markdown && inputs.color === color) return;
		this.#dropStableRenders();
		this.#stableRenderInputs = { prose, markdown, color };
	}

	#dropStableRenders(): void {
		this.#stableLedgers.clear();
		this.#stableRenderCache.clear();
		this.#stableHeadRenderer = undefined;
		this.#stableReplayRenderer = undefined;
	}

	/** Render completed prose rather than an earlier thinking row under emergency viewport pressure. */
	renderTranscriptBlockEmergencyRow(width: number): string | undefined {
		if (!this.#transcriptBlockFinalized) return undefined;
		return this.#emergencyText?.render(width)[0];
	}

	getTranscriptBlockVersion(): number {
		return this.#blockVersion;
	}

	markTranscriptBlockFinalized(): void {
		this.#transcriptBlockFinalized = true;
		this.#dropStableRenders();
		this.#stopThinkingAnimation();
		// A forced seal (abort, abandoned stream) also settles pending projections.
		// Re-render from source, never from the translated display snapshot.
		if (this.#thinkingDots || this.hasPendingTextDisplay()) {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
			if (this.#lastMessage) {
				this.updateContent(this.#lastMessage, {
					transient: this.hasPendingTextDisplay() ? false : this.#lastUpdateTransient,
				});
			}
		}
	}

	applyRetryRecovery(retryRecovery: AssistantMessage["retryRecovery"]): void {
		if (!this.#lastMessage || !retryRecovery) return;
		this.setErrorPinned(false);
		this.updateContent({ ...this.#lastMessage, retryRecovery });
	}

	messagePersistenceKey(): string | undefined {
		if (!this.#lastMessage) return undefined;
		return [
			"assistant",
			this.#lastMessage.timestamp,
			this.#lastMessage.provider,
			this.#lastMessage.model,
			this.#lastMessage.responseId ?? "",
			this.#lastMessage.stopReason,
		].join(":");
	}

	/**
	 * Render a turn-ending provider error inline, wrapped to the render width.
	 * Collapsed (default), the block keeps {@link MAX_TRANSCRIPT_ERROR_ROWS}
	 * wrapped rows and ends with a dim `ctrl+o`/expand hint when rows were cut,
	 * so a pathological body — e.g. the HTML page a proxy returns on a 502 —
	 * can't flood the transcript. Expanded (via {@link setExpanded}), every row
	 * is rendered so the complete message is reachable. Mirrors
	 * {@link ErrorBannerComponent}. The caller owns the separating Spacer.
	 */
	#appendErrorBlock(message: string): void {
		const maxRows = this.#errorExpanded ? Number.POSITIVE_INFINITY : MAX_TRANSCRIPT_ERROR_ROWS;
		this.#contentContainer.addChild(
			new WidthAwareText(
				contentWidth =>
					formatErrorBlock(message, contentWidth, maxRows, (line, index) =>
						theme.fg("error", index === 0 ? `Error: ${line}` : line),
					),
				1,
				0,
			),
		);
	}

	/** Toggle rendering for assistant-native and tool-result images. */
	setImagesVisible(visible: boolean): void {
		if (this.#showImages === visible) return;
		this.#showImages = visible;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	/** Toggle only images produced by tool results; assistant-native images remain governed by setImagesVisible. */
	setToolResultImagesVisible(visible: boolean): void {
		if (this.#showToolResultImages === visible) return;
		this.#showToolResultImages = visible;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	setToolResultImages(toolCallId: string, images: ImageContent[]): void {
		if (!toolCallId) return;
		const validImages = images.filter(img => img.type === "image" && img.data && img.mimeType);
		if (validImages.length === 0) {
			this.#toolImagesByCallId.delete(toolCallId);
		} else {
			this.#toolImagesByCallId.set(toolCallId, validImages);
			this.#convertImagesForKitty(validImages.map((image, index) => ({ image, key: `${toolCallId}:${index}` })));
		}
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	#convertImagesForKitty(entries: Array<{ image: ImageContent; key: string }>): void {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		for (const { image } of entries) {
			if (image.mimeType === "image/png") continue;
			const key = imagePayloadKey(image);
			if (this.#kittyConverted.has(key)) continue;
			const cached = cachedPngConversion(image);
			if (cached) {
				this.#kittyConverted.set(key, cached);
				continue;
			}
			if (this.#kittyConversionsAwaited.has(key)) continue;
			this.#kittyConversionsAwaited.add(key);
			convertImageToPngShared(image)
				.then(converted => {
					this.#kittyConverted.set(key, converted);
					if (this.#lastMessage) {
						this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
					}
					this.#onImageUpdate?.();
				})
				.catch(() => {
					this.#kittyConversionsAwaited.delete(key);
				});
		}
	}

	#renderImageEntries(entries: Array<{ image: ImageContent; key: string }>, withLeadingSpacer: boolean): void {
		if (!this.#showImages || entries.length === 0) return;
		this.#convertImagesForKitty(entries);

		if (withLeadingSpacer) this.#contentContainer.addChild(new Spacer(1));
		for (const { image, key } of entries) {
			const displayImage =
				TERMINAL.imageProtocol === ImageProtocol.Kitty && image.mimeType !== "image/png"
					? this.#kittyConverted.get(imagePayloadKey(image))
					: image;
			if (TERMINAL.imageProtocol && displayImage) {
				this.#contentContainer.addChild(
					new Image(
						displayImage.data,
						displayImage.mimeType,
						{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
						{
							...resolveImageOptions(),
							budget: this.#imageBudget,
							imageKey: key,
							requestRender: this.#onImageUpdate,
						},
					),
				);
				continue;
			}
			this.#contentContainer.addChild(new Text(theme.fg("toolOutput", `[Image: ${image.mimeType}]`), 1, 0));
		}
	}

	#renderToolImages(): void {
		if (!this.#showToolResultImages) return;
		const entries = Array.from(this.#toolImagesByCallId.entries()).flatMap(([toolCallId, images]) =>
			images.map((image, index) => ({ image, key: `${toolCallId}:${index}` })),
		);
		this.#renderImageEntries(entries, true);
	}

	#appendThinkingExtensions(contentIndex: number, thinkingIndex: number, text: string): void {
		const mounted: Component[] = [];
		this.#thinkingExtensions.set(contentIndex, mounted);
		for (const renderer of this.#thinkingRenderers) {
			try {
				const component = renderer(
					{
						contentIndex,
						thinkingIndex,
						text,
						requestRender: () => this.#onImageUpdate?.(),
					},
					theme,
				);
				if (component) {
					this.#contentContainer.addChild(component);
					mounted.push(component);
				}
			} catch {
				// Ignore extension renderer failures and keep the original thinking block visible.
			}
		}
	}

	#computeShapeKey(message: AssistantMessage): string {
		const parts: string[] = [
			`htb:${this.#hideThinkingBlock ? 1 : 0}|pot:${this.#proseOnlyThinking ? 1 : 0}|etb:${this.#expandThinkingBlocks ? 1 : 0}`,
		];
		for (const content of message.content) {
			if (content.type === "text") {
				parts.push(
					!canonicalizeMessage(content.text) ? "T0" : this.#liftsFigures(content.text.trim()) ? "TF" : "T1",
				);
			} else if (content.type === "thinking") {
				if (this.#hideThinkingBlock) {
					// Match the pulse's empty/nonempty transition without formatting hidden text.
					parts.push(canonicalizeMessage(content.thinking) ? "KH" : "K0");
				} else {
					parts.push(resolveThinkingDisplay(content, this.#proseOnlyThinking).visible ? "KV" : "K0");
				}
			} else {
				// Non-rendered blocks (toolCall, redactedThinking, …) still occupy a
				// content index. Encode their position so an inserted/removed one shifts
				// the key and forces the teardown path instead of mis-indexing children.
				parts.push(`O:${content.type}`);
			}
		}
		return parts.join("|");
	}

	#canFastPath(message: AssistantMessage): boolean {
		for (const content of message.content) {
			if (content.type === "toolCall" || content.type === "image") return false;
		}
		if (this.#toolImagesByCallId.size > 0) return false;
		const errorPresentation = resolveAssistantErrorPresentation(message);
		if (errorPresentation.kind === "compact-recovered") return false;
		if (
			errorPresentation.kind === "full" &&
			!(message.stopReason === "error" && this.#errorPinned && !this.#errorExpanded)
		) {
			return false;
		}
		// Extension stability: if thinking renderers exist and any tracked thinking
		// block's text changed, extensions may produce a different child count.
		if (!this.#hideThinkingBlock && this.#thinkingRenderers.length > 0 && this.#fastPathItems) {
			for (const item of this.#fastPathItems) {
				if (item.blockType === "thinking") {
					const content = message.content[item.contentIndex];
					if (content?.type === "thinking") {
						const display = resolveThinkingDisplay(content, this.#proseOnlyThinking);
						if (display.text !== item.lastText) return false;
					}
				}
			}
		}
		return true;
	}

	#tryFastPathUpdate(message: AssistantMessage, opts?: { transient?: boolean }): boolean {
		if (!this.#fastPathKey || !this.#fastPathItems) return false;
		if (!this.#canFastPath(message)) {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
			return false;
		}
		if (this.#computeShapeKey(message) !== this.#fastPathKey) {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
			return false;
		}
		const transient = opts?.transient === true;
		// Shape is identical — setText only on Markdown children whose source changed.
		this.#applyItemTransience(transient);
		for (let i = 0; i < this.#fastPathItems.length; i++) {
			const item = this.#fastPathItems[i]!;
			const content = message.content[item.contentIndex];
			if (!content) {
				this.#fastPathKey = undefined;
				this.#fastPathItems = undefined;
				return false;
			}
			let newText: string;
			if (item.blockType === "text" && content.type === "text") {
				newText = content.text.trim();
			} else if (item.blockType === "thinking" && content.type === "thinking") {
				newText = resolveThinkingDisplay(content, this.#proseOnlyThinking).text;
			} else {
				this.#fastPathKey = undefined;
				this.#fastPathItems = undefined;
				return false;
			}
			if (newText !== item.lastText) {
				// Only the last (actively streaming) block may mutate in place: a
				// delta into an earlier block would invalidate rows the settled
				// walk already declared final, so tear down and rebuild instead.
				if (i < this.#fastPathItems.length - 1) {
					this.#fastPathKey = undefined;
					this.#fastPathItems = undefined;
					return false;
				}
				item.md.setText(newText);
				item.lastText = newText;
			}
		}
		if (this.#thinkingDots) {
			if (this.#thinkingDots.setText(this.#thinkingDotsLabel())) {
				this.#onImageUpdate?.();
			}
		}
		return true;
	}

	updateContent(message: AssistantMessage, opts?: { transient?: boolean }): void {
		this.#blockVersion++;
		this.#lastMessage = message;
		this.#lastUpdateTransient = opts?.transient === true;
		// Re-derive reactions and projection from source on every display update.
		// Theme redraws and late images must not translate an already translated block.
		message = this.#projectTextDisplay(
			message,
			this.#displayMessage(message, this.#lastUpdateTransient),
			this.#lastUpdateTransient,
		);
		this.#displayedMessage = message;

		// Streaming-speed gauge: only a live, in-flight render of the single
		// animating hidden-thinking block feeds the shared session tracker. The
		// token count is the provider's own cumulative output — reasoning tokens when
		// reported (Gemini's thoughtsTokenCount, OpenAI's reasoning_tokens), else
		// total output tokens — never a character estimate, which undercounts when
		// the provider streams a summarized reasoning trace. An instantaneous tok/s
		// is derived from this block's delta and handed to the windowed averager.
		// Only transient renders count: the final non-transient render at
		// message_end carries the turn's end-of-stream usage, whose jump would spike
		// the gauge and pollute the next block. Providers that report usage only at
		// turn end leave the live count flat, so the rate stays 0 and the badge
		// self-suppresses (see #thinkingDotsLabel).
		// Native terminals show the live rate on visible thinking too, not only the hidden pulse.
		const isThinkingNow =
			this.#lastUpdateTransient &&
			(isNativeRendering() ? this.#thinkingTailIndex(message) !== undefined : this.#shouldAnimateThinking(message));
		if (isThinkingNow) {
			const currentTokens = message.usage.reasoningTokens ?? message.usage.output;
			this.#thinkingTokens = currentTokens;
			const now = performance.now();
			if (this.#lastTokenCount !== undefined) {
				const tokenDelta = currentTokens - this.#lastTokenCount;
				const elapsedMs = now - this.#lastTokenTime;
				if (tokenDelta > 0 && elapsedMs > 0) {
					// First live sample of this block: drop the session gauge's prior-turn
					// observations so the windowed average reflects only this block.
					if (!this.#thinkingRateLive) sharedSpeedTracker.reset();
					sharedSpeedTracker.observe((tokenDelta / elapsedMs) * 1000, now);
					this.#thinkingRateLive = true;
				}
			}
			this.#lastTokenCount = currentTokens;
			this.#lastTokenTime = now;
		} else {
			this.#lastTokenCount = undefined;
			this.#thinkingTokens = 0;
			this.#thinkingRateLive = false;
		}

		// Fast path: reuse Markdown children when shape is stable during streaming
		if (this.#tryFastPathUpdate(message, opts)) return;

		// Clear content container
		this.#contentContainer.clear();
		this.#thinkingExtensions.clear();
		this.#emergencyText = undefined;
		this.#thinkingDots = undefined;
		this.#hasTruncatableError = false;

		// Determine if we should capture Markdown instances for next fast path
		const shouldCapture = this.#canFastPath(message);
		const captureItems: FastPathItem[] | undefined = shouldCapture ? [] : undefined;
		const previousFigures = this.#figureBlocks;
		this.#figureBlocks = new Map();

		const hasVisibleContent = message.content.some(
			c =>
				(c.type === "text" && canonicalizeMessage(c.text)) ||
				(c.type === "image" && c.data && c.mimeType) ||
				(!this.#hideThinkingBlock &&
					c.type === "thinking" &&
					resolveThinkingDisplay(c, this.#proseOnlyThinking).visible),
		);

		// Render content in order
		let thinkingIndex = 0;
		let hasRenderedContent = false;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && canonicalizeMessage(content.text)) {
				// Set paddingY=0 to avoid extra spacing before tool executions
				const trimmed = content.text.trim();
				const md = this.#proseBlock(i, trimmed, previousFigures);
				this.#contentContainer.addChild(md);
				this.#emergencyText = md;
				captureItems?.push({ md, contentIndex: i, blockType: "text", lastText: trimmed });
				hasRenderedContent = true;
			} else if (content.type === "thinking") {
				if (this.#hideThinkingBlock) {
					thinkingIndex += 1;
					continue;
				}
				const display = resolveThinkingDisplay(content, this.#proseOnlyThinking);
				if (!display.visible) continue;
				const thinkingText = display.text;
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some(
						c =>
							(c.type === "text" && canonicalizeMessage(c.text)) ||
							(c.type === "image" && c.data && c.mimeType) ||
							(c.type === "thinking" && resolveThinkingDisplay(c, this.#proseOnlyThinking).visible),
					);

				// Thinking traces in thinkingText color, italic
				const md = this.#createMarkdown("thinking", thinkingText);
				md.transientRenderCache = this.#lastUpdateTransient;
				this.#contentContainer.addChild(md);
				captureItems?.push({ md, contentIndex: i, blockType: "thinking", lastText: thinkingText });
				this.#appendThinkingExtensions(i, thinkingIndex, thinkingText);
				hasRenderedContent = true;
				thinkingIndex += 1;
				if (hasVisibleContentAfter) {
					this.#contentContainer.addChild(new Spacer(1));
				}
			} else if (content.type === "image" && content.data && content.mimeType) {
				this.#renderImageEntries([{ image: content, key: `native:${i}` }], hasRenderedContent);
				hasRenderedContent ||= this.#showImages;
			}
		}
		for (const [index, block] of previousFigures) {
			if (this.#figureBlocks.get(index) !== block) block.dispose();
		}

		if (this.#shouldAnimateThinking(message)) {
			if (hasVisibleContent) this.#contentContainer.addChild(new Spacer(1));
			this.#thinkingDots = new Text(this.#thinkingDotsLabel(), 1, 0);
			this.#contentContainer.addChild(this.#thinkingDots);
			this.#startThinkingAnimation();
		} else {
			this.#stopThinkingAnimation();
		}

		this.#renderToolImages();
		const errorPresentation = resolveAssistantErrorPresentation(message);
		const hasToolCalls = message.content.some(c => c.type === "toolCall");
		if (errorPresentation.kind === "compact-recovered") {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("dim", errorPresentation.text), 1, 0));
		} else if (!hasToolCalls && errorPresentation.kind === "full") {
			if (message.stopReason === "aborted") {
				this.#contentContainer.addChild(new Spacer(1));
				this.#contentContainer.addChild(new Text(theme.fg("error", errorPresentation.text), 1, 0));
			} else {
				// Non-aborted provider error: a truncatable inline block. Mark it so
				// setExpanded re-renders even while the same error is pinned above.
				this.#hasTruncatableError = true;
				// Suppress the inline block only while pinned AND collapsed — the
				// banner already shows the capped error there. When expanded, draw
				// the inline block in full so the complete body is reachable without
				// sending a message; the pinned banner stays a short reminder.
				if (!(message.stopReason === "error" && this.#errorPinned) || this.#errorExpanded) {
					this.#contentContainer.addChild(new Spacer(1));
					this.#appendErrorBlock(errorPresentation.text);
				}
			}
		}
		// Store fast-path state for next call
		if (shouldCapture) {
			this.#fastPathItems = captureItems;
			this.#fastPathKey = this.#computeShapeKey(message);
			this.#applyItemTransience(this.#lastUpdateTransient);
		} else {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
		}
	}

	/**
	 * Only the actively streaming (last) markdown renders in transient mode;
	 * completed blocks render final — syntax-highlighted, module-LRU-cached,
	 * byte-stable — so their rows can settle into native scrollback mid-turn
	 * and are byte-identical to the finalize render.
	 */
	#applyItemTransience(transient: boolean): void {
		const items = this.#fastPathItems;
		if (!items) return;
		for (let i = 0; i < items.length; i++) {
			const item = items[i]!;
			item.md.transientRenderCache =
				transient && (i === items.length - 1 || this.#pendingTextDisplayBlocks.has(item.contentIndex));
		}
	}
}
