/**
 * Line-level ownership of a file's uncommitted changes, reconstructed from recorded edit snapshots.
 *
 * The caller describes the file's history as a chain of {@link Step}s from its HEAD content to its
 * worktree content: recorded edits carry the editing agent's id, and the stretches no record
 * explains carry a pseudo-actor ({@link PRE}, {@link GAP}, {@link TAIL}, {@link UNRECORDED}).
 * {@link attribute} replays the chain over a line list that keeps deleted lines as tombstones, so
 * every HEAD line and every worktree line keeps a position in one total order. That order is
 * what lets {@link buildContent} rebuild "HEAD plus only these changes" without patch offsets.
 *
 * {@link classify} then decides, for a set of agents in scope, which change lines are theirs,
 * which belong to someone else, and which need a human (or agent) decision.
 *
 * @example
 * ```ts
 * const edits = [{ actor: "AuthLoader", before: toLines(before), after: toLines(after) }];
 * const attribution = attribute(head, historySteps(head, edits, work), work);
 * const { status } = classify(attribution, new Set(["AuthLoader"]));
 * const committed = fromLines(buildContent(attribution, new Set(attribution.ops.filter(op => status[op.id] === "own").map(op => op.id))));
 * ```
 */
import { diffLineRuns } from "@oh-my-pi/pi-natives";

/** Lines already in the file (relative to HEAD) before its first recorded edit. */
export const PRE = "~pre";
/** Lines changed between two recorded edits by nobody on record (another process, a script, a formatter). */
export const GAP = "~gap";
/** Lines changed after the last recorded edit by nobody on record. */
export const TAIL = "~tail";
/** Lines of a file no record covers at all. */
export const UNRECORDED = "~none";
/** A net change whose ownership the edit replay cannot separate from already committed lines. */
export const REORDERED = "~reordered";
/** Inserter of lines present in HEAD. */
const HEAD = "~head";
/** Largest HEAD-side × worktree-side item product a cancellation window aligns; larger ones stay as replayed. */
const PAIRING_BUDGET = 250_000;

/** True for the pseudo-actors that stand for "no recorded edit explains this". */
export function isPseudoActor(actor: string): boolean {
	return actor.startsWith("~");
}

/** Split file content into lines; `null` (absent file) has no lines, `""` has one empty line. */
export function toLines(text: string | null): string[] {
	return text === null ? [] : text.split("\n");
}

/** Inverse of {@link toLines}. */
export function fromLines(lines: readonly string[]): string | null {
	return lines.length === 0 ? null : lines.join("\n");
}

/** One content transition in a file's history. `before` must equal the previous step's `after`. */
export interface Step {
	/** Agent id, or a pseudo-actor. */
	actor: string;
	before: readonly string[];
	after: readonly string[];
	/** For pseudo-actor steps: agent whose shell/eval call window contains the change. */
	hint?: string;
}

/** A change line of the file's HEAD → worktree difference. */
export interface ChangeOp {
	/** Index into {@link Attribution.ops}. */
	id: number;
	kind: "+" | "-";
	text: string;
	/** Actor that inserted (`+`) or deleted (`-`) the line. */
	by: string;
	/** For `+`: actors whose lines this insertion replaced within its step; empty for pure insertions. */
	over: readonly string[];
	/** Actors whose replacement must be selected to locate this insertion. */
	placementDependencies?: readonly string[];
	/** Index of the step that produced the change. */
	step: number;
	hint?: string;
}

/** A contiguous region of change lines between unchanged HEAD lines. */
export interface Hunk {
	ops: ChangeOp[];
	/** 0-based HEAD line index where the region starts. */
	headStart: number;
	headCount: number;
	/** 0-based worktree line index where the region starts. */
	workStart: number;
	workCount: number;
}

interface Item {
	text: string;
	alive: boolean;
	/** HEAD line index for lines that are (or were) HEAD lines. */
	head?: number;
	/**
	 * Projection onto HEAD. Lines of one replacement share its interval, not arbitrary subintervals.
	 * A later insertion at its edge or inside it records placementDependencies ([] for an exact gap).
	 */
	span?: { start?: number; end?: number; placementDependencies?: readonly string[] };
	by: string;
	over: readonly string[];
	step: number;
	hint?: string;
	deletedBy?: string;
	deletedStep?: number;
	deletedHint?: string;
	/** Op id once ops are derived. */
	op?: number;
}

/** Result of {@link attribute}: ordered change ops plus the line order needed to rebuild content. */
export interface Attribution {
	readonly ops: readonly ChangeOp[];
	readonly hunks: readonly Hunk[];
	readonly items: readonly Item[];
}

/** A changed region between two line lists: `a[i1, i2)` became `b[j1, j2)`. */
export interface Region {
	i1: number;
	i2: number;
	j1: number;
	j2: number;
}

function linesEqual(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((line, index) => line === b[index]);
}

/** One recorded edit of a file, as content snapshots. */
export interface RecordedEdit {
	actor: string;
	before: readonly string[];
	after: readonly string[];
	/** Agent whose shell/eval call explains a change that landed between the previous edit and this one. */
	gapHint?: string;
}

/**
 * Chain a file's recorded edits into contiguous {@link Step}s from `head` to `work`, filling the
 * stretches no record explains with {@link PRE}, {@link GAP}, and {@link TAIL} steps. A file
 * with no edits becomes one {@link UNRECORDED} step. Edits up to the latest recorded snapshot
 * equal to `head` are skipped: HEAD already holds them (they were committed meanwhile).
 */
export function historySteps(
	head: readonly string[],
	edits: readonly RecordedEdit[],
	work: readonly string[],
	tailHint?: string,
): Step[] {
	const steps: Step[] = [];
	let current = head;
	for (let index = firstUncommitted(head, edits); index < edits.length; index++) {
		const edit = edits[index];
		if (!linesEqual(current, edit.before)) {
			steps.push(
				index === 0
					? { actor: PRE, before: current, after: edit.before }
					: { actor: GAP, before: current, after: edit.before, hint: edit.gapHint },
			);
		}
		if (!linesEqual(edit.before, edit.after))
			steps.push({ actor: edit.actor, before: edit.before, after: edit.after });
		current = edit.after;
	}
	if (!linesEqual(current, work)) {
		steps.push({ actor: edits.length === 0 ? UNRECORDED : TAIL, before: current, after: work, hint: tailHint });
	}
	return steps;
}

/** Index of the first edit past the latest recorded snapshot equal to `head`; 0 when none is. */
function firstUncommitted(head: readonly string[], edits: readonly RecordedEdit[]): number {
	for (let index = edits.length - 1; index >= 0; index--) {
		if (linesEqual(edits[index].after, head)) return index + 1;
		if (linesEqual(edits[index].before, head)) return index;
	}
	return 0;
}

/** Changed regions between two line lists, in order (equal runs omitted). */
export function changedRegions(a: readonly string[], b: readonly string[]): Region[] {
	if (a.length === 0 || b.length === 0) {
		return a.length === 0 && b.length === 0 ? [] : [{ i1: 0, i2: a.length, j1: 0, j2: b.length }];
	}
	const regions: Region[] = [];
	let i = 0;
	let j = 0;
	let open: Region | undefined;
	for (const run of diffLineRuns(a.join("\n"), b.join("\n"))) {
		if (!run.added && !run.removed) {
			if (open) regions.push(open);
			open = undefined;
			i += run.count;
			j += run.count;
			continue;
		}
		open ??= { i1: i, i2: i, j1: j, j2: j };
		if (run.removed) {
			i += run.count;
			open.i2 = i;
		} else {
			j += run.count;
			open.j2 = j;
		}
	}
	if (open) regions.push(open);
	return regions;
}

/** Replay a boundary insertion around any HEAD lines already committed there. */
function* replayRegions(
	items: readonly Item[],
	aliveAt: readonly number[],
	headLength: number,
	step: Step,
): Generator<Region & { leftAt: number; rightAt: number }> {
	for (const region of changedRegions(step.before, step.after)) {
		let leftAt = region.i1 === 0 ? -1 : aliveAt[region.i1 - 1];
		const rightAt = region.i2 === aliveAt.length ? items.length : aliveAt[region.i2];
		let next = region.j1;
		const left = items[leftAt];
		const right = items[rightAt];
		if (region.i1 === region.i2 && (left?.span || right?.span)) {
			const start = headEnd(left);
			const end = headStart(right, headLength);
			// Only a forward gap can contain committed lines between these neighbours. A
			// replacement's own tombstones (possibly with identical text) are outside it.
			const deleted: number[] = [];
			if (start !== undefined && end !== undefined && start < end) {
				for (let i = leftAt + 1; i < rightAt; i++) {
					const { head, deletedBy } = items[i];
					if (head !== undefined && head >= start && head < end && (deletedBy === PRE || deletedBy === GAP)) {
						deleted.push(i);
					}
				}
			}
			if (deleted.length && deleted.length * (region.j2 - next) <= PAIRING_BUDGET) {
				const old = deleted.map(i => items[i].text).join("\n");
				const inserted = step.after.slice(next, region.j2).join("\n");
				let i = 0;
				let j = next;
				for (const run of diffLineRuns(old, inserted)) {
					if (run.removed) i += run.count;
					else if (run.added) j += run.count;
					else {
						if (next < j) yield { ...region, j1: next, j2: j, leftAt, rightAt: deleted[i] };
						const stop = i + run.count;
						while (i < stop) items[deleted[i++]].alive = true;
						leftAt = deleted[i - 1];
						j += run.count;
						next = j;
					}
				}
			}
		}
		if (next < region.j2 || region.i1 < region.i2) yield { ...region, j1: next, leftAt, rightAt };
	}
}

function headEnd(left: Item | undefined): number | undefined {
	return !left ? 0 : left.head !== undefined ? left.head + 1 : left.span?.end;
}

function headStart(right: Item | undefined, headLength: number): number | undefined {
	return !right ? headLength : (right.head ?? right.span?.start);
}

/**
 * Replay `steps` over `head` and derive the HEAD → `work` change ops with their actors.
 * @throws when the chain is not contiguous (a step's `before` differs from the running content)
 * or does not end at `work` — both mean the caller assembled the history wrongly.
 */
export function attribute(head: readonly string[], steps: readonly Step[], work: readonly string[]): Attribution {
	let items: Item[] = head.map((text, index) => ({ text, alive: true, head: index, by: HEAD, over: [], step: -1 }));
	steps.forEach((step, stepIndex) => {
		const aliveAt: number[] = [];
		items.forEach((item, index) => {
			if (item.alive) aliveAt.push(index);
		});
		if (aliveAt.length !== step.before.length || aliveAt.some((index, n) => items[index].text !== step.before[n])) {
			throw new Error(`attribution chain broken at step ${stepIndex} (${step.actor})`);
		}
		const insertions: Array<{ at: number; items: Item[] }> = [];
		for (const region of replayRegions(items, aliveAt, head.length, step)) {
			const over = new Set<string>();
			let dependencies: Set<string> | undefined;
			let orderedInsertion = region.i1 < region.i2;
			for (let n = region.i1; n < region.i2; n++) {
				const item = items[aliveAt[n]];
				if (item.span?.placementDependencies) {
					for (const actor of item.span.placementDependencies) (dependencies ??= new Set()).add(actor);
				} else {
					orderedInsertion = false;
				}
				item.alive = false;
				item.deletedBy = step.actor;
				item.deletedStep = stepIndex;
				item.deletedHint = step.hint;
				over.add(item.by);
			}
			if (region.j2 === region.j1) continue;
			let at = region.rightAt;
			let start: number | undefined;
			let end: number | undefined;
			if (region.i1 < region.i2) {
				const first = items[aliveAt[region.i1]];
				const last = items[aliveAt[region.i2 - 1]];
				start = first.head ?? first.span?.start;
				end = last.head !== undefined ? last.head + 1 : last.span?.end;
				at = aliveAt[region.i2 - 1] + 1;
			} else {
				const leftAt = region.leftAt;
				const left = items[leftAt];
				const right = items[at];
				if (left?.span || right?.span) {
					orderedInsertion = true;
					const leftEnd = headEnd(left);
					const rightStart = headStart(right, head.length);
					if (leftEnd !== undefined && leftEnd === rightStart) {
						// The two worktree neighbours meet at this HEAD gap. Keep the insertion on the
						// same side of the old body as it was on the new body.
						start = end = leftEnd;
						for (let i = leftAt + 1; i < at; i++) {
							const headLine = items[i].head;
							if (headLine !== undefined && headLine >= leftEnd) {
								at = i;
								break;
							}
						}
					} else {
						// No single gap in HEAD: selecting the insertion depends on its surrounding edit.
						dependencies = new Set();
						for (const neighbour of [left, right]) {
							if (!neighbour?.span) continue;
							dependencies.add(neighbour.by);
							for (const actor of neighbour.span.placementDependencies ?? []) dependencies.add(actor);
						}
						if (rightStart !== undefined && leftEnd !== undefined) {
							start = Math.min(rightStart, leftEnd);
							end = Math.max(rightStart, leftEnd);
						}
					}
				}
			}
			const actors = [...over];
			const placementDependencies = dependencies ? [...dependencies] : orderedInsertion ? [] : undefined;
			const span =
				placementDependencies || (start !== undefined && end !== undefined)
					? { start, end, placementDependencies }
					: undefined;
			const added = step.after.slice(region.j1, region.j2).map((text): Item => ({
				text,
				alive: true,
				by: step.actor,
				over: actors,
				span,
				step: stepIndex,
				hint: step.hint,
			}));
			insertions.push({ at, items: added });
		}
		// Later regions sit at higher positions; splicing back to front keeps earlier positions valid.
		for (let n = insertions.length - 1; n >= 0; n--) items.splice(insertions[n].at, 0, ...insertions[n].items);
		items = cancelReinsertions(items);
	});
	const alive = items.filter(item => item.alive).map(item => item.text);
	if (!linesEqual(alive, work)) throw new Error("attribution chain does not end at the worktree content");
	const replay = deriveOps(items);
	// After HEAD advances independently, crossing equal lines can strand a deletion and its
	// reinsertion in different hunks. Selecting just one would commit a change neither side made.
	// A replay that keeps each deletion and its equal reinsertion in one hunk is left alone: placing
	// an insertion inside an unselected replacement repeats text by design, and review covers it.
	if (
		steps[0]?.actor !== PRE ||
		replay.ops.length === Math.abs(work.length - head.length) ||
		!strandsTwin(replay.hunks)
	) {
		return replay;
	}
	return reconcileNetHunks(head, work, replay, changedRegions(head, work));
}

/** Whether some line is deleted in one hunk and added back in another. */
function strandsTwin(hunks: readonly Hunk[]): boolean {
	const removed = new Map<string, Set<number>>();
	const added = new Map<string, Set<number>>();
	hunks.forEach((hunk, index) => {
		for (const op of hunk.ops) {
			const byText = op.kind === "-" ? removed : added;
			let at = byText.get(op.text);
			if (!at) byText.set(op.text, (at = new Set()));
			at.add(index);
		}
	});
	for (const [text, from] of removed) {
		const to = added.get(text);
		if (to && [...from].some(a => [...to].some(b => a !== b))) return true;
	}
	return false;
}

/** Keep a replayed hunk only where it spans exactly a net HEAD → worktree hunk and adds no line
 * a disputed hunk deletes (or deletes one it adds); offer every other net hunk whole, for explicit
 * review. Matching op counts or repeated text is not proof of who wrote a line. */
function reconcileNetHunks(
	head: readonly string[],
	work: readonly string[],
	replay: Attribution,
	regions: readonly Region[],
): Attribution {
	const byRange = new Map(replay.hunks.map(hunk => [`${hunk.headStart}:${hunk.workStart}`, hunk]));
	const kept = regions.map(r => {
		const hunk = byRange.get(`${r.i1}:${r.j1}`);
		return hunk && hunk.headCount === r.i2 - r.i1 && hunk.workCount === r.j2 - r.j1 ? hunk : undefined;
	});
	if (regions.length === replay.hunks.length && kept.every(hunk => hunk !== undefined)) return replay;
	// A kept hunk could pair a line with its stranded twin in a disputed hunk: a kept `+A` whose
	// `-A` goes to review, or a kept `-A` whose `+A` does. Such a hunk is disputed too. A line both
	// add (or both delete) is no twin, so shared blank lines and braces leave kept hunks alone.
	// Each pass disputes at least one more hunk, so this runs at most `regions.length` times.
	const disputedRemoved = new Set<string>();
	const disputedAdded = new Set<string>();
	const dispute = (r: Region) => {
		for (let i = r.i1; i < r.i2; i++) disputedRemoved.add(head[i]);
		for (let j = r.j1; j < r.j2; j++) disputedAdded.add(work[j]);
	};
	regions.forEach((r, n) => {
		if (!kept[n]) dispute(r);
	});
	for (let grew = true; grew;) {
		grew = false;
		regions.forEach((r, n) => {
			if (kept[n]?.ops.some(op => (op.kind === "+" ? disputedRemoved : disputedAdded).has(op.text))) {
				kept[n] = undefined;
				dispute(r);
				grew = true;
			}
		});
	}
	const sources = replay.items.filter(item => item.op !== undefined);
	const result: Item[] = [];
	const base = { by: HEAD, over: [], step: -1 };
	let i = 0;
	regions.forEach((r, n) => {
		for (; i < r.i1; i++) result.push({ ...base, text: head[i], head: i, alive: true });
		const hunk = kept[n];
		if (hunk) {
			for (const op of hunk.ops) result.push(sources[op.id]);
			i = r.i2;
			return;
		}
		for (; i < r.i2; i++) result.push({ ...base, text: head[i], head: i, alive: false, deletedBy: REORDERED });
		for (let j = r.j1; j < r.j2; j++) result.push({ ...base, text: work[j], by: REORDERED, alive: true });
	});
	for (; i < head.length; i++) result.push({ ...base, text: head[i], head: i, alive: true });
	return deriveOps(result);
}

/** An unchanged HEAD line: present in HEAD and alive in the current content. */
function isAnchor(item: Item): boolean {
	return item.alive && item.head !== undefined;
}

/**
 * Turn a deleted HEAD line and an identical re-inserted line back into an unchanged HEAD line.
 * Happens when HEAD moved to include content the recorded history deleted and re-added (e.g. part
 * of the work was committed meanwhile, possibly only some of it). Run after every step, so a later
 * step that deletes the line again is recorded as that step's deletion of a HEAD line.
 *
 * A separately recorded insertion at a replacement boundary partitions these windows: identical
 * text beyond that boundary belongs to another edit and must not consume part of the insertion.
 *
 * Pairs are sought within each region between HEAD anchors, and across the anchors between two
 * regions when those may be what keeps a pair apart: the steps' diffs can place the same block at
 * different spots among repeated lines (`return;`, `}`), leaving its deletion before an anchor
 * and its re-insertion after it.
 */
function cancelReinsertions(items: Item[]): Item[] {
	const out: Item[] = [];
	let index = 0;
	while (index < items.length) {
		if (isAnchor(items[index]) || isOrderedInsertion(items[index])) {
			out.push(items[index++]);
			continue;
		}
		const start = index;
		let end = regionEnd(items, start);
		const window = tally(items, start, end);
		while (end < items.length) {
			let next = end;
			while (next < items.length && isAnchor(items[next])) next++;
			if (next === items.length || isOrderedInsertion(items[next])) break;
			const nextEnd = regionEnd(items, next);
			const region = tally(items, next, nextEnd);
			// Pairing across the anchors shifts their first onto a line before it and their last onto
			// one after them; without such lines every anchor keeps pairing with itself.
			if (!window.texts.has(items[end].text) || !region.texts.has(items[next - 1].text)) break;
			const anchors = next - end;
			const headCount = window.head + anchors + region.head;
			const workCount = window.work + anchors + region.work;
			if (headCount * workCount > PAIRING_BUDGET) break;
			window.head = headCount;
			window.work = workCount;
			for (let n = end; n < next; n++) window.texts.add(items[n].text);
			for (const text of region.texts) window.texts.add(text);
			end = nextEnd;
		}
		settleWindow(items, start, end, out);
		index = end;
	}
	return out;
}

/** A separately recorded insertion is not a restoration of identical text across its boundary. */
function isOrderedInsertion(item: Item): boolean {
	return item.alive && item.span?.placementDependencies !== undefined;
}

/** End of the run before the next HEAD anchor or separately positioned insertion. */
function regionEnd(items: readonly Item[], start: number): number {
	let end = start;
	while (end < items.length && !isAnchor(items[end]) && !isOrderedInsertion(items[end])) end++;
	return end;
}

/** HEAD-side and worktree-side item counts of `items[start, end)`, and the texts of those items. */
function tally(items: readonly Item[], start: number, end: number): { head: number; work: number; texts: Set<string> } {
	const counts = { head: 0, work: 0, texts: new Set<string>() };
	for (let index = start; index < end; index++) {
		const item = items[index];
		if (item.head !== undefined) counts.head++;
		if (item.alive) counts.work++;
		if (item.head !== undefined || item.alive) counts.texts.add(item.text);
	}
	return counts;
}

/**
 * Append `items[start, end)` to `out` with each deleted HEAD line paired to an identical
 * re-inserted line restored as one HEAD anchor. Anchors inside the window stay anchors but may
 * take over an equal HEAD line next to them, letting the pairs they separated meet. Every other
 * item moves between the restored anchors it falls between on its own side (HEAD order for
 * deleted HEAD lines, worktree order for the rest), so an unpaired deletion keeps its HEAD
 * position and a later step re-adding that line lands in the same region.
 */
function settleWindow(items: readonly Item[], start: number, end: number, out: Item[]): void {
	const headSide: Item[] = [];
	const workSide: Item[] = [];
	let deleted = false;
	let inserted = false;
	for (let index = start; index < end; index++) {
		const item = items[index];
		if (item.head !== undefined) {
			headSide.push(item);
			deleted ||= !item.alive;
		}
		if (item.alive) {
			workSide.push(item);
			inserted ||= item.head === undefined;
		}
	}
	const pairs =
		deleted && inserted && headSide.length * workSide.length <= PAIRING_BUDGET ? alignSides(headSide, workSide) : [];
	if (pairs.length === 0) {
		for (let index = start; index < end; index++) out.push(items[index]);
		return;
	}
	// segments[n] holds the unpaired items before restored anchor n; paired deletions are dropped.
	// Anchors always pair on both sides (see alignSides), so they leave only through their worktree side.
	const segments: Item[][] = Array.from({ length: pairs.length + 1 }, () => []);
	let headAt = 0;
	let workAt = 0;
	for (let index = start; index < end; index++) {
		const item = items[index];
		if (item.head !== undefined) {
			if (pairs[headAt]?.[0] === item) headAt++;
			else segments[headAt].push(item);
		}
		if (item.alive) {
			if (pairs[workAt]?.[1] === item) workAt++;
			else if (item.head === undefined) segments[workAt].push(item);
		} else if (item.head === undefined) segments[workAt].push(item);
	}
	// An anchor can be the HEAD side of one pair and the worktree side of an earlier one.
	const heads = pairs.map(([del]) => del.head);
	pairs.forEach(([, add], n) => {
		for (const item of segments[n]) out.push(item);
		// The line is HEAD's now: editing it later must not count as building on its old inserter's work.
		add.head = heads[n];
		add.span = undefined;
		add.by = HEAD;
		out.push(add);
	});
	for (const item of segments[pairs.length]) out.push(item);
}

/**
 * Order-preserving pairs of equal-text HEAD-side and worktree-side items that cancel the most
 * changes while every anchor stays paired on both sides, with itself or an equal neighbour.
 * Weighting each anchor side above any count of cancellations makes keeping them all paired
 * (always possible: each anchor with itself) take precedence.
 */
function alignSides(head: readonly Item[], work: readonly Item[]): Array<[Item, Item]> {
	const anchorWeight = Math.min(head.length, work.length) + 1;
	const weight = (a: Item, b: Item) => 1 + (a.alive ? anchorWeight : 0) + (b.head !== undefined ? anchorWeight : 0);
	const table = Array.from({ length: head.length + 1 }, () => new Int32Array(work.length + 1));
	for (let i = head.length - 1; i >= 0; i--) {
		for (let j = work.length - 1; j >= 0; j--) {
			const skip = Math.max(table[i + 1][j], table[i][j + 1]);
			table[i][j] =
				head[i].text === work[j].text ? Math.max(skip, table[i + 1][j + 1] + weight(head[i], work[j])) : skip;
		}
	}
	const pairs: Array<[Item, Item]> = [];
	let i = 0;
	let j = 0;
	while (i < head.length && j < work.length) {
		if (head[i].text === work[j].text && table[i][j] === table[i + 1][j + 1] + weight(head[i], work[j])) {
			pairs.push([head[i], work[j]]);
			i++;
			j++;
		} else if (table[i + 1][j] >= table[i][j + 1]) i++;
		else j++;
	}
	return pairs;
}

function deriveOps(items: Item[]): Attribution {
	const ops: ChangeOp[] = [];
	const hunks: Hunk[] = [];
	let headLine = 0;
	let workLine = 0;
	let hunk: Hunk | undefined;
	for (const item of items) {
		const anchor = isAnchor(item);
		const deletedHead = !item.alive && item.head !== undefined;
		const inserted = item.alive && item.head === undefined;
		if (anchor) {
			hunk = undefined;
			headLine++;
			workLine++;
			continue;
		}
		if (!deletedHead && !inserted) continue;
		if (!hunk) {
			hunk = { ops: [], headStart: headLine, headCount: 0, workStart: workLine, workCount: 0 };
			hunks.push(hunk);
		}
		const op: ChangeOp = deletedHead
			? {
					id: ops.length,
					kind: "-",
					text: item.text,
					by: item.deletedBy ?? UNRECORDED,
					over: [],
					step: item.deletedStep ?? -1,
					hint: item.deletedHint,
				}
			: {
					id: ops.length,
					kind: "+",
					text: item.text,
					by: item.by,
					over: item.over,
					placementDependencies: item.span?.placementDependencies,
					step: item.step,
					hint: item.hint,
				};
		item.op = op.id;
		ops.push(op);
		hunk.ops.push(op);
		if (deletedHead) {
			headLine++;
			hunk.headCount++;
		} else {
			workLine++;
			hunk.workCount++;
		}
	}
	return { ops, hunks, items };
}

/** Lines of HEAD with only the `selected` change ops applied, in recorded line order. */
export function buildContent(attribution: Attribution, selected: ReadonlySet<number>): string[] {
	const lines: string[] = [];
	for (const item of attribution.items) {
		if (item.op === undefined) {
			if (item.alive && item.head !== undefined) lines.push(item.text);
			continue;
		}
		const isSelected = selected.has(item.op);
		// A deleted HEAD line stays unless its deletion is selected; an added line appears only when selected.
		if (item.alive ? isSelected : !isSelected) lines.push(item.text);
	}
	return lines;
}

/** Ownership verdict for one change op relative to a scope. */
export type OpStatus = "own" | "other" | "review";

/** Why an op is not plainly own/other; drives the review explanation shown to the agent. */
export type ReviewReason =
	| { kind: "reordered" }
	/** An in-scope agent edited lines that out-of-scope actors added and never committed. */
	| { kind: "entangled"; with: readonly string[] }
	/** The insertion is inside a replacement with no corresponding gap in HEAD. */
	| { kind: "placement"; with: readonly string[] }
	/** An out-of-scope actor rewrote lines that in-scope agents wrote. */
	| { kind: "rewritten"; by: string }
	/** Shares a hunk with an op that needs review, so selecting it alone could split one change. */
	| { kind: "hunk" };

/** Per-op verdicts of {@link classify}. */
export interface Classification {
	status: OpStatus[];
	/** Set for every op whose status is `review`. */
	reasons: Map<number, ReviewReason>;
	/** Ops counted as own only because a scope agent's shell/eval call window explains them. */
	likely: Set<number>;
}

/**
 * Decide which change ops belong to the agents in `scope`.
 *
 * - Own: inserted or deleted by a scope agent, or by an unrecorded change that rewrote scope lines
 *   while a scope agent's shell/eval call was running (formatters, codegen).
 * - Review: a scope agent rewrote or inserted inside uncommitted work outside the scope, or
 *   someone outside the scope rewrote scope lines. Any review op puts its whole hunk in review.
 * - Other: everything else.
 */
export function classify(attribution: Attribution, scope: ReadonlySet<string>): Classification {
	const status: OpStatus[] = attribution.ops.map(() => "other");
	const reasons = new Map<number, ReviewReason>();
	const likely = new Set<number>();
	const inScope = (actor: string) => scope.has(actor);
	for (const hunk of attribution.hunks) {
		// Unrecorded steps in this hunk that rewrote scope lines inside a scope agent's call window.
		const likelySteps = new Set<number>();
		for (const op of hunk.ops) {
			if (
				op.kind === "+" &&
				isPseudoActor(op.by) &&
				op.hint !== undefined &&
				inScope(op.hint) &&
				op.over.some(inScope)
			) {
				likelySteps.add(op.step);
			}
		}
		let review = false;
		for (const op of hunk.ops) {
			if (op.by === REORDERED) {
				status[op.id] = "review";
				reasons.set(op.id, { kind: "reordered" });
				review = true;
				continue;
			}
			const inferred = likelySteps.has(op.step) && isPseudoActor(op.by);
			if ((inScope(op.by) || inferred) && op.placementDependencies?.length) {
				const missing = op.placementDependencies.filter(actor => !inScope(actor));
				if (missing.length > 0) {
					status[op.id] = "review";
					reasons.set(op.id, { kind: "placement", with: missing });
					review = true;
					continue;
				}
			}
			if (inferred) {
				status[op.id] = "own";
				likely.add(op.id);
				continue;
			}
			if (inScope(op.by)) {
				const foreign = op.over.filter(actor => actor !== HEAD && !inScope(actor));
				if (foreign.length > 0) {
					status[op.id] = "review";
					reasons.set(op.id, { kind: "entangled", with: [...new Set(foreign)] });
					review = true;
				} else {
					status[op.id] = "own";
				}
				continue;
			}
			if (op.kind === "+" && op.over.some(inScope)) {
				status[op.id] = "review";
				reasons.set(op.id, { kind: "rewritten", by: op.by });
				review = true;
			}
		}
		if (!review) continue;
		for (const op of hunk.ops) {
			if (status[op.id] === "review") continue;
			status[op.id] = "review";
			reasons.set(op.id, { kind: "hunk" });
			likely.delete(op.id);
		}
	}
	return { status, reasons, likely };
}
