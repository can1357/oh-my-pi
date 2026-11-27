/**
 * Helpers the panel looks share: reading a node's terminal facts, rules,
 * key glyphs and plain text of TSP spans.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { spinnerIndex } from "@oh-my-pi/pi-tui/term/painters/spinner";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { padTo, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { TspKbdProps, TspSpan, TspText, TspTextProps } from "@oh-my-pi/pi-wire";
import type { Keybinding } from "../../../config/keybindings/app-keybindings";
import { canonicalKeyId } from "../../../config/keybindings/key-id";
import { formatKeys, keyHintPlatform } from "@oh-my-pi/pi-tui/theme/keys";
import { formatKeyHint, formatTooltipKey, keyLabel } from "../../keys/hints";
import { getKeybindings } from "../../../config/keybindings/keybindings";

/** The terminal-only facts (`term` prop) of `node`. */
export function termOf<T>(node: UiNode): Partial<T> {
	const term = (node.props() as { term?: Partial<T> }).term;
	return term ?? {};
}

/** Wire props of `node`, typed by the caller. */
export function propsOf<T>(node: UiNode): T {
	return node.props() as T;
}

/** A full-width horizontal rule in `color`. */
export function rule(theme: Theme, color: string, width: number): string {
	return theme.fg(color, theme.symbols.box.horizontal.repeat(Math.max(0, width)));
}

/** Text of TSP text without styling. */
export function plainText(text: TspText | undefined): string {
	if (text === undefined) return "";
	if (typeof text === "string") return text;
	let out = "";
	for (const span of text as readonly TspSpan[]) out += span.t;
	return out;
}

/** Key names a `kbd` node may carry beside the canonical ids. */
const KEY_ALIASES: Readonly<Record<string, string>> = { esc: "escape", return: "enter" };

/**
 * A key id (`ctrl+o`, `escape`) as the hints show it under the active symbol preset and platform
 * (`⌃O`, `⎋`; `Ctrl+O` off macOS; the preset's keycap icons with a Nerd Font).
 */
export function keyGlyph(key: string): string {
	return formatKeyHint(
		chordOf(key)
			.map(part => KEY_ALIASES[part] ?? part)
			.join("+"),
	);
}

/** A chord's parts; a trailing `+` is the plus key itself. */
function chordOf(key: string): string[] {
	return key.endsWith("+") && key.length > 1 ? [...key.slice(0, -1).split("+").slice(0, -1), "+"] : key.split("+");
}

/** A key in a button's tooltip (`Cancel  esc`, `Submit  ⌃Q`): Escape as `esc`, other keys as unicode keycaps. */
export function keyTitle(key: string): string {
	return formatTooltipKey(canonicalKeyId(key));
}

/** The glyphs of the primary key bound to `action` (`⎋`, `⌃G`), else of `fallback`. */
export function bindingGlyph(action: Keybinding, fallback: string, theme?: Theme): string {
	const key = canonicalKeyId(getKeybindings().keysFor(action)[0] ?? fallback);
	return theme ? keyLabel(theme, key) : keyGlyph(key);
}

/** The selector up/down keys (`tui.select.up`/`down`) as glyphs, slash-joined (`↑/↓`). */
export function selectNavGlyphs(theme?: Theme): string {
	return `${bindingGlyph("tui.select.up", "up", theme)}/${bindingGlyph("tui.select.down", "down", theme)}`;
}

/** Preset keycaps for fixed alternative keys, slash-separated. */
export function keyLabels(theme: Theme, keys: readonly string[]): string {
	return formatKeys(keys, { preset: theme.symbols.preset, platform: keyHintPlatform() });
}

/** The glyphs of a `kbd`'s keys (`["alt", "i"]` → `⌥I`). */
export function kbdGlyph(keys: readonly string[]): string {
	return keyGlyph(keys.join("+"));
}

/** The `role` prop of `node`. */
export function roleOf(node: UiNode): string | undefined {
	return (node.props() as { role?: string }).role;
}

/** The first node (depth-first, `node` included) passing `test`. */
export function findNode(node: UiNode, test: (node: UiNode) => boolean): UiNode | undefined {
	if (test(node)) return node;
	for (const child of node.children()) {
		const hit = findNode(child, test);
		if (hit) return hit;
	}
	return undefined;
}

/** The text of a key hint strip (`omp.overlay.hints`): `⎋ cancel  ⏎ submit`. */
export function hintText(hints: UiNode, separator = "  "): string {
	const parts: string[] = [];
	for (const hint of hints.children()) {
		let keys = "";
		let label = "";
		for (const child of hint.children()) {
			if (child.kind === "kbd") keys = kbdGlyph(propsOf<TspKbdProps>(child).keys ?? []);
			else if (child.kind === "text")
				label = plainText(propsOf<TspTextProps>(child).spans ?? propsOf<TspTextProps>(child).text);
		}
		parts.push(keys && label ? `${keys} ${label}` : keys || label);
	}
	return parts.join(separator);
}

/** The activity spinner frame (`⠋⠙⠹…`) at the paint clock. */
export function activityFrame(cx: PaintContext): string {
	const frames = cx.theme.symbols.activityFrames;
	if (frames.length === 0) return "";
	return frames[spinnerIndex(cx, frames.length)]!;
}

/**
 * A rounded box titled ` title ` (bold accent) on its top edge: each content
 * row padded inside `│ … │`. Rows wider than the box's inside are cut.
 */
export function boxRows(
	theme: Theme,
	title: string,
	content: readonly string[],
	width: number,
	color = "border",
): string[] {
	const box = theme.symbols.box;
	const inner = Math.max(0, width - 4);
	const edge = (text: string) => theme.fg(color, text);
	const label = title === "" ? "" : truncate(` ${title} `, inner, theme.symbols.ellipsis);
	const fill = Math.max(0, width - 3 - visibleWidth(label));
	const rows = [
		`${edge(`${box.topLeft}${box.horizontal}`)}${label && theme.style("strong", theme.fg("accent", label))}${edge(`${box.horizontal.repeat(fill)}${box.topRight}`)}`,
	];
	for (const row of content)
		rows.push(`${edge(box.vertical)} ${padTo(truncate(row, inner, ""), inner)} ${edge(box.vertical)}`);
	rows.push(edge(`${box.bottomLeft}${box.horizontal.repeat(Math.max(0, width - 2))}${box.bottomRight}`));
	return rows;
}
