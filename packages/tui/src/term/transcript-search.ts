import type { InputEvent } from "../driver/contract";
import type { TextEdit } from "../events";
import { UiNode } from "../node";
import { batch, createRoot, signal } from "../reactive";
import { flattenLine, singleLine, stripControl } from "../text/sanitize";
import { padTo, truncate } from "../text/width";
import { widgetKeyMatches, widgetKeys } from "./keymap";
import { type PaintEnvironment, paintNode } from "./paint";
import { plainTranscriptText, styleTranscriptCells, transcriptLine } from "./transcript-cells";
import { type WidgetContext, widgetFor } from "./widgets";

interface Anchor {
	readonly node: UiNode;
	/** Entry-relative row, including its leading separator. */
	readonly row: number;
}

interface SourceRow extends Anchor {
	readonly start: number;
	readonly length: number;
}

interface Mark {
	readonly from: number;
	readonly to: number;
	readonly match: number;
}

/** One modal search session. Only rendered main rows enter the corpus, never the dock or a layer. */
export class TranscriptSearch {
	readonly #text = signal("");
	readonly #cursor = signal(0);
	readonly #field: UiNode<"input">;
	readonly #env: PaintEnvironment;
	readonly #context: WidgetContext;
	readonly #disposeField: () => void;
	readonly #base = new Map<UiNode, number>();
	#nodes: readonly UiNode[] | undefined;
	#blocks: { rows: readonly string[]; plain: readonly string[] }[] = [];
	#leads: number[] = [];
	#source: SourceRow[] = [];
	#corpus = "";
	#query = "";
	#matches: { first: number; last: number; col: number }[] = [];
	#marks = new Map<number, Mark[]>();
	#selected = -1;
	#step = 0;
	#room = 0;
	#browsing = false;
	#barRow = -1;
	#previousCol = -1;
	#nextCol = -1;

	constructor(
		readonly savedAnchor: Anchor | undefined,
		readonly owner: UiNode | null,
		env: PaintEnvironment,
		context: (field: UiNode) => WidgetContext,
	) {
		const field = createRoot(dispose => ({
			dispose,
			node: new UiNode("input", {
				text: this.#text,
				cursor: this.#cursor,
				onEdit: (edit: TextEdit) => {
					const text = this.#text.peek();
					const insert = singleLine(stripControl(edit.text));
					batch(() => {
						this.#text.set(text.slice(0, edit.from) + insert + text.slice(edit.to));
						this.#cursor.set(edit.cursor - edit.text.length + insert.length);
					});
				},
			}),
		}));
		this.#field = field.node;
		this.#disposeField = field.dispose;
		this.#env = { ...env, focus: () => this.#field };
		this.#context = context(this.#field);
	}

	dispose(): void {
		this.#disposeField();
	}

	/** Manual scrolling leaves the active match marked without jumping back there on streaming frames. */
	browse(): void {
		this.#browsing = true;
	}

	/** Only local key, paste and pointer input is routed here. Focus and terminal protocol events pass through. */
	input(event: InputEvent): "handled" | "cancel" | "accept" | undefined {
		if (event.type === "mouse") {
			const { row, col, button, action } = event.mouse;
			if (row === this.#barRow && button === "left" && action === "press") {
				if (col === this.#previousCol) this.#step--;
				if (col === this.#nextCol) this.#step++;
			}
			return "handled";
		}
		if (event.type === "paste") {
			widgetFor(this.#field)?.paste?.(this.#field, event.paste, this.#context);
			return "handled";
		}
		if (event.type !== "key") return undefined;
		const key = event.key;
		if (key.kind === "release") return "handled";
		if (widgetKeyMatches(key, "select.cancel") || key.id === "ctrl+c") return "cancel";
		if (key.id === "ctrl+enter") return "accept";
		if (key.id === "shift+enter" || key.id === "ctrl+shift+g" || widgetKeyMatches(key, "select.up")) {
			this.#step--;
		} else if (
			widgetKeyMatches(key, "select.confirm") ||
			widgetKeyMatches(key, "select.down") ||
			key.id === "ctrl+g"
		) {
			this.#step++;
		} else {
			widgetFor(this.#field)?.key?.(this.#field, key, this.#context);
		}
		return "handled";
	}

	/** Reuse immutable painted blocks: on a caret blink, only their identities and separators are checked. */
	#index(nodes: readonly UiNode[], rowsAt: (i: number) => readonly string[], sizeAt: (i: number) => number): boolean {
		let changed = nodes !== this.#nodes;
		for (let i = 0; i < nodes.length; i++) {
			const rows = rowsAt(i);
			const lead = sizeAt(i) - rows.length;
			if (rows !== this.#blocks[i]?.rows) {
				this.#blocks[i] = { rows, plain: rows.map(plainTranscriptText) };
				changed = true;
			}
			if (this.#leads[i] !== lead) changed = true;
			this.#leads[i] = lead;
		}
		if (!changed) return false;
		this.#blocks.length = this.#leads.length = nodes.length;
		this.#nodes = nodes;
		this.#base.clear();
		this.#source = [];
		const lines: string[] = [];
		let offset = 0;
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i]!;
			const { rows, plain } = this.#blocks[i]!;
			const lead = this.#leads[i]!;
			this.#base.set(node, lines.length);
			for (let row = 0; row < lead + rows.length; row++) {
				const text = row < lead ? "" : plain[row - lead]!;
				lines.push(text);
				this.#source.push({ node, row, start: offset, length: text.length });
				offset += text.length + 1;
			}
		}
		this.#corpus = lines.join("\n");
		return true;
	}

	#find(query: string): void {
		this.#matches = [];
		this.#marks.clear();
		if (!query || query.length > this.#corpus.length) return;
		// Whitespace in a literal phrase also crosses wrap, padding and separator rows.
		const expression = new RegExp(
			query
				.split(" ")
				.map(word => RegExp.escape(word))
				.join("\\s+"),
			"giu",
		);
		let row = 0;
		for (const match of this.#corpus.matchAll(expression)) {
			const from = match.index;
			const to = from + match[0].length;
			while (row + 1 < this.#source.length && this.#source[row + 1]!.start <= from) row++;
			const first = row;
			for (; row < this.#source.length; row++) {
				const line = this.#source[row]!;
				const start = Math.max(from - line.start, 0);
				const end = Math.min(to - line.start, line.length);
				if (end > start) {
					let marks = this.#marks.get(row);
					if (!marks) this.#marks.set(row, (marks = []));
					marks.push({ from: start, to: end, match: this.#matches.length });
				}
				if (line.start + line.length >= to) break;
			}
			this.#matches.push({ first, last: row, col: from - this.#source[first]!.start });
		}
	}

	get selectedAnchor(): Anchor | undefined {
		const hit = this.#matches[this.#selected];
		return hit && this.#source[hit.first];
	}

	#absolute(anchor: Anchor | undefined): number | undefined {
		if (!anchor) return undefined;
		const base = this.#base.get(anchor.node);
		return base === undefined ? undefined : base + anchor.row;
	}

	/** Refresh counts and reveal the current result in this frame, retaining a result across streamed edits. */
	reveal(
		nodes: readonly UiNode[],
		rowsAt: (i: number) => readonly string[],
		sizeAt: (i: number) => number,
		top: Anchor | undefined,
		room: number,
	): Anchor | undefined {
		const query = flattenLine(this.#text());
		const previous = this.selectedAnchor;
		const col = this.#matches[this.#selected]?.col ?? 0;
		const changed = query !== "" && this.#index(nodes, rowsAt, sizeAt);
		const edited = query !== this.#query;
		if (edited || changed) {
			this.#query = query;
			this.#find(query);
			const origin = this.#absolute(previous) ?? this.#absolute(top) ?? Math.max(0, this.#source.length - room);
			const index = this.#matches.findIndex(hit => hit.first > origin || (hit.first === origin && hit.col >= col));
			this.#selected = this.#matches.length === 0 ? -1 : Math.max(0, index);
		}
		const step = this.#step;
		this.#step = 0;
		const resized = room !== this.#room;
		this.#room = room;
		if (step || edited) this.#browsing = false;
		const count = this.#matches.length;
		if (!count) return edited && !query ? this.savedAnchor : top;
		if (!step && !edited && (!(changed || resized) || this.#browsing)) return top;
		if (step) this.#selected = (((this.#selected + step) % count) + count) % count;
		const hit = this.#matches[this.#selected]!;
		const start = this.#absolute(top) ?? Math.max(0, this.#source.length - room);
		if (hit.first >= start && hit.last < start + room - (top && room > 1 ? 1 : 0)) return top;
		return this.#source[Math.max(0, hit.first - Math.floor(room / 3))];
	}

	highlight(node: UiNode, entryRow: number, raw: string): string {
		const base = this.#base.get(node);
		const marks = base !== undefined && this.#marks.get(base + entryRow);
		if (!marks) return raw;
		const { cells } = transcriptLine(raw);
		let cell = 0;
		let out = raw;
		for (const mark of marks) {
			while (cell < cells.length && cells[cell]!.end <= mark.from) cell++;
			const first = cells[cell];
			if (!first) break;
			let last = first;
			while (cell + 1 < cells.length && cells[cell + 1]!.start < mark.to) last = cells[++cell]!;
			const style = mark.match === this.#selected ? currentMatch : otherMatch;
			out = styleTranscriptCells(out, first.col, last.col + last.width, style);
		}
		return out;
	}

	/** One bottom row instead of the dock. Leave at least one cell for the input, even at tiny sizes. */
	bar(width: number, row: number): { text: string; col: number } {
		const count = !this.#query
			? ""
			: this.#matches.length
				? `${this.#selected + 1}/${this.#matches.length}`
				: "No matches";
		const prefix = width >= 15 ? "Find: " : "/".slice(0, width - 1);
		const available = width - prefix.length - 1;
		const next = widgetKeys("select.confirm")[0] ?? "ctrl+g";
		const cancel = widgetKeys("select.cancel")[0] ?? "ctrl+c";
		const hint = `  ${next} next · ctrl+enter keep · ${cancel} cancel`;
		const help = available >= count.length + hint.length + 22 ? hint : "";
		const controls = available >= count.length + help.length + 6 ? " ↑ ↓" : "";
		const suffix = truncate(`${count ? ` ${count}` : ""}${help}${controls}`, available, "");
		const fieldWidth = width - prefix.length - suffix.length;
		const field = paintNode(this.#env, this.#field, fieldWidth);
		this.#barRow = row;
		this.#nextCol = controls ? width - 1 : -1;
		this.#previousCol = controls ? width - 3 : -1;
		return {
			text: prefix + padTo(field.rows[0] ?? "", fieldWidth) + this.#env.theme().fg("dim", suffix),
			col: prefix.length + Math.min(fieldWidth - 1, Math.max(0, field.cursor?.col ?? 0)),
		};
	}
}

// The two states must remain distinct even on a monochrome terminal.
const currentMatch = (text: string): string => `\x1b[7m${text}\x1b[27m`;
const otherMatch = (text: string): string => `\x1b[4m${text}\x1b[24m`;
