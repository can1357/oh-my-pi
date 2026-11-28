/** Cumulative row positions for the app-owned fullscreen transcript (separators belong to the block below). */
import type { UiNode } from "../node";
import { type Accessor, computed, createRoot } from "../reactive";

export interface TranscriptEntry {
	readonly node: UiNode;
	readonly top: number;
	readonly lead: number;
	readonly index: number;
	readonly size: number;
}

export class TranscriptDocument {
	readonly #entries: TranscriptEntry[] = [];
	readonly #byNode = new Map<UiNode, TranscriptEntry>();
	readonly rows: number;

	constructor(
		nodes: readonly { node: UiNode; height: Accessor<number> }[],
		readonly lines: (node: UiNode) => readonly string[],
		separator: (above: UiNode, below: UiNode) => number,
	) {
		let top = 0;
		let above: UiNode | undefined;
		for (let index = 0; index < nodes.length; index++) {
			const { node, height } = nodes[index]!;
			const count = height();
			if (!count) continue;
			const lead = above ? separator(above, node) : 0;
			const entry = { node, top, lead, index, size: count + lead };
			this.#entries.push(entry);
			this.#byNode.set(node, entry);
			top += lead + count;
			above = node;
		}
		this.rows = top;
	}

	entry(node: UiNode): TranscriptEntry | undefined {
		return this.#byNode.get(node);
	}

	at(row: number): TranscriptEntry | undefined {
		if (row < 0 || row >= this.rows) return undefined;
		let lo = 0;
		let hi = this.#entries.length;
		while (lo + 1 < hi) {
			const mid = (lo + hi) >>> 1;
			if (this.#entries[mid]!.top <= row) lo = mid;
			else hi = mid;
		}
		return this.#entries[lo];
	}

	line(row: number): string {
		const entry = this.at(row);
		return entry ? (this.lines(entry.node)[row - entry.top - entry.lead] ?? "") : "";
	}
}

export interface TranscriptIndex {
	readonly width: number;
	read(): TranscriptDocument;
	dispose(): void;
}

/** Scrolling reads the same cached index. Content/style-only updates do not invalidate the height prefix. */
export function transcriptIndex(
	width: number,
	main: Accessor<readonly UiNode[]>,
	lines: (node: UiNode) => readonly string[],
	separator: (above: UiNode, below: UiNode) => number,
): TranscriptIndex {
	return createRoot(dispose => {
		const heights = computed(() => main().map(node => ({ node, height: computed(() => lines(node).length) })));
		return { width, read: computed(() => new TranscriptDocument(heights(), lines, separator)), dispose };
	});
}
