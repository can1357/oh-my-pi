import type { AssistantMessage, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import {
	type Component,
	Container,
	Image,
	type ImageBudget,
	ImageProtocol,
	Markdown,
	type MarkdownTheme,
	Spacer,
	TERMINAL,
	Text,
} from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { AssistantThinkingRenderer } from "../../extensibility/extensions/types";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { resolveImageOptions } from "../../tools/render-utils";
import { WidthAwareText } from "../../tui";
import { convertImageToPng } from "../../utils/image-loading";
import { canonicalizeMessage, formatThinkingForDisplay, hasDisplayableThinking } from "../../utils/thinking-display";
import { resolveAssistantErrorPresentation } from "../utils/transcript-render-helpers";
import { type CacheInvalidation, CacheInvalidationMarkerComponent } from "./cache-invalidation-marker";
import { formatErrorBlock } from "./error-block";
import { isReactionTarget, type ReactionSplit, type ReactionTarget, splitReaction } from "./reaction";
import { isRowPrefix, type TranscriptStableRow, trimBlankEdges } from "./transcript-container";

/**
 * Max wrapped rows of a turn-ending provider error rendered inline in the
 * transcript. Bounds pathological error bodies — e.g. a proxy 502 whose body
 * is a full HTML page — so they can't flood the scrollback, while a long
 * single-line body wraps to the width instead of being cut at a fixed column.
 * Full text is still kept in the persisted session.
 */
const MAX_TRANSCRIPT_ERROR_ROWS = 8;
const EMPTY_STABLE_RENDER: readonly string[] = [];
const EMPTY_LINK_TARGETS: ReadonlyMap<string, string> = new Map();

type ThinkingContentBlock = Extract<AssistantMessage["content"][number], { type: "thinking" }>;
type DisplayThinkingContentBlock = ThinkingContentBlock & { rawThinking?: string };
type StableThinkingPart = { kind: "thinking"; text: string } | { kind: "spacer" };

/**
 * One published prefix of the leading visible-thinking run. Later snapshots
 * extend earlier ones part-wise (only the final thinking part may grow), so
 * rendered stable rows only ever gain a suffix — the append-only transcript
 * contract that lets them retire into native scrollback mid-stream.
 */
interface ThinkingStableSnapshot {
	readonly key: string;
	readonly parts: readonly StableThinkingPart[];
}

function isSnapshotExtension(previous: ThinkingStableSnapshot, current: ThinkingStableSnapshot): boolean {
	if (previous.parts.length > current.parts.length) return false;
	for (let index = 0; index < previous.parts.length; index++) {
		const before = previous.parts[index]!;
		const after = current.parts[index]!;
		if (before.kind !== after.kind) return false;
		if (before.kind === "spacer" || after.kind === "spacer") continue;
		const isLast = index === previous.parts.length - 1;
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
	#lastMessage?: AssistantMessage;
	#emergencyText?: Markdown;
	#toolImagesByCallId = new Map<string, ImageContent[]>();
	#convertedKittyImages = new Map<string, ImageContent>();
	#showImages = true;
	#showToolResultImages = true;
	#kittyConversionsInFlight = new Set<string>();
	#transcriptBlockFinalized: boolean;
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
	#fastPathItems:
		| Array<{ md: Markdown; contentIndex: number; blockType: "text" | "thinking"; lastText: string }>
		| undefined;
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
	/** Published width-independent thinking prefixes; grows only, never retracts. */
	#stableSnapshots: ThinkingStableSnapshot[] = [];
	#transcriptStableRows: TranscriptStableRow[] = [];
	/** Rendered stable rows memoized by `${count}:${width}`, insertion-evicted. */
	#stableRenderCache = new Map<string, readonly string[]>();
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
	#markdownTheme: MarkdownTheme = getMarkdownTheme();
	/** Block this reply reacts to; undefined when the preceding block takes no reactions. */
	#reactionTarget: ReactionTarget | undefined;
	/** Reaction lifted from the reply's opening emoji, once resolved. */
	#reaction: string | undefined;

	setTextColorTransform(transform?: (text: string) => string): void {
		this.#textColorTransform = transform;
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
		const snapshot = targets;
		this.#markdownTheme = {
			...getMarkdownTheme(),
			resolveLink: href => snapshot.get(href),
		};
		this.#fastPathKey = undefined;
		this.#fastPathItems = undefined;
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
	constructor(
		message?: AssistantMessage,
		private hideThinkingBlock = false,
		private readonly onImageUpdate?: () => void,
		private readonly thinkingRenderers: readonly AssistantThinkingRenderer[] = [],
		private readonly imageBudget?: ImageBudget,
		private proseOnlyThinking = true,
		linkTargets?: ReadonlyMap<string, string>,
	) {
		super();
		this.#transcriptBlockFinalized = message !== undefined;
		if (linkTargets?.size) {
			this.#linkTargets = linkTargets;
			const snapshot = linkTargets;
			this.#markdownTheme = {
				...getMarkdownTheme(),
				resolveLink: href => snapshot.get(href),
			};
		}

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
		this.#markerSlot.clear();
		if (info) {
			this.#markerSlot.addChild(new CacheInvalidationMarkerComponent(info));
		}
		this.#blockVersion++;
	}

	override invalidate(): void {
		super.invalidate();
		// Theme/symbol changes arrive via invalidate(). Fast-path children captured
		// their theme at construction, so drop them and force the teardown path to
		// rebuild with the current theme. Streaming updates call updateContent()
		// directly and keep the fast path.
		const snapshot = this.#linkTargets;
		this.#markdownTheme =
			snapshot.size > 0 ? { ...getMarkdownTheme(), resolveLink: href => snapshot.get(href) } : getMarkdownTheme();
		this.#fastPathKey = undefined;
		this.#fastPathItems = undefined;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
	}

	setProseOnlyThinking(proseOnly: boolean): void {
		this.proseOnlyThinking = proseOnly;
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
		if (!this.hideThinkingBlock || this.#transcriptBlockFinalized) return false;
		let tail: "text" | "thinking" | undefined;
		for (const content of message.content) {
			if (content.type === "toolCall") return false;
			if (content.type === "text" && canonicalizeMessage(content.text)) tail = "text";
			else if (content.type === "thinking" && canonicalizeMessage(content.thinking)) tail = "thinking";
		}
		return tail === "thinking";
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
		if (this.#thinkingDotsTimer) return;
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
		if (!this.#thinkingDots) {
			this.#stopThinkingAnimation();
			return;
		}
		this.#thinkingDotsFrame = (this.#thinkingDotsFrame + 1) % THINKING_DOTS_FRAMES.length;
		if (this.#thinkingDots.setText(this.#thinkingDotsLabel())) {
			this.onImageUpdate?.();
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

	override render(width: number): readonly string[] {
		const rows = super.render(width);
		this.#publishStableSnapshot(rows, width);
		return rows;
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
		this.#transcriptStableRows = [];
		this.#stableRenderCache.clear();
	}

	renderTranscriptStableRows(count: number, width: number): readonly string[] {
		const index = Math.min(Math.trunc(count), this.#stableSnapshots.length);
		if (index <= 0) return EMPTY_STABLE_RENDER;
		const key = `${index}:${width}`;
		const cached = this.#stableRenderCache.get(key);
		if (cached) return cached;
		const rows = this.#renderStableSnapshot(this.#stableSnapshots[index - 1]!, width);
		this.#stableRenderCache.set(key, rows);
		// Bounded: the container re-requests only recent counts at live widths.
		if (this.#stableRenderCache.size > 64) {
			const oldest = this.#stableRenderCache.keys().next().value;
			if (oldest !== undefined) this.#stableRenderCache.delete(oldest);
		}
		return rows;
	}

	/**
	 * Publish the frozen prefix of the leading visible-thinking run as stable
	 * transcript rows so a long reasoning stream can retire into native
	 * scrollback mid-turn. Only thinking publishes: streamed text deltas can
	 * revise earlier Markdown, and published bytes must never change — they may
	 * already sit in terminal history. Every guard skips publication; nothing
	 * ever retracts it.
	 */
	#publishStableSnapshot(rendered: readonly string[], width: number): void {
		const snapshot = this.#currentStableSnapshot();
		if (!snapshot) return;
		const previous = this.#stableSnapshots.at(-1);
		if (previous?.key === snapshot.key) return;
		if (previous && !isSnapshotExtension(previous, snapshot)) return;
		const currentRows = this.#renderStableSnapshot(snapshot, width);
		// The container verifies stable rows against the blank-trimmed render.
		if (!isRowPrefix(currentRows, trimBlankEdges(rendered))) return;
		const previousRows = previous
			? this.renderTranscriptStableRows(this.#stableSnapshots.length, width)
			: EMPTY_STABLE_RENDER;
		if (!isRowPrefix(previousRows, currentRows)) return;
		// Each stable row must add at least one physical row at every width.
		if (currentRows.length === previousRows.length) return;
		this.#stableSnapshots.push(snapshot);
		this.#transcriptStableRows.push({ key: snapshot.key });
		this.#stableRenderCache.set(`${this.#stableSnapshots.length}:${width}`, currentRows);
	}

	/**
	 * Width-independent parts eligible for publication right now: the leading
	 * run of visible thinking blocks, ending inside the streaming block at
	 * Markdown's frozen boundary. Undefined whenever any prefix byte could
	 * still change (finalized or non-transient renders, marker rows, extension
	 * components, hidden thinking, or no frozen prefix yet).
	 */
	#currentStableSnapshot(): ThinkingStableSnapshot | undefined {
		if (this.#transcriptBlockFinalized || !this.#lastUpdateTransient) return undefined;
		if (this.#markerSlot.children.length > 0) return undefined;
		const items = this.#fastPathItems;
		if (!items || items.length === 0) return undefined;
		const parts: StableThinkingPart[] = [];
		let itemIndex = 0;
		for (const child of this.#contentContainer.children) {
			const item = items[itemIndex];
			if (item?.md === child) {
				// Text blocks never publish: their deltas can revise earlier rows.
				if (item.blockType !== "thinking") break;
				if (itemIndex === items.length - 1) {
					// Streaming block: publish Markdown's frozen prefix, and only
					// once non-blank content exists past it — the thinking fold may
					// still rewrite the display text's last non-blank line (prose
					// ellipsis), which must stay out of published bytes.
					const frozen = item.md.getLastRenderStableText();
					if (frozen.length > 0 && /\S/.test(item.lastText.slice(frozen.length))) {
						parts.push({ kind: "thinking", text: frozen });
					}
					break;
				}
				parts.push({ kind: "thinking", text: item.lastText });
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
		if (!parts.some(part => part.kind === "thinking")) return undefined;
		return { key: JSON.stringify(parts), parts };
	}

	#renderStableSnapshot(snapshot: ThinkingStableSnapshot, width: number): readonly string[] {
		const rows: string[] = [];
		for (const part of snapshot.parts) {
			if (part.kind === "spacer") {
				rows.push("");
				continue;
			}
			// Constructor args mirror the live thinking Markdown exactly so these
			// rows are byte-identical to the block render's prefix.
			const markdown = new Markdown(part.text, 1, 0, getMarkdownTheme(), {
				color: (text: string) => theme.fg("thinkingText", text),
				italic: true,
			});
			rows.push(...markdown.render(width));
		}
		return rows;
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
		this.#stopThinkingAnimation();
		// If the live pulse was on screen when the block sealed, drop the fast path
		// and rebuild so the placeholder is removed — finalized blocks never animate.
		if (this.#thinkingDots) {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
			if (this.#lastMessage) this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
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
		for (const key of Array.from(this.#convertedKittyImages.keys())) {
			if (key.startsWith(`${toolCallId}:`)) {
				this.#convertedKittyImages.delete(key);
			}
		}
		for (const key of Array.from(this.#kittyConversionsInFlight)) {
			if (key.startsWith(`${toolCallId}:`)) {
				this.#kittyConversionsInFlight.delete(key);
			}
		}
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
		for (const { image, key } of entries) {
			if (image.mimeType === "image/png") continue;
			if (this.#convertedKittyImages.has(key) || this.#kittyConversionsInFlight.has(key)) continue;
			this.#kittyConversionsInFlight.add(key);
			convertImageToPng(image)
				.then(converted => {
					this.#kittyConversionsInFlight.delete(key);
					this.#convertedKittyImages.set(key, converted);
					if (this.#lastMessage) {
						this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
					}
					this.onImageUpdate?.();
				})
				.catch(() => {
					this.#kittyConversionsInFlight.delete(key);
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
					? this.#convertedKittyImages.get(key)
					: image;
			if (TERMINAL.imageProtocol && displayImage) {
				this.#contentContainer.addChild(
					new Image(
						displayImage.data,
						displayImage.mimeType,
						{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
						{ ...resolveImageOptions(), budget: this.imageBudget, imageKey: key },
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
		for (const renderer of this.thinkingRenderers) {
			try {
				const component = renderer(
					{
						contentIndex,
						thinkingIndex,
						text,
						requestRender: () => this.onImageUpdate?.(),
					},
					theme,
				);
				if (component) {
					this.#contentContainer.addChild(component);
				}
			} catch {
				// Ignore extension renderer failures and keep the original thinking block visible.
			}
		}
	}

	#computeShapeKey(message: AssistantMessage): string {
		const parts: string[] = [`htb:${this.hideThinkingBlock ? 1 : 0}|pot:${this.proseOnlyThinking ? 1 : 0}`];
		for (const content of message.content) {
			if (content.type === "text") {
				parts.push(canonicalizeMessage(content.text) ? "T1" : "T0");
			} else if (content.type === "thinking") {
				const display = resolveThinkingDisplay(content, this.proseOnlyThinking);
				if (!display.visible) parts.push("K0");
				else if (this.hideThinkingBlock) parts.push("KH");
				else parts.push("KV");
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
		if (this.thinkingRenderers.length > 0 && this.#fastPathItems) {
			for (const item of this.#fastPathItems) {
				if (item.blockType === "thinking") {
					const content = message.content[item.contentIndex];
					if (content?.type === "thinking") {
						const display = resolveThinkingDisplay(content, this.proseOnlyThinking);
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
				newText = resolveThinkingDisplay(content, this.proseOnlyThinking).text;
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
				this.onImageUpdate?.();
			}
		}
		return true;
	}

	updateContent(message: AssistantMessage, opts?: { transient?: boolean }): void {
		this.#blockVersion++;
		this.#lastMessage = message;
		this.#lastUpdateTransient = opts?.transient === true;
		// Everything below renders the display form; #lastMessage keeps the
		// verbatim message so re-renders re-derive the reaction deterministically.
		message = this.#displayMessage(message, this.#lastUpdateTransient);

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
		const isThinkingNow = this.#lastUpdateTransient && this.#shouldAnimateThinking(message);
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
		this.#emergencyText = undefined;
		this.#thinkingDots = undefined;
		this.#hasTruncatableError = false;

		// Determine if we should capture Markdown instances for next fast path
		const shouldCapture = this.#canFastPath(message);
		const captureItems:
			| Array<{ md: Markdown; contentIndex: number; blockType: "text" | "thinking"; lastText: string }>
			| undefined = shouldCapture ? [] : undefined;

		const hasVisibleContent = message.content.some(
			c =>
				(c.type === "text" && canonicalizeMessage(c.text)) ||
				(c.type === "image" && c.data && c.mimeType) ||
				(!this.hideThinkingBlock &&
					c.type === "thinking" &&
					resolveThinkingDisplay(c, this.proseOnlyThinking).visible),
		);

		// Render content in order
		let thinkingIndex = 0;
		let hasRenderedContent = false;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && canonicalizeMessage(content.text)) {
				// Set paddingY=0 to avoid extra spacing before tool executions
				const trimmed = content.text.trim();
				const mdOptions = this.#textColorTransform ? { color: this.#textColorTransform } : undefined;
				const md = new Markdown(trimmed, 1, 0, this.#markdownTheme, mdOptions, 0);
				this.#contentContainer.addChild(md);
				this.#emergencyText = md;
				captureItems?.push({ md, contentIndex: i, blockType: "text", lastText: trimmed });
				hasRenderedContent = true;
			} else if (content.type === "thinking" && resolveThinkingDisplay(content, this.proseOnlyThinking).visible) {
				const thinkingText = resolveThinkingDisplay(content, this.proseOnlyThinking).text;
				if (this.hideThinkingBlock) {
					thinkingIndex += 1;
					continue;
				}
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some(
						c =>
							(c.type === "text" && canonicalizeMessage(c.text)) ||
							(c.type === "image" && c.data && c.mimeType) ||
							(c.type === "thinking" && resolveThinkingDisplay(c, this.proseOnlyThinking).visible),
					);

				// Thinking traces in thinkingText color, italic
				const md = new Markdown(thinkingText, 1, 0, getMarkdownTheme(), {
					color: (text: string) => theme.fg("thinkingText", text),
					italic: true,
				});
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
			items[i]!.md.transientRenderCache = transient && i === items.length - 1;
		}
	}
}
