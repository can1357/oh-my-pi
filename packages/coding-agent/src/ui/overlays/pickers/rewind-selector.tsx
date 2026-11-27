/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Rewind (`/rewind`): pick the turn of the current branch to continue from.
 *
 * Every user prompt and assistant reply of the branch is a rewind point; the
 * outline rests on one (↑/↓ step, ←/→ jump between user turns, ⏎ rewinds).
 * A turn with sibling branches lets ←/→ move into those branches' columns
 * (↑ off a column's top returns to the current path above the fork).
 * `f` opens a word filter (whole Latin words, substrings in other scripts);
 * stepping then visits only matching turns.
 *
 * A long branch starts on its tail: `a`, a filter query, or stepping above
 * the oldest turn held loads the rest.
 *
 * The node is the bar (`omp.rewind.bar`): the counter, the filter field, the
 * key hints and the Cancel / Rewind buttons. A terminal fills the screen
 * with the branch above it, drawn by the transcript's own blocks (prompt
 * bubbles, replies, tool cards; ^O expands them) with the outlined turn boxed.
 *
 * In Tern the screen is a page (`replica` given): the turns are the session's
 * own blocks, standing before the bar as the page's `main`. The outlined
 * turn's blocks carry the `pick` mark under a caption saying what ⏎ does and
 * drops, the blocks a rewind would drop carry `drop`, and a click on a turn
 * outlines it. At a fork the rest of the branch and each sibling branch stand
 * side by side in a strip.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	type Accessor,
	batch,
	computed,
	derivedNode,
	effect,
	getOwner,
	type JSXNode,
	type KeyEvent,
	onCleanup,
	resolveChildren,
	runWithOwner,
	signal,
	type UiNode,
	untrack,
} from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { TspMark, TspSpan } from "@oh-my-pi/pi-wire";
import type { TranscriptReplica } from "../../../modes/interactive/transcript-replica";
import type { BranchVariantPath } from "../../../modes/view-model/overlays/rewind-selector";
import {
	isUserTurnEntry,
	recentTranscriptEntries,
	type SessionMessageEntryLike,
	type TranscriptEntryLike,
	userTurnLabel,
} from "../../../session/transcript/transcript-entry";
import "../../styles/pickers/rewind";
import type { RewindLookTerm } from "../../styles/pickers/rewind";
import type { LaneItem } from "../../styles/pickers/transcript-view";
import { editLine, type LineState } from "../settings/line-edit";
import type { Keybinding } from "../../../config/keybindings/app-keybindings";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import {
	appToolsExpandKeys,
	matchesAnyKey,
	matchesSelectCancel,
	selectKeyId,
} from "../../../config/keybindings/matchers";
import { actionKbd, kbdOf } from "../../keys/hints";
import { showsAnything, type TranscriptBlock } from "../../shell";
import { applyEdit } from "../panels/common";
import { keyTitle } from "../../styles/panels/common";
import { turnSearchText } from "./copy-selector";
import { TurnViews } from "./transcript-turns";
import { ActionButton } from "../panels/common";

export interface RewindSelectorProps {
	readonly entries: readonly TranscriptEntryLike[];
	/** Alternate branches diverging at a turn (by the id of the entry that opened it). */
	siblingPaths?(turnId: string): readonly BranchVariantPath[];
	/** Entry the outline starts on (a turn's "Rewind to here…"); default: the latest turn. */
	readonly startAt?: string;
	/** Screen rows, for a terminal layer that allots the screen no height. */
	readonly terminalRows?: Accessor<number>;
	/**
	 * Replays entries as the session's own blocks. Given, the screen is Tern's rewind page (see
	 * the module docs) and yields the turns' nodes before the bar; absent, the terminal look
	 * draws the turns. `clipped`: the entries are a later part of the session (the branch's tail,
	 * a sibling branch below its fork), so the run they open in may have started above them.
	 */
	replica?(entries: readonly TranscriptEntryLike[], clipped: boolean): TranscriptReplica;
	onSelect(entryId: string): void;
	onCancel(): void;
}

/** A rewind point: a user prompt or an assistant reply (with its tool results). */
export interface RewindTarget {
	readonly entryId: string;
	/** The entry that opened the turn: sibling branches diverge there. */
	readonly turnId: string;
	readonly isUserTurn: boolean;
	/** The turn's text, as the filter searches it. */
	readonly text: string;
	/** What the turn draws: its prompt, or its reply and the reply's tool results. */
	readonly messages: readonly AgentMessage[];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object" || !("type" in block)) continue;
		if (block.type === "text" && "text" in block && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "toolCall" && "name" in block && "arguments" in block)
			parts.push(`${String(block.name)} ${Object.values(block.arguments as object).join(" ")}`);
	}
	return parts.join("\n");
}

/** An entry that is a rewind point of its own: a prompt or a reply (a tool result joins the reply before it). */
type RewindPointEntry = SessionMessageEntryLike & {
	readonly message: Extract<AgentMessage, { role: "user" | "assistant" }>;
};

function isRewindPoint(entry: TranscriptEntryLike): entry is RewindPointEntry {
	return entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant");
}

/** Whether `entries` hold a rewind point, without building the targets (a long branch has thousands). */
export function hasRewindPoint(entries: readonly TranscriptEntryLike[]): boolean {
	return entries.some(isRewindPoint);
}

/** The rewind points of `entries`: one per user prompt and per assistant reply (tool results join the reply, which rewinds onto its last result). */
function rewindTargets(entries: readonly TranscriptEntryLike[]): RewindTarget[] {
	const targets: RewindTarget[] = [];
	for (const entry of entries) {
		if (isRewindPoint(entry)) {
			const message = entry.message;
			targets.push({
				entryId: entry.id,
				turnId: entry.id,
				isUserTurn: message.role === "user",
				text: textOf(message.content),
				messages: [message],
			});
		} else if (entry.type === "message" && entry.message.role === "toolResult" && targets.length > 0) {
			// The reply's rewind point moves onto its trailing result: rewinding keeps the tool output.
			const message = entry.message;
			const last = targets.pop()!;
			targets.push({
				...last,
				entryId: entry.id,
				text: `${last.text}\n${textOf(message.content)}`,
				messages: [...last.messages, message],
			});
		}
	}
	return targets;
}

/**
 * The entries the terminal look opens on: the branch's recent tail, reaching back to the newest
 * prompt or reply when the tail holds none (a long run of `!` commands), so it opens on a point
 * to rewind to. The look draws only prompts and replies: the entries it reaches over draw nothing.
 */
function termTail(entries: readonly TranscriptEntryLike[]): readonly TranscriptEntryLike[] {
	const tail = recentTranscriptEntries(entries);
	if (tail.some(isRewindPoint)) return tail;
	const newest = entries.findLastIndex(isRewindPoint);
	return newest < 0 ? tail : entries.slice(newest);
}

/** Word patterns of a filter query, matched against lowercased text: whole Latin words, substrings otherwise. */
function filterPatterns(query: string): RegExp[] {
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.map(word => {
			const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return /^[\p{Script=Latin}\p{N}_]+$/u.test(word)
				? new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "u")
				: new RegExp(escaped, "u");
		});
}

type LaneTurn = Pick<RewindTarget, "entryId" | "turnId" | "isUserTurn">;

/** One column of rewind points: the current path or a sibling branch. */
interface TurnLane {
	readonly turns: readonly LaneTurn[];
	/** The turns as the terminal look draws them. */
	readonly targets?: readonly RewindTarget[];
	/** The turns as a page's blocks (Tern). */
	readonly replica?: TranscriptReplica;
	/** Whether turn `index` shows anything (reactive); one that does not is stepped over. */
	shows(index: number): boolean;
	/** Lowercased text of turn `index`, as the filter searches it. */
	text(index: number): string;
	/** Whether turn `index` spans entry `entryId`. */
	holds(index: number, entryId: string): boolean;
}

/** The terminal look's lane: a turn whose blocks draw nothing (the empty reply an interrupt leaves) is stepped over. */
function termLane(targets: readonly RewindTarget[], views: TurnViews): TurnLane {
	const texts = targets.map(target => target.text.toLowerCase());
	return {
		turns: targets,
		targets,
		shows: index => {
			const target = targets[index];
			return target !== undefined && views.blocks(target.entryId, target.messages).some(showsAnything);
		},
		text: index => texts[index] ?? "",
		holds: (index, entryId) => targets[index]?.entryId === entryId || targets[index]?.turnId === entryId,
	};
}

function pageLane(replica: TranscriptReplica): TurnLane {
	const turns = replica.turns;
	const texts: (string | undefined)[] = [];
	return {
		turns,
		replica,
		shows: index => {
			const turn = turns[index];
			return turn !== undefined && replica.visible(turn);
		},
		text: index => {
			const turn = turns[index];
			return turn ? (texts[index] ??= turnSearchText(turn.entries)) : "";
		},
		holds: (index, entryId) => turns[index]?.entries.some(entry => entry.id === entryId) === true,
	};
}

/** A sibling branch at a fork. */
interface BranchColumn {
	readonly rootId: string;
	/** What the column's head names the branch by. */
	readonly label: string;
	readonly lane: TurnLane;
}

const NO_COLUMNS: readonly BranchColumn[] = [];

/** `selected`, or the nearest turn that shows (above first) when it shows nothing. */
function nearestShown(lane: TurnLane, selected: number): number {
	const count = lane.turns.length;
	if (selected < 0 || selected >= count) return lane.turns.findIndex((_, index) => lane.shows(index));
	if (lane.shows(selected)) return selected;
	for (let above = selected - 1; above >= 0; above--) if (lane.shows(above)) return above;
	for (let below = selected + 1; below < count; below++) if (lane.shows(below)) return below;
	return selected;
}

/** The click action that outlines a block's turn on the page. */
const PICK = "rewind-pick";

/** Where a page block stands: its mark, and the turn a click on it outlines (`turn` -1: none). */
interface BlockPlace {
	readonly mark?: TspMark;
	/** `main`, or a sibling column's root id. */
	readonly column: string;
	readonly turn: number;
}

/** One branch column of the page's strip. */
interface StripColumn {
	readonly key: string;
	readonly active: boolean;
	readonly head: readonly TspSpan[];
	readonly nodes: readonly UiNode[];
}

/** The page: the nodes before the bar, the strip's columns, and where every block stands. */
interface PageLayout {
	readonly nodes: readonly UiNode[];
	readonly strip: readonly StripColumn[];
	readonly places: ReadonlyMap<UiNode, BlockPlace>;
}

const NO_STRIP: readonly StripColumn[] = [];

/** Which turn of `replica` each of its blocks draws. */
function turnIndex(replica: TranscriptReplica): Map<TranscriptBlock, number> {
	const turnOf = new Map<TranscriptBlock, number>();
	replica.turns.forEach((turn, index) => {
		for (const block of turn.blocks) turnOf.set(block, index);
	});
	return turnOf;
}

const kMarked = Symbol("omp.rewind.marked");

/** A replayed block's node tagged with its marked view, so stepping reuses one view per block. */
interface MarkTagged extends UiNode {
	[kMarked]?: UiNode;
}

export function RewindSelector(props: RewindSelectorProps): JSXNode {
	const owner = getOwner();
	/** Build what outlives the reactive region asking for it: it belongs to the screen. */
	const keep = <T,>(build: () => T): T => runWithOwner(owner, () => untrack(build));
	const replay = props.replica;
	const replicas = new Set<TranscriptReplica>();
	/** ^O: tool output and thinking expanded, in every replica (those replayed later too). */
	let expanded = false;
	onCleanup(() => {
		for (const replica of replicas) replica.dispose();
	});
	const views = new TurnViews();
	const laneOf = (entries: readonly TranscriptEntryLike[], clipped: boolean): TurnLane => {
		if (!replay) return termLane(rewindTargets(entries), views);
		const replica = keep(() => replay(entries, clipped));
		replica.expanded.set(expanded);
		replicas.add(replica);
		return pageLane(replica);
	};

	// The page and the terminal look both start on the branch's tail: each turn they hold costs at
	// open, however far above the screen it stands.
	const tail = replay ? recentTranscriptEntries(props.entries) : termTail(props.entries);
	/** Older history is not replayed yet. */
	const truncated = signal(tail.length < props.entries.length);
	const main = signal(laneOf(tail, truncated.peek()));
	const selected = signal(Math.max(0, main.peek().turns.length - 1));
	/** 0: the current path; n: the n-th sibling branch of the selected turn. */
	const variant = signal(0);
	const siblingSelected = signal(0);
	const filter = signal<LineState | undefined>(undefined);
	/** The filter field is up: one field for the whole query, whatever is typed into it. */
	const filtering = computed(() => filter() !== undefined);

	/** Replay the whole branch, keeping the outline on the same turn. */
	const loadFull = (): void => {
		if (!truncated.peek()) return;
		const previous = main.peek();
		const turnId = previous.turns[selected.peek()]?.turnId;
		const next = laneOf(props.entries, false);
		const restored = turnId === undefined ? -1 : next.turns.findIndex(turn => turn.turnId === turnId);
		batch(() => {
			main.set(next);
			truncated.set(false);
			selected.set(restored >= 0 ? restored : Math.max(0, next.turns.length - 1));
		});
		if (previous.replica) {
			replicas.delete(previous.replica);
			previous.replica.dispose();
		}
	};
	if (props.startAt !== undefined) {
		const startAt = props.startAt;
		const find = (): number => {
			const lane = main.peek();
			return lane.turns.findIndex((_, index) => lane.holds(index, startAt));
		};
		let index = find();
		if (index < 0 && truncated.peek()) {
			loadFull();
			index = find();
		}
		if (index >= 0) selected.set(index);
	}

	/** Sibling columns per fork, built once: a column's replica keeps its blocks while the outline moves. */
	const forks = new Map<string, readonly BranchColumn[]>();
	const columns = computed((): readonly BranchColumn[] => {
		const turn = main().turns[selected()];
		const siblingPaths = props.siblingPaths;
		if (!turn || !siblingPaths) return NO_COLUMNS;
		let found = forks.get(turn.turnId);
		if (!found) {
			found = untrack(() => siblingPaths(turn.turnId))
				.filter(path => path.entries.length > 0)
				.map(path => {
					// A sibling branch below a fork leaves the turns above it out.
					const lane = laneOf(path.entries, path.entries[0]!.parentId !== null);
					const firstUser = path.entries.find(isUserTurnEntry);
					const label = replay
						? (firstUser && userTurnLabel(firstUser)) || path.rootId
						: (lane.targets?.[0]?.text.split("\n")[0] ?? "");
					return { rootId: path.rootId, label, lane };
				});
			forks.set(turn.turnId, found);
		}
		return found;
	});
	/** The turns of the current path the filter shows; every one that shows anything without a query. */
	const matches = computed((): readonly number[] => {
		const lane = main();
		const patterns = filterPatterns(filter()?.text ?? "");
		const shown: number[] = [];
		for (let index = 0; index < lane.turns.length; index++) {
			if (lane.shows(index) && patterns.every(pattern => pattern.test(lane.text(index)))) shown.push(index);
		}
		return shown;
	});
	const outlined = (): LaneTurn | undefined =>
		variant() > 0 ? columns()[variant() - 1]?.lane.turns[siblingSelected()] : main().turns[selected()];

	const toMain = (index: number): void =>
		batch(() => {
			selected.set(index);
			variant.set(0);
			siblingSelected.set(0);
		});
	// An outline on a turn that shows nothing (the empty turn an interrupt leaves last, one the
	// expansion toggle folded away) moves to the nearest that shows and leaves the strip.
	effect(() => {
		const at = selected();
		const next = nearestShown(main(), at);
		if (next !== at && next >= 0) untrack(() => toMain(next));
	});

	/** Step the current path by `delta` to the nearest shown turn `accept` takes; above the replayed tail, load the rest first. */
	const move = (delta: -1 | 1, accept: (turn: LaneTurn) => boolean): void => {
		const lane = main();
		for (let at = selected() + delta; at >= 0 && at < lane.turns.length; at += delta) {
			if (lane.shows(at) && accept(lane.turns[at]!)) {
				toMain(at);
				return;
			}
		}
		if (delta < 0 && truncated()) {
			loadFull();
			move(delta, accept);
		}
	};
	const isUserTurn = (turn: LaneTurn): boolean => turn.isUserTurn;
	const anyTurn = (): boolean => true;
	const moveVertical = (delta: -1 | 1): void => {
		if (variant() === 0) {
			move(delta, anyTurn);
			return;
		}
		const lane = columns()[variant() - 1]?.lane;
		const count = lane?.turns.length ?? 0;
		let at = siblingSelected() + delta;
		while (lane && at >= 0 && at < count && !lane.shows(at)) at += delta;
		if (at >= 0 && at < count) siblingSelected.set(at);
		else if (delta === -1) {
			// Off the top of a sibling branch: back to the current path above the fork.
			batch(() => {
				variant.set(0);
				siblingSelected.set(0);
			});
			move(-1, anyTurn);
		}
	};
	const stepFiltered = (delta: -1 | 1, userTurnsOnly: boolean): void => {
		const turns = main().turns;
		const shown = matches().filter(index => !userTurnsOnly || turns[index]!.isUserTurn);
		const next = delta < 0 ? shown.findLast(index => index < selected()) : shown.find(index => index > selected());
		if (next !== undefined) selected.set(next);
		else if (delta < 0 && truncated()) {
			// An open filter without a query still steps above the replayed tail.
			loadFull();
			stepFiltered(delta, userTurnsOnly);
		}
	};
	const rewind = (): void => {
		const target = filter() ? (matches().includes(selected()) ? main().turns[selected()] : undefined) : outlined();
		if (target) props.onSelect(target.entryId);
	};
	const openFilter = (): void =>
		batch(() => {
			filter.set({ text: "", cursor: 0 });
			variant.set(0);
			siblingSelected.set(0);
		});
	/** A typed query: an outline the query no longer matches rests on the newest match above it. */
	const setFilter = (line: LineState): void => {
		// A query searches the whole branch, not just the replayed tail.
		if (line.text.trim()) loadFull();
		batch(() => {
			const changed = line.text !== filter()?.text;
			filter.set(line);
			if (!changed) return;
			const shown = matches();
			if (!shown.includes(selected()))
				selected.set(shown.findLast(index => index < selected()) ?? shown.at(-1) ?? selected());
		});
	};
	const toggleExpanded = (): void => {
		views.toggleExpanded();
		expanded = !expanded;
		for (const replica of replicas) replica.expanded.set(expanded);
	};
	/** A click on a turn of the page: the outline moves there, as stepping would. */
	const pick = (place: BlockPlace): void => {
		if (place.turn < 0) return;
		if (place.column === "main") {
			if (variant() !== 0 || selected() !== place.turn) toMain(place.turn);
			return;
		}
		const at = columns().findIndex(column => column.rootId === place.column) + 1;
		if (at === 0) return;
		batch(() => {
			variant.set(at);
			siblingSelected.set(place.turn);
		});
	};

	const onKey = (key: KeyEvent): boolean => {
		if (key.kind === "release") return false;
		const line = filter();
		const cancel = matchesSelectCancel(key);
		const id = selectKeyId(key);
		if (line) {
			if (cancel) {
				filter.set(undefined);
				return true;
			}
			if (matchesAnyKey(key, appToolsExpandKeys())) {
				toggleExpanded();
				return true;
			}
			switch (id) {
				case "enter":
					rewind();
					return true;
				case "up":
				case "left":
					stepFiltered(-1, id === "left");
					return true;
				case "down":
				case "right":
					stepFiltered(1, id === "right");
					return true;
				case "backspace":
					if (line.text.length === 0) {
						filter.set(undefined);
						return true;
					}
			}
			const next = editLine(line, key);
			if (next) setFilter(next);
			return true;
		}
		if (cancel) {
			props.onCancel();
			return true;
		}
		if (matchesAnyKey(key, appToolsExpandKeys())) {
			toggleExpanded();
			return true;
		}
		switch (id) {
			case "f":
				openFilter();
				return true;
			case "up":
				moveVertical(-1);
				return true;
			case "down":
				moveVertical(1);
				return true;
			case "left":
				if (variant() > 0) variant.set(variant() - 1);
				else move(-1, isUserTurn);
				return true;
			case "right":
				if (variant() < columns().length) {
					batch(() => {
						siblingSelected.set(0);
						variant.set(variant() + 1);
					});
				} else if (variant() === 0) move(1, isUserTurn);
				return true;
			case "a":
			case "shift+a":
				loadFull();
				return true;
			case "enter":
				rewind();
				return true;
		}
		return false;
	};

	const counter = (): { t: string; s: string } => {
		if (filter()) {
			const shown = matches();
			if (shown.length === 0) return { t: "no matches", s: "error" };
			const at = shown.indexOf(selected());
			return { t: `${at >= 0 ? at + 1 : "-"}/${shown.length}`, s: "dim" };
		}
		const column = columns()[variant() - 1];
		if (column) return { t: `${siblingSelected() + 1}/${column.lane.turns.length}`, s: "dim" };
		return { t: `${selected() + 1}/${main().turns.length}`, s: "dim" };
	};
	const term = (): RewindLookTerm => {
		const line = filter();
		const targets = main().targets ?? [];
		const turnAt = (index: number): LaneItem => ({
			blocks: views.blocks(targets[index]!.entryId, targets[index]!.messages),
			outlined: variant() === 0 && index === selected(),
		});
		const base = {
			// The terminal counts the turns of the current path, also while a branch column is outlined.
			counter: line ? counter() : { t: `${selected() + 1}/${targets.length}`, s: "dim" },
			filter: line,
			sideLabel: !line && columns().length > 0 ? "branches" : "user turns",
			truncated: truncated(),
			rows: props.terminalRows?.(),
		};
		if (line) {
			const shown = matches();
			if (shown.length === 0)
				return { ...base, turns: [], columns: [], empty: `No items match "${line.text.trim()}"` };
			return { ...base, turns: shown.map(turnAt), columns: [] };
		}
		const siblings = columns();
		if (siblings.length === 0) return { ...base, turns: targets.map((_, index) => turnAt(index)), columns: [] };
		// The outlined turn forks: the rest of the branch beside each sibling branch.
		const at = selected();
		return {
			...base,
			turns: targets.slice(0, at).map((_, index) => turnAt(index)),
			columns: [
				{
					label: "current",
					active: variant() === 0,
					turns: targets.slice(at).map((_, index) => turnAt(at + index)),
				},
				...siblings.map((column, index) => ({
					label: column.label,
					active: variant() === index + 1,
					turns: (column.lane.targets ?? []).map((target, row) => ({
						blocks: views.blocks(target.entryId, target.messages),
						outlined: variant() === index + 1 && row === siblingSelected(),
					})),
				})),
			],
		};
	};

	// ─── The page (Tern): the turns as nodes before the bar ────────────────────

	/** The node `view` builds, owned by the screen. */
	const one = (view: () => JSXNode): UiNode => keep(() => resolveChildren(view())()[0]!);
	/** `source` (a replayed block's node) as the page shows it: marked where it stands, a click on it outlining its turn. */
	const markedNode = (source: MarkTagged): UiNode =>
		(source[kMarked] ??= keep(() =>
			derivedNode(
				source,
				props => {
					const place = layout().places.get(source);
					if (!place) return props;
					const actions = props.actions;
					// A block whose own click does something keeps it; a click anywhere else in a turn outlines it.
					const pickable = place.turn >= 0 && actions?.click === undefined;
					if (!place.mark && !pickable) return props;
					return {
						...props,
						...(place.mark ? { mark: place.mark } : {}),
						...(pickable ? { actions: { ...actions, click: PICK } } : {}),
					} as typeof props;
				},
				{
					...source.handlers,
					onAction: (act, event) => {
						const place = act === PICK ? layout().places.get(source) : undefined;
						if (place) pick(place);
						else source.handlers.onAction?.(act, event);
					},
				},
			),
		));
	/** The line over the outlined turn: what ⏎ does and what it drops. One node per turn, revealed whenever it appears. */
	const captions = new Map<string, UiNode>();
	const caption = (lane: TurnLane, picked: number, column: string): UiNode => {
		const turn = lane.turns[picked]!;
		const below = lane.turns.length - picked - 1;
		const id = `${column}:${turn.turnId}:${below}`;
		let node = captions.get(id);
		if (!node) {
			const symbols = currentTheme().symbols;
			const dot = symbols.symbol("sep.dot");
			const spans: TspSpan[] = [
				{ t: `${symbols.symbol("icon.rewind")} `, s: "accent" },
				{ t: turn.isUserTurn ? "Rewind to here" : "Continue from here", s: "accent strong" },
			];
			if (turn.isUserTurn) spans.push({ t: `${dot}the prompt returns to the editor`, s: "dim" });
			spans.push({
				t: below > 0 ? `${dot}${below} turn${below === 1 ? "" : "s"} below dropped` : `${dot}nothing below to drop`,
				s: "dim",
			});
			node = one(() => (
				<text
					key={`here:${column}:${turn.turnId}`}
					reveal="start"
					role="omp.rewind.here"
					wrap="none"
					spans={spans}
				/>
			));
			captions.set(id, node);
		}
		return node;
	};
	/** The page's first row while older history is unreplayed. */
	let earlierRow: UiNode | undefined;
	const earlier = (): UiNode =>
		(earlierRow ??= one(() => (
			<row key="earlier" role="omp.rewind.earlier" gap="xs" align="center">
				<kbd keys={["a"]} />
				<text spans={[{ t: "load earlier turns", s: "muted" }]} />
			</row>
		)));
	let emptyText: UiNode | undefined;
	const empty = (): UiNode =>
		(emptyText ??= one(() => (
			<text role="omp.rewind.empty" spans={() => [{ t: `No turns match "${filter()?.text ?? ""}"`, s: "muted" }]} />
		)));
	/** The strip's branch columns, one node per branch; the active one carries the accent tone. */
	const branchColumns = new Map<string, UiNode>();
	const branchColumn = (key: string): UiNode => {
		let node = branchColumns.get(key);
		if (!node) {
			const column = (): StripColumn | undefined => layout().strip.find(item => item.key === key);
			node = one(() => (
				<col key={key} role="omp.rewind.branch" gap="lg" tone={() => (column()?.active ? "accent" : undefined)}>
					<text role="omp.rewind.branch.head" wrap="none" spans={() => column()?.head ?? []} />
					{() => column()?.nodes ?? []}
				</col>
			));
			branchColumns.set(key, node);
		}
		return node;
	};
	let stripRow: UiNode | undefined;
	const strip = (): UiNode =>
		(stripRow ??= one(() => (
			<row key="strip" role="omp.rewind.strip" gap="lg" align="start">
				{() => layout().strip.map(column => branchColumn(column.key))}
			</row>
		)));

	const layout = computed((): PageLayout => {
		const lane = main();
		const replica = lane.replica;
		const places = new Map<UiNode, BlockPlace>();
		const nodes: UiNode[] = [];
		if (!replica) return { nodes, strip: NO_STRIP, places };
		const put = (
			out: UiNode[],
			block: TranscriptBlock,
			mark: TspMark | undefined,
			column: string,
			turn: number,
		): void => {
			for (const source of block.native()) {
				places.set(source, mark ? { mark, column, turn } : { column, turn });
				out.push(markedNode(source));
			}
		};
		/** `of`'s blocks from `from` on, marked for turn `picked` (-1: none): bare above it, its caption and `pick` on its blocks, `drop` below. */
		const run = (out: UiNode[], of: TurnLane, from: number, picked: number, column: string): void => {
			const source = of.replica;
			if (!source) return;
			const blocks = source.blocks();
			const turnOf = turnIndex(source);
			const target = source.turns[picked];
			const first = target?.blocks[0] ? blocks.indexOf(target.blocks[0]) : -1;
			const last = target ? blocks.indexOf(target.blocks.at(-1)!) : -1;
			for (let index = from; index < blocks.length; index++) {
				if (index === first) out.push(caption(of, picked, column));
				const mark = first < 0 || index < first ? undefined : index <= last ? "pick" : "drop";
				put(out, blocks[index]!, mark, column, turnOf.get(blocks[index]!) ?? -1);
			}
		};
		if (filter()) {
			// Only the matching turns of the current path.
			const shown = matches();
			for (const index of shown) {
				const picked = index === selected();
				if (picked) nodes.push(caption(lane, index, "main"));
				for (const block of replica.turns[index]!.blocks)
					put(nodes, block, picked ? "pick" : undefined, "main", index);
			}
			if (shown.length === 0) nodes.push(empty());
			return { nodes, strip: NO_STRIP, places };
		}
		if (truncated()) nodes.push(earlier());
		const siblings = columns();
		const anchor = replica.turns[selected()];
		if (siblings.length === 0 || !anchor?.blocks[0]) {
			run(nodes, lane, 0, selected(), "main");
			return { nodes, strip: NO_STRIP, places };
		}
		// Shared history above the fork at full width, then the branches side by side.
		const blocks = replica.blocks();
		const turnOf = turnIndex(replica);
		const start = blocks.indexOf(anchor.blocks[0]);
		for (let index = 0; index < start; index++)
			put(nodes, blocks[index]!, undefined, "main", turnOf.get(blocks[index]!) ?? -1);
		const symbols = currentTheme().symbols;
		const count = siblings.length + 1;
		const head = (index: number, label: string): TspSpan[] => {
			const active = index === variant();
			return [
				{ t: `${symbols.symbol("icon.branch")} `, s: active ? "accent" : "dim" },
				{ t: `${index + 1}/${count}`, s: active ? "accent" : "dim" },
				{ t: `${symbols.symbol("sep.dot")}${label}`, s: active ? "strong" : "dim" },
			];
		};
		const current: UiNode[] = [];
		run(current, lane, start, variant() === 0 ? selected() : -1, "main");
		const branches: StripColumn[] = [
			{ key: "current", active: variant() === 0, head: head(0, "current"), nodes: current },
		];
		siblings.forEach((column, index) => {
			const active = variant() === index + 1;
			const turns: UiNode[] = [];
			run(turns, column.lane, 0, active ? siblingSelected() : -1, column.rootId);
			branches.push({ key: column.rootId, active, head: head(index + 1, column.label), nodes: turns });
		});
		nodes.push(strip());
		return { nodes, strip: branches, places };
	});

	const hint = (keys: readonly string[][], label: () => string): JSXNode => (
		<row align="center" gap="xs">
			{keys.map(key => (
				<kbd keys={key} />
			))}
			<text spans={() => [{ t: label(), s: "muted" }]} />
		</row>
	);
	const button = (key: string, act: string, label: () => string, action: Keybinding, tone?: "accent"): JSXNode => {
		const [bound] = getKeybindings().keysFor(action);
		const keyName = bound ?? (action === "tui.select.confirm" ? "enter" : "escape");
		return (
			<ActionButton
				nodeKey={key}
				id={act}
				label={label}
				title={() => `${label()}  ${keyTitle(keyName)}`}
				tone={tone}
				keys={kbdOf(keyName)}
			/>
		);
	};

	const bar = (
		<row
			role="omp.rewind.bar"
			align="center"
			gap="md"
			wrap={true}
			term={replay ? undefined : term}
			onKey={onKey}
			onAction={act => {
				if (act === "rewind") rewind();
				else if (act === "cancel") {
					if (filter()) filter.set(undefined);
					else props.onCancel();
				}
			}}
		>
			<text
				spans={() => [
					{ t: `${currentTheme().symbols.symbol("icon.rewind")} `, s: "accent" },
					{ t: "Rewind", s: "strong" },
				]}
				wrap="none"
			/>
			{() =>
				filtering() ? (
					<input
						text={() => filter()?.text ?? ""}
						cursor={() => filter()?.cursor ?? 0}
						prompt="filter: "
						placeholder="words…"
						sendable={false}
						onEdit={edit => {
							// The terminal's own edit of the field: the query changes, the outline stays.
							const line = filter.peek();
							const next = line && applyEdit(line, edit);
							if (!next) return;
							if (next.text.trim()) loadFull();
							filter.set(next);
						}}
					/>
				) : null
			}
			<text spans={() => [counter()]} wrap="none" />
			<row key="hints" gap="md" role="omp.overlay.hints" wrap={true}>
				{hint([actionKbd("tui.select.up", "up"), actionKbd("tui.select.down", "down")], () => "step")}
				{hint([["left"], ["right"]], () =>
					filter() ? "user turns" : columns().length > 0 ? "branches" : "user turns",
				)}
				{() => (filter() ? null : hint([["f"]], () => "filter"))}
				{() => (!filter() && truncated() ? hint([["a"]], () => "earlier turns") : null)}
			</row>
			<row key="actions" align="center" gap="sm" role="omp.actions">
				<spacer grow={1} />
				{button("cancel", "cancel", () => (filter() ? "Show all" : "Cancel"), "tui.select.cancel")}
				{button("rewind", "rewind", () => "Rewind here", "tui.select.confirm", "accent")}
			</row>
		</row>
	);
	// The page: the turns stand before the bar, which docks under them.
	return replay ? [() => layout().nodes, bar] : bar;
}
