/**
 * Shared engine for the ephemeral fullscreen transcript selectors (esc-esc
 * rewind, `/copy`): replay session entries through {@link ChatTranscriptBuilder},
 * map each rendered turn to a selectable target, and compose gutter-prefixed
 * columns with a dotted outline around the selected target.
 */
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { SessionMessageEntry } from "../../session/session-entries";
import { type ThemeColor, theme } from "../theme/theme";
import type { ChatTranscriptBuilder } from "./chat-transcript-builder";
import { fit } from "./overlay-box";
import { isUsageRowBlock } from "./usage-row";

/** One selectable transcript item: a message entry plus its rendered block range. */
export interface OutlineTarget {
	/** Entry the selection resolves to; extended over trailing componentless tool results. */
	entryId: string;
	/** Entry that opened this turn (pre-fold) — anchor for tree lookups. */
	turnId: string;
	/** Real user prompt — drives user-turn jumps and role-specific actions. */
	isUserTurn: boolean;
	/** First transcript-container child rendered by this entry. */
	start: number;
	/** One past the last child rendered by this entry. */
	end: number;
	/** Entries this target spans: the turn plus any folded tool results. */
	entries: SessionMessageEntry[];
}

/** Composed rows of one column plus the outline's line range within them. */
export interface ComposedColumn {
	lines: string[];
	selStart: number;
	selEnd: number;
}
/** Presentation of the dotted outline: stroke color and an optional caption inset into the top rule. */
export interface OutlineStyle {
	color?: ThemeColor;
	/** Short affordance label (e.g. "3 blocks →") drawn into the top rule's right end. */
	caption?: string;
}

// User bubbles wrap their rows in OSC 133 prompt-zone marks (see
// user-message.ts). Re-emitting those inside the alternate-screen overlay
// latches the terminal's prompt semantics onto overlay rows and garbles the
// frame, so embedded rows shed them; the transcript proper keeps its zones.
const OSC133_SPAN_REGEX = /\x1b\]133;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Copy-on-write removal of OSC 133 spans from a rendered row array. */
export function stripPromptZones(rows: readonly string[]): readonly string[] {
	let sanitized: string[] | undefined;
	for (let index = 0; index < rows.length; index++) {
		if (!rows[index]!.includes("\x1b]133;")) continue;
		sanitized ??= rows.slice();
		sanitized[index] = rows[index]!.replace(OSC133_SPAN_REGEX, "");
	}
	return sanitized ?? rows;
}

/**
 * Append `entries` to `builder`, returning the selectable targets they
 * produce. Entries that render nothing are folded (tool results, so a turn's
 * rewind keeps its output) or skipped (notices, hidden messages); usage rows
 * flushed at the head of an append are attributed to the turn above.
 */
export function appendOutlineEntries(builder: ChatTranscriptBuilder, entries: SessionMessageEntry[]): OutlineTarget[] {
	const targets: OutlineTarget[] = [];
	for (const entry of entries) {
		const children = builder.container.children;
		const before = children.length;
		builder.append([entry]);
		const after = children.length;
		let start = before;
		while (start < after && isUsageRowBlock(children[start]!)) {
			const previous = targets.at(-1);
			if (previous && previous.end === start) previous.end = start + 1;
			start++;
		}
		if (start >= after) {
			const previous = targets.at(-1);
			if (entry.message.role === "toolResult" && previous) {
				previous.entryId = entry.id;
				previous.entries.push(entry);
			}
			continue;
		}
		targets.push({
			entryId: entry.id,
			turnId: entry.id,
			isUserTurn: entry.message.role === "user" && userMessageHasText(entry.message),
			start,
			end: after,
			entries: [entry],
		});
	}
	return targets;
}

/** Per-target "renders at least one non-blank row" flags at the given rows. */
export function outlineVisibility(
	childRows: readonly (readonly string[])[],
	targets: readonly OutlineTarget[],
): boolean[] {
	return targets.map(target => {
		for (let index = target.start; index < target.end; index++) {
			if (childRows[index]!.some(row => /\S/.test(row))) return true;
		}
		return false;
	});
}

/** Dotted horizontal rule with rounded corners, spanning the outline width. */
export function outlineRule(
	left: string,
	right: string,
	innerWidth: number,
	color: ThemeColor = "accent",
	caption?: string,
): string {
	const label = caption ? ` ${caption} ` : "";
	const fill = Math.max(0, innerWidth + 2 - visibleWidth(label));
	return (
		theme.fg(color, left + theme.boxDotted.horizontal.repeat(fill)) +
		theme.bold(theme.fg(color, label)) +
		theme.fg(color, right)
	);
}

/** Wrap pre-rendered rows in the dotted outline (rules above/below, `┆` sides). */
export function outlineRows(rows: readonly string[], innerWidth: number, style: OutlineStyle = {}): string[] {
	const color = style.color ?? "accent";
	const vertical = theme.fg(color, theme.boxDotted.vertical);
	const lines: string[] = [
		outlineRule(theme.boxRound.topLeft, theme.boxRound.topRight, innerWidth, color, style.caption),
	];
	for (const row of rows) lines.push(`${vertical} ${fit(row, innerWidth)} ${vertical}`);
	lines.push(outlineRule(theme.boxRound.bottomLeft, theme.boxRound.bottomRight, innerWidth, color));
	return lines;
}

/**
 * Compose one column: gutter-prefixed rows for `childRows[from, to)` with a
 * dotted outline around `targets[selected]`. `header` rows, when given, lead
 * the column.
 */
export function composeOutlineColumn(
	childRows: readonly (readonly string[])[],
	from: number,
	to: number,
	targets: readonly OutlineTarget[],
	selected: number,
	columnWidth: number,
	header: string[] | undefined,
	style: OutlineStyle = {},
): ComposedColumn {
	const inner = Math.max(10, columnWidth - 4);
	const lines: string[] = header ? [...header] : [];
	let selStart = -1;
	let selEnd = -1;
	const target = selected >= 0 ? targets[selected] : undefined;
	for (let index = from; index < to; index++) {
		if (target && index === target.start && target.end <= to) {
			const segment: string[] = [];
			for (let child = target.start; child < target.end; child++) segment.push(...childRows[child]!);
			// Outline only the non-blank core; edge spacers stay outside.
			let head = 0;
			let tail = segment.length;
			while (head < tail && !/\S/.test(segment[head]!)) head++;
			while (tail > head && !/\S/.test(segment[tail - 1]!)) tail--;
			for (let row = 0; row < head; row++) lines.push("");
			selStart = lines.length;
			lines.push(...outlineRows(segment.slice(head, tail), inner, style));
			selEnd = lines.length;
			for (let row = tail; row < segment.length; row++) lines.push("");
			index = target.end - 1;
			continue;
		}
		for (const row of childRows[index]!) lines.push(row ? `  ${row}` : row);
	}
	return { lines, selStart, selEnd };
}

/** Centered position rail for horizontally windowed content: `… ○ ◉ ○ …`. */
export function positionRail(
	count: number,
	active: number,
	moreLeft: boolean,
	moreRight: boolean,
	width: number,
): string {
	const dots: string[] = [];
	for (let index = 0; index < count; index++) {
		dots.push(index === active ? theme.fg("accent", theme.radio.selected) : theme.fg("dim", theme.radio.unselected));
	}
	const rail = `${moreLeft ? theme.fg("dim", "… ") : "  "}${dots.join(" ")}${moreRight ? theme.fg("dim", " …") : ""}`;
	const pad = Math.max(0, Math.floor((width - visibleWidth(rail)) / 2));
	return " ".repeat(pad) + rail;
}

/** Plain text of a user message (string or text blocks), single line. */
export function userMessageText(message: Extract<SessionMessageEntry["message"], { role: "user" }>): string {
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map(block => block.text)
					.join(" ");
	return text.replace(/\s+/g, " ").trim();
}

/** Whether a user message carries prompt text (string or text blocks). */
export function userMessageHasText(message: SessionMessageEntry["message"]): boolean {
	if (message.role !== "user") return false;
	if (typeof message.content === "string") return message.content.trim().length > 0;
	return message.content.some(block => block.type === "text" && block.text.trim().length > 0);
}
