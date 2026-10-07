/**
 * Card-form session titles: `<icon> <CODE>: <title>` (`🧪 FLAKY: Fix flaky park
 * tests`), the form Tern heads parked panes with. The card is part of the title
 * string itself, so everything that shows a session title (terminal title, the
 * `/resume` picker, listings) shows it; {@link splitCardTitle} takes one apart
 * where a piece is needed.
 */
import type { TitleIcons } from "./title-settings";
import { normalizeGeneratedTitle } from "../tiny/text";
import { canonicalNerdFontName, nerdFontGlyph } from "./nerd-font-glyphs";

/** The pieces of a card-form title. */
export interface CardTitleParts {
	/** An emoji or a Nerd Fonts glyph. */
	icon: string;
	/** 1-6 ASCII capitals or digits naming the subject (`FLAKY`, `Z3`). */
	code: string;
	/** The title without its card. */
	title: string;
}

/** A card a title reply named, validated: its code and the icons it offers. */
interface ReplyCard {
	code: string;
	emoji?: string;
	/** A Nerd Fonts class name the bundled catalog knows (`nf-md-flask`). */
	nf?: string;
}

/** The first `<title …/>` or `<title …>text</title>` tag in a reply. */
const TITLE_TAG = /<title(\s[^>]*?)?\s*(?:\/>|>([\s\S]*?)<\/title>)/i;
const TITLE_ATTR = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** One RGI emoji: ZWJ sequences, modifiers, flags and variation selectors included. */
const RGI_EMOJI = /^\p{RGI_Emoji}$/v;
const CODE = /^[A-Z0-9]{1,6}$/;
/** The card form, `<icon> <CODE>: <title>`. */
const CARD_LINE = /^(\S+) ([A-Z0-9]{1,6}): (\S.*)$/u;
/** Tern reads at most 8 characters as the icon. */
const MAX_ICON_CODEPOINTS = 8;

/** Whether `icon` reads as a card icon to Tern: 1-8 characters, none of them ASCII. */
function isCardIcon(icon: string): boolean {
	let codepoints = 0;
	for (const char of icon) {
		if (char.charCodeAt(0) < 0x80 || ++codepoints > MAX_ICON_CODEPOINTS) return false;
	}
	return codepoints > 0;
}

/**
 * One emoji as the card's icon, else `undefined`. An emoji the model left
 * unqualified (`🗄` for `🗄️`) gets its variation selector back; keycaps (`#️⃣`)
 * are refused because Tern reads an icon as non-ASCII characters only.
 */
function cardEmoji(value: string | undefined): string | undefined {
	const emoji = value?.trim();
	if (!emoji) return undefined;
	const qualified = RGI_EMOJI.test(emoji) ? emoji : RGI_EMOJI.test(`${emoji}\uFE0F`) ? `${emoji}\uFE0F` : undefined;
	return qualified && isCardIcon(qualified) ? qualified : undefined;
}

/**
 * The card for `code` and its icons, or `undefined` when a piece the card form
 * needs is missing: a code (a lowercase one is repaired) and at least one icon.
 * An `nf` name the bundled catalog does not know is dropped, leaving the emoji.
 */
function buildCard(code: string | undefined, emoji: string | undefined, nf: string | undefined): ReplyCard | undefined {
	const cardCode = code?.trim().toUpperCase();
	if (!cardCode || !CODE.test(cardCode)) return undefined;
	const cardEmojiValue = cardEmoji(emoji);
	const cardNf = nf ? canonicalNerdFontName(nf) : undefined;
	if (!cardEmojiValue && !cardNf) return undefined;
	const card: ReplyCard = { code: cardCode };
	if (cardEmojiValue) card.emoji = cardEmojiValue;
	if (cardNf) card.nf = cardNf;
	return card;
}

/**
 * The session title a reply in the card form names:
 * `<title nf="nf-md-flask" emoji="🧪" code="FLAKY">Fix flaky park tests</title>`
 * becomes `🧪 FLAKY: Fix flaky park tests`. `icons` picks the icon: the Nerd Fonts
 * glyph under `nf+emoji` when the catalog knows the `nf` name, else the emoji;
 * `boring` keeps the plain title.
 *
 * Returns `null` when the reply names no title: `<title/>` (the model declined),
 * no tag at all, or a title {@link normalizeGeneratedTitle} rejects. Card pieces
 * degrade one by one: an unknown `nf` name leaves the emoji, and a missing or
 * invalid code or icon leaves a plain title. A plain `<title>` holding the line
 * form (`🧪 FLAKY: Fix flaky park tests`) keeps its card as well.
 *
 * @param sourceText The user's message, to reconcile the title's casing against.
 */
export function parseCardTitleReply(reply: string, icons: TitleIcons, sourceText?: string): string | null {
	const tag = TITLE_TAG.exec(reply);
	if (!tag || tag[2] === undefined) return null;
	const attrs: Record<string, string> = {};
	for (const match of (tag[1] ?? "").matchAll(TITLE_ATTR)) {
		attrs[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? "";
	}
	let text = tag[2].replace(/\s+/g, " ").trim();
	let card = buildCard(attrs.code, attrs.emoji, attrs.nf);
	if (!card && attrs.code === undefined) {
		const line = CARD_LINE.exec(text);
		const lineCard = line ? buildCard(line[2], line[1], attrs.nf) : undefined;
		if (lineCard) {
			card = lineCard;
			text = line![3]!;
		}
	}
	const title = normalizeGeneratedTitle(text, sourceText);
	if (!title) return null;
	if (!card || icons === "boring") return title;
	const icon = (icons === "nf+emoji" && card.nf ? nerdFontGlyph(card.nf) : undefined) ?? card.emoji;
	return icon ? `${icon} ${card.code}: ${title}` : title;
}

/**
 * The pieces of a session title in the card form `<icon> <CODE>: <title>`, or
 * `undefined` for a plain title (`Fix: the parser` has no icon, so it stays whole).
 */
export function splitCardTitle(title: string): CardTitleParts | undefined {
	const line = CARD_LINE.exec(title);
	if (!line || !isCardIcon(line[1]!)) return undefined;
	return { icon: line[1]!, code: line[2]!, title: line[3]! };
}
