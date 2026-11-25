/**
 * Reads and drives what the /btw controller mounts on a real {@link Shell}: the inline panel in
 * the `btw` slot, the history sheet overlay and Tern's transcript notes.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { keyEvent } from "./input-harness";
import type { BtwNoteAction } from "@oh-my-pi/pi-coding-agent/modes/view-model/overlays/btw-note";
import type { InteractiveModeContext, PresentOptions } from "@oh-my-pi/pi-coding-agent/modes/types";
import { printRows } from "@oh-my-pi/pi-coding-agent/ui/print-rows";
import type { BtwHistoryModel } from "@oh-my-pi/pi-coding-agent/ui/overlays/panels/btw-history-panel-model";
import type { Shell, TranscriptBlock } from "@oh-my-pi/pi-coding-agent/ui/shell/index";
import { propsOf, termOf } from "@oh-my-pi/pi-coding-agent/ui/styles/panels/common";
import type { TspMenuEntry } from "@oh-my-pi/pi-wire";

/** The fake-context members the btw controller reaches on the shell. */
export function btwShellMembers(shell: Shell): Pick<InteractiveModeContext, "shell" | "present" | "transcriptBlocks"> {
	return {
		shell,
		transcriptBlocks: new WeakMap(),
		present(factory, options?: PresentOptions): TranscriptBlock {
			const block = options?.before
				? shell.transcript.insertBefore(options.before, factory)
				: shell.transcript.append(factory);
			if (!options?.live) shell.transcript.settle(block);
			return block;
		},
	};
}

/** Render as Tern (`shell.native()` true). */
export function setNative(shell: Shell, native: boolean): void {
	Object.assign(shell, { native: () => native });
}

/** Plain text of `node` painted at `width`. */
export function nodeText(node: UiNode | undefined, width = 120): string {
	if (!node) return "";
	return Bun.stripANSI(printRows(() => node, width).join("\n"));
}

/** The inline panel's text (empty when the slot is clear). */
export function inlineText(shell: Shell, width = 120): string {
	const view = shell.dock.slot("btw").view();
	return view ? Bun.stripANSI(printRows(() => view, width).join("\n")) : "";
}

function find(node: UiNode, match: (node: UiNode) => boolean): UiNode | undefined {
	if (match(node)) return node;
	for (const child of node.children()) {
		const found = find(child, match);
		if (found) return found;
	}
	return undefined;
}

function roleOf(node: UiNode): string | undefined {
	return propsOf<{ role?: string }>(node).role;
}

/** The open history sheet: its model, keys and text. */
export interface HistorySheet {
	/** The sheet's current node (it rebuilds on every model change). */
	readonly node: UiNode;
	/** The overlay holding it (and keyboard focus). */
	readonly overlay: UiNode;
	readonly model: BtwHistoryModel;
	readonly closed: boolean;
	press(id: string): boolean;
	paste(text: string): void;
	text(width?: number): string;
}

/** The history sheet on top of the overlay stack; throws when none is open. */
export function historySheet(shell: Shell): HistorySheet {
	const handle = shell.overlays.top();
	if (!handle) throw new Error("Expected the BTW history sheet");
	const current = () => {
		const node = find(handle.node, candidate => roleOf(candidate) === "omp.btw.sheet");
		if (!node) throw new Error("Expected the BTW history sheet");
		return node;
	};
	const model = termOf<{ model: BtwHistoryModel }>(current()).model;
	if (!model) throw new Error("Expected the BTW history model");
	return {
		get node() {
			return current();
		},
		overlay: handle.node,
		model,
		get closed() {
			return handle.closed;
		},
		press: id => handle.node.handlers.onKey?.(keyEvent(id)) ?? false,
		paste: text => void handle.node.handlers.onPaste?.({ text }),
		text: width => nodeText(current(), width),
	};
}

/** A transcript note (Tern). */
export interface NoteView {
	readonly block: TranscriptBlock;
	readonly node: UiNode;
	readonly role: string | undefined;
	readonly folded: boolean;
	/** The ids of its right-click entries. */
	readonly menu: string[];
	/** Its `outside` action: what Tern sends on a press outside it. */
	readonly outside: string | undefined;
	press(act: BtwNoteAction): void;
	text(width?: number): string;
}

function noteNode(block: TranscriptBlock): UiNode | undefined {
	return find(block.node, node => roleOf(node)?.startsWith("omp.btw.note") === true);
}

/** Whether `block` holds a /btw note. */
export function isNoteBlock(block: TranscriptBlock): boolean {
	return noteNode(block) !== undefined;
}

function noteView(block: TranscriptBlock): NoteView {
	const current = () => {
		const node = noteNode(block);
		if (!node) throw new Error("Expected a /btw note");
		return node;
	};
	return {
		block,
		get node() {
			return current();
		},
		get role() {
			return roleOf(current());
		},
		get folded() {
			return roleOf(current()) === "omp.btw.note.folded";
		},
		get menu() {
			const menu = propsOf<{ actions?: { menu?: readonly TspMenuEntry[] } }>(current()).actions?.menu ?? [];
			return menu.flatMap(entry => (typeof entry === "object" && "id" in entry ? [entry.id] : []));
		},
		get outside() {
			return propsOf<{ actions?: { outside?: string } }>(current()).actions?.outside;
		},
		press(act) {
			current().handlers.onAction?.(act, { type: "action", key: "", act, mods: [] } as never);
		},
		text: width => nodeText(current(), width),
	};
}

/** The /btw notes in transcript order. */
export function notesIn(shell: Shell): NoteView[] {
	return shell.transcript.blocks().filter(isNoteBlock).map(noteView);
}

export function noteIn(shell: Shell): NoteView {
	const [note] = notesIn(shell);
	if (!note) throw new Error("expected a /btw note in the transcript");
	return note;
}
