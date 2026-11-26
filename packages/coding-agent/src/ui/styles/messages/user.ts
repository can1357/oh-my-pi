/**
 * `omp.user` / `omp.user.synthetic` cards: the user's prompt as a filled
 * bubble.
 *
 * - The prompt is Markdown one cell in from both sides with a blank fill
 *   row above and below, on `userMessageBg`; prose in `userMessageText`
 *   (`dim` for synthetic input). Attachment chips keep their composer color.
 * - The live-steering marker (`*`, accent) and the reaction emoji take the
 *   top fill row (left and right, inside the padding).
 * - Tools are native-only. Attached images draw under the bubble, after the
 *   prompt zone closes, where the terminal draws images.
 * - A one-row allocation shows the first content row (no zone marks).
 * - With prompt zones on, the bubble is an OSC 133 prompt zone.
 * - An empty prompt draws nothing.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext, roleOf } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { renderMarkdownFrame } from "@oh-my-pi/pi-tui/text/markdown/index";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { fgSgr } from "@oh-my-pi/pi-tui/theme/color";
import type { TspCardProps } from "@oh-my-pi/pi-wire";
import { type GlowingKeyword, MAGIC_KEYWORD_PERIOD_MS, magicKeywordLetters } from "../../composer/magic-keywords";
import type { TermChip } from "../../transcript/messages/chips";
import { fileLink } from "../tools/file-common";
import { expandKeyLabel } from "../../keys/hints";
import { fillRow, hexFg, propsOf, termOf, withResolvedColor } from "./fill";

const ZONE_START = "\x1b]133;A\x07";
const ZONE_CLOSE = "\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07";
const BG = "userMessageBg";

interface UserTerm {
	zones?: boolean;
	steered?: boolean;
	reaction?: string;
}

interface PromptTerm {
	chips?: readonly TermChip[];
	synthetic?: boolean;
	/** Magic keywords that glow (their gradient sweeps on the terminal clock). */
	keywords?: readonly GlowingKeyword[];
	/** What the terminal shows when it differs from the native source (markers collapsed to chips). */
	display?: string;
}

/** `text` with each chip label drawn in its color (bold), linked to its file when `hyperlinks`. */
function colorChips(theme: Theme, text: string, chips: readonly TermChip[], hyperlinks: boolean): string {
	let out = text;
	for (const chip of chips) {
		const styled = chip.color.startsWith("#")
			? hexFg(chip.color, `\x1b[1m${chip.t}\x1b[22m`)
			: chip.pill
				? theme.bg("customMessageBg", theme.style(chip.color, chip.t))
				: theme.style(chip.color, chip.t);
		out = out.split(chip.t).join(fileLink({ hyperlinks }, styled, chip.link?.path, chip.link?.line));
	}
	return out;
}

/** Prompt Markdown as a user bubble draws it (unfilled): bubble prose color, chips in their colors. */
export function bubbleMarkdown(
	theme: Theme,
	text: string,
	width: number,
	options: {
		chips?: readonly TermChip[];
		synthetic?: boolean;
		padding?: number;
		/** The terminal draws OSC 8 links: chips link to their files. */
		hyperlinks?: boolean;
	},
): readonly string[] {
	const padding = options.padding ?? 0;
	return renderMarkdownFrame(colorChips(theme, text, options.chips ?? [], options.hyperlinks === true), width, {
		// A terminal-default text color reads as the theme's contrast fallback on the fill.
		theme: withResolvedColor(theme, "userMessageText"),
		paddingX: padding,
		paddingY: padding,
		textStyle: options.synthetic ? "dim" : "userMessageText",
	}).rows;
}

/** The bubble's rows: Markdown with its padding, filled (chips linked on a terminal that draws links). */
export function bubbleRows(cx: PaintContext, prompt: UiNode, width: number): string[] {
	const theme = cx.theme;
	const term = termOf<PromptTerm>(prompt);
	const text = glowKeywords(cx, term.display ?? propsOf<{ text: string }>(prompt).text ?? "", term.keywords ?? []);
	const rows = bubbleMarkdown(theme, text, width, {
		chips: term.chips,
		synthetic: term.synthetic,
		padding: 1,
		hyperlinks: cx.hyperlinks,
	});
	return rows.map(row => fillRow(theme, BG, row, width));
}

/**
 * `text` with each magic keyword letter in its gradient color, swept on the terminal clock (still
 * under reduced motion). The clock is read only when a keyword glows, so other bubbles never tick.
 */
function glowKeywords(cx: PaintContext, text: string, keywords: readonly GlowingKeyword[]): string {
	if (keywords.length === 0 || magicKeywordLetters(text, keywords).length === 0) return text;
	const now = cx.reduceMotion ? 0 : cx.now();
	const letters = magicKeywordLetters(text, keywords, (now % MAGIC_KEYWORD_PERIOD_MS) / MAGIC_KEYWORD_PERIOD_MS);
	const theme = cx.theme;
	const depth = "depth" in theme && (theme.depth === "256" || theme.depth === "16") ? theme.depth : "truecolor";
	let out = "";
	let at = 0;
	for (const letter of letters) {
		out += `${text.slice(at, letter.from)}${fgSgr(letter.color, depth)}${text.slice(letter.from, letter.to)}\x1b[39m`;
		at = letter.to;
	}
	return out + text.slice(at);
}

/** The first row holding text (the top fill row when none does). */
function emergencyRow(rows: readonly string[]): string {
	for (let i = 1; i < rows.length - 1; i++) if (stripEscapes(rows[i]!).trim()) return rows[i]!;
	return rows[rows.length >= 3 ? 1 : 0]!;
}

function paintUser(node: UiNode, cx: PaintContext): Block {
	const theme = cx.theme;
	const prompt = node.children().find(child => child.kind === "md");
	if (!prompt) return EMPTY_BLOCK;
	const rows = bubbleRows(cx, prompt, cx.width);
	if (rows.length === 0) return EMPTY_BLOCK;
	if (cx.height === 1) return { rows: [emergencyRow(rows)] };
	const term = termOf<UserTerm>(node);
	if (term.steered || term.reaction !== undefined) {
		const marker = term.steered ? theme.fg("accent", "*") : "";
		const emoji = term.reaction ?? "";
		const gap = Math.max(0, cx.width - 2 - visibleWidth(marker) - visibleWidth(emoji));
		rows[0] = fillRow(theme, BG, ` ${marker}${" ".repeat(gap)}${emoji}`, cx.width);
	}
	if (term.zones) {
		rows[0] = ZONE_START + rows[0]!;
		rows[rows.length - 1] += ZONE_CLOSE;
	}
	// Images sit outside the OSC 133 zone: their rows keep the exact shape the image protocol needs.
	// One under another: a `row` sizes children by visible width, and an image row's is all escapes.
	const strip = cx.images && node.children().find(child => roleOf(child) === "omp.user.images");
	for (const image of strip ? strip.children() : []) rows.push("", ...cx.paint(image, cx.width).rows);
	return { rows };
}

/**
 * A collapsible synthetic input: its dim one-line summary with the expand
 * hint, and the muted bubble under it while expanded.
 */
function paintSynthetic(node: UiNode, cx: PaintContext): Block {
	const props = propsOf<TspCardProps>(node);
	if (!props.collapsible) return paintUser(node, cx);
	const theme = cx.theme;
	const summary = `${styledText(theme, props.head)}${theme.symbols.symbol("sep.dot")}${expandKeyLabel(theme)}`;
	const rows = [` ${theme.fg("dim", truncate(stripEscapes(summary), Math.max(10, cx.width - 1)))}`];
	const prompt = node.children().find(child => child.kind === "md");
	if (prompt && !props.collapsed) rows.push(...bubbleRows(cx, prompt, cx.width));
	return { rows };
}

defineRolePainter("card", "omp.user", paintUser);
defineRolePainter("card", "omp.user.synthetic", paintSynthetic);
