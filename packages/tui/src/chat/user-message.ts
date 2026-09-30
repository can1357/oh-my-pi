import { applyBackgroundToLine, padding, visibleWidth } from "../utils";
import { type Component, Container } from "../tui";
import { Box } from "../components/box";
import { Disclosure } from "../components/disclosure";
import { Markdown } from "../components/markdown";
import { formatBytes } from "@oh-my-pi/pi-utils";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { ensureThemeSync, getMarkdownTheme, theme } from "../theme";
import {
	attachmentSgr,
	collapseImageMarkers,
	COMPOSER_TOKEN_REGEX,
	composerTokenRegex,
	modelChipStyle,
	modelMentionChipLabel,
	renderPlaceholders,
	skillChipStyle,
} from "../prompt/composer-attachments";
import { MODEL_MENTION_TAG_RE } from "../prompt/model-mention-syntax";
import { expandKeyHint, fileHyperlink } from "../render";
import { imageReferenceHyperlink } from "../prompt/image-references";
import { highlightMagicKeywords } from "../prompt/magic-keywords";
import type { ReactionTarget } from "./reaction";
import { card, md, node, row, span, text } from "../native/describe";
import { base64ImageNode } from "../native/blobs";
import { hasTranscriptActions, runTranscriptAction } from "./transcript-actions";
import { type NativeChild, type NativeNode, type NativeUiEvent, rootToggleExpanded } from "../native/node";
import { Memo } from "../native/memo";

// OSC 133 shell integration: marks prompt zones for terminal multiplexers.
//
// The zone must be *closed* within the same render. `133;B` sets a sticky
// cursor semantic of `.input` in Ghostty (and Ghostty-derived terminals such
// as cmux) that only a command-start marker clears; leaving it latched makes
// `cursorIsAtPrompt()` permanently true and tags every subsequently painted
// cell as `.input`. Combined with `cursor-click-to-move = true` (Ghostty's
// default) that turns every left-click inside the pane into a burst of
// synthesized arrow keys on omp's pty, slamming the editor caret to column 0
// (#8030, #6115).
//
// `133;C` is therefore emitted immediately followed by `133;D;0` at the end of
// the bubble. That clears the input state without reintroducing the grouping
// problem the marker was originally omitted to avoid: the command zone opens
// and finishes inside this component, so later assistant/tool output can never
// be grouped under the first submitted prompt.
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_COMMAND_START = "\x1b]133;C\x07";
const OSC133_COMMAND_DONE = "\x1b]133;D;0\x07";
const OSC133_ZONE_CLOSE = OSC133_ZONE_END + OSC133_COMMAND_START + OSC133_COMMAND_DONE;

/** How a user bubble styles its prose and chips (see {@link userBubbleColor}). */
export interface UserBubbleOptions {
	/** Materialized `file://` targets per attached image, indexed by chip number. */
	imageLinks?: readonly (string | undefined)[];
	/** The message's attached images in chip order (`#1` first); a native bubble shows them. */
	images?: readonly ImageContent[];
	/** Agent-attributed input: dim, flat prose. */
	synthetic?: boolean;
	/** Delivered into the response that was streaming; marked `*` at the bubble's top-left. */
	liveSteered?: boolean;
	/** SKILL.md path for a skill chip by name; `undefined` leaves the chip unlinked. */
	skillPath?: (name: string) => string | undefined;
	/** When the message was sent (ms); shown beside the native hover toolbar. */
	timestamp?: number;
	/** Visual layout of the message: block (colored background), box (border frame), or plain. */
	shape?: UserMessageShape;
}

export type UserMessageShape = "block" | "box" | "plain";

/** Process-wide default shape for user prompt bubbles in the chat transcript. */
let defaultUserMessageShape: UserMessageShape = "block";

/** Set the default visual framing shape for user messages in the chat transcript. */
export function setUserMessageShape(shape: UserMessageShape): void {
	defaultUserMessageShape = shape;
}

/**
 * Foreground styling for prose inside a user bubble: the bubble text color with the
 * magic-keyword glow, attachment chips in their composer identity color, and skill
 * chips as soft pills (linked to their SKILL.md) — each token restoring the bubble's
 * own foreground after it. Shared by {@link UserMessageComponent} and the skill
 * callout so both read as one turn.
 */
export function userBubbleColor(
	options: UserBubbleOptions = {},
	tokenRegex: RegExp = COMPOSER_TOKEN_REGEX,
): (value: string) => string {
	const { imageLinks, synthetic = false, skillPath, shape = defaultUserMessageShape } = options;
	// The Markdown component routes code spans and fenced blocks through its own code styling
	// (never `color`), so those are already excluded; `highlightMagicKeywords` additionally
	// restores the bubble's own foreground after each painted keyword so the gradient never
	// bleeds into the rest of the line.
	const hasBg = shape === "block";
	const keywordReset = hasBg
		? theme.getFgOnBgAnsi("userMessageText", "userMessageBg")
		: theme.fg("userMessageText", "");
	const bubbleReset = hasBg ? `${keywordReset}${theme.getBgAnsi("userMessageBg")}` : `${keywordReset}\x1b[49m`;
	const renderText = synthetic
		? (text: string) => theme.fg("dim", text)
		: (text: string) =>
				hasBg
					? theme.fgOnBg("userMessageText", "userMessageBg", highlightMagicKeywords(text, keywordReset))
					: theme.fg("userMessageText", highlightMagicKeywords(text, keywordReset));
	return (value: string) =>
		renderPlaceholders(
			value,
			{
				renderText,
				renderSkill: (label, name) => {
					const styled = skillChipStyle(label, bubbleReset);
					const path = skillPath?.(name);
					return path ? fileHyperlink(path, styled, { line: 1 }) : styled;
				},
				renderMention: label => modelChipStyle(label, bubbleReset),
				renderReference: (label, kind, index, form) => {
					// Chip tokens keep their composer identity color; the bubble's own
					// foreground resumes after the token (same pattern as keywords).
					const styled =
						form === "chip"
							? `${attachmentSgr(kind, index)}\x1b[1m${label}\x1b[22m${keywordReset}`
							: theme.fg("accent", `\x1b[1m${label}\x1b[22m`);
					return kind === "image" || kind === "video"
						? imageReferenceHyperlink(label, index, imageLinks, () => styled)
						: styled;
				},
			},
			tokenRegex,
		);
}

/**
 * Component that renders a user message. Accepts an agent reaction badge
 * (see {@link ReactionTarget}) drawn right-aligned in the bubble's top padding row;
 * a live-steered message carries a `*` marker left-aligned in the same row.
 */
export class UserMessageComponent extends Container implements ReactionTarget {
	// Memoized OSC 133 zone wrapping keyed on the underlying container render
	// (same source ref ⇒ identical rows ⇒ reuse the wrapped copy). Keeps this
	// component reference-stable for the transcript's incremental assembly and
	// never mutates the container's cached array.
	#zoneSource: readonly string[] | undefined;
	#zoneLines: string[] | undefined;
	readonly #bgColor: ((value: string) => string) | undefined;
	readonly #shape: UserMessageShape;
	readonly #liveSteered: boolean;
	readonly #synthetic: boolean;
	readonly #timestamp: number | undefined;
	readonly #images: readonly ImageContent[];
	readonly #imageLinks: readonly (string | undefined)[] | undefined;
	/** Display text: image markers collapsed to chips and model mentions to their labels. */
	readonly #text: string;
	/** Matches the composer tokens in {@link #text} (chips, skills, this message's mentions). */
	readonly #tokens: RegExp;
	#reaction: string | undefined;
	#native: NativeNode | undefined;

	constructor(text: string, options: UserBubbleOptions = {}) {
		super();
		ensureThemeSync();
		// Display-only collapse: the stored/wire text carries bracketed `[Image #N, WxH]` markers,
		// but the transcript shows the same compact `<icon> #N` chip the composer used. Runs before
		// Markdown layout so wrapping and bubble padding are computed on the visible text.
		text = collapseImageMarkers(text, Number.POSITIVE_INFINITY, () => {});
		const mentionLabels: string[] = [];
		MODEL_MENTION_TAG_RE.lastIndex = 0;
		text = text.replace(MODEL_MENTION_TAG_RE, (_tag, _agent: string, name: string) => {
			const label = modelMentionChipLabel(name);
			mentionLabels.push(label);
			return label;
		});
		this.#liveSteered = options.liveSteered === true;
		this.#synthetic = options.synthetic === true;
		this.#timestamp = options.timestamp;
		this.#images = options.images ?? [];
		this.#imageLinks = options.imageLinks;
		this.#text = text;
		this.#tokens = composerTokenRegex(mentionLabels);

		const shape = options.shape ?? defaultUserMessageShape;
		this.#shape = shape;
		const hasBg = shape === "block";
		const bgColor = hasBg ? (value: string) => theme.bg("userMessageBg", value) : undefined;
		this.#bgColor = bgColor;

		const pad = shape === "box" ? 0 : 1;
		const markdown = new Markdown(text, pad, pad, getMarkdownTheme(), {
			bgColor: shape === "block" ? bgColor : undefined,
			color: userBubbleColor({ ...options, shape }, this.#tokens),
		});
		markdown.setIgnoreTight(true);

		if (shape === "box") {
			const box = new Box(1, 0, undefined, {
				chars: theme.boxRound,
				color: (s: string) => theme.fg("borderAccent", s),
			});
			box.setIgnoreTight(true);
			box.addChild(markdown);
			this.addChild(box);
		} else {
			this.addChild(markdown);
		}
	}

	setReaction(emoji: string): void {
		if (this.#reaction === emoji) return;
		this.#reaction = emoji;
		this.#zoneLines = undefined;
		this.#native = undefined;
	}

	/**
	 * A head-less user-toned frame with the prompt as markdown under its
	 * attached images (titled `#N` like their chips, opening the materialized
	 * file on click): the fill says "you". A quiet toolbar (time, Copy, Rewind) fades in on hover when the
	 * host handles transcript actions. The live-steering marker and the
	 * agent's reaction are chips at the bottom-right, so a reaction landing
	 * later updates the frame in place, even deep in scrollback.
	 */
	override describe(): NativeNode {
		if (this.#native) return this.#native;
		const children: NativeChild[] = [];
		if (!this.#synthetic && hasTranscriptActions()) {
			const tools: NativeChild[] = [];
			if (this.#timestamp !== undefined) {
				const at = new Date(this.#timestamp);
				tools.push(
					text([span(at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), "dim mono")], {
						role: "omp.user.time",
						title: at.toLocaleString(),
					}),
				);
			}
			tools.push(
				// `copy-message`, not Tern's local `copy` (that would copy the label).
				text("Copy", {
					role: "omp.user.tool",
					actions: { click: "copy-message" },
					title: "Copy message",
					key: "copy",
				}),
				text("Rewind", {
					role: "omp.user.tool",
					actions: { click: "rewind" },
					title: "Rewind the conversation to an earlier message",
					key: "rewind",
				}),
			);
			children.push(node("row", { gap: "xs", role: "omp.user.tools" }, tools, "tools"));
		}
		// Videos keep their chip only: the native image node decodes stills.
		const thumbs: NativeNode[] = [];
		if (!this.#synthetic) {
			this.#images.forEach((image, i) => {
				if (!image.mimeType.startsWith("image/")) return;
				const label = `#${i + 1}`;
				const link = this.#imageLinks?.[i];
				const open = link ? { href: link, actions: { click: "open" } } : {};
				thumbs.push(base64ImageNode(image.data, image.mimeType, { alt: label, title: label, ...open }, label));
			});
		}
		if (thumbs.length > 0) {
			children.push(row(thumbs, { gap: "sm", wrap: true, align: "start", role: "omp.user.images" }));
		}
		const marks = this.#synthetic ? [] : tokenMarks(this.#text, this.#tokens);
		children.push(md(this.#text, marks.length > 0 ? { marks } : undefined));
		const badges: NativeChild[] = [];
		if (this.#liveSteered) {
			badges.push(
				node("badge", {
					text: "steered",
					tone: "accent",
					title: "Delivered into the response that was streaming",
				}),
			);
		}
		if (this.#reaction !== undefined) badges.push(node("badge", { text: this.#reaction, role: "omp.reaction" }));
		if (badges.length > 0)
			children.push(node("row", { gap: "xs", justify: "end", role: "omp.user.badges" }, badges, "badges"));
		this.#native = card(
			{ role: this.#synthetic ? "omp.user.synthetic" : "omp.user", tone: this.#synthetic ? "muted" : "user" },
			children,
		);
		return this.#native;
	}

	/** Hover toolbar clicks: omp's own copy and rewind commands. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		if (event.act === "copy-message") runTranscriptAction({ act: "copy", text: this.#text });
		else if (event.act === "rewind") runTranscriptAction({ act: "rewind" });
	}

	/**
	 * The top padding row: the live-steering marker left-aligned and the reaction
	 * badge right-aligned, both inside the horizontal padding.
	 */
	#badgeRow(width: number): string {
		const marker = this.#liveSteered ? theme.fg("accent", "*") : "";
		const emoji = this.#reaction ?? "";
		const gap = Math.max(0, width - 2 - visibleWidth(marker) - visibleWidth(emoji));
		return applyBackgroundToLine(` ${marker}${padding(gap)}${emoji}`, width, this.#bgColor ?? (s => s));
	}

	/** The top border row with the reaction badge docked into the border and live-steered marker. */
	#badgeBorderRow(topBorderRow: string, width: number): string {
		const chars = theme.boxRound;
		// Box drops the border when width <= 4 (or insufficient space); don't synthesize border rows.
		if (!Bun.stripANSI(topBorderRow).startsWith(chars.topLeft)) {
			return topBorderRow;
		}

		const marker = this.#liveSteered ? theme.fg("accent", "*") : "";
		const markerLen = this.#liveSteered ? 1 : 0;
		const emoji = this.#reaction;
		const color = (s: string) => theme.fg("borderAccent", s);

		if (!emoji) {
			if (!this.#liveSteered) return topBorderRow;
			// Only liveSteered marker: requires at least topLeft + margin (1) + marker (1) + topRight (1) = 4 chars
			if (width < 4) return topBorderRow;
			const leftMargin = 1;
			const rightLen = Math.max(0, width - 2 - leftMargin - markerLen);
			return (
				color(chars.topLeft + chars.horizontal.repeat(leftMargin)) +
				marker +
				color(chars.horizontal.repeat(rightLen) + chars.topRight)
			);
		}

		const emojiLen = visibleWidth(emoji);
		const badge = ` ${emoji} `;
		const badgeWidth = emojiLen + 2;
		const rightMargin = 2;
		const leftMargin = this.#liveSteered ? 1 : 0;
		const middleLen = width - 2 - leftMargin - markerLen - badgeWidth - rightMargin;
		if (middleLen < 0) return topBorderRow;

		return (
			color(chars.topLeft + chars.horizontal.repeat(leftMargin)) +
			marker +
			color(chars.horizontal.repeat(middleLen)) +
			badge +
			color(chars.horizontal.repeat(rightMargin) + chars.topRight)
		);
	}

	override render(width: number): readonly string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}
		if (this.#zoneSource === lines && this.#zoneLines !== undefined) {
			return this.#zoneLines;
		}
		const wrapped = lines.slice();
		if (this.#reaction !== undefined || this.#liveSteered) {
			if (this.#shape === "box") {
				wrapped[0] = this.#badgeBorderRow(wrapped[0]!, width);
			} else {
				wrapped[0] = this.#badgeRow(width);
			}
		}
		wrapped[0] = OSC133_ZONE_START + wrapped[0];
		wrapped[wrapped.length - 1] = wrapped[wrapped.length - 1] + OSC133_ZONE_CLOSE;
		this.#zoneSource = lines;
		this.#zoneLines = wrapped;
		return wrapped;
	}
}
/**
 * The composer tokens in `text` as `md` marks, styled as the composer
 * decorates them (`CustomEditor.describeDecorations`), so a sent prompt keeps
 * its chips highlighted.
 */
function tokenMarks(text: string, tokens: RegExp): TspSpan[] {
	// One mark per distinct token: Tern styles every occurrence of its text.
	const styles = new Map<string, string>();
	const mark = (s: string) => (label: string) => {
		styles.set(label, s);
		return "";
	};
	renderPlaceholders(
		text,
		{
			renderText: () => "",
			renderSkill: mark("customMessageLabel strong"),
			renderMention: mark("statusLineModel strong"),
			renderReference: mark("accent strong"),
		},
		tokens,
	);
	return [...styles].map(([t, s]) => ({ t, s }));
}

/**
 * Always-visible dim summary row for a collapsed synthetic input. Kept as a
 * small domain renderer so the width-truncated label never pays Markdown
 * layout; the heavy body lives in the {@link Disclosure} detail slot.
 */
class SyntheticSummary implements Component {
	readonly #summary: string;
	#cache: { width: number; lines: readonly string[] } | undefined;

	constructor(summary: string) {
		this.#summary = summary;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	render(width: number): readonly string[] {
		width = Math.max(1, width);
		if (this.#cache?.width === width) return this.#cache.lines;
		const hint = `${theme.sep.dot.trim()} ${expandKeyHint()}`;
		const lines = [` ${theme.fg("dim", truncateSummary(`${this.#summary} ${hint}`, Math.max(10, width - 1)))}`];
		this.#cache = { width, lines };
		return lines;
	}
}

/**
 * Collapsed placeholder for a synthetic (agent-attributed) user input in the
 * file/remote-backed transcript viewer — chiefly the advisor's `Session update`
 * replay dumps, which can each be hundreds of KiB of Markdown and, on cold open,
 * blocked the TUI for tens of seconds while every historical body was laid out
 * before the viewport clip (issue #6308).
 *
 * Collapsed by default: renders one dim summary row (label · size · line count ·
 * expand hint) and builds NO Markdown. The heavy {@link UserMessageComponent} is
 * constructed lazily only when expanded via `ctrl+o`, so blocks above the
 * viewport never pay layout cost until the reader asks to see them. The raw
 * observability data stays intact in `__advisor.jsonl`.
 */
export class CollapsedSyntheticMessageComponent implements Component {
	#disclosure: Disclosure;
	#expanded = false;
	readonly #native = new Memo();

	readonly #text: string;
	readonly #imageLinks?: readonly (string | undefined)[];

	constructor(text: string, imageLinks?: readonly (string | undefined)[]) {
		this.#text = text;
		this.#imageLinks = imageLinks;

		// The heavy UserMessageComponent is constructed lazily only on the
		// first expanded render and retained across collapse/re-expand cycles.
		this.#disclosure = new Disclosure({
			summary: new SyntheticSummary(summarizeSyntheticInput(text)),
			body: () => new UserMessageComponent(this.#text, { synthetic: true, imageLinks: this.#imageLinks }),
		});
	}

	/** ctrl+o toggle: reveal/hide the full Markdown body. */
	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		this.#disclosure.setExpanded(expanded);
	}

	/**
	 * A muted collapsible card whose head is the one-line summary. The
	 * (potentially huge) markdown body is only described while expanded, so
	 * collapsed history costs no layout on either side; a native toggle
	 * expands it through {@link handleNativeEvent}.
	 */
	describe(): NativeNode {
		return this.#native.get([this.#expanded], () =>
			card(
				{
					role: "omp.user.synthetic",
					tone: "muted",
					head: [span(summarizeSyntheticInput(this.#text), "dim")],
					collapsible: true,
					collapsed: !this.#expanded,
				},
				this.#expanded ? [md(this.#text)] : [],
			),
		);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		const expanded = rootToggleExpanded(event);
		if (expanded !== undefined) this.setExpanded(expanded);
	}

	setIgnoreTight(ignore: boolean): this {
		this.#disclosure.setIgnoreTight(ignore);
		return this;
	}

	invalidate(): void {
		this.#disclosure.invalidate();
	}

	dispose(): void {
		this.#disclosure.dispose();
	}

	render(width: number): readonly string[] {
		return this.#disclosure.render(width);
	}
}

/** Truncate a plain summary label to `maxWidth` display columns, appending `…`. */
function truncateSummary(text: string, maxWidth: number): string {
	if (Bun.stringWidth(text, { countAnsiEscapeCodes: false }) <= maxWidth) return text;
	let out = "";
	let w = 0;
	for (const ch of text) {
		const cw = Bun.stringWidth(ch, { countAnsiEscapeCodes: false });
		if (w + cw > maxWidth - 1) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
}

/**
 * One-line summary for a collapsed synthetic input: `<label> · <size> · <n>
 * lines`. The label is the first Markdown heading's text (e.g. `Session
 * update`), falling back to `Synthetic input` when the body opens with none.
 */
function summarizeSyntheticInput(text: string): string {
	const size = formatBytes(Buffer.byteLength(text, "utf-8"));
	const lineCount = text === "" ? 0 : text.split("\n").length;
	const dot = theme.sep.dot.trim();
	return `${syntheticInputLabel(text)} ${dot} ${size} ${dot} ${lineCount} line${lineCount === 1 ? "" : "s"}`;
}

/** First Markdown heading text in `text`, else `Synthetic input`. */
function syntheticInputLabel(text: string): string {
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		return heading ? heading[1]!.trim() || "Synthetic input" : "Synthetic input";
	}
	return "Synthetic input";
}
