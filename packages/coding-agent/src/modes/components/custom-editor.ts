import type { ImageContent } from "@pk-nerdsaver-ai/pi-ai";
import {
	addKeyAliases,
	canonicalKeyId,
	Editor,
	type KeyId,
	parseKey,
	parseKittySequence,
} from "@pk-nerdsaver-ai/pi-tui";
import { BracketedPasteHandler } from "@pk-nerdsaver-ai/pi-tui/bracketed-paste";
import type { AppKeybinding } from "../../config/keybindings";
import { isSettingsInitialized, settings } from "../../config/settings";
import { imageReferenceHyperlink, PLACEHOLDER_REGEX, renderPlaceholders } from "../image-references";
import { hasMagicKeyword, highlightMagicKeywords } from "../magic-keywords";
import { fgOrPlain } from "../theme/theme";

type ConfigurableEditorAction = Extract<
	AppKeybinding,
	| "app.interrupt"
	| "app.clear"
	| "app.exit"
	| "app.suspend"
	| "app.display.reset"
	| "app.thinking.cycle"
	| "app.model.cycleForward"
	| "app.model.cycleBackward"
	| "app.model.select"
	| "app.model.selectTemporary"
	| "app.tools.expand"
	| "app.thinking.toggle"
	| "app.editor.external"
	| "app.history.search"
	| "app.message.dequeue"
	| "app.retry"
	| "app.clipboard.pasteImage"
	| "app.clipboard.pasteTextRaw"
	| "app.clipboard.copyPrompt"
>;

const DEFAULT_ACTION_KEYS: Record<ConfigurableEditorAction, KeyId[]> = {
	"app.interrupt": ["escape"],
	"app.clear": ["ctrl+c"],
	"app.exit": ["ctrl+d"],
	"app.suspend": ["ctrl+z"],
	"app.display.reset": ["ctrl+l"],
	"app.thinking.cycle": ["shift+tab"],
	"app.model.cycleForward": ["ctrl+p"],
	"app.model.cycleBackward": ["shift+ctrl+p"],
	"app.model.select": ["alt+m"],
	"app.model.selectTemporary": ["alt+p"],
	"app.tools.expand": ["ctrl+o"],
	"app.thinking.toggle": ["ctrl+t"],
	"app.editor.external": ["ctrl+g"],
	"app.history.search": ["ctrl+r"],
	"app.message.dequeue": ["alt+up"],
	"app.retry": ["alt+r"],
	"app.clipboard.pasteImage": ["ctrl+v"],
	"app.clipboard.pasteTextRaw": ["ctrl+shift+v", "alt+shift+v"],
	"app.clipboard.copyPrompt": ["alt+shift+c"],
};

function buildMatchKeys(keys: readonly KeyId[]): Set<string> {
	const matchKeys = new Set<string>();
	for (const key of keys) {
		addKeyAliases(matchKeys, key);
	}
	return matchKeys;
}

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const BRACKETED_IMAGE_PATH_REGEX = /\.(?:png|jpe?g|gif|webp)$/i;
const BRACKETED_PATH_BOUNDARY_REGEX = /\.[a-z0-9]+(?=$|["']?\s)/gi;
const SHELL_ESCAPED_PATH_CHAR_REGEX = /\\([\\\s'"()[\]{}&;<>|?*!$`])/g;
/** Explicit-directory anchors: absolute, home-relative, or a Windows drive.
 *  A bare filename is almost always a project-relative reference the user
 *  wants as text, so it never counts as a pasted path. */
const ABSOLUTE_PATH_PREFIX_REGEX = /^(?:\/|~\/|[A-Za-z]:[\\/])/;

/** Max gap (ms) between two spaces for the later one to count as OS key auto-repeat rather than a
 *  deliberate press. OS auto-repeat is fast; a deliberate tap (even a fast one) is slower. */
export const SPACE_REPEAT_MAX_GAP_MS = 120;
/** Two consecutive inter-space gaps are "mechanical" (machine-driven auto-repeat) when both are
 *  within {@link SPACE_REPEAT_MAX_GAP_MS} and differ by no more than this — an absolute jitter floor
 *  or, for slower repeat rates, {@link SPACE_REPEAT_JITTER_RATIO} of the smaller gap. OS key-repeat
 *  is metronomic; a human smashing the bar is fast but irregular, so its deltas never stay this
 *  steady. */
export const SPACE_REPEAT_JITTER_MS = 18;
export const SPACE_REPEAT_JITTER_RATIO = 0.35;
/** Consecutive mechanical (fast + steady) deltas that confirm the space bar is held and start
 *  recording. Needs a sustained metronomic cadence, so jittery smashing and deliberate taps never
 *  reach it. */
export const SPACE_HOLD_MECHANICAL_RUN = 2;
/** Idle gap (ms) after the last repeated space that counts as the space bar being released, ending
 *  the push-to-talk recording. Must comfortably exceed the OS key-repeat interval. */
export const SPACE_HOLD_RELEASE_MS = 250;

/** Whether two consecutive inter-space gaps look machine-driven: both within the auto-repeat band
 *  and steady enough (small absolute or proportional difference). OS key-repeat is metronomic, so
 *  its successive deltas match closely; human smashing is fast but irregular and deliberate taps are
 *  too slow, so neither passes. */
function gapsAreMechanical(gap: number, prevGap: number): boolean {
	if (gap > SPACE_REPEAT_MAX_GAP_MS || prevGap > SPACE_REPEAT_MAX_GAP_MS) return false;
	const tolerance = Math.max(SPACE_REPEAT_JITTER_MS, Math.min(gap, prevGap) * SPACE_REPEAT_JITTER_RATIO);
	return Math.abs(gap - prevGap) <= tolerance;
}

function isPastedPathSeparator(char: string | undefined): boolean {
	return char === undefined || char === " " || char === "\t" || char === "\r" || char === "\n";
}

function imagePathBoundaryEnd(payload: string, segmentStart: number, extensionEnd: number): number | undefined {
	const quote = payload[segmentStart];
	const afterExtension = payload[extensionEnd];
	if (quote === '"' || quote === "'") {
		return afterExtension === quote && isPastedPathSeparator(payload[extensionEnd + 1])
			? extensionEnd + 1
			: undefined;
	}
	if (isPastedPathSeparator(afterExtension)) return extensionEnd;
	return undefined;
}

/** Decode a `file://` URL to its local filesystem path. macOS terminals
 *  (Ghostty, iTerm2) sometimes forward the pasteboard's `public.file-url`
 *  representation on Finder→Copy + Cmd+V; without decoding, image loading
 *  would try to read a literal `file:///…` path and fail. Percent-escapes
 *  are only decoded inside `file://` URLs — plain paths pass through. */
function decodePastedFileUrl(path: string): string {
	const match = path.match(/^file:\/\/(?:localhost)?(?=\/)/i);
	if (!match) return path;
	const rest = path.slice(match[0].length);
	try {
		return decodeURIComponent(rest);
	} catch {
		return rest;
	}
}

function normalizePastedPath(path: string): string {
	const trimmed = path.trim();
	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];
	const unquoted =
		trimmed.length > 1 && (first === '"' || first === "'") && last === first ? trimmed.slice(1, -1) : trimmed;
	return decodePastedFileUrl(unquoted.replace(SHELL_ESCAPED_PATH_CHAR_REGEX, "$1"));
}

/**
 * Extract explicitly-anchored file paths from pasted text: dot-extension
 * terminated segments, each quoted/shell-escaped form normalized and required
 * to carry an explicit directory anchor (see ABSOLUTE_PATH_PREFIX_REGEX).
 * Returns undefined unless the entire text parses as one or more such paths —
 * partial matches fall back to the normal text path.
 */
export function extractPastePathsFromText(pasted: string): string[] | undefined {
	const paths: string[] = [];
	let segmentStart = 0;
	BRACKETED_PATH_BOUNDARY_REGEX.lastIndex = 0;
	for (
		let match = BRACKETED_PATH_BOUNDARY_REGEX.exec(pasted);
		match;
		match = BRACKETED_PATH_BOUNDARY_REGEX.exec(pasted)
	) {
		const extensionEnd = match.index + match[0].length;
		const boundaryEnd = imagePathBoundaryEnd(pasted, segmentStart, extensionEnd);
		if (boundaryEnd === undefined) continue;

		const path = normalizePastedPath(pasted.slice(segmentStart, boundaryEnd));
		if (!path || !ABSOLUTE_PATH_PREFIX_REGEX.test(path)) return undefined;
		paths.push(path);

		segmentStart = boundaryEnd;
		while (segmentStart < pasted.length && isPastedPathSeparator(pasted[segmentStart])) {
			segmentStart++;
		}
		BRACKETED_PATH_BOUNDARY_REGEX.lastIndex = segmentStart;
	}

	if (paths.length === 0 || segmentStart !== pasted.length) return undefined;
	return paths;
}

/** Extract explicitly-anchored file paths from a bracketed-paste envelope. */
export function extractBracketedPastePaths(data: string): string[] | undefined {
	if (!data.startsWith(BRACKETED_PASTE_START)) return undefined;
	const endIndex = data.indexOf(BRACKETED_PASTE_END, BRACKETED_PASTE_START.length);
	if (endIndex === -1 || endIndex + BRACKETED_PASTE_END.length !== data.length) return undefined;

	const pasted = data.slice(BRACKETED_PASTE_START.length, endIndex).trim();
	if (!pasted) return undefined;
	return extractPastePathsFromText(pasted);
}

export function extractBracketedImagePastePaths(data: string): string[] | undefined {
	const paths = extractBracketedPastePaths(data);
	if (!paths || !paths.every(path => BRACKETED_IMAGE_PATH_REGEX.test(path))) return undefined;
	return paths;
}

export function extractBracketedImagePastePath(data: string): string | undefined {
	const paths = extractBracketedImagePastePaths(data);
	return paths?.length === 1 ? paths[0] : undefined;
}

/**
 * Extract a single image path from plain (non-bracketed) text, e.g. a
 * clipboard read (issue #3506). Delegates to the pasted-path splitter first;
 * when that mis-segments a single anchored path containing unescaped spaces
 * (macOS screenshot names), a whole-text branch — gated on
 * ABSOLUTE_PATH_PREFIX_REGEX so prose never triggers it — recovers the path.
 */
export function extractImagePathFromText(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;

	const paths = extractPastePathsFromText(trimmed);
	if (paths !== undefined) {
		return paths.length === 1 && BRACKETED_IMAGE_PATH_REGEX.test(paths[0]) ? paths[0] : undefined;
	}

	const whole = normalizePastedPath(trimmed);
	if (ABSOLUTE_PATH_PREFIX_REGEX.test(whole) && BRACKETED_IMAGE_PATH_REGEX.test(whole) && !whole.includes("\n")) {
		return whole;
	}
	return undefined;
}

/**
 * Custom editor that handles configurable app-level shortcuts for coding-agent.
 */
export class CustomEditor extends Editor {
	imageLinks?: readonly (string | undefined)[];

	/** Images attached to the composed draft, aligned with its `[Image #N]` markers. */
	pendingImages: ImageContent[] = [];
	/** Source hyperlink (file path / URL) per pending image, aligned by index. */
	pendingImageLinks: (string | undefined)[] = [];

	/** Treat image/paste markers as indivisible: a stray backspace deletes the whole token
	 *  instead of corrupting `[Paste #1, +30 lines]` into plain text. */
	override atomicTokenPattern = PLACEHOLDER_REGEX;

	/** Magic-keyword shimmer cadence — drives one editor repaint every 70 ms while
	 *  a keyword is on screen and the prompt is focused. ~14 frames/s is smooth
	 *  without flooding the renderer. */
	static readonly SHIMMER_FRAME_MS = 70;
	/** Time for the gradient to sweep one full cycle across each keyword. */
	static readonly SHIMMER_PERIOD_MS = 1800;

	/** Per-render scratch flag: did any layout line in this render contain a magic
	 *  keyword that should shimmer? Reset by {@link #scheduleShimmerIfNeeded} each
	 *  time a frame is queued. */
	#shimmerTimer: Timer | undefined;
	/** Repaint hook the host wires once at construction. Called from the shimmer
	 *  timer to request the next animation frame. Undefined when nobody is
	 *  listening (tests, headless callers); the timer chain still self-cleans. */
	#requestShimmerRepaint: (() => void) | undefined;

	/** Gradient-highlight the "ultrathink" / "orchestrate" / "workflowz" keywords as the user types
	 *  them, skipping any occurrence inside code spans, fenced blocks, or XML sections. Also make
	 *  pasted image placeholders visually distinct and hyperlink them once their blob file exists.
	 *  When the editor is focused, the buffer contains a magic keyword, and `magicKeywords.enabled`
	 *  is on, the gradient shifts every frame to produce a Claude-Code-style shimmer; each render
	 *  schedules the next frame, so losing focus, deleting the keyword, or flipping the setting
	 *  stops the animation on its own. The static glow itself runs even when shimmering is gated
	 *  off, matching existing behavior for the editor and sent bubbles. */
	decorateText = (text: string): string => {
		const animated = this.focused && this.#shimmerEnabled() && hasMagicKeyword(this.getText());
		const phase = animated ? (Date.now() % CustomEditor.SHIMMER_PERIOD_MS) / CustomEditor.SHIMMER_PERIOD_MS : 0;
		if (animated) this.#scheduleShimmerFrame();
		return renderPlaceholders(text, {
			renderText: value => highlightMagicKeywords(value, undefined, phase),
			renderReference: (value, kind, index) =>
				kind === "image"
					? imageReferenceHyperlink(value, index, this.imageLinks, label =>
							fgOrPlain("accent", label, `\x1b[1m\x1b[4m${label}\x1b[24m\x1b[22m`),
						)
					: fgOrPlain("accent", value, `\x1b[1m${value}\x1b[22m`),
		});
	};

	/** Optional test/host override for the magic-keyword shimmer gate. When
	 *  defined, takes precedence over the global `magicKeywords.enabled` setting,
	 *  letting tests assert the gating behaviour without mutating the
	 *  process-wide Settings singleton (which races with parallel test files —
	 *  see issue #2582). Production wires this through the host's Settings
	 *  reader and updates it on the relevant setting change. */
	magicKeywordsEnabledOverride: boolean | undefined;

	/** Whether the shimmer should advance this frame. Defaults to "on" before
	 *  settings have initialised (tests, early boot) so the animation does not
	 *  silently disappear during a race; settings disabling the feature wins
	 *  once they are loaded. An explicit `magicKeywordsEnabledOverride` overrides
	 *  both paths. */
	#shimmerEnabled(): boolean {
		if (this.magicKeywordsEnabledOverride !== undefined) return this.magicKeywordsEnabledOverride;
		return isSettingsInitialized() ? settings.get("magicKeywords.enabled") : true;
	}

	/** Bind the host's render request callback. Idempotent — the host wires this
	 *  once after construction (and again after `setEditorComponent` swaps the
	 *  editor). Passing `undefined` clears any pending frame. */
	setShimmerRepaintHandler(handler: (() => void) | undefined): void {
		this.#requestShimmerRepaint = handler;
		if (!handler && this.#shimmerTimer) {
			clearTimeout(this.#shimmerTimer);
			this.#shimmerTimer = undefined;
		}
	}

	/** Schedule one shimmer frame if none is already pending. The next render
	 *  decides whether to schedule another, so the chain stops by itself when
	 *  `focused` flips off or the keyword leaves the buffer. */
	#scheduleShimmerFrame(): void {
		if (this.#shimmerTimer || !this.#requestShimmerRepaint) return;
		this.#shimmerTimer = setTimeout(() => {
			this.#shimmerTimer = undefined;
			this.#requestShimmerRepaint?.();
		}, CustomEditor.SHIMMER_FRAME_MS);
		this.#shimmerTimer.unref?.();
	}
	onEscape?: () => void;
	onClear?: () => void;
	/** Host hook invoked by {@link clearDraft} so composer-owned draft state
	 *  (pending images and their hyperlinks) is dropped with the buffer. */
	onClearDraft?: () => void;
	onExit?: () => void;
	onDisplayReset?: () => void;
	onCycleThinkingLevel?: () => void;
	onCycleModelForward?: () => void;
	onCycleModelBackward?: () => void;
	onSelectModel?: () => void;
	onExpandTools?: () => void;
	onToggleThinking?: () => void;
	onExternalEditor?: () => void;
	onHistorySearch?: () => void;
	onSuspend?: () => void;
	onSelectModelTemporary?: () => void;
	/** Called when the configured copy-prompt shortcut is pressed. */
	onCopyPrompt?: () => void;
	/** Called when the configured image-paste shortcut is pressed. */
	onPasteImage?: () => Promise<boolean>;
	/** Called when a bracketed paste contains one or more image-file paths. */
	onPasteImagePath?: (path: string) => void | Promise<void>;
	/** Called when the configured raw text-paste shortcut is pressed. */
	onPasteTextRaw?: () => void;
	/** Called when the configured dequeue shortcut is pressed. */
	onDequeue?: () => void;
	/** Called when the configured retry shortcut is pressed. */
	onRetry?: () => void;
	/** Called when Caps Lock is pressed. */
	onCapsLock?: () => void;
	/** Called when left-arrow is pressed while the editor is empty (cursor necessarily at start). */
	onLeftAtStart?: () => void;

	/** Fired when a sustained space-bar hold is recognized — the push-to-talk STT start. The
	 *  optimistically-typed spaces have already been deleted by the time this runs. */
	onSpaceHoldStart?: () => void;
	/** Fired when the held space bar is released (detected as an idle gap with no further repeated
	 *  spaces) — the push-to-talk STT stop. */
	onSpaceHoldEnd?: () => void;
	/** Gate for the space-hold gesture. Returns false to keep the space bar inserting spaces
	 *  normally; wired to `stt.enabled` so disabling STT restores plain space behavior. */
	sttHoldEnabled?: () => boolean;

	/** Custom key handlers from extensions and non-built-in app actions. */
	#customKeyHandlers = new Map<KeyId, () => void>();
	#customMatchKeys = new Map<string, () => void>();
	/** Assembles bracketed pastes (possibly split across stdin chunks) ahead of the
	 *  base editor so the empty/image-path/text routing always sees the full payload. */
	#pasteAssembler = new BracketedPasteHandler();
	/** True while an empty-paste `onPasteImage` clipboard read is in flight; trailing
	 *  input queues behind it so a follow-up Enter cannot submit pre-image. */
	#pasteImageInFlight = false;
	/** Input chunks received while the image read is in flight, dispatched on settle. */
	#pendingPasteInput: string[] = [];
	/** Spaces actually inserted in the current run; tracked back out when a hold is recognized. */
	#spaceRunInserted = 0;
	/** Consecutive "mechanical" deltas (fast + steady); a sustained run of these confirms a held bar. */
	#mechanicalRun = 0;
	/** Inter-space gap (ms) of the previous space pair, compared against the next to judge steadiness. */
	#prevSpaceGap: number | undefined;
	/** Monotonic timestamp (ms) of the last space, to measure the gap to the next one. */
	#lastSpaceAt = Number.NEGATIVE_INFINITY;
	/** True while a recognized space-hold push-to-talk recording is in progress. */
	#spaceHoldActive = false;
	/** Idle timer that fires `onSpaceHoldEnd` once repeated spaces stop arriving. */
	#spaceHoldTimer: NodeJS.Timeout | undefined;
	#actionKeys = new Map<ConfigurableEditorAction, KeyId[]>(
		Object.entries(DEFAULT_ACTION_KEYS).map(([action, keys]) => [action as ConfigurableEditorAction, [...keys]]),
	);
	#actionMatchKeys = new Map<ConfigurableEditorAction, Set<string>>(
		Object.entries(DEFAULT_ACTION_KEYS).map(([action, keys]) => [
			action as ConfigurableEditorAction,
			buildMatchKeys(keys),
		]),
	);

	setActionKeys(action: ConfigurableEditorAction, keys: KeyId[]): void {
		this.#actionKeys.set(action, [...keys]);
		this.#rebuildActionMatchKeys(action);
	}

	#rebuildActionMatchKeys(action: ConfigurableEditorAction): void {
		this.#actionMatchKeys.set(action, buildMatchKeys(this.#actionKeys.get(action) ?? []));
	}

	#rebuildCustomMatchKeys(): void {
		this.#customMatchKeys.clear();
		for (const [keyId, handler] of this.#customKeyHandlers) {
			for (const alias of buildMatchKeys([keyId])) {
				// Preserve current iteration behavior: the first registered handler for colliding aliases wins.
				if (!this.#customMatchKeys.has(alias)) this.#customMatchKeys.set(alias, handler);
			}
		}
	}

	#matchesAction(canonical: string | undefined, action: ConfigurableEditorAction): boolean {
		return canonical !== undefined && (this.#actionMatchKeys.get(action)?.has(canonical) ?? false);
	}

	/**
	 * Register a custom key handler. Extensions use this for shortcuts.
	 */
	setCustomKeyHandler(key: KeyId, handler: () => void): void {
		this.#customKeyHandlers.set(key, handler);
		this.#rebuildCustomMatchKeys();
	}

	/**
	 * Remove a custom key handler.
	 */
	removeCustomKeyHandler(key: KeyId): void {
		this.#customKeyHandlers.delete(key);
		this.#rebuildCustomMatchKeys();
	}

	/**
	 * Clear all custom key handlers.
	 */
	clearCustomKeyHandlers(): void {
		this.#customKeyHandlers.clear();
		this.#rebuildCustomMatchKeys();
	}

	/**
	 * Discard the composed draft: empty the buffer, drop the pending images
	 * and their image-reference hyperlinks, then let the host clear any extra
	 * draft state via {@link onClearDraft}. Pass the draft's text to record it
	 * in prompt history first (used when the draft is queued rather than
	 * submitted).
	 */
	clearDraft(historyText?: string): void {
		if (historyText) this.addToHistory(historyText);
		this.setText("");
		this.pendingImages = [];
		this.pendingImageLinks = [];
		this.imageLinks = undefined;
		this.onClearDraft?.();
	}

	#spaceHoldGestureEnabled(): boolean {
		return this.onSpaceHoldStart !== undefined && (this.sttHoldEnabled?.() ?? false) && !this.isShowingAutocomplete();
	}

	/** Drive the space-hold push-to-talk state machine. Returns true when the gesture consumed the
	 *  input so it must not reach normal editing. A held space bar emits OS auto-repeat: a *steady*
	 *  stream of spaces at a fixed fast interval. We watch the inter-space deltas and only recognize a
	 *  hold once {@link SPACE_HOLD_MECHANICAL_RUN} consecutive deltas are "mechanical" — both
	 *  auto-repeat-fast and near-identical (see {@link gapsAreMechanical}). Smashing the bar is fast
	 *  but jittery and deliberate taps are too slow, so neither escalates and both keep typing real
	 *  spaces; the few spaces typed before a real hold is recognized are tracked back out. */
	#handleSpaceHold(data: string, canonical: string | undefined): boolean {
		const isSpace = canonical === "space";
		if (this.#spaceHoldActive) {
			if (isSpace) {
				// Auto-repeat while held: swallow it and keep the release timer alive.
				this.#armSpaceHoldReleaseTimer();
				return true;
			}
			// Any non-space means the bar was released — stop recording, then let the key through.
			this.#endSpaceHold();
			return false;
		}
		if (!isSpace) {
			this.#resetSpaceRun();
			return false;
		}
		if (!this.#spaceHoldGestureEnabled()) return false;
		const now = performance.now();
		const gap = now - this.#lastSpaceAt;
		const prevGap = this.#prevSpaceGap;
		this.#lastSpaceAt = now;
		this.#prevSpaceGap = gap;
		if (prevGap === undefined || !gapsAreMechanical(gap, prevGap)) {
			// First space, a deliberate tap, or jittery smashing: not a steady machine cadence yet, so
			// type a real space and reset the mechanical run.
			this.#mechanicalRun = 0;
			super.handleInput(data);
			this.#spaceRunInserted++;
			return true;
		}
		// Steady fast repeat: swallow it. Once the cadence has held for SPACE_HOLD_MECHANICAL_RUN
		// deltas it's a held bar — track back the few pre-burst spaces already typed and start.
		if (++this.#mechanicalRun >= SPACE_HOLD_MECHANICAL_RUN) {
			this.deleteBeforeCursor(this.#spaceRunInserted);
			this.#resetSpaceRun();
			this.#beginSpaceHold();
		}
		return true;
	}

	#resetSpaceRun(): void {
		this.#spaceRunInserted = 0;
		this.#mechanicalRun = 0;
		this.#prevSpaceGap = undefined;
		this.#lastSpaceAt = Number.NEGATIVE_INFINITY;
	}

	#beginSpaceHold(): void {
		this.#spaceHoldActive = true;
		this.#armSpaceHoldReleaseTimer();
		this.onSpaceHoldStart?.();
	}

	#armSpaceHoldReleaseTimer(): void {
		if (this.#spaceHoldTimer) clearTimeout(this.#spaceHoldTimer);
		this.#spaceHoldTimer = setTimeout(() => {
			this.#spaceHoldTimer = undefined;
			this.#endSpaceHold();
		}, SPACE_HOLD_RELEASE_MS);
		this.#spaceHoldTimer.unref?.();
	}

	#endSpaceHold(): void {
		if (!this.#spaceHoldActive) return;
		this.#spaceHoldActive = false;
		this.#resetSpaceRun();
		if (this.#spaceHoldTimer) {
			clearTimeout(this.#spaceHoldTimer);
			this.#spaceHoldTimer = undefined;
		}
		this.onSpaceHoldEnd?.();
	}

	handleInput(data: string): void {
		if (this.#pasteImageInFlight) {
			this.#pendingPasteInput.push(data);
			return;
		}

		const kittyParsed = parseKittySequence(data);
		if (kittyParsed && (kittyParsed.modifier & 64) !== 0 && this.onCapsLock) {
			// Caps Lock is modifier bit 64
			this.onCapsLock();
			return;
		}

		const paste = this.#pasteAssembler.process(data);
		if (paste.handled) {
			if (paste.pasteContent !== undefined) {
				this.#routeAssembledPaste(paste.pasteContent, paste.remaining);
			}
			return;
		}

		const parsedKey = parseKey(data);
		const canonical = parsedKey !== undefined ? canonicalKeyId(parsedKey) : undefined;

		// Left-arrow on an empty editor: surface for the agent-hub double-tap
		// gesture. Plain "left" only — modified arrows and any in-text cursor
		// movement fall through to normal handling.
		if (canonical === "left" && this.onLeftAtStart && this.getText().trim() === "") {
			this.onLeftAtStart();
			return;
		}

		// Space-hold push-to-talk: a sustained space bar starts/stops STT instead of typing spaces.
		if (this.#handleSpaceHold(data, canonical)) return;

		if (canonical !== undefined) {
			// Intercept configured image paste (async - fires and handles result)
			if (this.#matchesAction(canonical, "app.clipboard.pasteImage") && this.onPasteImage) {
				void this.onPasteImage();
				return;
			}

			// Intercept configured raw text paste (fires and handles result)
			if (this.#matchesAction(canonical, "app.clipboard.pasteTextRaw") && this.onPasteTextRaw) {
				this.onPasteTextRaw();
				return;
			}

			// Intercept configured external editor shortcut
			if (this.#matchesAction(canonical, "app.editor.external") && this.onExternalEditor) {
				this.onExternalEditor();
				return;
			}

			// Intercept configured temporary model selector shortcut
			if (this.#matchesAction(canonical, "app.model.selectTemporary") && this.onSelectModelTemporary) {
				this.onSelectModelTemporary();
				return;
			}

			// Intercept configured display reset shortcut
			if (this.#matchesAction(canonical, "app.display.reset") && this.onDisplayReset) {
				this.onDisplayReset();
				return;
			}

			// Intercept configured suspend shortcut
			if (this.#matchesAction(canonical, "app.suspend") && this.onSuspend) {
				this.onSuspend();
				return;
			}

			// Intercept configured thinking block visibility toggle
			if (this.#matchesAction(canonical, "app.thinking.toggle") && this.onToggleThinking) {
				this.onToggleThinking();
				return;
			}

			// Intercept configured model selector shortcut
			if (this.#matchesAction(canonical, "app.model.select") && this.onSelectModel) {
				this.onSelectModel();
				return;
			}

			// Intercept configured history search shortcut
			if (this.#matchesAction(canonical, "app.history.search") && this.onHistorySearch) {
				this.onHistorySearch();
				return;
			}

			// Intercept configured tool output expansion shortcut
			if (this.#matchesAction(canonical, "app.tools.expand") && this.onExpandTools) {
				this.onExpandTools();
				return;
			}

			// Intercept configured backward model cycling (check before forward cycling)
			if (this.#matchesAction(canonical, "app.model.cycleBackward") && this.onCycleModelBackward) {
				this.onCycleModelBackward();
				return;
			}

			// Intercept configured forward model cycling
			if (this.#matchesAction(canonical, "app.model.cycleForward") && this.onCycleModelForward) {
				this.onCycleModelForward();
				return;
			}

			// Intercept configured thinking level cycling
			if (this.#matchesAction(canonical, "app.thinking.cycle") && this.onCycleThinkingLevel) {
				this.onCycleThinkingLevel();
				return;
			}

			// Intercept configured interrupt shortcut.
			// When the autocomplete popup is visible, ESC's first job is to dismiss
			// the popup — let super.handleInput() route it to #cancelAutocomplete().
			// The user can press ESC again afterward to fire the global interrupt
			// handler. This matches the standard TUI/IDE pattern and prevents a
			// single ESC from both closing an @ completion and aborting an active
			// agent run (#1655).
			if (this.#matchesAction(canonical, "app.interrupt") && this.onEscape && !this.isShowingAutocomplete()) {
				this.onEscape();
				return;
			}

			// Intercept configured clear shortcut
			if (this.#matchesAction(canonical, "app.clear") && this.onClear) {
				this.onClear();
				return;
			}

			// Intercept configured exit shortcut. Always consume the shortcut so it
			// never reaches the parent handler; firing onExit is the controller's
			// chance to snapshot the current text as a draft before shutting down.
			if (this.#matchesAction(canonical, "app.exit")) {
				this.onExit?.();
				return;
			}

			// Intercept configured dequeue shortcut (restore queued message to editor)
			if (this.#matchesAction(canonical, "app.message.dequeue") && this.onDequeue) {
				this.onDequeue();
				return;
			}

			// Intercept configured copy-prompt shortcut
			if (this.#matchesAction(canonical, "app.clipboard.copyPrompt") && this.onCopyPrompt) {
				this.onCopyPrompt();
				return;
			}

			// Intercept configured retry shortcut. Later user/custom handlers keep
			// precedence so adding the default Alt+R binding does not steal existing
			// shortcuts such as app.plan.toggle or extension commands; copy-prompt is
			// checked above for the same reason.
			if (this.#matchesAction(canonical, "app.retry") && this.onRetry) {
				const customHandler = this.#customMatchKeys.get(canonical);
				if (customHandler) {
					customHandler();
					return;
				}
				this.onRetry();
				return;
			}

			// Check custom key handlers (extensions)
			const handler = this.#customMatchKeys.get(canonical);
			if (handler) {
				handler();
				return;
			}
		}

		// Pass to parent for normal handling
		super.handleInput(data);
	}

	/** Route a fully-assembled bracketed paste. A strictly-empty payload is the macOS
	 *  image-only clipboard Cmd+V shape (#3601) and goes to the smart clipboard reader;
	 *  a payload of explicit image-file paths attaches via {@link onPasteImagePath}
	 *  (#3506); everything else — including whitespace-only pastes — stays a text paste. */
	#routeAssembledPaste(payload: string, remaining: string): void {
		if (payload.length === 0) {
			if (this.onPasteImage) {
				this.#pasteImageInFlight = true;
				if (remaining.length > 0) this.#pendingPasteInput.unshift(remaining);
				Promise.resolve(this.onPasteImage()).then(
					() => this.#onPasteImageSettled(),
					() => this.#onPasteImageSettled(),
				);
			} else if (remaining.length > 0) {
				this.handleInput(remaining);
			}
			return;
		}
		const paths = extractPastePathsFromText(payload.trim());
		if (paths?.every(path => BRACKETED_IMAGE_PATH_REGEX.test(path)) && this.onPasteImagePath) {
			void (async () => {
				for (const path of paths) {
					await this.onPasteImagePath?.(path);
				}
			})();
		} else {
			this.pasteText(payload);
		}
		if (remaining.length > 0) this.handleInput(remaining);
	}

	/** Drain input queued behind the in-flight image read, in arrival order. Stops if a
	 *  drained chunk starts another empty-paste read; that read's settle resumes the drain. */
	#onPasteImageSettled(): void {
		this.#pasteImageInFlight = false;
		while (this.#pendingPasteInput.length > 0 && !this.#pasteImageInFlight) {
			const chunk = this.#pendingPasteInput.shift();
			if (chunk !== undefined) this.handleInput(chunk);
		}
	}
}
