/**
 * The magic-keyword glow: each enabled keyword standing as prose in the draft
 * (`ultrathink`, `chillax`, …; never inside code or markup) shows its own
 * HSL gradient. The terminal sweeps the gradient across the word on its
 * animation clock (still under reduced motion); a Tern terminal draws the
 * word in the accent with its shimmer effect.
 */
import type { Settings } from "../../config/settings";
import { MAGIC_KEYWORDS } from "../../modes/magic-keywords";
import { cfgMagicKeyword, cfgMagicKeywordsEnabled } from "../../modes/settings";
import { magicKeywordRanges } from "../../session/magic-keywords";
import type { ComposerDecoration, ComposerDecorator } from "./composer";

/** A keyword that glows: its trigger word and gradient. */
export interface GlowingKeyword {
	readonly word: string;
	/** HSL hue sweep `[from, to]` in degrees; `to` may exceed 360 to wrap through red. */
	readonly hue: readonly [number, number];
	/** HSL lightness sweep `[from, to]` in percent; 62 throughout when absent. */
	readonly lightness?: readonly [number, number];
}

/** Color stops per gradient. */
const STOPS = 14;
/** One sweep of the gradient across a word. */
export const MAGIC_KEYWORD_PERIOD_MS = 1800;
const SATURATION = 90;

const kPalette = Symbol("magic-keyword.palette");

interface PaletteHolder {
	[kPalette]?: readonly string[];
}

/** `keyword`'s gradient stops as `#rrggbb` (computed once per keyword). */
function palette(keyword: GlowingKeyword): readonly string[] {
	const holder = keyword as GlowingKeyword & PaletteHolder;
	let stops = holder[kPalette];
	if (stops) return stops;
	const [hueFrom, hueTo] = keyword.hue;
	const [lightFrom, lightTo] = keyword.lightness ?? [62, 62];
	stops = Array.from({ length: STOPS }, (_, i) => {
		const t = i / STOPS;
		const hue = Math.round((hueFrom + t * (hueTo - hueFrom)) % 360);
		const lightness = Math.round(lightFrom + t * (lightTo - lightFrom));
		return Bun.color(`hsl(${hue}, ${SATURATION}%, ${lightness}%)`, "hex") ?? "#ffffff";
	});
	holder[kPalette] = stops;
	return stops;
}

/**
 * A composer decorator glowing the keywords `keywords()` returns (read on every draft change,
 * so settings toggles apply at the next edit); `animate()` false keeps the gradient still.
 */
export function magicKeywordDecorator(
	keywords: () => readonly GlowingKeyword[],
	animate: () => boolean = () => true,
): ComposerDecorator {
	return text => {
		const active = keywords();
		if (active.length === 0) return [];
		const byWord = new Map(active.map(keyword => [keyword.word, keyword]));
		const periodMs = animate() ? MAGIC_KEYWORD_PERIOD_MS : undefined;
		return magicKeywordRanges(text, [...byWord.keys()]).map(({ from, to, word }): ComposerDecoration => ({
			from,
			to,
			s: "accent",
			fx: periodMs ? "shimmer" : undefined,
			gradient: { stops: palette(byWord.get(word)!), periodMs },
		}));
	};
}

/** The keywords `settings` turns on (`magicKeywords.enabled` and each `magicKeywords.<id>`). */
export function enabledMagicKeywords(settings: Settings): readonly GlowingKeyword[] {
	if (!cfgMagicKeywordsEnabled.get(settings)) return [];
	return MAGIC_KEYWORDS.filter(keyword => cfgMagicKeyword[keyword.id].get(settings));
}

/** A keyword letter of a text and its gradient color. */
export interface GlowingLetter {
	readonly from: number;
	readonly to: number;
	/** `#rrggbb`. */
	readonly color: string;
}

/**
 * Each letter of the `keywords` standing as prose in `text` with its gradient color at `phase`
 * (in [0, 1): how far the sweep has moved), in text order. Empty when none glows.
 */
export function magicKeywordLetters(text: string, keywords: readonly GlowingKeyword[], phase = 0): GlowingLetter[] {
	if (keywords.length === 0) return [];
	const byWord = new Map(keywords.map(keyword => [keyword.word, keyword]));
	const out: GlowingLetter[] = [];
	for (const { from, to, word } of magicKeywordRanges(text, [...byWord.keys()])) {
		const stops = palette(byWord.get(word)!);
		const chars = Array.from(text.slice(from, to));
		let at = from;
		chars.forEach((char, i) => {
			const color = stops[Math.floor(((i / chars.length + phase) % 1) * stops.length) % stops.length]!;
			out.push({ from: at, to: at + char.length, color });
			at += char.length;
		});
	}
	return out;
}
