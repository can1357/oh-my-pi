/**
 * Card-form session titles: a plain title plus a card index (an icon and a
 * short code) for terminals that show sessions as small cards. Tern parses a
 * window title of the form `<icon> <CODE>: <title>`; any other title is shown
 * as-is, so a title without a card stays a plain title.
 */
import type { TitleIcons } from "./title-settings";
import type { SessionTitleCard } from "../session/session-entries";
import { normalizeGeneratedTitle } from "../tiny/text";
import { canonicalNerdFontName, nerdFontGlyph } from "./nerd-font-glyphs";

/** A generated title and the card index it came with, if a valid one. */
export interface CardTitle {
	title: string;
	card?: SessionTitleCard;
}

/** The first `<title …/>` or `<title …>text</title>` tag in a reply. */
const TITLE_TAG = /<title(\s[^>]*?)?\s*(?:\/>|>([\s\S]*?)<\/title>)/i;
const TITLE_ATTR = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** One RGI emoji: ZWJ sequences, modifiers, flags and variation selectors included. */
const RGI_EMOJI = /^\p{RGI_Emoji}$/v;
const CODE = /^[A-Z0-9]{1,6}$/;
/** The line card form inside a plain tag, `<emoji> <CODE>: <title>`. */
const CARD_LINE = /^(\S+) ([A-Z0-9]{1,6}): (\S.*)$/u;
/** Tern reads at most 8 characters as the icon. */
const MAX_ICON_CODEPOINTS = 8;

/**
 * One emoji as the card's icon, else `undefined`. An emoji the model left
 * unqualified (`🗄` for `🗄️`) gets its variation selector back; keycaps (`#️⃣`)
 * are refused because Tern reads an icon as non-ASCII characters only.
 */
function cardEmoji(value: string | undefined): string | undefined {
	const emoji = value?.trim();
	if (!emoji) return undefined;
	const qualified = RGI_EMOJI.test(emoji) ? emoji : RGI_EMOJI.test(`${emoji}\uFE0F`) ? `${emoji}\uFE0F` : undefined;
	if (!qualified) return undefined;
	let codepoints = 0;
	for (const char of qualified) {
		if (char.charCodeAt(0) < 0x80 || ++codepoints > MAX_ICON_CODEPOINTS) return undefined;
	}
	return qualified;
}

/**
 * The card for `code` and its icons, or `undefined` when a piece the card form
 * needs is missing: a code (a lowercase one is repaired) and at least one icon.
 * An `nf` name the bundled catalog does not know is dropped, leaving the emoji.
 */
function buildCard(
	code: string | undefined,
	emoji: string | undefined,
	nf: string | undefined,
): SessionTitleCard | undefined {
	const cardCode = code?.trim().toUpperCase();
	if (!cardCode || !CODE.test(cardCode)) return undefined;
	const cardEmojiValue = cardEmoji(emoji);
	const cardNf = nf ? canonicalNerdFontName(nf) : undefined;
	if (!cardEmojiValue && !cardNf) return undefined;
	const card: SessionTitleCard = { code: cardCode };
	if (cardEmojiValue) card.emoji = cardEmojiValue;
	if (cardNf) card.nf = cardNf;
	return card;
}

/**
 * Parse a title reply in the card form,
 * `<title nf="nf-md-flask" emoji="🧪" code="FLAKY">Fix flaky park tests</title>`.
 *
 * Returns `null` when the reply names no title: `<title/>` (the model declined),
 * no tag at all, or a title {@link normalizeGeneratedTitle} rejects. Card pieces
 * degrade one by one: an unknown `nf` name leaves the emoji, and a missing or
 * invalid code or icon leaves a plain title. A plain `<title>` holding the line
 * form (`🧪 FLAKY: Fix flaky park tests`) is split into its card as well.
 *
 * @param sourceText The user's message, to reconcile the title's casing against.
 */
export function parseCardTitleReply(reply: string, sourceText?: string): CardTitle | null {
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
	return card ? { title, card } : { title };
}

/**
 * The window title for `title` with its card: `<icon> <CODE>: <title>`
 * (`🧪 FLAKY: Fix flaky park tests`), or the plain title without a card, without
 * an icon to show, or under `boring` icons. The icon is the Nerd Fonts glyph under
 * `nf+emoji` when the catalog knows the card's name, else the card's emoji.
 */
export function formatCardTitle(title: string, card: SessionTitleCard | undefined, icons: TitleIcons): string {
	if (!card || icons === "boring") return title;
	const icon = (icons === "nf+emoji" && card.nf ? nerdFontGlyph(card.nf) : undefined) ?? card.emoji;
	return icon ? `${icon} ${card.code}: ${title}` : title;
}
