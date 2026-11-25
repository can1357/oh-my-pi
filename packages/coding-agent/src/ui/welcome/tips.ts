/**
 * Welcome tips: one line of `tips.txt` per tip, picked once per session.
 *
 * A tip may carry markers and placeholders:
 * - `[NO-TERN] ` (leading): a Tern pitch, left out while a TSP surface is live.
 * - ` [NEW]` (trailing): a fresh affordance, picked 4× as often and tagged.
 * - `{key:ctrl+r}`, `{keys:up,down}`, `{tap:left}`, `{action:<keybinding>}`:
 *   keys, formatted through the symbol preset.
 * - `[label](url)`: a link.
 */
import { formatKey, formatKeys, formatKeyTwice, type KeyStyle } from "../keys/format";
import type { TspSpan, TspText } from "@oh-my-pi/pi-wire";
import tipsText from "./tips.txt" with { type: "text" };

const NO_TERN = /^\[NO-TERN\]\s*/;
const NEW = /\s*\[NEW\]\s*$/;
/** Pick weight of a `[NEW]` tip; others weigh 1. */
const NEW_WEIGHT = 4;

const LINES: readonly string[] = tipsText
	.split("\n")
	.map(line => line.trim())
	.filter(line => line.length > 0);

/** The nag shown instead of a tip to one in ten sessions on the plain unicode preset. */
export const NERD_FONT_NAG = "Please use nerdfont 😭.";

/** Every tip with its markers resolved for the renderer: Tern pitches dropped under Tern, unmarked otherwise. */
export function tipPool(tern: boolean): string[] {
	return tern ? LINES.filter(line => !NO_TERN.test(line)) : LINES.map(line => line.replace(NO_TERN, ""));
}

/** A tip from `tips` for the uniform sample `roll` in [0, 1), `[NEW]` tips weighted up; "" when empty. */
export function pickTip(tips: readonly string[], roll: number): string {
	if (tips.length === 0) return "";
	const weights = tips.map(tip => (NEW.test(tip) ? NEW_WEIGHT : 1));
	let left = roll * weights.reduce((sum, weight) => sum + weight, 0);
	for (let i = 0; i < tips.length; i++) {
		left -= weights[i]!;
		if (left < 0) return tips[i]!;
	}
	return tips[tips.length - 1]!;
}

/** The session's tip: the nerd-font nag (unicode preset, `nagRoll` < 0.1) or a weighted pick by `tipRoll`. */
export function welcomeTip(options: {
	readonly nagRoll: number;
	readonly tipRoll: number;
	readonly preset: string;
	readonly tern: boolean;
}): string | undefined {
	if (options.preset === "unicode" && options.nagRoll < 0.1) return NERD_FONT_NAG;
	return pickTip(tipPool(options.tern), options.tipRoll) || undefined;
}

/** Whether `tip` ends in the `[NEW]` marker. */
export function isNewTip(tip: string): boolean {
	return NEW.test(tip);
}

/** How tip keys read: the key style, and how `{action:…}` placeholders resolve. */
export interface TipKeyStyle extends KeyStyle {
	/** The key a keybinding action is bound to, already formatted; undefined keeps the placeholder. */
	readonly action?: (action: string) => string | undefined;
}

const MODIFIERS = ["ctrl", "alt", "shift", "super"] as const;

const PLACEHOLDER = /\{(key|keys|tap|action):([^}]+)\}/g;

function isKeyName(key: string): boolean {
	const parts = key.split("+");
	return parts.every(
		(part, i) => part.length > 0 && (i === parts.length - 1 || (MODIFIERS as readonly string[]).includes(part)),
	);
}

/** `tip` with its key placeholders formatted; malformed ones stay as written. */
export function expandTipKeys(tip: string, style: TipKeyStyle): string {
	return tip.replace(PLACEHOLDER, (placeholder, kind: string, value: string) => {
		if (kind === "action") return style.action?.(value) ?? placeholder;
		const keys = value.split(",");
		if (!keys.every(isKeyName)) return placeholder;
		if (kind === "keys") return formatKeys(keys, style);
		return kind === "key" ? formatKey(keys[0]!, style) : formatKeyTwice(keys[0]!, style);
	});
}

const LINK = /\[([^\]]+)\]\(([^\s)]+)\)/g;

/**
 * The tip body (markers dropped, keys formatted) as text: plain when it has
 * no links, else spans with `link` spans carrying their `href`.
 */
export function tipText(tip: string, style: TipKeyStyle): TspText {
	const body = expandTipKeys(tip.replace(NEW, ""), style);
	const spans: TspSpan[] = [];
	let cursor = 0;
	for (const match of body.matchAll(LINK)) {
		if (match.index > cursor) spans.push({ t: body.slice(cursor, match.index) });
		spans.push({ t: match[1]!, s: "link", href: match[2]! });
		cursor = match.index + match[0].length;
	}
	if (spans.length === 0) return body;
	if (cursor < body.length) spans.push({ t: body.slice(cursor) });
	return spans;
}
