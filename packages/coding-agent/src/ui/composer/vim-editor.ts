/**
 * Vim editing over a text field (docs/keybindings.md, "Vim editing mode"). {@link VimState} decides
 * what each key means; {@link VimEditor} applies its commands to the field's text and caret and
 * keeps what Vim keeps beside them: undo and redo ({@link UndoHistory}), the registers, the Insert
 * session `.` replays, the `"+`/`"*` clipboard registers. Prompt history, its search and slash
 * commands are the host's ({@link VimEditorHost}). The composer and dialog text boxes share it.
 */
import { type Accessor, batch, type KeyEvent, type Signal, signal } from "@oh-my-pi/pi-tui";
import { columnOf, type EditorRow, offsetAt, rowOf } from "@oh-my-pi/pi-tui/term/painters/editor";
import { segmentGraphemes } from "@oh-my-pi/pi-utils/graphemes";
import {
	countGraphemes,
	diffInsertSession,
	firstNonBlank,
	flatten,
	lastGraphemeStart,
	nextGraphemeStart,
	offsetToPos,
	prevGraphemeStart,
	stepGraphemes,
	type VimCaseMode,
	type VimCommand,
	type VimInsertRecord,
	type VimMode,
	type VimPosition,
	VimState,
	visualRange,
} from "./vim";

/** A field's text and caret (UTF-16 offset). */
export interface VimSnapshot {
	readonly text: string;
	readonly cursor: number;
}

/** Undo-stack position to fold later snapshots back to; `shifts` counts snapshots evicted from the front. */
export interface UndoMark {
	readonly depth: number;
	readonly shifts: number;
}

/** Both stacks of an {@link UndoHistory}, as {@link UndoHistory.save} took them. */
export interface UndoStacks {
	readonly undo: readonly VimSnapshot[];
	readonly redo: readonly VimSnapshot[];
}

const UNDO_LIMIT = 200;

/**
 * A field's undo and redo stacks. Every edit pushes the state before it ({@link push}), which drops
 * the redo history; {@link undo} and {@link redo} trade the current state for the stacked one, the
 * caret landing where the undone change began, as Vim's does.
 */
export class UndoHistory {
	#undo: VimSnapshot[] = [];
	#redo: VimSnapshot[] = [];
	#shifts = 0;
	/** The mark whose first snapshot must outlive eviction (an open Insert session, the running key). */
	pinned: UndoMark | null = null;

	/** Record `before`, the state an edit is about to change; a new edit drops the redo history. */
	push(before: VimSnapshot): void {
		this.#redo.length = 0;
		this.#pushUndo(before);
	}

	#pushUndo(snapshot: VimSnapshot): void {
		this.#undo.push(snapshot);
		if (this.#undo.length <= UNDO_LIMIT) return;
		const pin = this.pinned;
		const anchor = pin === null ? -1 : pin.depth - (this.#shifts - pin.shifts);
		if (anchor === 0 && this.#undo.length > 1) {
			// The front entry is the open change's restore point: drop the one after it instead.
			this.#undo.splice(1, 1);
			return;
		}
		this.#undo.shift();
		this.#shifts++;
	}

	/** The state to restore for one undo from `current`, or undefined with nothing to undo. */
	undo(current: VimSnapshot): VimSnapshot | undefined {
		const snapshot = this.#undo.pop();
		if (snapshot) this.#redo.push({ text: current.text, cursor: snapshot.cursor });
		return snapshot;
	}

	/** The state to restore for one redo from `current`, or undefined with nothing undone. */
	redo(current: VimSnapshot): VimSnapshot | undefined {
		const snapshot = this.#redo.pop();
		if (snapshot) this.#pushUndo({ text: current.text, cursor: snapshot.cursor });
		return snapshot;
	}

	mark(): UndoMark {
		return { depth: this.#undo.length, shifts: this.#shifts };
	}

	/** Keep only the first snapshot pushed since `mark`: everything after it becomes one undo step. */
	collapseSince(mark: UndoMark): void {
		const keep = Math.max(0, mark.depth - (this.#shifts - mark.shifts)) + 1;
		if (this.#undo.length > keep) this.#undo.length = keep;
	}

	clear(): void {
		this.#undo.length = 0;
		this.#redo.length = 0;
	}

	/** Both stacks as they are now. */
	save(): UndoStacks {
		return { undo: this.#undo.slice(), redo: this.#redo.slice() };
	}

	/** Put back stacks {@link save} took. */
	restore(stacks: UndoStacks): void {
		this.#undo = stacks.undo.slice();
		this.#redo = stacks.redo.slice();
	}
}

/** The field a {@link VimEditor} edits, and what the field's owner does for Vim. */
export interface VimEditorHost {
	text(): string;
	cursor(): number;
	/** Put `text` and the caret (Vim's edits, undo, redo); the host records no undo step for it. */
	set(text: string, cursor: number): void;
	/** The field's undo and redo stacks (shared with the host's own undo). */
	readonly history: UndoHistory;
	/** The host pushes undo steps for its field's edits itself; otherwise {@link VimEditor.edited} does. */
	readonly recordsUndo?: boolean;
	/** The mode each prompt starts in (`tui.vimStartMode`); Insert without it. */
	startMode?(): "insert" | "normal";
	/** The field's wrapped rows as last laid out, for `gj`/`gk`; without it they move by lines. */
	layout?(): readonly EditorRow[];
	/** Ranges of `text` an edit takes whole or not at all (chips). */
	atoms?(text: string): readonly { readonly from: number; readonly to: number }[];
	/** `k`/`j` (and `-`/`+`) with no line left above or below: step `count` prompts older or newer. */
	historyStep?(older: boolean, count: number): void;
	/** `/` and `?`: open the prompt-history search. */
	historySearch?(): void;
	/** `:` on an empty prompt: start a slash command (type `/` so the command menu opens); without it `:` does nothing. */
	commandLine?(): void;
	/**
	 * Every yank, and anything stored into `"+`/`"*` (`register`), for the system clipboard;
	 * linewise text ends in a newline.
	 */
	onYank?(text: string, register: string | undefined): void;
	/** Reads the system clipboard for `"+p`/`"*p`; without it they put the last `"+y`. */
	readClipboard?(): Promise<string>;
}

/** What the app gives a dialog's text box for Vim: the start mode and the clipboard registers. */
export type DialogVim = Pick<VimEditorHost, "startMode" | "onYank" | "readClipboard">;

/** A register: its text (no trailing newline) and whether `p` puts it as whole lines. */
interface Register {
	text: string;
	linewise: boolean;
}

interface Buffer {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

/**
 * The open Insert/Replace session: `[0, leftEnd)` is surviving pre-session text on the left and
 * `[rightStart, length)` on the right, so the gap is what the session typed; `delBefore`/`delAfter`
 * count pre-session graphemes deleted around the start.
 */
interface Session {
	mark: UndoMark;
	replace: boolean;
	text: string;
	cursor: number;
	arrowed: boolean;
	leftEnd: number;
	rightStart: number;
	delBefore: number;
	delAfter: number;
	tracked: boolean;
}

/** A Replace-mode overwrite Backspace can take back. */
interface ReplaceEntry {
	line: number;
	col: number;
	removed: string;
	text: string;
}

/** Named keys Normal and Visual modes read as motions instead of edits. */
const NAV_KEYS: Record<string, string | undefined> = {
	up: "k",
	down: "j",
	left: "h",
	right: "l",
	home: "0",
	end: "$",
	backspace: "h",
	delete: "x",
	space: "l",
};

const editing = (mode: VimMode): boolean => mode === "insert" || mode === "replace";

/** See the module docs. */
export class VimEditor {
	readonly #host: VimEditorHost;
	readonly #vim = new VimState();
	readonly #mode: Signal<VimMode> = signal<VimMode>("insert");
	readonly #pending = signal("");
	readonly #anchor = signal<VimPosition | null>(null);
	/** The buffer while a key's commands apply; loaded from and committed to the host around them. */
	#state: Buffer = { lines: [""], cursorLine: 0, cursorCol: 0 };
	/** Bumped by every edit, undo and redo Vim makes. */
	#revision = 0;
	#session: Session | null = null;
	readonly #registers = new Map<string, Register>();
	#unnamed: Register | null = null;
	#clipboardRead: Promise<void> | null = null;
	#clipboardGeneration = 0;
	#keySerial = 0;
	#putDeferred = false;
	/** While a key runs: where its first edit pushed an undo snapshot (null: none yet); undefined outside. */
	#keyFirstEdit: UndoMark | null | undefined = undefined;
	/** `gj`/`gk` moved within this key, so the screen column they keep survives it. */
	#screenMoved = false;
	#screenCol: number | null = null;
	readonly #replaceLog: ReplaceEntry[] = [];
	/** The last edit was a Replace-mode overwrite (Backspace may restore). */
	#overwriting = false;

	constructor(host: VimEditorHost) {
		this.#host = host;
		this.#vim.screenMove = host.layout ? count => this.#screenMove(count) : null;
	}

	/** The mode (reactive). */
	get mode(): Accessor<VimMode> {
		return this.#mode;
	}

	/** The half-typed command as Vim echoes it (`2d`, `"a`), empty when none (reactive). */
	pendingText(): string {
		return this.#pending();
	}

	/** Whether Escape is Vim's now (leave Insert/Visual, cancel a half-typed command) rather than the app's. */
	consumesEscape(): boolean {
		return this.#mode() !== "normal" || this.#vim.pending;
	}

	/** The Visual selection as `[from, to)` offsets (reactive), null outside Visual modes. */
	selection(): { from: number; to: number } | null {
		const mode = this.#mode();
		const anchor = this.#anchor();
		if ((mode !== "visual" && mode !== "visual-line") || anchor === null) return null;
		const buf = this.#bufferOf(this.#host.text(), this.#host.cursor());
		const { from, to } = visualRange(buf, anchor, mode === "visual-line");
		return { from: offsetOf(buf.lines, from), to: offsetOf(buf.lines, to) };
	}

	/** The Visual anchor as an offset (reactive), null outside Visual modes. */
	anchorOffset(): number | null {
		const anchor = this.#anchor();
		if (anchor === null) return null;
		return offsetOf(this.#host.text().split("\n"), anchor);
	}

	/** Lines the Visual selection spans; 0 outside Visual modes (reactive). */
	selectedLines(): number {
		const mode = this.#mode();
		const anchor = this.#anchor();
		if ((mode !== "visual" && mode !== "visual-line") || anchor === null) return 0;
		const buf = this.#bufferOf(this.#host.text(), this.#host.cursor());
		const { from, to } = visualRange(buf, anchor, mode === "visual-line");
		const last = mode === "visual" && to.col === 0 && to.line > from.line ? to.line - 1 : to.line;
		return last - from.line + 1;
	}

	/**
	 * Start a fresh prompt in the start mode with nothing half-typed; registers and `.` carry over.
	 * Hosts call it when Vim turns on and for every new prompt.
	 */
	begin(): void {
		const vim = this.#vim;
		const history = this.#host.history;
		this.#session = null;
		history.pinned = null;
		vim.begin(this.#host.startMode?.() ?? "insert");
		if (vim.mode === "insert") {
			this.#load();
			const mark = history.mark();
			history.pinned = mark;
			this.#startSession(mark, false);
		} else {
			this.#load();
			this.#clampCursor();
			this.#commit();
		}
		this.#sync();
	}

	/** Offer a key; true when Vim took it. */
	handle(key: KeyEvent): boolean {
		if (key.kind === "release") return false;
		const vim = this.#vim;
		// Kitty and modifyOtherKeys send Ctrl+[ as a modified key rather than as Escape.
		if (key.id === "escape" || key.id === "ctrl+[") return this.#run("escape");
		if (this.#modeNow() === "insert") return false;
		if (this.#modeNow() === "replace") {
			if (key.id === "backspace" || key.id === "shift+backspace") {
				this.#replaceBackspace();
				return true;
			}
			if (key.text && !/^(?:ctrl|alt|super)\+/.test(key.id)) {
				for (const seg of segmentGraphemes(key.text)) this.#overwriteGrapheme(seg.segment);
				return true;
			}
		}
		// `f`/`t`/`r` wait for a character: Space is that character; arrows and other named keys cancel.
		const awaiting = /[fFtTr]$/.test(vim.pendingText);
		if (awaiting && key.id === "space") return this.#run(" ");
		const mapped = NAV_KEYS[key.id];
		if (awaiting && mapped !== undefined) return this.#run("escape");
		if (mapped !== undefined) return this.#run(mapped);
		// Redo is the one control chord Normal mode keeps; Insert and Visual leave Ctrl+R to the app.
		if (key.id === "ctrl+r" && this.#modeNow() === "normal" && !awaiting) return this.#run("ctrl+r");
		// Control chords, Enter and Tab stay with the app; a half-typed command is cancelled first so it
		// cannot outlive a submit and swallow the next prompt's first key.
		const text = key.text;
		if (!text || /^(?:ctrl|alt|super)\+/.test(key.id)) {
			if (vim.pending) this.#run("escape");
			return false;
		}
		for (const seg of segmentGraphemes(text)) {
			if (this.#modeNow() === "replace") {
				this.#overwriteGrapheme(seg.segment);
				continue;
			}
			if (this.#run(seg.segment)) continue;
			// A command entered Insert part-way through a run of keys: the rest is typed.
			this.#typeRun(text.slice(seg.index));
			return true;
		}
		return true;
	}

	/**
	 * Call after the field applied an edit of its own (typing, a paste, a deletion, a caret move)
	 * with the state `before` it: records the undo step (unless the host does) and follows the
	 * Insert session for `.`; a bare caret move splits the session, as an arrow key does in Vim.
	 */
	edited(before: VimSnapshot): void {
		const host = this.#host;
		const text = host.text();
		const changed = text !== before.text;
		if (changed) {
			if (!host.recordsUndo) host.history.push(before);
			this.#overwriting = false;
		}
		const session = this.#session;
		if (session === null) return;
		if (!changed) {
			if (host.cursor() !== before.cursor) this.#breakSession();
			return;
		}
		if (session.tracked && !session.replace) trackSessionEdit(session, before.text, text);
		// A line break typed in Replace mode is part of what `.` overwrites with.
		else if (session.replace && text.length === before.text.length + 1 && text[before.cursor] === "\n") {
			const at = offsetToPos(before.text.split("\n"), before.cursor);
			this.#replaceLog.push({ line: at.line, col: at.col, removed: "", text: "\n" });
		}
	}

	/** Undo one step (a host's undo key). */
	undo(): void {
		this.#load();
		this.#applyUndo();
		this.#clampCursor();
		this.#commit();
		this.#sync();
	}

	/** Redo one undone step. */
	redo(): void {
		this.#load();
		this.#applyRedo();
		this.#clampCursor();
		this.#commit();
		this.#sync();
	}

	#modeNow(): VimMode {
		return this.#vim.mode;
	}

	// ─── Keys ───────────────────────────────────────────────────────────────

	#run(key: string): boolean {
		const vim = this.#vim;
		const history = this.#host.history;
		const before = this.#modeNow();
		const mark = history.mark();
		const pinHere = this.#session === null;
		if (pinHere) history.pinned = mark;
		this.#load();
		const revision = this.#revision;
		this.#screenMoved = false;
		this.#putDeferred = false;
		this.#keySerial++;
		this.#keyFirstEdit = null;
		vim.slashCommands = this.#host.commandLine !== undefined;
		const registerBefore = vim.register;
		const commands = vim.handleKey(key, this.#state);
		if (commands === null) {
			this.#keyFirstEdit = undefined;
			if (pinHere) history.pinned = null;
			return false;
		}
		const after = this.#modeNow();
		const leaving = editing(before) && !editing(after);
		// `3ifoo<Esc>` types its copies on the way out; they belong to the session's undo step.
		const sessionMark = leaving ? this.#session?.mark : undefined;
		if (leaving) this.#endSession();
		this.#apply(commands);
		const firstEdit = this.#keyFirstEdit;
		this.#keyFirstEdit = undefined;
		// A put waiting on the clipboard settles its `.` record itself once it lands.
		if (!this.#putDeferred) {
			if (this.#revision !== revision) vim.commitChange();
			else vim.discardChange();
		}
		// The session's undo mark precedes `cw`'s delete or `o`'s new line, so one `u` takes the whole
		// change. Every other key is one undo step: the snapshots its own edits pushed fold into the
		// first. `u`, Ctrl+R and history steps push none, so the stacks they restore stay whole.
		const now = this.#modeNow();
		if (!editing(before) && editing(now)) this.#startSession(mark, now === "replace");
		else if (this.#session === null) {
			const fold = sessionMark ?? firstEdit;
			if (fold) history.collapseSince(fold);
			history.pinned = null;
		}
		if (!this.#screenMoved && vim.pendingText === "") this.#screenCol = null;
		const register = vim.register;
		if ((register === "+" || register === "*") && register !== registerBefore) this.#prefetchClipboard(register);
		if (before === "replace" || now === "replace") this.#replaceLog.length = 0;
		this.#sync();
		return true;
	}

	/** Type the literal tail of a run of keys whose earlier keys entered Insert mode. */
	#typeRun(text: string): void {
		const host = this.#host;
		const before = { text: host.text(), cursor: host.cursor() };
		const next = before.text.slice(0, before.cursor) + text + before.text.slice(before.cursor);
		host.history.push(before);
		host.set(next, before.cursor + text.length);
		const session = this.#session;
		if (session?.tracked && !session.replace) trackSessionEdit(session, before.text, next);
	}

	/** Mirror the engine's mode, pending command and anchor into the reactive signals. */
	#sync(): void {
		const vim = this.#vim;
		const anchor = vim.visual ? vim.anchor : null;
		const previous = this.#anchor.peek();
		batch(() => {
			this.#mode.set(vim.mode);
			this.#pending.set(vim.pendingText);
			if (anchor?.line !== previous?.line || anchor?.col !== previous?.col)
				this.#anchor.set(anchor ? { ...anchor } : null);
		});
	}

	// ─── Buffer ─────────────────────────────────────────────────────────────

	#bufferOf(text: string, cursor: number): Buffer {
		const lines = text.split("\n");
		const at = offsetToPos(lines, Math.max(0, Math.min(text.length, cursor)));
		return { lines, cursorLine: at.line, cursorCol: at.col };
	}

	#load(): void {
		this.#state = this.#bufferOf(this.#host.text(), this.#host.cursor());
	}

	#snapshot(): VimSnapshot {
		const { text, cursor } = flatten(this.#state);
		return { text, cursor };
	}

	#commit(): void {
		const { text, cursor } = this.#snapshot();
		if (text !== this.#host.text() || cursor !== this.#host.cursor()) this.#host.set(text, cursor);
	}

	#restore(snapshot: VimSnapshot): void {
		this.#state = this.#bufferOf(snapshot.text, snapshot.cursor);
	}

	#setCursorCol(col: number): void {
		this.#state.cursorCol = col;
	}

	#recordUndo(): void {
		const history = this.#host.history;
		if (this.#keyFirstEdit === null) this.#keyFirstEdit = history.mark();
		history.push(this.#snapshot());
	}

	#afterEdit(): void {
		this.#revision++;
		this.#overwriting = false;
	}

	#applyUndo(): void {
		const snapshot = this.#host.history.undo(this.#snapshot());
		if (!snapshot) return;
		this.#restore(snapshot);
		this.#revision++;
	}

	#applyRedo(): void {
		const snapshot = this.#host.history.redo(this.#snapshot());
		if (!snapshot) return;
		this.#restore(snapshot);
		this.#revision++;
	}

	// ─── Insert sessions ────────────────────────────────────────────────────

	#startSession(mark: UndoMark, replace: boolean): void {
		const text = this.#host.text();
		const cursor = this.#host.cursor();
		this.#session = {
			mark,
			replace,
			text,
			cursor,
			arrowed: false,
			leftEnd: cursor,
			rightStart: cursor,
			delBefore: 0,
			delAfter: 0,
			tracked: true,
		};
	}

	/** Hand the session segment's text to `.` and fold its undo steps. */
	#finalizeSegment(): void {
		const session = this.#session;
		if (session === null) return;
		const text = this.#host.text();
		const record: VimInsertRecord = session.replace
			? { deleteBefore: 0, deleteAfter: 0, text: this.#replaceLog.map(entry => entry.text).join("") }
			: session.tracked
				? {
						deleteBefore: session.delBefore,
						deleteAfter: session.delAfter,
						text: text.slice(session.leftEnd, session.rightStart),
					}
				: diffInsertSession(session.text, session.cursor, text);
		if (!session.arrowed) this.#vim.recordInsert(record, false);
		// An empty segment after an arrow keeps the earlier change, as Vim does.
		else if (record.text !== "" || record.deleteBefore > 0 || record.deleteAfter > 0)
			this.#vim.recordInsert(record, true);
		this.#host.history.collapseSince(session.mark);
	}

	#endSession(): void {
		this.#finalizeSegment();
		this.#session = null;
		this.#host.history.pinned = null;
		this.#replaceLog.length = 0;
	}

	/** A caret move inside Insert/Replace: close the segment and start a fresh one where the caret went. */
	#breakSession(): void {
		const session = this.#session;
		if (session === null) return;
		this.#finalizeSegment();
		this.#vim.cancelInsertRepeat();
		this.#replaceLog.length = 0;
		this.#overwriting = false;
		const cursor = this.#host.cursor();
		const mark = this.#host.history.mark();
		this.#session = {
			...session,
			mark,
			text: this.#host.text(),
			cursor,
			arrowed: true,
			leftEnd: cursor,
			rightStart: cursor,
			delBefore: 0,
			delAfter: 0,
			tracked: true,
		};
		this.#host.history.pinned = mark;
	}

	// ─── Commands ───────────────────────────────────────────────────────────

	#apply(commands: readonly VimCommand[]): void {
		for (const command of commands) {
			// An edit other than a motion invalidates Replace-mode Backspace restores.
			if (
				this.#modeNow() === "replace" &&
				command.kind !== "move" &&
				command.kind !== "mode" &&
				command.kind !== "yank"
			)
				this.#replaceLog.length = 0;
			switch (command.kind) {
				case "move":
					this.#move(command.to);
					break;
				case "mode":
					this.#overwriting = false;
					this.#screenCol = null;
					break;
				case "yank": {
					const body = this.#slice(command.from, command.to, command.linewise);
					if (body || command.linewise) this.#writeRegister(body, command.linewise, true, command.register);
					break;
				}
				case "delete":
					this.#delete(command.from, command.to, command.linewise, command.insert, command.register);
					break;
				case "openLine":
					this.#openLine(command.below);
					break;
				case "paste":
					if (this.#deferClipboard(command)) break;
					this.#paste(command.after, command.count, command.cursorAfter, command.register);
					break;
				case "visualPut":
					if (this.#deferClipboard(command)) break;
					this.#putOverSelection(
						command.from,
						command.to,
						command.linewise,
						command.keepRegister,
						command.register,
					);
					break;
				case "historySearch":
					this.#viaHost(() => this.#host.historySearch?.());
					break;
				case "commandLine":
					this.#viaHost(() => this.#host.commandLine?.());
					break;
				case "historyStep":
					this.#viaHost(() => this.#host.historyStep?.(command.older, command.count));
					break;
				case "undo":
					for (let i = 0; i < command.count; i++) this.#applyUndo();
					break;
				case "redo":
					for (let i = 0; i < command.count; i++) this.#applyRedo();
					break;
				case "replace":
					this.#replaceSpan(command.from, command.to, command.text);
					break;
				case "join":
					this.#join(command.fromLine, command.lines, command.spaces);
					break;
				case "indent":
					this.#indent(command.fromLine, command.toLine, command.out);
					break;
				case "case":
					this.#changeCase(command.from, command.to, command.linewise, command.mode);
					break;
				case "retype":
					this.#retype(command);
					break;
				case "insertRepeat": {
					const text = this.#vim.lastInsertText;
					for (let n = 0; n < command.times && text !== ""; n++) {
						if (command.newline) this.#openLine(true);
						this.#spliceInsert({ deleteBefore: 0, deleteAfter: 0, text });
					}
					// Escape's step back off the end of the typed text.
					const line = this.#state.lines[this.#state.cursorLine] ?? "";
					this.#setCursorCol(prevGraphemeStart(line, this.#state.cursorCol));
					break;
				}
			}
		}
		this.#clampCursor();
		this.#commit();
	}

	/** Run a host action on the committed buffer, then read back what it left. */
	#viaHost(action: () => void): void {
		this.#commit();
		action();
		this.#load();
	}

	#move(to: VimPosition): void {
		const lines = this.#state.lines;
		this.#state.cursorLine = Math.max(0, Math.min(to.line, lines.length - 1));
		const line = lines[this.#state.cursorLine] ?? "";
		this.#setCursorCol(Math.max(0, Math.min(to.col, line.length)));
	}

	/** Normal mode rests the caret on a grapheme; Insert and Visual may sit one past the end. */
	#clampCursor(): void {
		if (this.#modeNow() !== "normal") return;
		const line = this.#state.lines[this.#state.cursorLine] ?? "";
		if (this.#state.cursorCol > lastGraphemeStart(line)) this.#state.cursorCol = lastGraphemeStart(line);
	}

	/** `gj`/`gk`: where `count` wrapped rows away lands, keeping the screen column; null when it cannot move. */
	#screenMove(count: number): VimPosition | null {
		const rows = this.#host.layout?.();
		if (!rows || rows.length === 0) return null;
		const { text, cursor } = this.#snapshot();
		const current = rowOf(rows, cursor);
		const target = Math.max(0, Math.min(rows.length - 1, current + count));
		if (target === current) return null;
		this.#screenCol ??= columnOf(text, rows[current]!, cursor);
		this.#screenMoved = true;
		return offsetToPos(this.#state.lines, offsetAt(text, rows, target, this.#screenCol));
	}

	/** Text of the half-open range `[from, to)`; linewise ranges take whole lines. */
	#slice(from: VimPosition, to: VimPosition, linewise: boolean): string {
		const lines = this.#state.lines;
		if (linewise) return lines.slice(from.line, Math.min(to.line, lines.length - 1) + 1).join("\n");
		if (from.line === to.line) return (lines[from.line] ?? "").slice(from.col, to.col);
		const parts = [(lines[from.line] ?? "").slice(from.col)];
		for (let i = from.line + 1; i < to.line; i++) parts.push(lines[i] ?? "");
		parts.push((lines[to.line] ?? "").slice(0, to.col));
		return parts.join("\n");
	}

	/** The atom (chip) covering offset `at` of the buffer, if any. */
	#atomAt(at: number): { from: number; to: number } | undefined {
		const atoms = this.#host.atoms;
		if (!atoms) return undefined;
		const { text } = this.#snapshot();
		return atoms(text).find(range => range.from <= at && at < range.to);
	}

	/** Widen a charwise range so it never cuts through an atom. */
	#expandRange(from: VimPosition, to: VimPosition): { start: VimPosition; end: VimPosition } {
		const lines = this.#state.lines;
		let start = offsetOf(lines, from);
		let end = offsetOf(lines, to);
		const first = this.#atomAt(start);
		if (first) start = first.from;
		const last = end > start ? this.#atomAt(end - 1) : undefined;
		if (last && last.to > end) end = last.to;
		return { start: offsetToPos(lines, start), end: offsetToPos(lines, end) };
	}

	/** `insert` marks a change (`cc`): a linewise range then leaves one empty line to type into. */
	#delete(from: VimPosition, to: VimPosition, linewise: boolean, insert: boolean, register?: string): void {
		const lines = this.#state.lines;
		if (linewise) {
			const last = Math.min(to.line, lines.length - 1);
			const removed = this.#slice(from, to, true);
			if (!removed && from.line === last && (insert || lines.length === 1)) return;
			this.#recordUndo();
			this.#writeRegister(removed, true, false, register);
			if (insert) lines.splice(from.line, last - from.line + 1, "");
			else lines.splice(from.line, last - from.line + 1);
			if (lines.length === 0) lines.push("");
			this.#state.cursorLine = Math.min(from.line, lines.length - 1);
			// `dd` lands on the next line's first non-blank; `cc` types at the start.
			this.#setCursorCol(insert ? 0 : firstNonBlank(lines[this.#state.cursorLine] ?? ""));
			this.#afterEdit();
			return;
		}
		const { start, end } = this.#expandRange(from, to);
		const removed = this.#slice(start, end, false);
		if (!removed) return;
		this.#recordUndo();
		this.#writeRegister(removed, false, false, register);
		const head = (lines[start.line] ?? "").slice(0, start.col);
		const tail = (lines[Math.min(end.line, lines.length - 1)] ?? "").slice(end.col);
		lines.splice(start.line, Math.min(end.line, lines.length - 1) - start.line + 1, head + tail);
		this.#state.cursorLine = start.line;
		this.#setCursorCol(start.col);
		this.#afterEdit();
	}

	#replaceSpan(from: VimPosition, to: VimPosition, text: string): void {
		const line = this.#state.lines[from.line] ?? "";
		const lines = this.#state.lines;
		const start = offsetOf(lines, from);
		const end = offsetOf(lines, to);
		const atom = this.#atomAt(start) ?? (end > start ? this.#atomAt(end - 1) : undefined);
		if (atom) return;
		this.#recordUndo();
		lines[from.line] = line.slice(0, from.col) + text + line.slice(to.col);
		this.#state.cursorLine = from.line;
		let last = from.col;
		for (const seg of segmentGraphemes(text)) last = from.col + seg.index;
		this.#setCursorCol(last);
		this.#afterEdit();
	}

	#overwriteGrapheme(grapheme: string): void {
		this.#load();
		const lineIdx = this.#state.cursorLine;
		const line = this.#state.lines[lineIdx] ?? "";
		const col = this.#state.cursorCol;
		if (this.#atomAt(offsetOf(this.#state.lines, { line: lineIdx, col }))) return;
		// Any other edit since the last overwrite makes the logged columns meaningless: a fresh undo step and log.
		if (!this.#overwriting) {
			this.#host.history.push(this.#snapshot());
			if (!this.#session?.replace) this.#replaceLog.length = 0;
		}
		const end = col >= line.length ? col : nextGraphemeStart(line, col);
		const removed = line.slice(col, end);
		this.#state.lines[lineIdx] = line.slice(0, col) + grapheme + line.slice(end);
		this.#replaceLog.push({ line: lineIdx, col, removed, text: grapheme });
		this.#setCursorCol(col + grapheme.length);
		this.#revision++;
		this.#commit();
		this.#overwriting = true;
	}

	#replaceBackspace(): void {
		if (!this.#overwriting) {
			this.#replaceLog.length = 0;
			return;
		}
		const entry = this.#replaceLog.pop();
		if (!entry) return;
		this.#load();
		const line = this.#state.lines[entry.line] ?? "";
		const stillThere = line.slice(entry.col, entry.col + entry.text.length) === entry.text;
		const atCursor = this.#state.cursorLine === entry.line && this.#state.cursorCol === entry.col + entry.text.length;
		if (!stillThere) return;
		if (!atCursor) {
			this.#replaceLog.push(entry);
			return;
		}
		this.#state.lines[entry.line] =
			line.slice(0, entry.col) + entry.removed + line.slice(entry.col + entry.text.length);
		this.#setCursorCol(entry.col);
		this.#revision++;
		this.#commit();
	}

	/** `J` (`spaces`) trims each joined line's indent and puts one seam space; `gJ` concatenates as is. */
	#join(fromLine: number, span: number, spaces: boolean): void {
		const lines = this.#state.lines;
		const start = Math.max(0, Math.min(fromLine, lines.length - 1));
		const last = Math.min(start + Math.max(span, 2) - 1, lines.length - 1);
		if (last <= start) return;
		this.#recordUndo();
		let text = lines[start] ?? "";
		let cursor = text.length;
		for (let i = start + 1; i <= last; i++) {
			const raw = lines[i] ?? "";
			const trim = spaces ? (/^[ \t]*/.exec(raw)?.[0].length ?? 0) : 0;
			const next = raw.slice(trim);
			// Vim leaves the cursor on the last seam it made.
			cursor = text.length;
			// No space after whitespace, before `)`, or for an empty line; two after `.!?`.
			const gap =
				!spaces || text.length === 0 || next.length === 0 || /[ \t]$/.test(text) || next.startsWith(")")
					? ""
					: /[.!?]$/.test(text)
						? "  "
						: " ";
			text += gap + next;
		}
		lines.splice(start, last - start + 1, text);
		this.#state.cursorLine = start;
		this.#setCursorCol(cursor);
		this.#afterEdit();
	}

	#indent(fromLine: number, toLine: number, out: boolean): void {
		const lines = this.#state.lines;
		const first = Math.max(0, Math.min(fromLine, lines.length - 1));
		const last = Math.max(first, Math.min(toLine, lines.length - 1));
		// Two spaces, not Vim's shiftwidth of 8; a leading tab shifts by one tab. Empty lines stay empty.
		const next = lines.slice(first, last + 1).map(text => {
			if (!out) return text.length === 0 ? text : (text.startsWith("\t") ? "\t" : "  ") + text;
			if (text.startsWith("\t")) return text.slice(1);
			const spaces = /^ */.exec(text)?.[0].length ?? 0;
			return text.slice(Math.min(2, spaces));
		});
		this.#state.cursorLine = first;
		this.#setCursorCol(firstNonBlank(lines[first] ?? ""));
		if (next.every((line, i) => line === (lines[first + i] ?? ""))) return;
		this.#recordUndo();
		for (let i = first; i <= last; i++) lines[i] = next[i - first] ?? "";
		this.#state.cursorLine = first;
		this.#setCursorCol(firstNonBlank(lines[first] ?? ""));
		this.#afterEdit();
	}

	#openLine(below: boolean): void {
		this.#recordUndo();
		const at = below ? this.#state.cursorLine + 1 : this.#state.cursorLine;
		this.#state.lines.splice(at, 0, "");
		this.#state.cursorLine = at;
		this.#setCursorCol(0);
		this.#afterEdit();
	}

	/** `p`/`P`, and `gp`/`gP` (`cursorAfter`), which leave the cursor just past the put text. */
	#paste(after: boolean, count: number, cursorAfter: boolean, register?: string): void {
		const entry = this.#readRegister(register);
		if (!entry) return;
		const lines = this.#state.lines;
		this.#recordUndo();
		if (entry.linewise) {
			const body = entry.text.split("\n");
			const at = after ? this.#state.cursorLine + 1 : this.#state.cursorLine;
			const payload: string[] = [];
			for (let i = 0; i < count; i++) payload.push(...body);
			lines.splice(at, 0, ...payload);
			if (cursorAfter) {
				this.#state.cursorLine = Math.min(at + payload.length, lines.length - 1);
				this.#setCursorCol(0);
			} else {
				this.#state.cursorLine = at;
				this.#setCursorCol(firstNonBlank(lines[at] ?? ""));
			}
		} else {
			const line = lines[this.#state.cursorLine] ?? "";
			const at = after ? nextGraphemeStart(line, this.#state.cursorCol) : this.#state.cursorCol;
			const payload = entry.text.repeat(count);
			const pieces = (line.slice(0, at) + payload + line.slice(at)).split("\n");
			const first = this.#state.cursorLine;
			lines.splice(first, 1, ...pieces);
			if (cursorAfter) {
				const tail = payload.slice(payload.lastIndexOf("\n") + 1);
				this.#state.cursorLine = first + pieces.length - 1;
				this.#setCursorCol((pieces.length > 1 ? 0 : at) + tail.length);
			} else {
				// A one-line put leaves the cursor on its last character, a multi-line one at its start.
				this.#setCursorCol(pieces.length > 1 ? at : at + payload.length - 1);
			}
		}
		this.#afterEdit();
	}

	/**
	 * Visual `p`/`P`: replace the selection with the register. `p` leaves the replaced text in the
	 * register, as Vim does; `P` keeps the register.
	 */
	#putOverSelection(
		from: VimPosition,
		to: VimPosition,
		linewise: boolean,
		keepRegister: boolean,
		register?: string,
	): void {
		const entry = this.#readRegister(register);
		if (!entry) return;
		const lines = this.#state.lines;
		const body = entry.text.split("\n");
		this.#move(from);
		this.#recordUndo();
		let removed: string;
		if (linewise) {
			const last = Math.min(to.line, lines.length - 1);
			removed = this.#slice(from, to, true);
			lines.splice(from.line, last - from.line + 1, ...body);
			this.#state.cursorLine = from.line;
			this.#setCursorCol(firstNonBlank(lines[from.line] ?? ""));
		} else {
			const { start, end } = this.#expandRange(from, to);
			removed = this.#slice(start, end, false);
			const head = (lines[start.line] ?? "").slice(0, start.col);
			const tail = (lines[Math.min(end.line, lines.length - 1)] ?? "").slice(end.col);
			const span = Math.min(end.line, lines.length - 1) - start.line + 1;
			if (entry.linewise) {
				lines.splice(start.line, span, head, ...body, tail);
				this.#state.cursorLine = start.line + 1;
				this.#setCursorCol(firstNonBlank(lines[start.line + 1] ?? ""));
			} else {
				const pieces = (head + entry.text + tail).split("\n");
				lines.splice(start.line, span, ...pieces);
				this.#state.cursorLine = start.line;
				this.#setCursorCol(pieces.length > 1 ? start.col : Math.max(start.col, start.col + entry.text.length - 1));
			}
		}
		if (!keepRegister && (removed || linewise)) this.#writeRegister(removed, linewise, false, undefined);
		this.#afterEdit();
	}

	/** `gu`/`gU`/`g~` and `~`: convert the case of a range in place, grapheme by grapheme. */
	#changeCase(from: VimPosition, to: VimPosition, linewise: boolean, mode: VimCaseMode): void {
		const lines = this.#state.lines;
		const convert = (text: string): string => {
			if (mode === "upper") return text.toUpperCase();
			if (mode === "lower") return text.toLowerCase();
			let out = "";
			for (const { segment } of segmentGraphemes(text)) {
				const upper = segment.toUpperCase();
				out += segment === upper ? segment.toLowerCase() : upper;
			}
			return out;
		};
		const last = Math.min(to.line, lines.length - 1);
		const next: string[] = [];
		for (let line = from.line; line <= last; line++) {
			const text = lines[line] ?? "";
			const start = linewise || line > from.line ? 0 : from.col;
			const end = linewise || line < last ? text.length : Math.min(to.col, text.length);
			next.push(text.slice(0, start) + convert(text.slice(start, end)) + text.slice(end));
		}
		if (next.every((text, i) => text === lines[from.line + i])) return;
		this.#recordUndo();
		lines.splice(from.line, next.length, ...next);
		this.#afterEdit();
	}

	/** `.` after an Insert/Replace session: type its text again, `times` copies, then Escape's step back. */
	#retype(command: Extract<VimCommand, { kind: "retype" }>): void {
		for (let n = 0; n < command.times; n++) {
			// `3.` after `ofoo`: one new line per copy, stacking downward.
			if (n > 0 && command.newline) this.#openLine(true);
			if (command.overwrite) this.#overwriteText(command.record.text);
			else this.#spliceInsert(command.record);
		}
		if (command.overwrite) {
			this.#replaceLog.length = 0;
			this.#overwriting = false;
		}
		const line = this.#state.lines[this.#state.cursorLine] ?? "";
		this.#setCursorCol(prevGraphemeStart(line, this.#state.cursorCol));
	}

	/** Overwrite from the cursor as Replace mode would, line breaks opening new lines. */
	#overwriteText(text: string): void {
		this.#recordUndo();
		for (const seg of segmentGraphemes(text)) {
			const lines = this.#state.lines;
			const line = lines[this.#state.cursorLine] ?? "";
			const col = this.#state.cursorCol;
			if (seg.segment === "\n" || seg.segment === "\r\n") {
				lines.splice(this.#state.cursorLine, 1, line.slice(0, col), line.slice(col));
				this.#state.cursorLine++;
				this.#setCursorCol(0);
				continue;
			}
			const end = col >= line.length ? col : nextGraphemeStart(line, col);
			lines[this.#state.cursorLine] = line.slice(0, col) + seg.segment + line.slice(end);
			this.#setCursorCol(col + seg.segment.length);
		}
		this.#afterEdit();
	}

	/** Replay one Insert session at the cursor. */
	#spliceInsert(record: VimInsertRecord): void {
		const lines = this.#state.lines;
		const { text: flat, cursor } = flatten(this.#state);
		const { start, end } = this.#expandRange(
			offsetToPos(lines, stepGraphemes(flat, cursor, record.deleteBefore, false)),
			offsetToPos(lines, stepGraphemes(flat, cursor, record.deleteAfter, true)),
		);
		if (record.text === "" && start.line === end.line && start.col === end.col) return;
		this.#recordUndo();
		const head = (lines[start.line] ?? "").slice(0, start.col);
		const tail = (lines[end.line] ?? "").slice(end.col);
		const parts = record.text.split("\n");
		const rows = parts.slice();
		rows[0] = head + rows[0];
		rows[rows.length - 1] += tail;
		lines.splice(start.line, end.line - start.line + 1, ...rows);
		this.#state.cursorLine = start.line + parts.length - 1;
		this.#setCursorCol((parts.length === 1 ? head.length : 0) + (parts.at(-1) ?? "").length);
		this.#afterEdit();
	}

	// ─── Registers ──────────────────────────────────────────────────────────

	/**
	 * Store a yank or delete the way Vim does: `"x` into that register (`"X` appends), `"_` nowhere,
	 * otherwise yanks into `"0` and deletes into `"1`–`"9` (whole lines or several) or `"-` (within a
	 * line). The unnamed register always follows. Yanks, and anything stored into `"+`/`"*`, go to
	 * the host's `onYank`.
	 */
	#writeRegister(text: string, linewise: boolean, yank: boolean, name: string | undefined): void {
		if (name === "_") return;
		if (yank || name === "+" || name === "*") this.#host.onYank?.(linewise ? `${text}\n` : text, name);
		let entry: Register = { text, linewise };
		const named = name !== undefined && /^[a-zA-Z]$/.test(name) ? name.toLowerCase() : undefined;
		if (named !== undefined) {
			const previous = this.#registers.get(named);
			if (name !== named && previous) {
				// Appending to or with whole lines keeps the result linewise, each part on its own line.
				entry =
					previous.linewise || linewise
						? { text: `${previous.text}\n${text}`, linewise: true }
						: { text: previous.text + text, linewise: false };
			}
			this.#registers.set(named, entry);
		} else if (name !== undefined && /^[0-9+*-]$/.test(name)) {
			if (name === "+" || name === "*") this.#clipboardGeneration++;
			this.#registers.set(name, entry);
		} else if (yank) {
			this.#registers.set("0", entry);
		} else if (linewise || text.includes("\n")) {
			for (let n = 9; n > 1; n--) {
				const shifted = this.#registers.get(String(n - 1));
				if (shifted) this.#registers.set(String(n), shifted);
			}
			this.#registers.set("1", entry);
		} else {
			this.#registers.set("-", entry);
		}
		this.#unnamed = entry;
	}

	/** What `p` puts from register `name` (unnamed: the last store). */
	#readRegister(name: string | undefined): Register | null {
		if (name === undefined || name === '"') return this.#unnamed;
		if (!/^[a-zA-Z0-9+*-]$/.test(name)) return null;
		return this.#registers.get(name.toLowerCase()) ?? null;
	}

	/** `"+`/`"*` named: start reading the clipboard now, so it has usually landed by the `p` that follows. */
	#prefetchClipboard(name: string): void {
		const host = this.#host;
		if (host.readClipboard === undefined) return;
		const generation = this.#clipboardGeneration;
		const pending: Promise<void> = host
			.readClipboard()
			.then(
				text => {
					// A store into the register since the read began wins; an empty read (no clipboard
					// tool, as over SSH) keeps the last `"+y`.
					if (generation !== this.#clipboardGeneration || text === "") return;
					// Clipboard text carries no type; like Vim, a trailing newline makes it linewise.
					this.#registers.set(
						name,
						text.endsWith("\n") ? { text: text.slice(0, -1), linewise: true } : { text, linewise: false },
					);
				},
				() => {},
			)
			.finally(() => {
				if (this.#clipboardRead === pending) this.#clipboardRead = null;
			});
		this.#clipboardRead = pending;
	}

	/**
	 * A `"+p` that beat its clipboard read runs once the read lands, and settles `.` then. It is
	 * dropped if another key or an edit came first: its positions were taken from the older text.
	 */
	#deferClipboard(command: Extract<VimCommand, { kind: "paste" | "visualPut" }>): boolean {
		const read = this.#clipboardRead;
		if (read === null || (command.register !== "+" && command.register !== "*")) return false;
		const serial = this.#keySerial;
		const text = this.#host.text();
		this.#putDeferred = true;
		void read.then(() => {
			if (serial !== this.#keySerial || text !== this.#host.text()) return;
			const revision = this.#revision;
			this.#load();
			this.#apply([command]);
			if (this.#revision !== revision) this.#vim.commitChange();
			else this.#vim.discardChange();
			this.#sync();
		});
		return true;
	}
}

/** The flat offset of `pos` in `lines`. */
function offsetOf(lines: readonly string[], pos: VimPosition): number {
	let offset = pos.col;
	for (let i = 0; i < pos.line && i < lines.length; i++) offset += (lines[i] ?? "").length + 1;
	return offset;
}

/**
 * Fold one field edit (`before` → `after`) into the session window. Counting original deletions
 * here keeps `delBefore`/`delAfter` exact even when typed text coincides with what was deleted.
 */
function trackSessionEdit(session: Session, before: string, after: string): void {
	const max = Math.min(before.length, after.length);
	let p = 0;
	while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
	let q = 0;
	while (q < max - p && before.charCodeAt(before.length - 1 - q) === after.charCodeAt(after.length - 1 - q)) q++;
	const removedEnd = before.length - q;
	const inserted = after.length - p - q;
	const leftCut = Math.max(0, Math.min(removedEnd, session.leftEnd) - p);
	const rightCut = Math.max(0, removedEnd - Math.max(p, session.rightStart));
	const typedCut = removedEnd - p - leftCut - rightCut;
	if (inserted > 0 && p < session.leftEnd - leftCut) {
		// An insertion inside surviving original text cannot be told from typed text; the final diff bounds it.
		session.tracked = false;
		return;
	}
	if (leftCut > 0) session.delBefore += countGraphemes(before.slice(p, p + leftCut));
	if (rightCut > 0) session.delAfter += countGraphemes(before.slice(removedEnd - rightCut, removedEnd));
	session.leftEnd -= leftCut;
	session.rightStart = session.rightStart - leftCut - typedCut + inserted;
}
