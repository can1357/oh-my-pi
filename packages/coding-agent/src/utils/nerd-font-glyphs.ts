/**
 * Nerd Fonts glyph names, from the official `glyphnames.json` (see
 * `scripts/generate-nerd-font-glyphs.ts` for the file format). Models name
 * icons from memory and misremember them, so a name resolves to the catalog
 * glyph it most plausibly means ({@link closest}) and counts only then.
 */
import catalog from "./nerd-font-glyphs.txt" with { type: "text" };

/** Classes searched for a name the model put in the wrong class, after the class it named. */
const CLASS_ORDER = ["md", "cod", "oct", "dev", "fa", "seti"];

/**
 * The catalog entry a Nerd Fonts class name (`nf-md-flask` or `md-flask`) means:
 * its `<class>-<name>` key and hex codepoint, exactly or else by {@link closest}.
 *
 * A name joins its words with `_` (`md-text_box`), and no name in the catalog
 * holds a `-`, so a model writing `nf-md-text-box` still finds it.
 */
function find(name: string): [key: string, hex: string] | undefined {
	const written = name.trim().replace(/^nf-/, "");
	// Anything outside the catalog's name alphabet could match across entry delimiters.
	if (!/^[a-z0-9_-]+$/.test(written)) return undefined;
	const dash = written.indexOf("-");
	const named = dash === -1 ? "" : written.slice(0, dash);
	const glyph = written.slice(dash + 1).replaceAll("-", "_");
	return exact(`${named}-${glyph}`) ?? closest(named, glyph);
}

/** The catalog entry keyed `key`: entries are `<key> <hex>` lines, so one search for "\n<key> ". */
function exact(key: string): [key: string, hex: string] | undefined {
	const at = catalog.indexOf(`\n${key} `);
	if (at === -1) return undefined;
	const hex = at + key.length + 2;
	return [key, catalog.slice(hex, catalog.indexOf("\n", hex))];
}

/**
 * The catalog entry nearest `glyph`, a name class `named` lacks. Models misplace
 * an icon's class (`md-spinner` is `fa-spinner`) and misremember its words
 * (`md-text_cursor` is `md-cursor_text`, `md-test` is `md-test_tube`), but keep
 * the words that picture the subject; so a candidate's words must hold all of
 * the name's, or all be among them and cover at least half of them
 * (`md-timer_sand_half` is `md-timer_sand`, `dev-git_cherry_pick` is not `dev-git`).
 * Most words in common wins, then fewest words added (`md-go` is `dev-go`, not
 * `md-go_kart`), then class `named`, then {@link CLASS_ORDER}, then catalog order.
 * `undefined` when no candidate qualifies.
 */
function closest(named: string, glyph: string): [key: string, hex: string] | undefined {
	const words = new Set(glyph.split("_").filter(Boolean));
	if (words.size === 0) return undefined;
	const classRank = (cls: string) => {
		if (cls === named) return 0;
		const at = CLASS_ORDER.indexOf(cls);
		return at === -1 ? CLASS_ORDER.length + 1 : at + 1;
	};
	let best: { line: string; space: number; shared: number; added: number; rank: number } | undefined;
	for (const line of catalog.split("\n")) {
		const dash = line.indexOf("-");
		const space = line.indexOf(" ", dash);
		if (line.startsWith("#") || dash === -1 || space === -1) continue;
		const candidate = new Set(line.slice(dash + 1, space).split("_"));
		let shared = 0;
		for (const word of candidate) if (words.has(word)) shared++;
		if (shared * 2 < words.size || (shared !== words.size && shared !== candidate.size)) continue;
		const added = candidate.size - shared;
		const rank = classRank(line.slice(0, dash));
		if (
			!best ||
			shared > best.shared ||
			(shared === best.shared && (added < best.added || (added === best.added && rank < best.rank)))
		) {
			best = { line, space, shared, added, rank };
		}
	}
	return best && [best.line.slice(0, best.space), best.line.slice(best.space + 1)];
}

/**
 * The canonical `nf-<class>-<name>` form of the catalog glyph a Nerd Fonts class
 * name means (`nf-md-flask`, `md-flask`, or a misremembered `nf-md-spinner` for
 * `nf-fa-spinner`), else `undefined`.
 */
export function canonicalNerdFontName(name: string): string | undefined {
	const entry = find(name);
	return entry && `nf-${entry[0]}`;
}

/** The glyph a Nerd Fonts class name (`nf-md-flask` or `md-flask`) stands for, resolved as {@link canonicalNerdFontName} does. */
export function nerdFontGlyph(name: string): string | undefined {
	const entry = find(name);
	return entry && String.fromCodePoint(Number.parseInt(entry[1], 16));
}
