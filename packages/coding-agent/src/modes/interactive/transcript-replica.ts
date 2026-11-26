/**
 * A replica of a branch's transcript: its entries replayed, by the session's own
 * history replay and block presenters, into a transcript no surface shows by
 * itself. A page lays the blocks out (the rewind page's `main`), so every turn
 * reads there exactly as it does in the session.
 *
 * Each entry that draws something is a {@link ReplicaTurn}. Tool results fold
 * into the turn that drew their call (rewinding a turn keeps its output), and a
 * request's usage row, which the replay flushes when the next entry starts,
 * stays with the turn it measures. Entries that draw nothing have no turn.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type Signal, signal, type UiNode } from "@oh-my-pi/pi-tui";
import { getAssistantMessageLinkTargets } from "../../session/transcript/link-targets";
import { ServedModelTracker } from "../../session/transcript/served-model-marker";
import {
	isUserTurnEntry,
	type TranscriptEntryLike,
	transcriptEntryMessage,
} from "../../session/transcript/transcript-entry";
import { type Shell, Transcript, type TranscriptBlock, ViewList } from "../../ui/shell";
import type { ReplayContext, ReplayTarget } from "../utils/ui-helpers";
import type { MessageFaceEnv } from "./messages";
import { type DisplayFlags, TranscriptPresenter } from "./transcript";

/** One selectable item of a replica: an entry and the blocks that draw it. */
export interface ReplicaTurn {
	/** The entry a selection resolves to: the turn's, moved onto its last folded tool result. */
	readonly entryId: string;
	/** The entry that opened the turn (the anchor for session tree lookups). */
	readonly turnId: string;
	/** A real user prompt: what user-turn jumps stop on. */
	readonly isUserTurn: boolean;
	/** The turn's entry and the tool results folded into it. */
	readonly entries: readonly TranscriptEntryLike[];
	/** The blocks drawing it, in transcript order. */
	readonly blocks: readonly TranscriptBlock[];
}

/** What a replica takes from the interactive mode. */
export interface ReplicaHost {
	/** The mode, for what a replay reads of it (the viewed session, settings). */
	readonly mode: ReplayTarget;
	/** The shell showing the replica: where one of its blocks opens a page of its own (a bash card's inspector). */
	readonly shell: Pick<Shell, "overlays" | "size">;
	/** The session view's display flags; the replica expands tool output on its own. */
	readonly display: DisplayFlags;
	/** What the session's message faces read; the replica's prompts act on nothing. */
	readonly messages: MessageFaceEnv;
	/** The session's history replay, run into `target`. */
	replaySteps(target: ReplayTarget, context: ReplayContext): Iterator<void, void, void>;
}

interface MutableTurn {
	entryId: string;
	readonly turnId: string;
	readonly isUserTurn: boolean;
	readonly entries: TranscriptEntryLike[];
	blocks: TranscriptBlock[];
}

/** Whether `node` shows something: a layout `col`/`row` only through a child that does. */
function shows(node: UiNode): boolean {
	if (node.kind !== "col" && node.kind !== "row") return true;
	return node.children().some(shows);
}

/** See the module docs. */
export class TranscriptReplica {
	/** Tool output and thinking expanded, for this replica only. */
	readonly expanded: Signal<boolean> = signal(false);
	/** The selectable turns, in transcript order. */
	readonly turns: readonly ReplicaTurn[];
	readonly #transcript = new Transcript();

	/** `clipped`: the entries are a later part of the session, so the run they open in may have started above them. */
	constructor(host: ReplicaHost, entries: readonly TranscriptEntryLike[], clipped: boolean) {
		const mode = host.mode;
		const transcript = this.#transcript;
		const presenter = new TranscriptPresenter({
			shell: { transcript, host: undefined, overlays: host.shell.overlays, size: () => host.shell.size() },
			get viewSession() {
				return mode.viewSession;
			},
			display: { ...host.display, toolOutputExpanded: this.expanded },
			pendingShellRuns: new ViewList(),
			linkTargets: () => getAssistantMessageLinkTargets(mode),
			// The blocks carry the session's controls, as its own do; here they act on nothing.
			onAssistantAction: () => {},
			messages: { ...host.messages, expanded: this.expanded, onUserAction: () => {} },
		});
		// Blocks the replay mounts for an entry before the entry's own: the usage row of the turn above.
		let head: TranscriptBlock[] = [];
		let own = false;
		const drawn = <T>(value: T): T => {
			own = true;
			return value;
		};
		const target: ReplayTarget = {
			shell: { transcript, native: mode.shell.native },
			pendingTools: new Map(),
			get viewSession() {
				return mode.viewSession;
			},
			lastAssistantUsage: undefined,
			servedModelTracker: new ServedModelTracker(),
			statusLine: mode.statusLine,
			updateEditorBorderColor: () => mode.updateEditorBorderColor(),
			settings: mode.settings,
			get hideToolActivity() {
				return mode.hideToolActivity;
			},
			transcriptBlocks: new WeakMap<AgentMessage, TranscriptBlock>(),
			present: (factory, options) => {
				const block = options?.before
					? transcript.insertBefore(options.before, factory, options)
					: transcript.append(factory, options);
				if (!options?.live) transcript.settle(block);
				if (!own) head.push(block);
				return block;
			},
			presentAssistant: (message, options) => drawn(presenter.presentAssistant(message, options)),
			presentMessage: (message, options) => drawn(presenter.presentMessage(message, options)),
			presentToolCall: (spec, options) => drawn(presenter.presentToolCall(spec, options)),
			presentReadGroup: options => drawn(presenter.presentReadGroup(options)),
			presentExecRun: (run, options) => drawn(presenter.presentExecRun(run, options)),
		};

		const replayed: { readonly entry: TranscriptEntryLike; readonly message: AgentMessage }[] = [];
		for (const entry of entries) {
			const message = transcriptEntryMessage(entry);
			if (message) replayed.push({ entry, message });
		}
		const steps = host.replaySteps(target, { messages: replayed.map(item => item.message), clipped });
		const turns: MutableTurn[] = [];
		const seen = new Set<TranscriptBlock>();
		for (const { entry, message } of replayed) {
			head = [];
			own = false;
			// One step replays one message; the last also closes the replay (trailing usage row, open groups).
			steps.next();
			const blocks = transcript.blocks();
			const added = blocks.filter(block => !seen.has(block));
			for (const block of added) seen.add(block);
			const previous = turns.at(-1);
			if (message.role === "toolResult" && previous) {
				previous.entryId = entry.id;
				previous.entries.push(entry);
				previous.blocks.push(...added);
				continue;
			}
			const above = new Set(head);
			if (previous && head.length > 0 && blocks[blocks.indexOf(head[0]!) - 1] === previous.blocks.at(-1)) {
				previous.blocks.push(...head);
			}
			const mine = added.filter(block => !above.has(block));
			if (mine.length === 0) continue;
			turns.push({
				entryId: entry.id,
				turnId: entry.id,
				isUserTurn: isUserTurnEntry(entry),
				entries: [entry],
				blocks: mine,
			});
		}
		// A block a later call displaced (a superseded `wait` poll) is gone from its turn too.
		const kept = new Set(transcript.blocks());
		for (const turn of turns) turn.blocks = turn.blocks.filter(block => kept.has(block));
		this.turns = turns;
	}

	/** Every block, in transcript order (reactive). */
	blocks(): readonly TranscriptBlock[] {
		return this.#transcript.blocks();
	}

	/** Whether `turn` shows anything (reactive): an interrupted turn with no output does not. */
	visible(turn: ReplicaTurn): boolean {
		return turn.blocks.some(block => block.native().some(shows));
	}

	/** Retire every block. */
	dispose(): void {
		this.#transcript.clear();
	}
}
