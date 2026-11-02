/**
 * Keyboard link hints: tags drawn over the extension link labels ({@link extensionLinkLabels}) on
 * the rows a surface shows, so typing a tag picks its link. The composer tags the live viewport;
 * the fullscreen link browser tags the transcript rows it scrolls to.
 */
import { theme } from "../theme/theme";
import { sliceByColumn, visibleWidth } from "../utils";
import { compositeLineAt } from "./composite";
import { type ExtensionLinkLabel, extensionLinkLabels } from "./extension-links";

/** Hint tag letters, home row first: what a tag falls back to after its label's own letters. */
const LINK_HINT_ALPHABET = "asdfghjklqwertyuiopzxcvbnm";
/** Most tags one session holds: every two-letter tag. Links past it stay untagged. */
const MAX_TAGS = LINK_HINT_ALPHABET.length * LINK_HINT_ALPHABET.length;

/** An extension link label drawn on a shown row: what a click or hint tag lands on. */
export interface ViewportLink {
	readonly url: string;
	/** Shown row the label is drawn on (its first row, for a label wrapped across rows). */
	readonly row: number;
	/** First cell of the label's part on that row. */
	readonly start: number;
}

/** A label {@link viewportLinkTargets} found: where it is drawn, its marker id and its text. */
export interface ViewportLinkTarget extends ViewportLink {
	/** The label's marker id ({@link ExtensionLinkLabel.id}). */
	readonly id: string;
	/** The label's text, across every shown row it wraps to; its tag prefers these letters. */
	readonly text: string;
	/** Where each shown row's part of the label starts, top to bottom; the first is `row`/`start`. */
	readonly parts: readonly { readonly row: number; readonly start: number }[];
}

/** An extension link label tagged for picking by keyboard. */
interface LinkHint {
	readonly tag: string;
	readonly link: ViewportLinkTarget;
	/**
	 * The row each shown row part of the label is on in the whole content (shown row plus origin):
	 * with the part's first cell, marker id and URL, what tells the label apart across repaints;
	 * see {@link LinkHints.update}.
	 */
	readonly rows: readonly number[];
}

/** What tells one row part of a label apart across repaints. */
function partKey(row: number, start: number, link: ViewportLinkTarget): string {
	return `${row}\0${start}\0${link.id}\0${link.url}`;
}

/**
 * The extension link labels drawn on `rows`, top to bottom, a wrapped label once at its first row:
 * a row's first label continues the previous row's last label when that has the same marker id
 * and ends its row.
 */
export function viewportLinkTargets(rows: readonly string[]): ViewportLinkTarget[] {
	const targets: {
		url: string;
		row: number;
		start: number;
		id: string;
		text: string;
		parts: { row: number; start: number }[];
	}[] = [];
	let previous: ExtensionLinkLabel | undefined;
	for (let row = 0; row < rows.length; row++) {
		const line = rows[row]!;
		const labels = extensionLinkLabels(line);
		for (const [index, label] of labels.entries()) {
			const text = Bun.stripANSI(sliceByColumn(line, label.start, label.end - label.start));
			const continued = targets.at(-1);
			if (index === 0 && previous?.endsRow && previous.id === label.id && continued) {
				continued.text += text;
				continued.parts.push({ row, start: label.start });
				continue;
			}
			targets.push({
				url: label.url,
				row,
				start: label.start,
				id: label.id,
				text,
				parts: [{ row, start: label.start }],
			});
		}
		previous = labels.at(-1);
	}
	return targets;
}

/** The letters a label's tag tries, in order: the label's own (its first one first), then the alphabet. */
function tagLetters(text: string): string[] {
	const letters = new Set<string>();
	for (const char of text.toLowerCase()) if (char >= "a" && char <= "z") letters.add(char);
	for (const char of LINK_HINT_ALPHABET) letters.add(char);
	return [...letters];
}

/**
 * The first tag for a label reading `text` that keeps `used` prefix-free: a single letter that is
 * no tag and starts none, else two letters whose first is no single-letter tag; `undefined` when
 * none is left. With `twoLetters`, only two-letter tags are tried.
 */
function pickTag(text: string, used: ReadonlySet<string>, twoLetters = false): string | undefined {
	const letters = tagLetters(text);
	if (!twoLetters) {
		const firsts = new Set<string>();
		for (const tag of used) firsts.add(tag[0]!);
		const single = letters.find(letter => !firsts.has(letter));
		if (single !== undefined) return single;
	}
	for (const first of letters) {
		if (used.has(first)) continue;
		for (const second of letters) if (!used.has(`${first}${second}`)) return `${first}${second}`;
	}
	return undefined;
}

/**
 * The tags of one hint session and the letters typed so far. A tag is drawn over the first cell of
 * its label, so it prefers the letters it covers: the label's first letter, then its others, then
 * the home row. Tags never prefix one another.
 */
export class LinkHints {
	#hints: LinkHint[] | undefined;
	#typed = "";

	/** Whether labels have been tagged since construction. */
	get tagged(): boolean {
		return this.#hints !== undefined;
	}

	/** Tag every label `rows` draw afresh and forget the letters typed; returns how many were tagged. */
	assign(rows: readonly string[]): number {
		this.#hints = undefined;
		this.#typed = "";
		this.update(rows);
		return this.#hints!.length;
	}

	/**
	 * Keep the tags while `rows` still draw the tagged labels first, in the same order and columns
	 * (they may sit on other rows, and links may be added after them), following them to the rows
	 * they are on now. Returns false, keeping nothing to pick, when they no longer are.
	 */
	follow(rows: readonly string[]): boolean {
		const hints = this.#hints;
		if (hints === undefined) return false;
		const targets = viewportLinkTargets(rows);
		const unchanged =
			targets.length >= hints.length &&
			hints.every(({ link }, index) => link.url === targets[index]!.url && link.start === targets[index]!.start);
		if (!unchanged) {
			this.#hints = [];
			return false;
		}
		this.#hints = hints.map(({ tag, rows: partRows }, index) => ({ tag, rows: partRows, link: targets[index]! }));
		return true;
	}

	/**
	 * Tag what `rows` draw now, keeping each label's tag while it stays in view: tags of labels no
	 * longer drawn are dropped and only newly drawn labels get one, top to bottom. A label is the
	 * same across repaints when one of its row parts is: that part's row (shown row plus `origin`,
	 * so a scrolling surface passes the row its first shown row has in the whole content), first
	 * cell, marker id and URL; marker ids alone repeat across replies. Matching any part keeps a
	 * wrapped label's tag while only some of its rows stay in view.
	 *
	 * The one time existing tags change: a new label finds no tag that keeps the set prefix-free
	 * (every letter is already a single-letter tag, say a 27th label joins 26). Then every label is
	 * tagged afresh with two letters, and the letters typed are forgotten.
	 */
	update(rows: readonly string[], origin = 0): void {
		const kept = new Map<string, string>();
		for (const { link, rows: partRows, tag } of this.#hints ?? []) {
			for (const [index, part] of link.parts.slice(0, partRows.length).entries()) {
				kept.set(partKey(partRows[index]!, part.start, link), tag);
			}
		}
		const targets = viewportLinkTargets(rows).map(link => {
			const partRows = link.parts.map(part => part.row + origin);
			return {
				link,
				rows: partRows,
				keys: link.parts.map((part, index) => partKey(partRows[index]!, part.start, link)),
			};
		});
		const used = new Set<string>();
		const tags = targets.map(({ keys }) => {
			const tag = keys.map(key => kept.get(key)).find(found => found !== undefined && !used.has(found));
			if (tag !== undefined) used.add(tag);
			return tag;
		});
		let hints: LinkHint[] = [];
		let exhausted = false;
		for (const [index, { link, rows: partRows }] of targets.entries()) {
			let tag = tags[index];
			if (tag === undefined) {
				// Past the cap a label stays untagged.
				if (used.size >= MAX_TAGS) continue;
				tag = pickTag(link.text, used);
				if (tag === undefined) {
					exhausted = true;
					break;
				}
				used.add(tag);
			}
			hints.push({ tag, link, rows: partRows });
		}
		if (exhausted) {
			hints = [];
			used.clear();
			for (const { link, rows: partRows } of targets.slice(0, MAX_TAGS)) {
				// Two letters each leave 676 prefix-free tags, so one is always left.
				const tag = pickTag(link.text, used, true)!;
				used.add(tag);
				hints.push({ tag, link, rows: partRows });
			}
			this.#typed = "";
		}
		this.#hints = hints;
		if (!hints.some(({ tag }) => tag.startsWith(this.#typed))) this.#typed = "";
	}

	/**
	 * The content moved under the tags, as when a reply above some labels is redrawn taller or
	 * shorter: `move` maps the row a label was last drawn on in the whole content to the row it is
	 * on now, so the next {@link update} finds it there with its tag.
	 */
	moveRows(move: (row: number) => number): void {
		if (this.#hints) this.#hints = this.#hints.map(hint => ({ ...hint, rows: hint.rows.map(move) }));
	}

	/** Whether some row holds more tag cells than `width`, so its tags could not all be read side by side. */
	crowded(width: number): boolean {
		const cells = new Map<number, number>();
		for (const { tag, link } of this.#hints ?? []) cells.set(link.row, (cells.get(link.row) ?? 0) + tag.length);
		for (const count of cells.values()) if (count > width) return true;
		return false;
	}

	/**
	 * Type one letter of a tag. Returns the link whose whole tag is now typed, `true` while the
	 * letters still lead to several tags, and `false` when none starts with them. A pick or a miss
	 * forgets the letters typed.
	 */
	type(letter: string): ViewportLink | boolean {
		const typed = this.#typed + letter.toLowerCase();
		const matching = (this.#hints ?? []).filter(hint => hint.tag.startsWith(typed));
		const picked = matching.length === 1 && matching[0]!.tag === typed ? matching[0]!.link : undefined;
		if (matching.length === 0 || picked !== undefined) {
			this.#typed = "";
			return picked === undefined ? false : { url: picked.url, row: picked.row, start: picked.start };
		}
		this.#typed = typed;
		return true;
	}

	/**
	 * Draw every tag the typed letters still lead to over the start of its label, within the first
	 * `width` cells of each row (cells past it, such as a scrollbar, are kept). Tags on one row never
	 * overlap: one that would land on an earlier tag moves right, and tags that would run past
	 * `width` move left, so each stays readable as long as the row has room for them all.
	 */
	paint(rows: readonly string[], width: number): string[] {
		const painted = [...rows];
		const byRow = new Map<number, { tag: string; col: number }[]>();
		for (const { tag, link } of this.#hints ?? []) {
			if (rows[link.row] === undefined || !tag.startsWith(this.#typed)) continue;
			let row = byRow.get(link.row);
			if (!row) byRow.set(link.row, (row = []));
			row.push({ tag, col: link.start });
		}
		for (const [index, tags] of byRow) {
			tags.sort((a, b) => a.col - b.col);
			let free = 0;
			for (const placed of tags) {
				placed.col = Math.max(placed.col, free);
				free = placed.col + placed.tag.length;
			}
			let limit = width;
			for (let i = tags.length - 1; i >= 0; i--) {
				const placed = tags[i]!;
				placed.col = Math.max(0, Math.min(placed.col, limit - placed.tag.length));
				limit = placed.col;
			}
			let line = painted[index]!;
			const lineWidth = Math.max(width, visibleWidth(line));
			for (const { tag, col } of tags) {
				// Raw SGR like the hover highlight: chalk's inverse/bold drop out when it detects no color.
				const styled = `\x1b[1;7m${theme.fg("accent", tag)}\x1b[22;27m`;
				line = compositeLineAt(line, styled, col, tag.length, lineWidth);
			}
			painted[index] = line;
		}
		return painted;
	}
}
