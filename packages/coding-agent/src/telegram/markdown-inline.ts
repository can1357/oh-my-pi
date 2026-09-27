/**
 * Inline markdown → the HTML subset Telegram accepts.
 *
 * Only the tags Telegram renders survive; everything else is escaped, so model
 * output can never inject markup. `plainText` is the inverse used by the
 * delivery ladder's last rung.
 */

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const CODE_SPAN = /(`[^`\n]+`)/u;
const BOLD = /\*\*([^\n<]+?)\*\*|__([^\n<]+?)__/gu;
const TRIPLE = /\*\*\*([^\n<]+?)\*\*\*|___([^\n<]+?)___/gu;
const STRIKE = /~~([^\n<]+?)~~/gu;
const MARK = /==([^\n<]+?)==/gu;
const SPOILER = /\|\|([^\n<]+?)\|\|/gu;
const ITALIC = /(?<![\w*])\*(?!\s)([^\n<]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)([^\n<]+?)(?<!\s)_(?![\w_])/gu;
const LINK = /\[([^\]\n]*)\]\(([^)\s]+)\)/gu;
const SCHEME = /^(?:https?|tg|mailto):/iu;
const CHAR_ESCAPE = /\\([\\`*_[\]()#+\-.!|>~=$&])/gu;
const ENTITY = /&(?:(lt|gt|amp|quot|apos)|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/gu;
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const STRIPPED_ENTITIES: ReadonlyArray<readonly [string, string]> = [
	["&lt;", "<"],
	["&gt;", ">"],
	["&quot;", '"'],
	["&amp;", "&"],
];

/** Escapes the four characters that would otherwise start Telegram markup. */
export function escapeHtml(value: unknown): string {
	return String(value ?? "").replace(/[&<>"]/gu, char => ESCAPES[char]);
}

function decodeEntities(text: string): string {
	return text.replace(
		ENTITY,
		(all, name: string | undefined, decimal: string | undefined, hex: string | undefined) => {
			if (name !== undefined) return NAMED[name.toLowerCase()];
			const code = Number.parseInt(decimal ?? hex ?? "", decimal === undefined ? 16 : 10);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
		},
	);
}

function marked(text: string): string {
	const struck = text.replace(STRIKE, (_all, inner: string) => `<s>${inner}</s>`);
	const triple = struck.replace(
		TRIPLE,
		(_all, stars: string, underscores: string) => `<b><i>${stars ?? underscores}</i></b>`,
	);
	const bold = triple.replace(BOLD, (_all, stars: string, underscores: string) => `<b>${stars ?? underscores}</b>`);
	const italic = bold.replace(ITALIC, (_all, stars: string, underscores: string) => `<i>${stars ?? underscores}</i>`);
	const linked = italic.replace(LINK, (all, label: string, url: string) =>
		SCHEME.test(url) ? `<a href="${url}">${label}</a>` : all,
	);
	const mark = linked.replace(MARK, (_all, inner: string) => inner);
	return mark.replace(SPOILER, (_all, inner: string) => `<tg-spoiler>${inner}</tg-spoiler>`);
}

function codeSpans(text: string): string {
	return text
		.split(CODE_SPAN)
		.map((part, index) =>
			index % 2 === 1 ? `<code>${escapeHtml(part.slice(1, -1))}</code>` : marked(escapeHtml(decodeEntities(part))),
		)
		.join("");
}

/** Renders one markdown line into the HTML subset. */
export function inline(text: string): string {
	return text
		.split(CHAR_ESCAPE)
		.map((part, index) => (index % 2 === 1 ? escapeHtml(part) : codeSpans(part)))
		.join("");
}

/** Strips the HTML subset back to the text a user reads (plain delivery rung). */
export function plainText(html: string): string {
	let text = String(html).replace(/<[^>]*>/gu, "");
	for (const [entity, char] of STRIPPED_ENTITIES) text = text.replaceAll(entity, char);
	return text;
}
