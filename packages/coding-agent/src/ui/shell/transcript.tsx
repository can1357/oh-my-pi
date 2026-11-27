/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The transcript: the main region's blocks, in order.
 *
 * Each block is one owned node (see {@link ViewList}). Settling a block
 * tells the renderer it is final: a plain terminal may then move its rows
 * into scrollback, where they can no longer change; Tern drops its retained
 * description. Changing or removing a block whose rows already reached
 * scrollback needs a history replay, which {@link Transcript.redraw} and
 * {@link Transcript.truncate} run once per batch.
 *
 * A settled block whose content still has work in flight that changes its
 * rows ({@link holdSettle}: a figure whose raster has not landed) stays
 * live until that work ends, so scrollback gets its final rows.
 *
 * Compact blocks (one-row notices, markers) pack against compact neighbours:
 * the terminal draws no blank row between them and Tern shows the run as one
 * gapless block (a `col` with role `omp.compact`).
 */
import {
	type Accessor,
	createContext,
	effect,
	getOwner,
	isSettled,
	type JSXNode,
	onCleanup,
	type Owner,
	provide,
	runWithOwner,
	type Signal,
	settle,
	signal,
	type UiHandlers,
	type UiNode,
	untrack,
	useContext,
} from "@oh-my-pi/pi-tui";
import { holdsImage } from "@oh-my-pi/pi-tui/driver/images/anchor";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { mountNode, type ViewEntry, ViewList } from "./views";

/** A block in the transcript. */
export interface TranscriptBlock extends ViewEntry {
	/** A real user prompt for transcript navigation, not a synthetic message. */
	readonly prompt?: true;
	/** Whether the block currently draws as compact rows (reactive). */
	readonly compact: Accessor<boolean>;
	/** The block draws its own blank row below it: no separator follows it. */
	readonly spacedBelow: boolean;
	/** The block heads the transcript (see {@link BlockOptions.head}). */
	readonly head: boolean;
	/**
	 * The nodes Tern receives for the block (reactive): its content without the terminal's
	 * edge-trimming wrapper, or an inline block's children (see {@link BlockOptions.inline}).
	 */
	readonly native: Accessor<readonly UiNode[]>;
}

/** Options of {@link Transcript.append}. */
export interface BlockOptions {
	readonly prompt?: boolean;
	/** Pack against compact neighbours (may change over time). */
	readonly compact?: Accessor<boolean>;
	/**
	 * The block draws its own blank rows (the welcome card): they are kept, and the terminal adds no
	 * separator below it. Other blocks have blank edge rows trimmed.
	 */
	readonly spacedBelow?: boolean;
	/**
	 * The block heads the transcript and is not a session message (the welcome card, the header
	 * lines under it): a rebuild's {@link Transcript.commit} keeps it on top instead of dropping it.
	 */
	readonly head?: boolean;
	/**
	 * Natively the block's children stand in the main region themselves (the welcome card between
	 * its spacers, as Tern lays out omp's start screen). Only with {@link spacedBelow}.
	 */
	readonly inline?: boolean;
}

/** What the transcript needs from the running host. */
export interface TranscriptHost {
	/** Whether `node` has rows in terminal scrollback. */
	retired(node: UiNode): boolean;
	/** Rebuild terminal scrollback from the current main region. */
	replayHistory(): void;
	/** Describe again the settled block holding `node` (Tern dropped its description). */
	redescribe(node: UiNode): void;
}

const NOT_COMPACT: Accessor<boolean> = () => false;

/** Registers a settle hold with the block being built. */
const SettleHolds = createContext<((pending: Accessor<boolean>) => void) | undefined>(undefined, "omp.settleHolds");

/**
 * Keep the transcript block being built live while `pending` is true, even
 * once it is settled: work that still changes its rows (a figure's raster)
 * must land before the block's rows go to scrollback. The hold ends with
 * the calling scope; outside a transcript block it does nothing.
 */
export function holdSettle(pending: Accessor<boolean>): void {
	useContext(SettleHolds)?.(pending);
}

/** Describes the block being built again once it is settled (see {@link settledRevision}). */
const SettledRevision = createContext<(() => void) | undefined>(undefined, "omp.settledRevision");

/**
 * How content of the transcript block being built says it changed after the
 * block settled (state the user changed from elsewhere: a bash card's
 * inspector): Tern, which dropped a settled block's description, gets it
 * again. Outside a transcript block the returned function does nothing.
 */
export function settledRevision(): () => void {
	return useContext(SettledRevision) ?? (() => {});
}

/** A mounted block's settle holds and the scope that owns it. */
interface BlockHolds {
	readonly owner: Owner | null;
	readonly pending: Signal<readonly Accessor<boolean>[]>;
	/** {@link Transcript.settle} was asked. */
	requested: boolean;
}

/** See the module docs. */
export class Transcript {
	/** The blocks drawn. */
	readonly #shown = new ViewList<TranscriptBlock>();
	/** Where edits go: the shown list, or a staged one while a rebuild builds off-screen. */
	readonly #target = signal(this.#shown);
	readonly #byNode = new WeakMap<UiNode, TranscriptBlock>();
	readonly #holds = new WeakMap<UiNode, BlockHolds>();
	/** Native wrappers of compact runs, keyed by the run's first member. */
	#wrappers = new Map<UiNode, CompactRun>();
	#host: TranscriptHost | undefined;
	#insertionPoint: TranscriptBlock | undefined;

	/** A `select` no handler inside its block took: an extension link label clicked in Markdown (its href). */
	onSelect: ((item: string) => void) | undefined;
	/** An action no node inside a block handled (`subagents.focus=<id>` from a task card's agent row). */
	onAction: ((act: string) => void) | undefined;

	/** Blocks in order (reactive); while {@link stage}d, the staged ones. */
	readonly blocks: Accessor<readonly TranscriptBlock[]> = () => this.#target().entries();

	/** The blocks' nodes, as the terminal draws them (reactive). */
	readonly nodes: Accessor<readonly UiNode[]> = this.#shown.nodes;

	get #blocks(): ViewList<TranscriptBlock> {
		return this.#target.peek();
	}

	/** Whether a rebuild is staged ({@link stage}). */
	get staged(): boolean {
		return this.#target.peek() !== this.#shown;
	}

	/**
	 * Build the next transcript off-screen: until {@link commit} or {@link abort}, every edit goes
	 * to an empty staged list while the shown blocks keep drawing.
	 */
	stage(): void {
		if (!this.staged) this.#target.set(new ViewList<TranscriptBlock>());
	}

	/**
	 * Show the staged blocks in place of the shown ones, which are disposed (`preserve`: kept,
	 * after the staged ones). Head blocks ({@link BlockOptions.head}) stay above the staged ones.
	 * Scrollback is rebuilt when `history` asks or a removed block had rows there.
	 */
	commit(options?: { preserve?: boolean; history?: boolean }): void {
		const staged = this.#target.peek();
		if (staged === this.#shown) return;
		const shown = this.#shown.take();
		const built = staged.take();
		this.#target.set(this.#shown);
		const head = shown.filter(block => block.head);
		const previous = shown.filter(block => !block.head);
		const retired = !options?.preserve && previous.some(block => this.#host?.retired(block.node) ?? false);
		this.#shown.push(...head, ...built, ...(options?.preserve ? previous : []));
		if (!options?.preserve) for (const block of previous) block.dispose();
		if (options?.history || retired) this.#host?.replayHistory();
	}

	/** Drop the staged blocks; the shown ones stay. */
	abort(): void {
		const staged = this.#target.peek();
		if (staged === this.#shown) return;
		this.#target.set(this.#shown);
		staged.clear();
	}

	/** Attach the running host (scrollback queries and replays). */
	attach(host: TranscriptHost | undefined): void {
		this.#host = host;
	}

	get length(): number {
		return this.#blocks.length;
	}

	/** Mount a block at the end (before the insertion point while one is set); `factory` must build exactly one node. */
	append(factory: () => JSXNode, options?: BlockOptions): TranscriptBlock {
		const block = this.#mount(factory, options);
		const anchor = this.#insertionPoint;
		if (anchor && this.#blocks.peek().includes(anchor)) this.#blocks.insertBefore(anchor, block);
		else this.#blocks.push(block);
		return block;
	}

	/**
	 * Make {@link append} insert before `anchor` until cleared (`undefined`): a rebuild replays
	 * history above blocks that stay live under it.
	 */
	setInsertionPoint(anchor: TranscriptBlock | undefined): void {
		this.#insertionPoint = anchor;
	}

	/**
	 * Remove every block but `keep`, in one pass; scrollback is rebuilt once when any removed
	 * block had rows there.
	 */
	retain(keep: ReadonlySet<TranscriptBlock>): void {
		// Asked before the removed blocks are disposed.
		const retired = this.#blocks.peek().some(block => !keep.has(block) && this.retired(block));
		this.#blocks.retain(block => keep.has(block));
		if (retired) this.#host?.replayHistory();
	}

	/** Mount a block before `anchor` (at the end when it is gone). */
	insertBefore(anchor: TranscriptBlock, factory: () => JSXNode, options?: BlockOptions): TranscriptBlock {
		const block = this.#mount(factory, options);
		this.#blocks.insertBefore(anchor, block);
		return block;
	}

	/** The block owning `node`, if any. */
	blockOf(node: UiNode): TranscriptBlock | undefined {
		return this.#byNode.get(node);
	}

	/** Mark `block` final, once no {@link holdSettle} of its content is pending. */
	settle(block: TranscriptBlock): void {
		const holds = this.#holds.get(block.node);
		if (!holds || block.node.disposed) {
			settleBlock(block);
			return;
		}
		if (holds.requested) return;
		holds.requested = true;
		// Content built on demand (a reply's figures once it stops streaming) registers its holds now,
		// not when the next frame paints the block.
		untrack(() => buildTree(block.node));
		runWithOwner(holds.owner, () =>
			effect(() => {
				if (!holds.pending().some(pending => pending())) untrack(() => settleBlock(block));
			}),
		);
	}

	/** Whether `block` has rows in terminal scrollback. */
	retired(block: TranscriptBlock): boolean {
		return this.#host?.retired(block.node) ?? false;
	}

	/** Remove `block`; scrollback is rebuilt when it had rows there. */
	remove(block: TranscriptBlock): void {
		const retired = this.retired(block);
		// A shown block may go while a rebuild is staged (a notice, a displaced card).
		const removed = this.#blocks.remove(block) || (this.staged && this.#shown.remove(block));
		if (removed && retired) this.#host?.replayHistory();
	}

	/**
	 * Remove `block` and every block after it. Scrollback is rebuilt when any
	 * of them had rows there; `replay: false` reports that instead (returns
	 * false) so the caller can choose a full rebuild.
	 */
	truncate(block: TranscriptBlock, options?: { replay?: boolean }): boolean {
		const index = this.#blocks.peek().indexOf(block);
		if (index < 0) return true;
		const retired = this.#blocks
			.peek()
			.slice(index)
			.some(entry => this.retired(entry));
		if (retired && options?.replay === false) return false;
		this.#blocks.truncate(index);
		if (retired) this.#host?.replayHistory();
		return true;
	}

	/**
	 * Run `redraw` over `blocks` (it returns whether the block's display
	 * changed). Live blocks repaint by themselves; changed blocks with rows in
	 * scrollback rebuild it once for the batch.
	 */
	redraw(blocks: Iterable<TranscriptBlock>, redraw: (block: TranscriptBlock) => boolean): void {
		let replay = false;
		for (const block of blocks) if (redraw(block) && this.retired(block)) replay = true;
		if (replay) this.#host?.replayHistory();
	}

	/** Remove every block; `history` also clears terminal scrollback (session switch, `/clear`). */
	clear(options?: { history?: boolean }): void {
		this.abort();
		this.#blocks.clear();
		for (const run of this.#wrappers.values()) run.dispose();
		this.#wrappers.clear();
		if (options?.history) this.#host?.replayHistory();
	}

	/** Blank rows the terminal draws between two non-empty blocks: none inside a compact run or under a self-spaced block. */
	readonly separator = (above: UiNode, below: UiNode): number => {
		// A self-spaced block's own blank row stands in for the separator while it is on screen; once
		// it went into scrollback the next block takes its separator too (the old header's retirement).
		if (this.#byNode.get(above)?.spacedBelow) return this.#host?.retired(above) ? 1 : 0;
		return this.#compact(above) && this.#compact(below) ? 0 : 1;
	};

	/**
	 * The main region as Tern receives it: runs of two or more consecutive
	 * compact blocks wrapped in one gapless `col` (reactive). A wrapper is
	 * reused while its run starts with the same block and settles with its
	 * last member.
	 */
	readonly nativeNodes: Accessor<readonly UiNode[]> = () => {
		const out: UiNode[] = [];
		const runs = new Map<UiNode, CompactRun>();
		let run: TranscriptBlock[] = [];
		const flush = (): void => {
			if (run.length === 1) out.push(...run[0]!.native());
			else if (run.length > 1) out.push(this.#wrap(run, runs));
			run = [];
		};
		for (const block of this.#shown.entries()) {
			if (block.compact()) run.push(block);
			else {
				flush();
				out.push(...block.native());
			}
		}
		flush();
		for (const [first, wrapper] of this.#wrappers) if (runs.get(first) !== wrapper) wrapper.dispose();
		this.#wrappers = runs;
		return out;
	};

	#wrap(run: readonly TranscriptBlock[], runs: Map<UiNode, CompactRun>): UiNode {
		const first = run[0]!.node;
		const members = run.flatMap(block => block.native());
		let wrapper = this.#wrappers.get(first);
		if (wrapper) wrapper.members.set(members);
		else wrapper = compactRun(members);
		if (run.every(block => isSettled(block.node))) settle(wrapper.node);
		runs.set(first, wrapper);
		return wrapper.node;
	}

	/** Route `select`s and actions nothing under `node` handled to the transcript's handlers. */
	#fallback(node: UiNode): void {
		const handlers = node.handlers as UiHandlers;
		handlers.onSelect ??= item => this.onSelect?.(item);
		handlers.onAction ??= act => this.onAction?.(act);
	}

	#compact(node: UiNode): boolean {
		return this.#byNode.get(node)?.compact() ?? false;
	}

	#mount(factory: () => JSXNode, options: BlockOptions | undefined): TranscriptBlock {
		let holds: BlockHolds | undefined;
		const hold = (pending: Accessor<boolean>): void => {
			holds!.pending.update(list => [...list, pending]);
			onCleanup(() => holds!.pending.update(list => list.filter(other => other !== pending)));
		};
		const revise = (): void => {
			for (const node of untrack(native)) this.#host?.redescribe(node);
		};
		const build = (): JSXNode => {
			holds = { owner: getOwner(), pending: signal<readonly Accessor<boolean>[]>([]), requested: false };
			return provide(SettleHolds, hold, () => provide(SettledRevision, revise, factory));
		};
		// A self-spaced block keeps its blank rows; any other has them trimmed (the separator spaces it).
		const entry = options?.spacedBelow
			? mountNode(build, "A transcript block")
			: mountNode(() => <col role="omp.block">{build()}</col>, "A transcript block");
		this.#holds.set(entry.node, holds!);
		const native: Accessor<readonly UiNode[]> = options?.spacedBelow
			? options.inline
				? () => entry.node.children()
				: () => [entry.node]
			: () => entry.node.children();
		// A `select` nothing inside the block took (a link label in Markdown) reaches the transcript,
		// as does an action nothing inside it handled (a task card's agent row). Natively the
		// block's own nodes are the top of the path: they carry the fallbacks too.
		this.#fallback(entry.node);
		const block: TranscriptBlock = {
			...entry,
			compact: options?.compact ?? NOT_COMPACT,
			spacedBelow: options?.spacedBelow === true,
			head: options?.head === true,
			...(options?.prompt ? { prompt: true } : {}),
			native: () => {
				const nodes = native();
				for (const node of nodes) this.#fallback(node);
				return nodes;
			},
		};
		this.#byNode.set(entry.node, block);
		return block;
	}
}

/** Mark `block` final: its node, and the nodes Tern receives for it. */
function settleBlock(block: TranscriptBlock): void {
	settle(block.node);
	// A retired block left the transcript: no native nodes to settle (like `buildTree`, never read
	// a disposed node's children — a list that never resolved before disposal has no value).
	if (block.node.disposed) return;
	for (const node of block.native()) settle(node);
}

/** Resolve every child list under `node` (disposed nodes have none). */
function buildTree(node: UiNode): void {
	if (node.disposed) return;
	for (const child of node.children()) buildTree(child);
}

/** SGR that fills a cell without text: a background color, or inverse video. */
const FILLED_ROW = /\x1b\[(?:[0-9:]*;)*(?:48[;:]|7[;m])/;

/**
 * A row with nothing on it: no text, no fill (the padding rows of a bubble or an inverse notice box
 * are not blank) and no image.
 */
function blankRow(row: string): boolean {
	return stripEscapes(row).trim() === "" && !FILLED_ROW.test(row) && !holdsImage(row);
}

/**
 * A block as the terminal transcript draws it: its blank edge rows dropped (the separator stands
 * between blocks) and bare `text`/`md` set one cell in, like the transcript's prose.
 */
function paintBlock(node: UiNode, cx: PaintContext): Block {
	const child = node.children()[0];
	if (!child) return { rows: [] };
	const bare =
		(child.kind === "text" || child.kind === "md") && (child.props() as { role?: string }).role === undefined;
	const painted = bare
		? (() => {
				const inner = cx.paint(child, Math.max(1, cx.width - 2), cx.height);
				return { ...inner, rows: inner.rows.map(row => ` ${row}`) };
			})()
		: cx.paint(child, cx.width, cx.height);
	const rows = painted.rows;
	let start = 0;
	let end = rows.length;
	while (start < end && blankRow(rows[start]!)) start++;
	while (end > start && blankRow(rows[end - 1]!)) end--;
	if (start === 0 && end === rows.length && !bare) return painted;
	const shift = bare ? 1 : 0;
	return {
		rows: rows.slice(start, end),
		...(painted.cursor ? { cursor: { row: painted.cursor.row - start, col: painted.cursor.col + shift } } : {}),
		...(painted.hits
			? { hits: painted.hits.map(hit => ({ ...hit, row: hit.row - start, col: hit.col + shift })) }
			: {}),
		...(painted.stable !== undefined ? { stable: Math.max(0, painted.stable - start) } : {}),
	};
}

defineRolePainter("col", "omp.block", paintBlock);

/** The native wrapper of a compact run: a gapless column over the run's members. */
interface CompactRun {
	readonly node: UiNode;
	readonly members: Signal<readonly UiNode[]>;
	dispose(): void;
}

function compactRun(initial: readonly UiNode[]): CompactRun {
	const members = signal(initial);
	// Members belong to their blocks; the wrapper only lists them, so it is built outside the
	// region's reactive scope (a recompute must not dispose it).
	const entry = mountNode(
		() => (
			<col role="omp.compact" gap="none">
				{members}
			</col>
		),
		"A compact run",
	);
	return { node: entry.node, members, dispose: entry.dispose };
}
