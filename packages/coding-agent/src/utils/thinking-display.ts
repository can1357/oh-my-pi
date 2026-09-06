import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

// Single-slot-per-mode memo for formatThinkingForDisplay. During a streaming
// tick the same growing thinking text is formatted up to three times (reveal
// count, reveal slice, component render); this collapses them to one
// computation. Prose and raw modes produce different output for the same text,
// so each mode keeps its own slot. One entry per mode is enough for the common
// case of one active thinking block and never regresses (a miss recomputes
// exactly as before).
//
// Each slot also carries the fold state for incremental extension: when the
// incoming text is an append of the previously formatted text (streaming only
// ever extends the trailing partial line), the fold resumes at the stored
// line boundary — only the appended suffix is re-scanned, reusing the
// committed output and the fence state captured entering that line. Append
// detection is exact: the stored text must be a verbatim prefix of the
// incoming text, checked with `startsWith` (memcmp speed, O(previous text)
// per genuinely-new text — deterministic, no unchecked byte a stream switch
// could hide in; the repeated renders within one tick are answered by the
// identity memo without rescanning). Anything else takes the full-recompute
// path. A partial line that grows past {@link MAX_RESUME_PARTIAL_BYTES} with
// no newline (seam stuck at 0) would otherwise refold the entire text every
// tick; past the cap the checkpoint is retired and the slot degrades to the
// identity memo — the pre-incremental asymptotics for that pathological
// shape, bounded per call. The last input line is always
// re-folded (never committed), so its transient effects — comment-noise
// skipping, the prose ellipsis — are replayed under the new context instead
// of leaking into the committed prefix. The committed output keeps the last
// non-blank line in a mutable tail slot so the prose ellipsis can rewrite it
// without re-joining (or even touching) the committed prefix.

/**
 * Fold accumulator for the output produced so far. Output lines are appended
 * once and frozen into `committed`; only the trailing region stays mutable.
 */
interface FoldState {
	/** joined output lines before the last non-blank line, fully finalized */
	committed: string;
	/** whether a non-blank output line exists (kept in {@link tailLine}) */
	hasTail: boolean;
	/** the last non-blank output line — rewritten in place by the prose ellipsis */
	tailLine: string;
	/** raw blank output lines after `tailLine`, each prefixed by its separator */
	tailBlankSep: string;
	/** whether any output line precedes `tailLine` (a lone leading blank line leaves `committed` empty) */
	tailPred: boolean;
	/** output lines emitted so far */
	emitted: number;
	inFence: boolean;
	fenceChar: string;
	fenceLen: number;
}

interface DisplayCache {
	/** last formatted text */
	text: string;
	/** formatted output for `text` */
	value: string;
	/** whether `text` contains `<!--` (extended incrementally on appends) */
	hadComment: boolean;
	/** byte offset of the start of the last (possibly partial) line of `text` */
	startLineByte: number;
	/** fold state ENTERING that last line — the resume point for appends */
	state: FoldState;
	/** whether the fold checkpoint in {@link state} is valid to resume from */
	resumable: boolean;
}

function freshFoldState(): FoldState {
	return {
		committed: "",
		hasTail: false,
		tailLine: "",
		tailBlankSep: "",
		tailPred: false,
		emitted: 0,
		inFence: false,
		fenceChar: "",
		fenceLen: 0,
	};
}

function freshDisplayCache(): DisplayCache {
	return { text: "", value: "", hadComment: false, startLineByte: 0, state: freshFoldState(), resumable: true };
}

const proseCache = freshDisplayCache();
const rawCache = freshDisplayCache();

export function canonicalizeMessage(text: string | null | undefined): string {
	if (!text) return "";
	const trimmed = text.trim();
	for (let i = 0; i < trimmed.length; i++) {
		const code = trimmed.charCodeAt(i);
		if (code !== 0x2e && code !== 0x2026 && code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
			return trimmed;
		}
	}
	return "";
}

/**
 * Resume cap: a trailing partial line longer than this retires the fold
 * checkpoint. With no newline the seam sits at byte 0, so resuming would
 * refold the entire text every tick — O(total)/tick, O(n²) per stream. Past
 * the cap the slot falls back to the exact-key memo: O(1) on exact repeats,
 * a full recompute on growth (the pre-incremental asymptotics for this
 * pathological shape, bounded per call).
 */
const MAX_RESUME_PARTIAL_BYTES = 8192;

// gpt-5.x reasoning summaries pad every summary part with an empty HTML
// comment (`**Headline**\n\n<!-- -->`), streamed as a `<!--` delta followed by
// ` -->`. Comments with actual content are left untouched.
const EMPTY_COMMENT_RE = /^<!--\s*-->$/;
const OPEN_COMMENT_RE = /^<!--\s*$/;
const FENCE = /^( {0,3})([`~]{3,})/;

/**
 * Whether `line` is reasoning-summary comment noise: an empty HTML comment,
 * or its still-unterminated `<!--` prefix on the last line while streaming.
 */
function isCommentNoise(line: string, isLastLine: boolean): boolean {
	const trimmed = line.trim();
	return EMPTY_COMMENT_RE.test(trimmed) || (isLastLine && OPEN_COMMENT_RE.test(trimmed));
}

/**
 * Whether `text` is an append of the previously formatted text: the stored
 * text must be a verbatim prefix of `text`. Verified exactly with
 * `startsWith` — its intrinsic compare runs at memcmp speed, and every byte
 * of the previous text is checked, leaving no gap a stream switch could hide
 * in (spot-check anchors were exploitable: texts crafted to match only at
 * the sampled positions slipped through as false-positive appends). This
 * reads O(previous text) per genuinely-new text; the repeated renders of one
 * streaming tick never reach here — the identity memo answers them first.
 */
function isAppend(cache: DisplayCache, text: string): boolean {
	const prev = cache.text;
	return prev.length > 0 && text.startsWith(prev);
}

/** Fold one input line into the accumulator. Whitespace-only lines defer to the tail region. */
function pushFoldLine(state: FoldState, line: string): void {
	state.emitted++;
	if (line.trim() === "") {
		// Blank lines are kept verbatim (a `" "` line still renders its space);
		// they just never become the prose ellipsis target.
		if (state.hasTail) state.tailBlankSep += `\n${line}`;
		else state.committed += (state.emitted > 1 ? "\n" : "") + line;
		return;
	}
	if (state.hasTail) {
		state.committed += (state.tailPred ? "\n" : "") + state.tailLine + state.tailBlankSep;
		state.tailPred = true;
	} else {
		state.tailPred = state.emitted > 1;
	}
	state.tailLine = line;
	state.hasTail = true;
	state.tailBlankSep = "";
}

/** Prose-mode ellipsis: rewrite the last non-blank output line in place. */
function appendFoldEllipsis(state: FoldState): void {
	if (!state.hasTail) {
		pushFoldLine(state, "...");
		return;
	}
	const trimmed = state.tailLine.trimEnd();
	if (trimmed.endsWith("...")) {
		state.tailLine = trimmed;
	} else if (trimmed.endsWith(".")) {
		state.tailLine = `${trimmed.slice(0, -1)}...`;
	} else {
		state.tailLine = `${trimmed}...`;
	}
}

/** Materialize the folded output from the committed prefix and the tail region. */
function renderFold(state: FoldState): string {
	if (!state.hasTail) return state.committed;
	return state.committed + (state.tailPred ? "\n" : "") + state.tailLine + state.tailBlankSep;
}

/**
 * Thinking text prepared for display. Both modes drop empty `<!-- -->`
 * sentinel lines outside code fences (see {@link isCommentNoise}); prose-only
 * mode additionally elides fenced code down to a trailing ellipsis.
 */
export function formatThinkingForDisplay(text: string, proseOnly: boolean): string {
	if (!text) return text;
	const cache = proseOnly ? proseCache : rawCache;
	// Identity memo first: the 2nd and 3rd renders of one streaming tick pass
	// the same text and must not pay the prefix verification below.
	if (text === cache.text) return cache.value;
	let hasComment: boolean;
	let fromByte: number;
	let state: FoldState;
	if (cache.resumable && isAppend(cache, text)) {
		// Append: a `<!--` introduced by the suffix flips the noise gate, and a
		// marker straddling the seam can start at most 3 bytes back — identical
		// to rescanning the full text, at O(delta).
		hasComment = cache.hadComment || text.indexOf("<!--", Math.max(0, cache.text.length - 3)) !== -1;
		fromByte = cache.startLineByte;
		state = { ...cache.state };
	} else {
		hasComment = text.includes("<!--");
		fromByte = 0;
		state = freshFoldState();
	}
	// Raw mode without comments is the identity (fences pass through
	// verbatim), so skip the fold entirely, as the previous full-scan shortcut
	// did. Record the slot but leave the checkpoint cleared/non-resumable: no
	// fold state entering the last line was ever computed, so a later append
	// must recompute from scratch rather than resume from a stale checkpoint.
	if (!proseOnly && !hasComment) {
		cache.text = text;
		cache.value = text;
		cache.hadComment = false;
		cache.startLineByte = 0;
		cache.state = freshFoldState();
		cache.resumable = false;
		return text;
	}

	const lines = text.slice(fromByte).split("\n");
	const last = lines.length - 1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		// Freeze the resume state entering the final (possibly partial) line;
		// that line is re-folded from here on the next append.
		if (i === last) cache.state = { ...state };

		if (state.inFence) {
			const close = FENCE.exec(line);
			// A closing fence is the same char, at least as long, with nothing else on the line.
			if (
				close &&
				close[2]![0] === state.fenceChar &&
				close[2]!.length >= state.fenceLen &&
				line.slice(close[1]!.length + close[2]!.length).trim() === ""
			) {
				state.inFence = false;
				state.fenceChar = "";
				state.fenceLen = 0;
			}
			// Prose mode skips all fence lines; raw mode keeps them verbatim
			// (comment markers inside fences are code, not noise).
			if (!proseOnly) pushFoldLine(state, line);
			continue;
		}

		// Drop the whole line so `**Headline**\n\n<!-- -->` leaves no blank tail.
		if (hasComment && isCommentNoise(line, i === last)) continue;

		const open = FENCE.exec(line);
		if (open) {
			const marker = open[2]!;
			const ch = marker[0]!;
			// A backtick fence's info string may not contain a backtick.
			if (!(ch === "`" && line.slice(open[1]!.length + marker.length).includes("`"))) {
				state.inFence = true;
				state.fenceChar = ch;
				state.fenceLen = marker.length;
				if (proseOnly) {
					appendFoldEllipsis(state);
				} else {
					pushFoldLine(state, line);
				}
				continue;
			}
		}
		pushFoldLine(state, line);
	}

	const formatted = renderFold(state);
	cache.text = text;
	cache.value = formatted;
	cache.hadComment = hasComment;
	cache.startLineByte = text.lastIndexOf("\n") + 1;
	// A trailing partial line past the cap means no newline ever arrived (the
	// seam sits at 0 and resuming would refold the whole text every tick).
	// Retire the checkpoint: later calls hit the identity memo on exact
	// repeats and recompute fully on growth — bounded per call.
	cache.resumable = text.length - cache.startLineByte <= MAX_RESUME_PARTIAL_BYTES;
	return formatted;
}

/** Whether a formatted thinking block has non-placeholder content worth rendering. */
export function hasDisplayableThinking(
	text: string | null | undefined,
	formattedText: string | null | undefined,
): boolean {
	if (!text || !formattedText) return false;
	// Visibility keys off the formatted text: a block whose raw text is only
	// comment noise (`<!-- -->\n`) formats to whitespace and stays hidden. The
	// raw canonicalize check still hides dot/ellipsis-only placeholder blocks.
	return formattedText.trim().length > 0 && canonicalizeMessage(text).length > 0;
}

/** Whether an assistant message contains thinking content the TUI can reveal. */
export function messageHasDisplayableThinking(message: AgentMessage, proseOnly: boolean): boolean {
	if (message.role !== "assistant") return false;
	for (const content of message.content) {
		if (content.type !== "thinking") continue;
		if (hasDisplayableThinking(content.thinking, formatThinkingForDisplay(content.thinking, proseOnly))) {
			return true;
		}
	}
	return false;
}
