import type { AssistantMessage, ImageContent } from "@pk-nerdsaver-ai/pi-ai";
import {
	Container,
	Image,
	type ImageBudget,
	ImageProtocol,
	Markdown,
	Spacer,
	TERMINAL,
	Text,
} from "@pk-nerdsaver-ai/pi-tui";
import type { AssistantThinkingRenderer } from "../../extensibility/extensions/types";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { resolveAbortLabel, shouldRenderAbortReason } from "../../session/messages";
import { getPreviewLines, resolveImageOptions, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { canonicalizeMessage, formatThinkingForDisplay } from "../../utils/thinking-display";
import { type CacheInvalidation, CacheInvalidationMarkerComponent } from "./cache-invalidation-marker";

/**
 * Max lines of a turn-ending provider error rendered inline in the transcript.
 * Bounds pathological error bodies — e.g. a proxy 502 whose body is a full HTML
 * page — so they can't flood the scrollback. Blank lines are dropped and each
 * line is width-truncated by {@link getPreviewLines}. Full text is still kept in
 * the persisted session.
 */
const MAX_TRANSCRIPT_ERROR_LINES = 8;

/**
 * A GFM table delimiter row (`| --- | :--: |`, with or without bounding pipes).
 * The header row alone does not render a table — this delimiter is what makes
 * Markdown lay one out, and a streaming table re-aligns its columns as rows
 * arrive. Requires at least one column pipe so a bare thematic break (`---`)
 * does not match.
 */
const MARKDOWN_TABLE_DELIMITER = /^ {0,3}\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*:?-*:?[ \t]*$/;

/** Opening or closing fence of a code block: ≥3 backticks/tildes plus info string. */
const CODE_FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Whether `text` currently contains reflowing Markdown whose layout is not yet
 * permanent: an open ` ```mermaid ` fence (the diagram reshapes as source
 * arrives) or a GFM table (columns re-align as rows arrive). Used by
 * {@link AssistantMessageComponent.isTranscriptBlockCommitStable}.
 *
 * Fence-aware: a mermaid block is detected by its opener, and table delimiters
 * inside ordinary fenced code (shell pipes, ASCII separators, doc examples) are
 * ignored so a long streamed code block is never held out of native scrollback.
 * A delimiter counts only directly under a pipe-bearing header row, outside any
 * code fence.
 */
function detectLiveReflowingMarkdown(text: string): boolean {
	let fence: string | null = null;
	let prevLine = "";
	for (const line of text.split("\n")) {
		const fenceMatch = CODE_FENCE_LINE.exec(line);
		if (fence !== null) {
			// Inside a code block: only a bare matching closing fence ends it.
			if (
				fenceMatch &&
				fenceMatch[2]!.trim() === "" &&
				fenceMatch[1]![0] === fence[0] &&
				fenceMatch[1]!.length >= fence.length
			) {
				fence = null;
			}
			continue;
		}
		if (fenceMatch) {
			if (/^mermaid\b/.test(fenceMatch[2]!.trim())) return true;
			fence = fenceMatch[1]!;
			prevLine = "";
			continue;
		}
		if (prevLine.includes("|") && MARKDOWN_TABLE_DELIMITER.test(line)) return true;
		prevLine = line;
	}
	return false;
}

/**
 * Frames for the streaming "thinking" pulse rendered in place of a hidden
 * thinking block while the model is still producing it. A single fixed-width
 * glyph: an expanding/shrinking ✻ pulse so the indicator animates without
 * shifting the line.
 * Advanced every {@link THINKING_DOTS_FRAME_MS}.
 */
const THINKING_DOTS_FRAMES = ["✻", "✢", "·", "✢"] as const;
const THINKING_DOTS_FRAME_MS = 320;

/** Ceiling for the displayed thinking token speed; provider usage arrives in bursts. */
const THINKING_SPEED_MAX_TOKS_PER_SEC = 200;

/**
 * Visibility source for a thinking block. Reveal-controller display blocks carry
 * the already-formatted text (e.g. an ascii ellipsis standing in for pure-code
 * thinking) plus the original in `rawThinking` — canonicalizing the formatted
 * stand-in alone would wrongly hide it.
 */
function thinkingSource(content: { thinking: string }): string {
	return (content as { rawThinking?: string }).rawThinking ?? content.thinking;
}

// Module-wide window: successive components in one turn share the baseline, and
// a new turn (or test) resets it explicitly.
let thinkingSpeedSample: { time: number; tokens: number } | undefined;
let thinkingSpeedRate: number | undefined;

/** Reset the thinking token-speed window (new turn / tests). */
export function resetThinkingSpeedTracker(): void {
	thinkingSpeedSample = undefined;
	thinkingSpeedRate = undefined;
}

/**
 * Slide the speed window with the latest provider output-token total. The
 * first sample only seeds the baseline (no rate yet); each later sample
 * derives tokens-per-second over the elapsed window, clamped to the ceiling.
 */
function trackThinkingSpeed(tokens: number): number | undefined {
	const now = performance.now();
	if (thinkingSpeedSample === undefined) {
		thinkingSpeedSample = { time: now, tokens };
		return undefined;
	}
	const deltaMs = now - thinkingSpeedSample.time;
	if (deltaMs <= 0) return thinkingSpeedRate;
	const rate = ((tokens - thinkingSpeedSample.tokens) / deltaMs) * 1000;
	thinkingSpeedSample = { time: now, tokens };
	thinkingSpeedRate = Math.min(THINKING_SPEED_MAX_TOKS_PER_SEC, Math.max(0, rate));
	return thinkingSpeedRate;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	#contentContainer: Container;
	#markerSlot: Container;
	#lastMessage?: AssistantMessage;
	#toolImagesByCallId = new Map<string, ImageContent[]>();
	#convertedKittyImages = new Map<string, ImageContent>();
	#kittyConversionsInFlight = new Set<string>();
	#transcriptBlockFinalized: boolean;
	/**
	 * True while a non-finalized text item carries reflowing Markdown — a
	 * ` ```mermaid ` fence or a GFM table — whose layout re-flows every frame as
	 * source arrives (a diagram reshaping, a table re-aligning its columns), so
	 * no prefix is byte-stable until the message finalizes. See
	 * {@link isTranscriptBlockCommitStable}. Recomputed in {@link updateContent}
	 * ahead of the fast-path return, so it tracks every stream tick.
	 */
	#hasLiveReflowingMarkdown = false;
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
	/** Latest provider output-token total while the thinking pulse is live. */
	#thinkingTokens: number | undefined;
	/** Windowed token speed derived from provider usage (see trackThinkingSpeed). */
	#thinkingRate: number | undefined;
	/** Whether THIS block has fed the session gauge before — its first feed only seeds. */
	#thinkingFedTracker = false;
	#thinkingDotsTimer: NodeJS.Timeout | undefined;
	#thinkingDotsFrame = 0;

	constructor(
		message?: AssistantMessage,
		private hideThinkingBlock = false,
		private readonly onImageUpdate?: () => void,
		private readonly thinkingRenderers: readonly AssistantThinkingRenderer[] = [],
		private readonly imageBudget?: ImageBudget,
		private readonly proseOnlyThinking = false,
	) {
		super();
		this.#transcriptBlockFinalized = message !== undefined;

		// Slim cache-invalidation divider, populated above the content when this
		// turn's request lost the prompt cache (see setCacheInvalidation).
		this.#markerSlot = new Container();
		this.addChild(this.#markerSlot);

		// Container for text/thinking content
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	/**
	 * Show or clear the slim cache-invalidation divider above this turn. Set at
	 * `message_end` (live) or during rebuild, once the turn's usage is known and
	 * compared against the previous turn's cache footprint. Bumps the transcript
	 * block version so the change repaints even after content finalized.
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
		// getMarkdownTheme() at construction, so drop them and force the teardown
		// path to rebuild with the current theme. Streaming updates call
		// updateContent() directly and keep the fast path.
		this.#fastPathKey = undefined;
		this.#fastPathItems = undefined;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
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
			else if (content.type === "thinking" && canonicalizeMessage(thinkingSource(content))) tail = "thinking";
		}
		return tail === "thinking";
	}

	/** Thinking text as displayed: canonicalized, with code fences elided in prose-only mode.
	 *  Reveal-controller display blocks (marked by `rawThinking`) are already formatted. */
	#displayThinking(content: { thinking: string }): string {
		if ((content as { rawThinking?: string }).rawThinking !== undefined) return content.thinking;
		const canon = canonicalizeMessage(content.thinking);
		return canon ? formatThinkingForDisplay(canon, this.proseOnlyThinking) : canon;
	}

	#thinkingDotsLabel(): string {
		const glyph = THINKING_DOTS_FRAMES[this.#thinkingDotsFrame % THINKING_DOTS_FRAMES.length] ?? "✻";
		// Layout: "<glyph> <total> · <rate> toks/s"; totals/rate appear once provider usage lands.
		let label: string = glyph;
		if (this.#thinkingTokens !== undefined) {
			label += ` ${this.#thinkingTokens}`;
			if (this.#thinkingRate !== undefined) label += ` · ${this.#thinkingRate.toFixed(1)} toks/s`;
		}
		return theme.fg("thinkingText", label);
	}

	#startThinkingAnimation(): void {
		if (this.#thinkingDotsTimer) return;
		this.#thinkingDotsTimer = setInterval(() => this.#advanceThinkingDots(), THINKING_DOTS_FRAME_MS);
		this.#thinkingDotsTimer.unref?.();
	}

	#advanceThinkingDots(): void {
		if (!this.#thinkingDots) {
			this.#stopThinkingAnimation();
			return;
		}
		this.#thinkingDotsFrame = (this.#thinkingDotsFrame + 1) % THINKING_DOTS_FRAMES.length;
		if (this.#thinkingDots.setText(this.#thinkingDotsLabel())) {
			this.onImageUpdate?.();
		}
	}

	#stopThinkingAnimation(): void {
		if (this.#thinkingDotsTimer) {
			clearInterval(this.#thinkingDotsTimer);
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

	isTranscriptBlockFinalized(): boolean {
		return this.#transcriptBlockFinalized;
	}

	/**
	 * Whether this still-live block's scrolled-off rows may be committed to
	 * immutable native scrollback (the {@link TranscriptContainer} durable-
	 * snapshot path). Reflowing Markdown — a streaming mermaid diagram or a GFM
	 * table — re-lays-out its body as source arrives (the diagram reshapes, the
	 * table re-aligns its columns), so committing an intermediate layout strands
	 * a stale fragment in native scrollback that only a full repaint (Ctrl+L) can
	 * clear. While such content is still streaming the block therefore stays
	 * wholly in the repaintable live region and commits once, at its final
	 * layout, when the turn finalizes.
	 */
	isTranscriptBlockCommitStable(): boolean {
		return this.#transcriptBlockFinalized || !this.#hasLiveReflowingMarkdown;
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

	/**
	 * Render a turn-ending provider error inline. Drops blank lines, clamps the
	 * line count to {@link MAX_TRANSCRIPT_ERROR_LINES}, and width-truncates each
	 * line so a pathological body — e.g. the HTML page a proxy returns on a 502 —
	 * can't flood the transcript. Mirrors {@link ErrorBannerComponent}.
	 */
	#appendErrorBlock(message: string): void {
		const lines = getPreviewLines(message, MAX_TRANSCRIPT_ERROR_LINES, TRUNCATE_LENGTHS.LINE);
		if (lines.length === 0) lines.push("Unknown error");
		this.#contentContainer.addChild(new Spacer(1));
		this.#contentContainer.addChild(new Text(theme.fg("error", `Error: ${lines[0]}`), 1, 0));
		for (const line of lines.slice(1)) {
			this.#contentContainer.addChild(new Text(theme.fg("error", `  ${line}`), 1, 0));
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
			this.#convertToolImagesForKitty(toolCallId, validImages);
		}
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage, { transient: this.#lastUpdateTransient });
		}
	}

	#convertToolImagesForKitty(toolCallId: string, images: ImageContent[]): void {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		for (let index = 0; index < images.length; index++) {
			const image = images[index];
			if (!image || image.mimeType === "image/png") continue;
			const key = `${toolCallId}:${index}`;
			if (this.#convertedKittyImages.has(key) || this.#kittyConversionsInFlight.has(key)) continue;
			this.#kittyConversionsInFlight.add(key);
			new Bun.Image(Buffer.from(image.data, "base64"))
				.png()
				.toBase64()
				.then(data => {
					this.#kittyConversionsInFlight.delete(key);
					this.#convertedKittyImages.set(key, {
						type: "image",
						data,
						mimeType: "image/png",
					});
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

	#renderToolImages(): void {
		const imageEntries = Array.from(this.#toolImagesByCallId.entries()).flatMap(([toolCallId, images]) =>
			images.map((image, index) => ({ image, key: `${toolCallId}:${index}` })),
		);
		if (imageEntries.length === 0) return;

		this.#contentContainer.addChild(new Spacer(1));
		for (const { image, key } of imageEntries) {
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
		const parts: string[] = [`htb:${this.hideThinkingBlock ? 1 : 0}`];
		for (const content of message.content) {
			if (content.type === "text") {
				parts.push(canonicalizeMessage(content.text) ? "T1" : "T0");
			} else if (content.type === "thinking") {
				const canon = canonicalizeMessage(thinkingSource(content));
				if (!canon) parts.push("K0");
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
			if (content.type === "toolCall") return false;
		}
		if (this.#toolImagesByCallId.size > 0) return false;
		if (message.stopReason === "aborted" && shouldRenderAbortReason(message)) return false;
		if (message.stopReason === "error" && !this.#errorPinned) return false;
		if (
			message.errorMessage &&
			shouldRenderAbortReason(message) &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error"
		)
			return false;
		// Extension stability: if thinking renderers exist and any tracked thinking
		// block's text changed, extensions may produce a different child count.
		if (this.thinkingRenderers.length > 0 && this.#fastPathItems) {
			for (const item of this.#fastPathItems) {
				if (item.blockType === "thinking") {
					const content = message.content[item.contentIndex];
					if (content?.type === "thinking" && this.#displayThinking(content) !== item.lastText) return false;
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
		for (const item of this.#fastPathItems) {
			item.md.transientRenderCache = transient;
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
				newText = this.#displayThinking(content);
			} else {
				this.#fastPathKey = undefined;
				this.#fastPathItems = undefined;
				return false;
			}
			if (newText !== item.lastText) {
				item.md.setText(newText);
				item.lastText = newText;
			}
		}
		return true;
	}

	updateContent(message: AssistantMessage, opts?: { transient?: boolean }): void {
		this.#blockVersion++;
		this.#lastMessage = message;
		this.#lastUpdateTransient = opts?.transient === true;

		// Streaming reflowing Markdown (a mermaid diagram reshaping, a GFM table
		// re-aligning columns) re-lays-out its body each frame; see
		// isTranscriptBlockCommitStable. Detect it from raw text — a Markdown
		// parser only resolves these once the closing fence / delimiter row
		// arrives, but the stale native-scrollback commits happen mid-stream.
		this.#hasLiveReflowingMarkdown = message.content.some(
			content => content.type === "text" && detectLiveReflowingMarkdown(content.text),
		);

		// Windowed thinking token speed from provider usage: update ahead of the
		// fast-path return so the live pulse label tracks every stream tick.
		if (this.#shouldAnimateThinking(message)) {
			const output = message.usage?.output ?? 0;
			if (output > 0) {
				const rate = trackThinkingSpeed(output);
				// A fresh block must not borrow the session gauge's prior-turn rate —
				// only its own positive-delta observation lights the badge — and a
				// zero rate (streaming lull) drops the badge rather than lingering
				// on "0.0 toks/s"; only the bare pulse remains.
				if (this.#thinkingFedTracker && rate !== undefined && rate > 0) {
					this.#thinkingTokens = output;
					this.#thinkingRate = rate;
				} else {
					this.#thinkingTokens = undefined;
					this.#thinkingRate = undefined;
				}
				this.#thinkingFedTracker = true;
				this.#thinkingDots?.setText(this.#thinkingDotsLabel());
			}
		}

		// Fast path: reuse Markdown children when shape is stable during streaming
		if (this.#tryFastPathUpdate(message)) return;

		// Clear content container
		this.#contentContainer.clear();
		this.#thinkingDots = undefined;

		// Determine if we should capture Markdown instances for next fast path
		const shouldCapture = this.#canFastPath(message);
		const captureItems:
			| Array<{ md: Markdown; contentIndex: number; blockType: "text" | "thinking"; lastText: string }>
			| undefined = shouldCapture ? [] : undefined;

		const hasVisibleContent = message.content.some(
			c =>
				(c.type === "text" && canonicalizeMessage(c.text)) ||
				(!this.hideThinkingBlock && c.type === "thinking" && canonicalizeMessage(thinkingSource(c))),
		);

		// Render content in order
		let thinkingIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && canonicalizeMessage(content.text)) {
				// Set paddingY=0 to avoid extra spacing before tool executions
				const trimmed = content.text.trim();
				const md = new Markdown(trimmed, 1, 0, getMarkdownTheme());
				md.transientRenderCache = this.#lastUpdateTransient;
				this.#contentContainer.addChild(md);
				captureItems?.push({ md, contentIndex: i, blockType: "text", lastText: trimmed });
			} else if (content.type === "thinking" && canonicalizeMessage(thinkingSource(content))) {
				const thinkingText = this.#displayThinking(content);
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
							(c.type === "thinking" && canonicalizeMessage(thinkingSource(c))),
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
				thinkingIndex += 1;
				if (hasVisibleContentAfter) {
					this.#contentContainer.addChild(new Spacer(1));
				}
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
		// Check if aborted - show after partial content
		// But only if there are no tool calls (tool execution components will show the error)
		const hasToolCalls = message.content.some(c => c.type === "toolCall");
		if (!hasToolCalls) {
			if (message.stopReason === "aborted" && shouldRenderAbortReason(message)) {
				const abortMessage = resolveAbortLabel(message);
				if (hasVisibleContent) {
					this.#contentContainer.addChild(new Spacer(1));
				} else {
					this.#contentContainer.addChild(new Spacer(1));
				}
				this.#contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
			} else if (message.stopReason === "error" && !this.#errorPinned) {
				this.#appendErrorBlock(message.errorMessage || "Unknown error");
			}
		}
		if (
			message.errorMessage &&
			shouldRenderAbortReason(message) &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error"
		) {
			this.#appendErrorBlock(message.errorMessage);
		}
		// Store fast-path state for next call
		if (shouldCapture) {
			this.#fastPathItems = captureItems;
			this.#fastPathKey = this.#computeShapeKey(message);
		} else {
			this.#fastPathKey = undefined;
			this.#fastPathItems = undefined;
		}
	}
}
