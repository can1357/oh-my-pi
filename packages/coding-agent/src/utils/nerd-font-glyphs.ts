/**
 * Nerd Fonts glyph names, from the official `glyphnames.json` (see
 * `scripts/generate-nerd-font-glyphs.ts` for the file format). Models name
 * icons from memory and sometimes invent plausible ones, so a name only counts
 * once this catalog knows it.
 */
import catalog from "./nerd-font-glyphs.txt" with { type: "text" };

/**
 * The catalog entry for a Nerd Fonts class name (`nf-md-flask` or `md-flask`):
 * its `<class>-<name>` key and hex codepoint. Entries are newline-delimited
 * `<key> <hex>` lines, so the lookup is one search for "\n<key> ".
 */
function find(name: string): [key: string, hex: string] | undefined {
	const key = name.trim().replace(/^nf-/, "");
	// Anything outside the catalog's name alphabet could match across entry delimiters.
	if (!/^[a-z0-9_-]+$/.test(key)) return undefined;
	const at = catalog.indexOf(`\n${key} `);
	if (at === -1) return undefined;
	const hex = at + key.length + 2;
	return [key, catalog.slice(hex, catalog.indexOf("\n", hex))];
}

/**
 * The canonical `nf-<class>-<name>` form of a Nerd Fonts class name the catalog
 * knows (`nf-md-flask`, or `md-flask` without the prefix), else `undefined`.
 */
export function canonicalNerdFontName(name: string): string | undefined {
	const entry = find(name);
	return entry && `nf-${entry[0]}`;
}

/** The glyph a Nerd Fonts class name (`nf-md-flask` or `md-flask`) stands for, if the catalog knows it. */
export function nerdFontGlyph(name: string): string | undefined {
	const entry = find(name);
	return entry && String.fromCodePoint(Number.parseInt(entry[1], 16));
}
