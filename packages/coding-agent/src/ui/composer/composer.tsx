/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The composer: the prompt field and its state.
 *
 * One `col` node (role `omp.editor`, `omp.editor.bash|python|btw-ask` in
 * a draft mode, tone `pending` while a turn runs) holding the `focus` row
 * (the viewing header, while a subagent is viewed), the `line` row (mode
 * chip and the `editor` field), the `bar` row (status facts the app slots
 * in, then Send or Stop) and, while completing, the `complete` popup. A Tern
 * terminal draws it natively; the terminal backend paints it with the
 * composer looks (`../styles/composer`): the field inside its shape, the
 * popup under it.
 *
 * The composer owns the draft: text and caret (edits from the field apply
 * here; deleting into a chip deletes all of it), undo, prompt history (Up on
 * an empty draft or the first row of a recalled one, Down on its last row),
 * attachment chips (a large paste collapses into one), completion
 * (`/command`, `@path`), Vim modes and submission.
 *
 * Extension hooks: {@link Composer.addKeyHandler} (consulted before the
 * composer's own bindings), {@link Composer.addPasteHandler} (consulted
 * before a paste is typed or collapsed), {@link Composer.addDecorator}
 * (styled ranges over the draft), {@link Composer.setSubmitTransform}
 * (rewrite or cancel what is sent) and the shape ({@link Composer.setShape};
 * shapes are registered with `registerComposerShape`).
 */
import {
	type Accessor,
	batch,
	computed,
	type JSXNode,
	type KeyEvent,
	type PasteEvent,
	type Signal,
	signal,
	isUiNode,
	type TextEdit,
	type UiNode,
	effect,
	untrack,
} from "@oh-my-pi/pi-tui";
import {
	type EditorTerm,
	type EditorTermRange,
	lastLayout,
	lastWrapWidth,
	layoutText,
	rowOf,
} from "@oh-my-pi/pi-tui/term/painters/editor";
import { lineStart, nextBoundary } from "@oh-my-pi/pi-tui/term/widgets/editor";
import { flattenLine, stripControl } from "@oh-my-pi/pi-tui/text/sanitize";
import type { TspEditorDecoration, TspEffect, TspSpan, TspText } from "@oh-my-pi/pi-wire";
import { terminalIdentity } from "@oh-my-pi/pi-tui/driver/session";
import "../styles/composer";
import {
	extractAtFilePrefix,
	isDirectoryCompletionValue,
	MODEL_MENTION_CONTEXT_RE,
	SKILL_NAMESPACE,
	subsequenceMatch,
} from "../../autocomplete/tokens";
import { getKeybindings } from "../../config/keybindings/keybindings";
import { fileUriForTerminal } from "../../utils/file-links";
import type { ComposerTerm } from "../styles/composer/frame";
import type { PopupItemTerm, PopupTerm } from "../styles/composer/popup";
import { type ComposerStatus, caretOverflow, composerShape } from "../styles/composer/shapes";
import {
	type Atom,
	atomRanges,
	type ChipKind,
	chipColor,
	chipLabel,
	collapsesPaste,
	type DraftImage,
	draftImageBlob,
	expandAtoms,
	type PixelSize,
	withMarkerPixelSize,
} from "./attachments";
import { untilAborted } from "@oh-my-pi/pi-utils/abortable";
import * as logger from "@oh-my-pi/pi-utils/logger";
import {
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	type Completion,
	inCompletionContext,
	inSubmittedSlashContext,
} from "./autocomplete";
import type { VimMode } from "./vim";
import { UndoHistory, type UndoStacks, VimEditor } from "./vim-editor";
import { holdText, SpaceHoldGesture, type SpaceHoldHandler } from "../../config/keybindings/space-hold";
import { MAIN_AGENT_ID } from "../../registry/agent-hub-types";
import { actionKbd, actionKey, formatTooltipKey } from "../keys/hints";

/**
 * Action prefix of the viewing header's links: `focus:<agent id>` views that agent, the main
 * agent's id ({@link MAIN_AGENT_ID}) goes back to the main session. The app handles them
 * ({@link Composer.addActionHandler}).
 */
export const FOCUS_ACTION = "focus:";

/** Live state the composer shows (set by the app). */
export interface ComposerState {
	/** A turn runs: Stop replaces Send, the composer reads as pending. */
	readonly running?: boolean;
	/**
	 * The draft's mode: code for a shell (`!` bash, `$` python) or a `/btw` side question (`?`).
	 * Natively a chip stands in for the sigil and the composer's role names the mode
	 * (`omp.editor.<kind>`; btw's is `omp.editor.btw-ask`).
	 */
	readonly shell?: { readonly kind: "bash" | "python" | "btw"; readonly excluded?: boolean };
	/** Drafts go to the `/btw` note the user clicked, as its follow-ups: role `omp.editor.btw`, a `btw` chip that leads back to the chat. */
	readonly btw?: boolean;
	/**
	 * The viewed subagent's lineage, outermost first and the viewed agent last; undefined on the main
	 * session. Natively the viewing header (`omp.composer.focus`) names it over the draft.
	 */
	readonly viewing?: readonly string[];
	/**
	 * Sending the draft skips the ask waiting above the composer: natively a `skips ask` chip leads
	 * the input and Send reads Skip & send (`omp.composer.skip`).
	 */
	readonly skipsAsk?: boolean;
}

/** Whether two composer states draw the same composer (see {@link ComposerState}). */
function sameComposerState(a: ComposerState, b: ComposerState): boolean {
	if (a.running !== b.running || a.btw !== b.btw || a.skipsAsk !== b.skipsAsk) return false;
	if (a.viewing?.length !== b.viewing?.length || a.viewing?.some((id, i) => id !== b.viewing?.[i])) return false;
	if (a.shell === b.shell) return true;
	return (
		a.shell !== undefined &&
		b.shell !== undefined &&
		a.shell.kind === b.shell.kind &&
		a.shell.excluded === b.shell.excluded
	);
}

/** Status facts the app slots into the native composer (Tern draws them in the bar). */
export interface ComposerSlots {
	/** The context meter above the field. */
	readonly context?: JSXNode;
	/** Attachment chips above the field. */
	readonly chips?: JSXNode;
	readonly model?: JSXNode;
	/** The thinking level's own chip (when the model chip does not carry it). */
	readonly effort?: JSXNode;
	readonly rate?: JSXNode;
	/** The flexible status facts (a spacer keeps Send at the end without them). */
	readonly extras?: JSXNode;
	readonly usage?: JSXNode;
	readonly dictation?: JSXNode;
}

/** A styled range over the draft (an extension's decoration). */
export interface ComposerDecoration {
	readonly from: number;
	readonly to: number;
	/** Span style tokens (native and terminal). */
	readonly s: string;
	/** Terminal-only truecolor foreground (`#rrggbb`). */
	readonly fg?: string;
	/**
	 * Terminal-only gradient over the range's characters: `stops` (`#rrggbb`) swept across them,
	 * cycling once per `periodMs` on the terminal clock (still without it).
	 */
	readonly gradient?: { readonly stops: readonly string[]; readonly periodMs?: number };
	readonly fx?: TspEffect;
	/** Terminal-only text drawn in place of the range (see {@link EditorTermRange.label}); Tern draws the range. */
	readonly label?: string;
}

/** Decorations for the draft `text`. */
export type ComposerDecorator = (text: string) => readonly ComposerDecoration[];

/** A key handler consulted before the composer's bindings; true takes the key. */
export type ComposerKeyHandler = (key: KeyEvent, composer: Composer) => boolean;

/** A paste handler consulted before the composer types or collapses the paste; true takes it. */
export type ComposerPasteHandler = (paste: PasteEvent, composer: Composer) => boolean;

/** An edit typed or pasted into the field: `[from, to)` of the old draft became `insert`. */
export interface ComposerEdit {
	readonly from: number;
	readonly to: number;
	readonly insert: string;
	/** One typed grapheme (not a paste, a deletion or a replacement). */
	readonly typed: boolean;
}

/** Hears every edit made in the field, after it applied. */
export type ComposerEditListener = (edit: ComposerEdit, composer: Composer) => void;

/** A replacement picker over `[from, to)` of the draft (spelling guesses). */
interface ReplacementPicker {
	readonly from: number;
	readonly to: number;
	readonly original: string;
}

/** Rewrites the expanded draft before it is sent; undefined cancels the submission (the draft stays). */
export type SubmitTransform = (text: string) => string | undefined;

/** A native composer action (`interrupt`, `thinking.set` with its value, …); true when handled. */
export type ComposerActionHandler = (act: string, value: string | undefined) => boolean;

/**
 * Whole-message predictions of the next prompt, most likely first: the first one the single-line
 * draft is a strict prefix of shows as ghost text; Tab or Right inserts its rest.
 */
export interface ComposerPredictions {
	/** The alternatives (reactive), undefined while none is ready. */
	choices(): readonly string[] | undefined;
	/** The ghost first painted. */
	shown(): void;
	/** The alternative at `rank` was inserted. */
	accepted(rank: number): void;
}

/**
 * Prose word completion (`WordCompletionProvider`): the rest of the word ending at the caret shows
 * as ghost text when the caret ends its line; Tab inserts it and a space, Right just the word.
 */
export interface ComposerWordCompletion {
	/** Bumped when an answer arrives that changes the last ghost (reactive). */
	revision(): number;
	getWordCompletion(lines: readonly string[], cursorLine: number, cursorCol: number): string | null;
	wordCompletionFeedback(
		lines: readonly string[],
		cursorLine: number,
		cursorCol: number,
		suggestion: string,
		accepted: boolean,
	): void;
}

/** `[Image #N…]` / `[Video #N…]` reference markers in submitted text (with a legacy ` attachment://N` after them). */
const VISION_MARKER = /\[(Image|Video) #([1-9]\d*)((?:,[^\]\n]*)?)\](?: attachment:\/\/\2(?!\d))?/g;

/** A token of the draft that shows as a chip (`/skill:name` as `🧩 name`) and is sent as `expansion`. */
export interface DraftToken {
	/** UTF-16 range of the token in the text it was found in. */
	readonly from: number;
	readonly to: number;
	/** Where the token's match ends when it reaches past `to` (prose punctuation after it stays text). */
	readonly matchEnd?: number;
	readonly label: string;
	readonly expansion: string;
	/** The chip's span style (a theme style token; `accent strong` when absent). */
	readonly s?: string;
	/** The file the chip opens (and the line), linked where the terminal draws links. */
	readonly link?: { readonly path: string; readonly line?: number };
}

/**
 * Finds the tokens of `text` that collapse into chips: in restored drafts, and while typing once
 * a token is complete (something follows it). `taken(label, expansion)` tells whether the draft
 * already holds a chip with that label standing for something else (that token must stay text).
 */
export type TokenAtomizer = (
	text: string,
	taken: (label: string, expansion: string) => boolean,
) => readonly DraftToken[];

/** One atomizer over several: their tokens in text order, the first of overlapping ones kept. */
export function combineAtomizers(...atomizers: readonly TokenAtomizer[]): TokenAtomizer {
	return (text, taken) => {
		const tokens = atomizers.flatMap(atomizer => atomizer(text, taken)).sort((a, b) => a.from - b.from);
		const out: DraftToken[] = [];
		for (const token of tokens) if (out.length === 0 || token.from >= out.at(-1)!.to) out.push(token);
		return out;
	};
}

export interface ComposerOptions {
	readonly text?: string;
	/** Prompt history, oldest first. */
	readonly history?: readonly string[];
	/** The placeholder the terminal shows on an empty draft (none by default). */
	readonly placeholder?: TspText;
	/** Shape id (`box` default; unknown ids draw as `box`). */
	readonly shape?: string;
	readonly paddingX?: number;
	readonly vim?: boolean;
	readonly disableSubmit?: boolean;
	/** Recording or transcription still owns the draft. Its own submit trigger may send; the user may not. */
	readonly dictating?: Accessor<boolean>;
	/** Ready to accept an atomic `send` (Tern). */
	readonly sendable?: boolean;
	readonly autocomplete?: AutocompleteProvider;
	/** Popup rows (default 10). */
	readonly autocompleteMaxVisible?: number;
	/** `drawn`: the caret is drawn in the text (default); `terminal`: the hardware cursor alone shows it. */
	readonly caret?: "drawn" | "terminal";
	/** `tui.imeSafeCursor`: move the box bottom border to its own row at the end of input. */
	readonly imeSafeCursor?: boolean;
	/** Symbol lookup for chip glyphs (the theme's `symbols.symbol`). */
	readonly symbol?: (key: string) => string;
	readonly onSubmit?: (text: string) => void;
}

const NATIVE_PLACEHOLDER = "What are we cooking?";
const HISTORY_LIMIT = 100;
const SHELL_SIGIL = /^\s*(?:!!?|\$\$?|\?)[ \t]?/;
const SHELL_TITLES: Record<"bash" | "python" | "btw", string> = {
	bash: "Runs in your shell",
	python: "Runs in Python",
	btw: "Asks a /btw side question",
};

/** `text` as one plain line: control sequences dropped, whitespace runs collapsed. */
function plainLine(text: string): string {
	return flattenLine(stripControl(text));
}

/** What a draft holds besides its text: atoms and attached images (with their links). */
interface DraftState {
	readonly atoms: readonly Atom[];
	readonly images: readonly DraftImage[];
	readonly links: readonly (string | undefined)[];
}

/** A recallable prompt: its text and, for a draft or a submission made here, what its chips stood for. */
interface HistoryEntry {
	readonly text: string;
	readonly state?: DraftState;
}

/** The draft a recall stepped away from: its text, caret, attachments and undo history. */
interface StashedDraft {
	readonly text: string;
	readonly cursor: number;
	readonly state: DraftState;
	readonly undo: UndoStacks;
}

/** Resolves links (file paths, URLs) for attached images that have none; `undefined` where there is none. */
export type ImageLinkResolver = (images: readonly DraftImage[]) => Promise<readonly (string | undefined)[]>;

/** See the module docs. */
export class Composer {
	/** The composer node. */
	readonly node: UiNode;
	/** The `editor` field (focus it to type). */
	field!: UiNode;

	readonly #options: ComposerOptions;
	readonly #text: Signal<string>;
	readonly #cursor: Signal<number>;
	#revision = 0;

	readonly #history = new UndoHistory();
	#typingAt = -1;
	#typedBlank = false;
	#jump: "forward" | "backward" | undefined;

	/** Newest first. */
	readonly #entries: HistoryEntry[] = [];
	#historyIndex = -1;
	#historyDraft: StashedDraft | null = null;
	/** Vim's `k`/`j` are stepping through history, at this entry (kept across edits to it, unlike {@link #historyIndex}). */
	#vimBrowse: { at: number } | null = null;
	/** Edits made to entries `k` recalled, by index, kept (as zsh keeps them) until the prompt is sent. */
	readonly #vimEdits = new Map<number, string>();
	#persistHistory: ((text: string) => void) | undefined;
	/** The last submission handed to the app's {@link onSubmit}: its recall entry waits for {@link addToHistory}. */
	#submitted: { readonly entry: HistoryEntry; readonly sent: string } | undefined;
	#linkResolver: ImageLinkResolver | undefined;
	/** The draft's atoms and attachments came from a recalled entry: recalling a plain entry clears them. */
	#recalledState = false;
	/** Bumped when {@link pendingImageLinks} change (chip links read it). */
	readonly #linksRevision = signal(0);
	/** The terminal's hint in an empty draft (the app's live composer hint). */
	readonly #placeholder = signal<TspText | undefined>(undefined);
	/** A passing state the terminal shows in the hint's place, over a prediction too (the history loading). */
	readonly #notice = signal<TspText | undefined>(undefined);
	/** What Tern shows in an empty draft (the session's title, who the draft goes to); undefined: the default. */
	readonly #nativePlaceholder = signal<TspText | undefined>(undefined);

	readonly #atoms: Signal<readonly Atom[]> = signal<readonly Atom[]>([]);
	readonly #counts: Record<ChipKind, number> = { paste: 0, image: 0, video: 0 };
	/** Images the draft's chips stand for. */
	readonly pendingImages: DraftImage[] = [];
	/** Each pending image's source link (a file path or URL), parallel to {@link pendingImages}. */
	readonly pendingImageLinks: (string | undefined)[] = [];
	/**
	 * Receives each submission (after atoms are expanded and the submit transform ran); replaces
	 * the `onSubmit` option. The app's input loop sets it.
	 */
	onSubmit: ((text: string) => void) | undefined;
	/**
	 * Receives every Vim yank, and anything stored into `"+`/`"*` (`register`), for the system
	 * clipboard; linewise text ends in a newline.
	 */
	onYank: ((text: string, register: string | undefined) => void) | undefined;
	/** Reads the system clipboard for Vim's `"+p`/`"*p`; without it they put the last `"+y`. */
	readClipboard: (() => Promise<string>) | undefined;
	/** Vim's `/` and `?`: open the prompt-history search. */
	onHistorySearch: (() => void) | undefined;
	/** Vim's `k` off the draft's top, not browsing history: true when the app took the keys (an ask waiting above). */
	onUpFromTop: (() => boolean) | undefined;
	#atomizer: TokenAtomizer | undefined;
	#autocomplete: AutocompleteProvider | undefined;
	readonly #actionHandlers: ComposerActionHandler[] = [];
	#spaceHold: SpaceHoldGesture | undefined;
	readonly #predictions = signal<ComposerPredictions | undefined>(undefined);
	readonly #words = signal<ComposerWordCompletion | undefined>(undefined);
	/** The draft a prediction insert produced: equal to one of several, Tab lists them instead. */
	#insertedPrediction: string | undefined;
	/** The open popup lists predictions (accepting replaces the whole draft). */
	#predictionPopup = false;

	readonly #completion: Signal<Completion | null> = signal<Completion | null>(null);
	#completionRequest: AbortController | undefined;
	#forceFiles = false;

	readonly #vimLayer: VimEditor;
	readonly #vimOn: Signal<boolean>;
	#vimStartMode: "insert" | "normal" = "insert";
	/** The Vim layer while Vim is on (reactive). */
	get #vim(): VimEditor | null {
		return this.#vimOn() ? this.#vimLayer : null;
	}
	readonly #state: Signal<ComposerState> = signal<ComposerState>({}, { equals: sameComposerState });
	readonly #faint = signal(false);
	readonly #status = signal<ComposerStatus | undefined>(undefined);
	readonly #shape: Signal<string>;
	readonly #paddingX: Signal<number | undefined>;
	readonly #border = signal<string | undefined>(undefined);
	readonly #borderFaint = signal(false);
	readonly #disableSubmit: Signal<boolean>;
	readonly #caret: Signal<"drawn" | "terminal">;
	readonly #slots = signal<ComposerSlots>({});
	readonly #imeSafeCursor: Signal<boolean>;

	readonly #keyHandlers: ComposerKeyHandler[] = [];
	readonly #pasteHandlers: ComposerPasteHandler[] = [];
	readonly #editListeners: ComposerEditListener[] = [];
	/** The open popup lists replacements for a range of the draft. */
	#replacing: ReplacementPicker | undefined;
	readonly #decorators = signal<readonly ComposerDecorator[]>([]);
	#submitTransform: SubmitTransform | undefined;

	constructor(options: ComposerOptions = {}) {
		this.#options = options;
		const text = options.text ?? "";
		this.#text = signal(text);
		this.#cursor = signal(text.length);
		this.#shape = signal(options.shape ?? "box");
		this.#paddingX = signal(options.paddingX);
		this.#disableSubmit = signal(options.disableSubmit === true);
		this.#caret = signal(options.caret ?? "drawn");
		this.#autocomplete = options.autocomplete;
		this.#imeSafeCursor = signal(options.imeSafeCursor === true);
		this.#placeholder.set(options.placeholder);
		for (const entry of options.history ?? []) this.addToHistory(entry);
		this.#vimOn = signal(options.vim === true);
		const composer = this;
		this.#vimLayer = new VimEditor({
			text: () => this.#text(),
			cursor: () => this.#cursor(),
			set: (text, cursor) => this.#change(0, this.#text().length, text, cursor, "vim"),
			history: this.#history,
			recordsUndo: true,
			startMode: () => this.#vimStartMode,
			layout: () => lastLayout(this.field),
			atoms: text => atomRanges(text, this.#atoms.peek()),
			historyStep: (older, count) => this.#vimHistoryStep(older, count),
			historySearch: () => this.onHistorySearch?.(),
			// `:` starts a slash command only where there is a completion source to list the commands.
			get commandLine() {
				return composer.#autocomplete ? () => composer.#typeCommandSlash() : undefined;
			},
			onYank: (text, register) => this.onYank?.(text, register),
			get readClipboard() {
				const read = composer.readClipboard;
				return read ? () => read() : undefined;
			},
		});
		if (options.vim === true) this.#vimLayer.begin();
		this.#autocompleteMaxVisible.set(options.autocompleteMaxVisible ?? 10);
		this.node = this.#view();
	}

	// ─── Draft ──────────────────────────────────────────────────────────────

	/** The draft text. */
	get text(): Accessor<string> {
		return this.#text;
	}

	/** The caret (UTF-16 offset). */
	get cursor(): Accessor<number> {
		return this.#cursor;
	}

	/** The Vim mode, or null without Vim. */
	vimMode(): VimMode | null {
		return this.#vim?.mode() ?? null;
	}

	/** Whether the completion popup is open. */
	completing(): boolean {
		return this.#completion() !== null;
	}

	/** Replace the draft (caret at its end; a new undo step). */
	setText(text: string): void {
		this.#recalledState = false;
		this.#vimBrowse = null;
		this.#vimEdits.clear();
		this.#change(0, this.#text().length, text, text.length, "edit");
	}

	/** Undo the last change. */
	undo(): void {
		const last = this.#history.undo({ text: this.#text(), cursor: this.#cursor() });
		if (!last) return;
		this.#typingAt = -1;
		this.#closeCompletion();
		this.#revision++;
		batch(() => {
			this.#text.set(last.text);
			this.#cursor.set(last.cursor);
		});
	}

	/**
	 * Replace `[from, to)` with `insert`, caret to `cursor`. Deleting into an
	 * atom widens the deletion to the whole atom. `type` changes (typed
	 * graphemes) merge into one undo step until a blank or a jump; `history`
	 * (a recall) and `vim` (Vim's own edits, undo and redo) push none.
	 */
	#change(from: number, to: number, insert: string, cursor: number, kind: "type" | "edit" | "history" | "vim"): void {
		const text = this.#text();
		if (insert === "" && from < to) {
			for (const range of atomRanges(text, this.#atoms())) {
				if (range.from < to && range.to > from) {
					from = Math.min(from, range.from);
					to = Math.max(to, range.to);
					cursor = from;
				}
			}
		}
		const next = text.slice(0, from) + insert + text.slice(to);
		const before = { text, cursor: this.#cursor() };
		if (kind === "type" || kind === "edit") {
			// Typing is one step per word with the blanks after it.
			const blank = /^\s+$/.test(insert);
			const merges = kind === "type" && from === this.#typingAt && (blank || !this.#typedBlank);
			if (!merges && next !== text) this.#history.push(before);
			this.#typedBlank = blank;
			this.#typingAt = kind === "type" ? from + insert.length : -1;
		} else if (kind === "vim") this.#typingAt = -1;
		if (next !== text || cursor !== before.cursor) this.#closeCompletion();
		if (next !== text) {
			this.#revision++;
			if (kind !== "history") this.#historyIndex = -1;
		}
		batch(() => {
			this.#text.set(next);
			this.#cursor.set(Math.max(0, Math.min(next.length, cursor)));
		});
		// Vim follows the field's own edits into its Insert session (`.` replays what it typed).
		if (kind !== "vim") this.#vim?.edited(before);
	}

	#insert(text: string, kind: "edit" | "type" = "edit"): { from: number; to: number } {
		const cursor = this.#cursor();
		const selection = this.field.fieldSelection!;
		const range = selection.range(cursor) ?? { from: cursor, to: cursor };
		selection.anchor = null;
		this.#change(range.from, range.to, text, range.from + text.length, range.from === range.to ? kind : "edit");
		return range;
	}

	/** Lines of the draft and the caret's line and column. */
	#position(): { lines: string[]; line: number; col: number; before: string } {
		const lines = this.#text().split("\n");
		let line = 0;
		let col = this.#cursor();
		while (line < lines.length - 1 && col > lines[line]!.length) col -= lines[line++]!.length + 1;
		return { lines, line, col, before: lines[line]!.slice(0, col) };
	}

	// ─── Attachments ────────────────────────────────────────────────────────

	/**
	 * The token of chip `n` of `kind` in this composer's glyphs (the symbol preset's `chip.*`, see
	 * {@link ComposerOptions.symbol}): what an attachment the app inserts ({@link insertAtom}) is labelled.
	 */
	chipLabel(kind: ChipKind, n: number): string {
		return chipLabel(kind, n, this.#options.symbol);
	}

	/** Attach `content` as a text chip at the caret; the submission carries `expansion` (default: the content). */
	insertTextAttachment(content: string, expansion: string = content): void {
		const n = ++this.#counts.paste;
		const label = this.chipLabel("paste", n);
		this.#atoms.set([
			...this.#atoms(),
			{ label, kind: "paste", n, expansion, ...(expansion !== content ? { content } : {}) },
		]);
		this.#insert(`${label} `);
	}

	/**
	 * Insert an atom labelled `label` (a chip of `kind`, a text chip by default) expanding to
	 * `expansion` on submit. An image joins {@link pendingImages} with its source `link`.
	 */
	insertAtom(
		label: string,
		expansion: string,
		options?: { kind?: ChipKind; image?: DraftImage; link?: string },
	): void {
		if (options?.image) {
			this.pendingImages.push(options.image);
			this.pendingImageLinks.push(options.link);
		}
		this.#registerAtom(label, expansion, options);
		this.#insert(`${label} `);
	}

	/** Remember `label` as an atom of the draft without inserting it (the text already holds it). */
	#registerAtom(label: string, expansion: string, options?: { kind?: ChipKind; image?: DraftImage }): void {
		const n = Number(/#(\d+)/.exec(label)?.[1] ?? 0);
		this.#atoms.set([
			...this.#atoms.peek(),
			{ label, kind: options?.kind ?? "paste", n, expansion, image: options?.image },
		]);
	}

	/** The draft with every atom (chip, token) replaced by what it stands for. */
	expandedText(): string {
		return expandAtoms(this.#text(), this.#atoms());
	}

	/**
	 * Replace the draft with restored `text` (a dequeued or detached draft), turning image markers
	 * and tokens ({@link setAtomizer}) back into chips. Pending images stay as they are.
	 */
	setCollapsedText(text: string): void {
		this.setText(this.#collapse(text));
		this.relinkImages();
	}

	/**
	 * Replace the draft with `text` and `images` without keeping the old draft in history (a
	 * rewind, a tree jump, a dialog handing its text back); references collapse as in
	 * {@link setCollapsedText}.
	 */
	setDraft(text: string, images: readonly DraftImage[] = []): void {
		this.#resetDraft();
		this.pendingImages.push(...images);
		this.pendingImageLinks.push(...images.map(() => undefined));
		this.setCollapsedText(text);
	}

	/** `[Image #N…]`/`[Video #N…]` markers of pending images back into chips, then the app's collapser. */
	#collapse(text: string): string {
		const count = this.pendingImages.length;
		const chips =
			count === 0
				? text
				: text.replace(VISION_MARKER, (match, kind: string, idx: string) => {
						const n = Number(idx);
						if (n > count) return match;
						const chipKind: ChipKind = kind === "Video" ? "video" : "image";
						const label = this.chipLabel(chipKind, n);
						this.#counts[chipKind] = Math.max(this.#counts[chipKind], n);
						// The chip stands for the marker alone: a legacy `attachment://N` after it goes.
						const marker = match.replace(/ attachment:\/\/\d+$/, "");
						this.#registerAtom(label, marker, { kind: chipKind, image: this.pendingImages[n - 1] });
						return label;
					});
		return this.#atomizeText(chips, Number.POSITIVE_INFINITY).text;
	}

	/**
	 * `text` with the tokens the atomizer finds collapsed into chips (registered as atoms), and
	 * where `caret` lands; a token ending the text is left until something follows it when
	 * `complete` is false.
	 */
	#atomizeText(text: string, caret: number, complete = true): { text: string; caret: number } {
		const atoms = this.#atoms.peek();
		const taken = (label: string, expansion: string): boolean =>
			atoms.some(atom => atom.label === label && atom.expansion !== expansion && text.includes(label));
		const tokens = this.#atomizer?.(text, taken) ?? [];
		let out = "";
		let at = 0;
		let moved = caret;
		for (const token of tokens) {
			if (token.from < at || token.to > text.length) continue;
			if (!complete && (token.matchEnd ?? token.to) === text.length) continue;
			out += text.slice(at, token.from) + token.label;
			at = token.to;
			const shrink = token.to - token.from - token.label.length;
			if (caret >= token.to) moved -= shrink;
			else if (caret > token.from) moved = out.length;
			this.#atoms.set([
				...this.#atoms.peek(),
				{
					label: token.label,
					kind: "token",
					n: 0,
					expansion: token.expansion,
					...(token.s ? { s: token.s } : {}),
					...(token.link ? { link: token.link } : {}),
				},
			]);
		}
		return at === 0 ? { text, caret } : { text: out + text.slice(at), caret: moved };
	}

	/** After an edit from the field: collapse the tokens it completed. */
	#atomizeTyped(): void {
		if (!this.#atomizer) return;
		const text = this.#text();
		const next = this.#atomizeText(text, this.#cursor(), false);
		if (next.text !== text) this.#change(0, text.length, next.text, next.caret, "history");
	}

	/** Insert `text` literally at the caret (no paste collapse). */
	insertText(text: string): void {
		this.#closeCompletion();
		this.#insert(text);
	}

	/** Move the caret to UTF-16 offset `offset` (clamped). */
	setCursor(offset: number): void {
		this.#closeCompletion();
		this.#typingAt = -1;
		this.#cursor.set(Math.max(0, Math.min(this.#text().length, offset)));
	}

	/** The completion source (extensions stack theirs through the app); `undefined` turns completion off. */
	setAutocomplete(provider: AutocompleteProvider | undefined): void {
		this.#autocomplete = provider;
		this.#closeCompletion();
		// The startup composer can already contain a token when the live providers arrive.
		if (provider && this.#text() && (!this.#vim || this.#vim.mode() === "insert")) this.#afterEdit("", false);
	}

	/**
	 * Handle native composer actions besides Send (`interrupt`, `thinking.cycle`, `thinking.set`
	 * with its value, `focus:<agentId>`, `dictation.toggle`); first handler returning true wins.
	 */
	addActionHandler(handler: ComposerActionHandler): () => void {
		this.#actionHandlers.push(handler);
		return () => {
			const at = this.#actionHandlers.indexOf(handler);
			if (at !== -1) this.#actionHandlers.splice(at, 1);
		};
	}

	readonly #passthrough = signal(false);
	readonly #maxLines = signal<number | undefined>(undefined);
	readonly #autocompleteMaxVisible = signal(10);

	/** Turn the Vim layer on or off (`tui.vimMode`); turning it on starts in the start mode. */
	setVim(on: boolean): void {
		if (this.#vimOn.peek() === on) return;
		// The first key of Vim's opening Insert session is an undo step of its own.
		this.#typingAt = -1;
		if (on) this.#vimLayer.begin();
		this.#vimOn.set(on);
	}

	/** The mode each prompt starts in under Vim (`tui.vimStartMode`): on enabling Vim and after each submit. */
	setVimStartMode(mode: "insert" | "normal"): void {
		if (this.#vimStartMode === mode) return;
		this.#vimStartMode = mode;
		// A prompt not yet begun (startup, a fresh draft) starts over in the new mode.
		if (this.#text.peek() === "") this.#vim?.begin();
	}

	/** The half-typed Vim command (`2d`, `"a`), empty when none or without Vim (reactive). */
	vimPendingText(): string {
		return this.#vim?.pendingText() ?? "";
	}

	/** Lines the Vim Visual selection spans; 0 outside Visual modes (reactive). */
	vimSelectedLines(): number {
		return this.#vim?.selectedLines() ?? 0;
	}

	/** `:` on an empty prompt: type `/` as the field would, so the command menu opens. */
	#typeCommandSlash(): void {
		this.#change(0, 0, "/", 1, "type");
		this.#afterEdit("/", false);
	}

	/**
	 * Vim's `k`/`j` past the first or last line: `count` prompts older or newer, as zsh's vi mode. An
	 * older prompt opens on its last line and a newer one on its first, so further `k`/`j` walk
	 * through it; stepping newer past the newest brings back the draft the first `k` left, with its
	 * attachments and undo history. `k` off the draft's top first offers the keys to what waits above
	 * ({@link onUpFromTop}). An edit to a recalled prompt is kept for when the steps come back to it.
	 */
	#vimHistoryStep(older: boolean, count: number): void {
		const browse = this.#vimBrowse;
		if (browse === null && older && this.#historyIndex === -1 && this.onUpFromTop?.()) return;
		if (browse !== null) {
			const text = this.#text();
			if (text !== (this.#entries[browse.at]?.text ?? "")) this.#vimEdits.set(browse.at, text);
			this.#historyIndex = browse.at;
		} else if (this.#historyIndex === -1 && !older) return;
		const from = this.#historyIndex;
		const to = older ? Math.min(from + count, this.#entries.length - 1) : Math.max(from - count, -1);
		if (to === from) return;
		this.#recall(to, older ? "up" : "down");
		if (to === -1) this.#vimBrowse = null;
		else {
			this.#vimBrowse = { at: to };
			const edited = this.#vimEdits.get(to);
			if (edited !== undefined) this.#change(0, this.#text().length, edited, edited.length, "history");
		}
		const text = this.#text();
		const lineAt = older ? text.lastIndexOf("\n") + 1 : 0;
		const lineEnd = older ? text.length : text.indexOf("\n") === -1 ? text.length : text.indexOf("\n");
		const indent = /^[ \t]*/.exec(text.slice(lineAt, lineEnd))?.[0].length ?? 0;
		this.#cursor.set(lineAt + indent);
	}

	/** Items the completion popup lists before it scrolls. */
	setAutocompleteMaxVisible(rows: number): void {
		this.#autocompleteMaxVisible.set(rows);
	}

	/** Rows the field grows to before it scrolls (`undefined`: unbounded). */
	setMaxLines(rows: number | undefined): void {
		this.#maxLines.set(rows);
	}

	/**
	 * While a `!` command's PTY owns the keyboard: a native field forwards printable keys as key
	 * events (mode `PTY`) instead of editing the draft, so the app can write them to the PTY.
	 */
	setKeyPassthrough(on: boolean): void {
		this.#passthrough.set(on);
	}

	/** The hint an empty draft shows in the terminal (`undefined`: none). */
	setPlaceholder(placeholder: TspText | undefined): void {
		this.#placeholder.set(placeholder);
	}

	/** Show `notice` in an empty draft's hint place, a prediction's included, until cleared with `undefined`. */
	setNotice(notice: TspText | undefined): void {
		this.#notice.set(notice);
	}

	/** What Tern shows in an empty draft (`undefined`: the default question). */
	setNativePlaceholder(placeholder: TspText | undefined): void {
		this.#nativePlaceholder.set(placeholder);
	}

	/** The prediction source (`undefined`: none). */
	setPredictions(predictions: ComposerPredictions | undefined): void {
		this.#predictions.set(predictions);
	}

	/** The prediction shown as ghost text: its index and the part not yet typed. */
	readonly #shownPrediction = computed((): { index: number; suffix: string } | undefined => {
		const choices = this.#predictions()?.choices();
		if (!choices?.length || this.#completion() !== null) return undefined;
		const typed = this.#text();
		if (typed.includes("\n") || this.#cursor() !== typed.length) return undefined;
		if (choices.length > 1 && typed === this.#insertedPrediction && choices.includes(typed)) return undefined;
		const index = choices.findIndex(choice => typed.length < choice.length && choice.startsWith(typed));
		return index < 0 ? undefined : { index, suffix: choices[index]!.slice(typed.length) };
	});

	/** Insert the rest of the shown prediction (never submits). */
	#acceptPrediction(): boolean {
		const shown = this.#shownPrediction();
		if (!shown) return false;
		this.#insert(shown.suffix);
		this.#insertedPrediction = this.#text();
		this.#predictions.peek()?.accepted(shown.index);
		return true;
	}

	/** Over a draft equal to one of two or more predictions: list them all, that one selected. */
	#listPredictions(): boolean {
		const choices = this.#predictions.peek()?.choices();
		const typed = this.#text();
		if (!choices || choices.length < 2 || typed.includes("\n") || this.#cursor() !== typed.length) return false;
		const index = choices.indexOf(typed);
		if (index < 0) return false;
		this.#closeCompletion();
		this.#predictionPopup = true;
		this.#completion.set({ items: choices.map(value => ({ value, label: value })), prefix: "", selected: index });
		return true;
	}

	/** The prose word-completion engine (`spelling.autocomplete`); `undefined`: none. */
	setWordCompletion(source: ComposerWordCompletion | undefined): void {
		this.#words.set(source);
	}

	/** The word completion shown as ghost text at the end of the caret's line (never over a prediction). */
	readonly #shownWord = computed((): string | undefined => {
		const source = this.#words();
		if (!source || this.#completion() !== null || this.#shownPrediction()) return undefined;
		source.revision();
		const at = this.#wordQuery();
		if (!at) return undefined;
		return untrack(() => source.getWordCompletion(at.lines, at.line, at.col)) ?? undefined;
	});

	/** The draft as lines and the caret's line/column, when the caret ends its line. */
	#wordQuery(): { lines: string[]; line: number; col: number } | undefined {
		const text = this.#text();
		const cursor = this.#cursor();
		const end = text.indexOf("\n", cursor);
		if (end !== -1 && end !== cursor) return undefined;
		if (end === -1 && cursor !== text.length) return undefined;
		const before = text.slice(0, cursor).split("\n");
		return { lines: text.split("\n"), line: before.length - 1, col: before.at(-1)!.length };
	}

	/** Insert the shown word completion; Tab adds a space after it. */
	#acceptWord(space: boolean): boolean {
		const word = this.#shownWord();
		const at = word && this.#wordQuery();
		if (!word || !at) return false;
		this.#words.peek()?.wordCompletionFeedback(at.lines, at.line, at.col, word, true);
		this.#insert(space ? `${word} ` : word);
		return true;
	}

	/**
	 * The dim ghost at the end of the caret's line, first that applies: the selected completion's
	 * hint; the shown prediction; over a draft equal to one of several predictions, how many more
	 * Tab lists; the provider's argument hint; the word completion.
	 */
	readonly #ghost = computed((): string | undefined => {
		const at = this.#wordQuery();
		if (!at) return undefined;
		const open = this.#completion();
		if (open) return this.#predictionPopup || this.#replacing ? undefined : open.items[open.selected]?.hint;
		const prediction = this.#shownPrediction();
		if (prediction) return prediction.suffix;
		const choices = this.#predictions()?.choices();
		const typed = this.#text();
		if (choices && choices.length > 1 && !typed.includes("\n") && choices.includes(typed)) {
			const tab = actionKey("tui.input.tab");
			if (tab) return ` ${tab} ${choices.length - 1} more`;
		}
		const provider = this.#autocomplete;
		const hint = provider?.getInlineHint && untrack(() => provider.getInlineHint!(at.lines, at.line, at.col));
		return hint || this.#shownWord();
	});

	/** Whether Escape is Vim's (leave Insert/Visual mode, cancel a half-typed command) rather than the app's. */
	vimConsumesEscape(): boolean {
		return this.#vim?.consumesEscape() ?? false;
	}

	/**
	 * Push-to-talk on a held key: `keys` (KeyEvent ids) recognized as held by their auto-repeat
	 * cadence start `handler`; `undefined` turns it off.
	 */
	setSpaceHold(keys: readonly string[], handler: SpaceHoldHandler | undefined): void {
		if (!handler) {
			this.#spaceHold?.dispose();
			this.#spaceHold = undefined;
			return;
		}
		this.#spaceHold ??= new SpaceHoldGesture(
			count => this.deleteBeforeCursor(count),
			() => !this.#jump && !this.completing() && (this.vimMode() === null || this.vimMode() === "insert"),
		);
		this.#spaceHold.keys = keys;
		this.#spaceHold.handler = handler;
	}

	// ─── Dictation target ───────────────────────────────────────────────────

	readonly #volatile = signal<{ from: number; text: string } | undefined>(undefined);
	readonly #caretGlyph = signal<string | undefined>(undefined);

	/** Show not-yet-final dictated `text` at the caret (replacing the previous volatile text). */
	setVolatileText(text: string): void {
		const current = this.#volatile.peek();
		const from = current?.from ?? this.#cursor();
		const to = current ? current.from + current.text.length : from;
		this.#change(from, to, text, from + text.length, "history");
		this.#volatile.set({ from, text });
	}

	/** Drop the volatile text. */
	clearVolatileText(): void {
		const current = this.#volatile.peek();
		if (!current) return;
		this.#change(current.from, current.from + current.text.length, "", current.from, "history");
		this.#volatile.set(undefined);
	}

	/** Replace the volatile text with final `text` (one undo step). */
	commitVolatileText(text: string): void {
		const current = this.#volatile.peek();
		const from = current?.from ?? this.#cursor();
		if (current) this.#change(from, from + current.text.length, "", from, "history");
		this.#volatile.set(undefined);
		this.#change(from, from, text, from + text.length, "edit");
	}

	/** Delete `count` UTF-16 units before the caret. */
	deleteBeforeCursor(count: number): void {
		const at = this.#cursor();
		const from = Math.max(0, at - count);
		if (from < at) this.#change(from, at, "", from, "edit");
	}

	/** Draw `glyph` in place of the caret (push-to-talk's mic); `undefined` restores the caret. */
	setCaretGlyph(glyph: string | undefined): void {
		this.#caretGlyph.set(glyph);
	}

	/** The app's token chips (`/skill:name`): collapsed while typing and in restored drafts. */
	setAtomizer(atomizer: TokenAtomizer | undefined): void {
		this.#atomizer = atomizer;
	}

	/** The attachments the draft's chips stand for, in insertion order (token chips are not attachments). */
	chips(): readonly Atom[] {
		const text = this.#text();
		return this.#atoms().filter(atom => atom.kind !== "token" && text.includes(atom.label));
	}

	/**
	 * A paste into the field: the app's handlers first ({@link addPasteHandler}), then a large
	 * one collapses into a text chip; anything else is left for the field to type.
	 */
	#onPaste(paste: PasteEvent): boolean {
		this.#jump = undefined;
		for (const handler of this.#pasteHandlers) if (handler(paste, this)) return true;
		const text = paste.text.replace(/\r\n?/g, "\n");
		if (!collapsesPaste(text)) return false;
		this.#closeCompletion();
		this.insertTextAttachment(text);
		return true;
	}

	// ─── History ────────────────────────────────────────────────────────────

	/**
	 * Replace the recall history with `entries` (newest first) and persist every later prompt
	 * through `persist` (the prompt history store).
	 */
	setHistory(entries: readonly string[], persist?: (text: string) => void): void {
		this.#entries.length = 0;
		this.#entries.push(...entries.slice(0, HISTORY_LIMIT).map(text => ({ text })));
		this.#historyIndex = -1;
		this.#persistHistory = persist;
	}

	/**
	 * Remember a prompt for Up/Down recall (and in the history store). The text of the last
	 * submission the app received recalls as that draft, chips and attachments included.
	 */
	addToHistory(text: string): void {
		const trimmed = text.trim();
		if (trimmed === "") return;
		this.#persistHistory?.(trimmed);
		const submitted = this.#submitted;
		if (submitted && submitted.sent.trim() === trimmed) {
			this.#submitted = undefined;
			this.#remember(submitted.entry);
			return;
		}
		if (this.#entries[0]?.text === text && !this.#entries[0].state) return;
		this.#remember({ text });
	}

	#remember(entry: HistoryEntry): void {
		this.#entries.unshift(entry);
		if (this.#entries.length > HISTORY_LIMIT) this.#entries.pop();
	}

	/** The draft's atoms (those still in `text`), images and links. */
	#draftState(text: string): DraftState {
		return {
			atoms: this.#atoms.peek().filter(atom => text.includes(atom.label)),
			images: [...this.pendingImages],
			links: [...this.pendingImageLinks],
		};
	}

	/**
	 * Clear the draft, keeping it (chips and attachments included) recallable with Up unless
	 * `recall` is false. A cleared draft is never written to the history store.
	 */
	clearDraft(options?: { readonly recall?: boolean }): void {
		const text = this.#text();
		if (options?.recall !== false && text.trim() !== "") this.#remember({ text, state: this.#draftState(text) });
		this.#resetDraft();
	}

	/**
	 * Resolve links for attached images restored without one (a recalled or restored draft), so
	 * their chips link to the image again; `undefined` turns it off.
	 */
	setImageLinkResolver(resolver: ImageLinkResolver | undefined): void {
		this.#linkResolver = resolver;
		this.relinkImages();
	}

	/** Resolve the links {@link pendingImageLinks} lacks (see {@link setImageLinkResolver}). */
	relinkImages(): void {
		this.#linksRevision.set(this.#linksRevision.peek() + 1);
		const resolver = this.#linkResolver;
		const missing = this.pendingImages.filter((_, i) => this.pendingImageLinks[i] === undefined);
		if (!resolver || missing.length === 0) return;
		void resolver(missing).then(
			links => {
				let changed = false;
				missing.forEach((image, i) => {
					const at = this.pendingImages.indexOf(image);
					const link = links[i];
					if (at === -1 || link === undefined || this.pendingImageLinks[at] !== undefined) return;
					this.pendingImageLinks[at] = link;
					changed = true;
				});
				if (changed) this.#linksRevision.set(this.#linksRevision.peek() + 1);
			},
			() => {},
		);
	}

	/** The link of an image chip's attachment (reactive), if it has one. */
	imageLink(atom: Atom): string | undefined {
		this.#linksRevision();
		if (!atom.image) return undefined;
		const at = this.pendingImages.indexOf(atom.image);
		return at === -1 ? undefined : this.pendingImageLinks[at];
	}

	/**
	 * Make `image`, `size` pixels, what image chip `atom` stands for (Tern's annotator handed back
	 * the annotated picture, maybe cropped or grown): it takes the old image's place among
	 * {@link pendingImages}, its link is resolved anew, and the chip keeps its label and number
	 * while its marker states the new size. An atom no longer in the draft, or whose image is no
	 * longer pending, is ignored.
	 */
	replaceImage(atom: Atom, image: DraftImage, size: PixelSize): void {
		const atoms = this.#atoms.peek();
		const index = atoms.indexOf(atom);
		const at = atom.image ? this.pendingImages.indexOf(atom.image) : -1;
		if (index === -1 || at === -1) return;
		this.pendingImages[at] = image;
		this.pendingImageLinks[at] = undefined;
		const expansion = atom.expansion === undefined ? undefined : withMarkerPixelSize(atom.expansion, size);
		this.#atoms.set(atoms.with(index, { ...atom, image, expansion }));
		this.relinkImages();
	}

	/** Make `state` the draft's atoms and attachments (chip numbering continues after them). */
	#restoreState(state: DraftState | undefined): void {
		const atoms = state?.atoms ?? [];
		this.#atoms.set(atoms);
		for (const kind of ["paste", "image", "video"] as const)
			this.#counts[kind] = Math.max(0, ...atoms.filter(atom => atom.kind === kind).map(atom => atom.n));
		this.pendingImages.splice(0, this.pendingImages.length, ...(state?.images ?? []));
		this.pendingImageLinks.splice(0, this.pendingImageLinks.length, ...(state?.links ?? []));
		this.relinkImages();
	}

	#resetDraft(): void {
		this.#jump = undefined;
		this.#history.clear();
		this.#typingAt = -1;
		this.#historyIndex = -1;
		this.#historyDraft = null;
		this.#vimBrowse = null;
		this.#vimEdits.clear();
		this.#closeCompletion();
		this.#revision++;
		this.#atoms.set([]);
		this.#recalledState = false;
		for (const kind of ["paste", "image", "video"] as const) this.#counts[kind] = 0;
		this.pendingImages.length = 0;
		this.pendingImageLinks.length = 0;
		this.#linksRevision.set(this.#linksRevision.peek() + 1);
		batch(() => {
			this.#text.set("");
			this.#cursor.set(0);
		});
		// Every prompt starts in Vim's start mode.
		this.#vim?.begin();
	}

	/** Load history entry `index` (−1: the draft browsing started from). Up opens a tall entry at its top. */
	#recall(index: number, from: "up" | "down"): void {
		if (this.#historyIndex === -1) {
			const text = this.#text();
			this.#historyDraft = {
				text,
				cursor: this.#cursor(),
				state: this.#draftState(text),
				undo: this.#history.save(),
			};
		}
		this.#historyIndex = index;
		const draft = index === -1 ? this.#historyDraft : null;
		const entry = draft ?? this.#entries[index] ?? { text: "" };
		const text = entry.text;
		const tall =
			text.includes("\n") || layoutText(text, lastWrapWidth(this.field) ?? Number.MAX_SAFE_INTEGER).length > 1;
		const cursor = draft ? draft.cursor : from === "up" && tall ? 0 : text.length;
		this.#history.clear();
		this.#typingAt = -1;
		batch(() => {
			// A plain entry (a prompt from the store) keeps what is attached, unless a recalled entry put it there.
			if (draft || entry.state || this.#recalledState) this.#restoreState(entry.state);
			this.#recalledState = !draft && entry.state !== undefined;
			this.#change(0, this.#text().length, text, cursor, "history");
		});
		// Back on the draft: its undo history too.
		if (draft) this.#history.restore(draft.undo);
	}

	#caretRow(): { row: number; rows: number } {
		const rows = lastLayout(this.field);
		return { row: rowOf(rows, this.#cursor()), rows: rows.length };
	}

	#historyUp(): boolean {
		// Out to what waits above (an ask) first, as Vim's `k` does.
		if (this.#historyIndex === -1 && this.#caretRow().row === 0 && this.onUpFromTop?.()) return true;
		if (this.#historyIndex === -1 && this.#text() !== "") return false;
		if (this.#historyIndex > -1 && this.#caretRow().row !== 0) return false;
		if (this.#historyIndex + 1 < this.#entries.length) this.#recall(this.#historyIndex + 1, "up");
		return true;
	}

	#historyDown(): boolean {
		if (this.#historyIndex === -1) return false;
		const at = this.#caretRow();
		if (at.row !== at.rows - 1) return false;
		this.#recall(this.#historyIndex - 1, "down");
		return true;
	}

	// ─── Completion ─────────────────────────────────────────────────────────

	#closeCompletion(): void {
		this.#predictionPopup = false;
		this.#replacing = undefined;
		this.#completionRequest?.abort();
		this.#completionRequest = undefined;
		this.#forceFiles = false;
		if (this.#completion() !== null) this.#completion.set(null);
	}

	/** Ask the provider about the token before the caret; a request the text moved past is dropped. */
	async #complete(explicitTab = false, at = this.#position(), force = false): Promise<void> {
		const provider = this.#autocomplete;
		if (!provider) return;
		const { lines, line, col, before } = at;
		const revision = this.#revision;
		const cursor = this.#cursor();
		this.#completionRequest?.abort();
		const controller = new AbortController();
		this.#completionRequest = controller;
		const { signal } = controller;
		const current = () =>
			this.#completionRequest === controller &&
			!signal.aborted &&
			revision === this.#revision &&
			cursor === this.#cursor();
		const show = (result: AutocompleteSuggestions | null) => {
			if (!current()) return;
			if (!result?.items.length) {
				this.#completion.set(null);
				return;
			}
			const open = this.#completion.peek();
			const selected = open?.prefix === result.prefix ? open.items[open.selected]?.value : undefined;
			const kept = selected === undefined ? -1 : result.items.findIndex(item => item.value === selected);
			this.#completion.set({
				items: result.items,
				prefix: result.prefix,
				selected: Math.max(0, kept),
				chosen: kept >= 0 && open?.chosen,
				revision,
			});
		};

		try {
			const commandName = inSubmittedSlashContext(before, lines, line) && !before.trimStart().includes(" ");
			// A second Tab on an @ token with no selectable row must be able to start
			// the immediate directory listing even if a slow fuzzy walk is still running.
			const regular =
				!force &&
				(!explicitTab ||
					((commandName || extractAtFilePrefix(before) === null) && inCompletionContext(before, lines, line)));
			this.#forceFiles = !regular;
			if (regular && commandName && provider.trySyncSlashCompletion) {
				const result = provider.trySyncSlashCompletion(before);
				if (result) {
					show(result);
					return;
				}
			}
			if (regular && MODEL_MENTION_CONTEXT_RE.test(before) && provider.trySyncModelMentionCompletion) {
				const mention = provider.trySyncModelMentionCompletion(lines, line, col);
				if (mention.kind !== "unhandled") {
					show(mention.kind === "matched" ? mention.suggestions : null);
					if (mention.pending) {
						await untilAborted(signal, mention.pending);
						if (!current()) return;
						const settled = provider.trySyncModelMentionCompletion(lines, line, col);
						show(settled.kind === "matched" ? settled.suggestions : null);
					}
					return;
				}
			}

			// Coalesce an input batch before starting I/O. A subsequent batch cancels the
			// running lookup; even providers that ignore abort cannot publish old rows.
			await Promise.resolve();
			if (!current()) return;
			const suggest = () =>
				provider.getSuggestions(lines, line, col, signal, partial => {
					if (partial.items.length) show(partial);
				});
			if (regular) {
				const result = await suggest();
				if (!current()) return;
				if (result?.items.length || !explicitTab || commandName || !provider.getForceFileSuggestions) {
					show(result);
					return;
				}
			}
			if (provider.shouldTriggerFileCompletion?.(lines, line, col) === false) {
				show(null);
				return;
			}
			this.#forceFiles = true;
			const files = provider.getForceFileSuggestions
				? await provider.getForceFileSuggestions(lines, line, col, signal)
				: await suggest();
			show(files);
		} catch (error) {
			if (current()) {
				logger.debug("Autocomplete provider failed", { error: String(error) });
				show(null);
			}
		} finally {
			if (this.#completionRequest === controller) {
				this.#completionRequest = undefined;
				if (!this.#completion.peek()) this.#forceFiles = false;
			}
		}
	}

	/** Accept the displayed item. Only Enter can submit; Tab and pointer picks complete in place. */
	#accept(open: Completion, via: "enter" | "complete", index = open.selected): void {
		const item = open.items[index];
		if (this.#completion() !== open || !item) return;
		const value = item.value;
		const replacing = this.#replacing;
		if (replacing) {
			this.#closeCompletion();
			if (this.#text().slice(replacing.from, replacing.to) === replacing.original)
				this.replaceRange(replacing.from, replacing.to, value);
			return;
		}
		if (this.#predictionPopup) {
			this.#closeCompletion();
			this.#change(0, this.#text().length, value, value.length, "edit");
			this.#insertedPrediction = value;
			const rank = this.#predictions.peek()?.choices()?.indexOf(value) ?? -1;
			if (rank >= 0) this.#predictions.peek()?.accepted(rank);
			return;
		}
		const provider = this.#autocomplete;
		if (!provider) return;
		const { lines, line, col, before } = this.#position();
		const enter = via === "enter";
		const slash = inSubmittedSlashContext(before, lines, line);
		const name =
			slash &&
			open.prefix.trimStart().startsWith("/") &&
			!/\s/.test(before.trimStart()) &&
			!value.startsWith("/") &&
			!value.startsWith('"');
		const typedArg =
			slash &&
			col === lines[line]!.length &&
			open.prefix.trimEnd() !== "" &&
			value.trimEnd() === open.prefix.trimEnd() &&
			!item.hint?.replace(/\[[^\]]*]/g, "").includes("<");
		// A pending refresh can leave old rows on screen. Never apply one to different text.
		if (open.revision !== this.#revision || (enter && ((!open.chosen && item.descriptionMatch) || typedArg))) {
			this.#closeCompletion();
			if (enter) this.submit();
			return;
		}
		const run = enter && name && value !== SKILL_NAMESPACE && this.#cursor() === this.#text().length;
		const result = provider.applyCompletion(lines, line, col, item, open.prefix);
		this.#closeCompletion();
		const text = result.lines.join("\n");
		let cursor = result.cursorCol;
		for (let i = 0; i < result.cursorLine; i++) cursor += (result.lines[i]?.length ?? 0) + 1;
		this.#change(0, this.#text().length, text, cursor, "edit");
		this.#atomizeTyped();
		result.onApplied?.();
		if (run) this.submit();
		else if (name) void this.#complete();
		else if (isDirectoryCompletionValue(value)) {
			if (open.prefix.startsWith("@")) void this.#complete();
			else if (!enter) void this.#complete(true);
		}
	}

	/** After an edit from the field: open, refresh or leave the popup. */
	#afterEdit(insert: string, deleted: boolean, force = false, previous?: Completion | null): void {
		const provider = this.#autocomplete;
		if (!provider) return;
		const at = this.#position();
		if (!deleted && insert.length === 1 && provider.trySyncInlineReplace) {
			let replacement: { replaceLen: number; insert: string } | null = null;
			try {
				replacement = provider.trySyncInlineReplace(at.before);
			} catch (error) {
				logger.debug("Autocomplete inline replacement failed", { error: String(error) });
			}
			if (
				replacement &&
				Number.isInteger(replacement.replaceLen) &&
				replacement.replaceLen >= 0 &&
				replacement.replaceLen <= at.col
			) {
				const cursor = this.#cursor();
				const start = cursor - replacement.replaceLen;
				// The user's keystroke already recorded this undo step.
				this.#change(start, cursor, replacement.insert, start + replacement.insert.length, "history");
				this.#typingAt = -1;
				return;
			}
		}
		// While a fuzzy walk refreshes, previously offered files that still match the extended
		// token can be picked immediately. Never re-anchor rows across whitespace or a new `@`.
		if (!deleted && previous?.prefix.startsWith("@")) {
			const token = extractAtFilePrefix(at.before);
			if (token === previous.prefix + insert) {
				const query = token.toLowerCase();
				const items = previous.items.filter(item => subsequenceMatch(query, item.value.toLowerCase()));
				if (items.length) this.#completion.set({ items, prefix: token, selected: 0, revision: this.#revision });
			}
		}
		if (force && at.before && !/\s$/.test(at.before)) void this.#complete(false, at, true);
		else if (inCompletionContext(at.before, at.lines, at.line)) void this.#complete(false, at);
	}

	// ─── Input ──────────────────────────────────────────────────────────────

	#onEdit(event: TextEdit): void {
		this.#jump = undefined;
		const text = this.#text();
		if (event.len !== text.length) return;
		if (event.from === event.to && event.text === "") {
			const before = { text, cursor: this.#cursor() };
			if (event.cursor !== before.cursor) this.#closeCompletion();
			this.#typingAt = -1;
			this.#cursor.set(Math.max(0, Math.min(text.length, event.cursor)));
			// A caret move inside a Vim Insert session splits it, as an arrow key does in Vim.
			this.#vim?.edited(before);
			return;
		}
		const typed =
			!event.paste &&
			event.from === event.to &&
			event.cursor === event.from + event.text.length &&
			[...new Intl.Segmenter().segment(event.text)].length === 1;
		const force = this.#forceFiles;
		const previous = event.from === this.#cursor() ? this.#completion.peek() : null;
		this.#change(event.from, event.to, event.text, event.cursor, typed ? "type" : "edit");
		this.#atomizeTyped();
		// Pasted text is content, not a request to complete: a trailing `@name` must not turn the
		// next Enter into a file pick (#20681). Tab still completes it explicitly.
		if (event.paste) this.#closeCompletion();
		else this.#afterEdit(event.text, event.from < event.to, force, previous);
		this.#notifyEdit({ from: event.from, to: event.to, insert: event.text, typed });
	}

	#notifyEdit(edit: ComposerEdit): void {
		for (const listener of this.#editListeners.slice()) listener(edit, this);
	}

	/** Ctrl+] / Ctrl+Alt+] reads the next printable key as a target, not an insertion. */
	#finishJump(key: KeyEvent): boolean {
		const direction = this.#jump;
		if (!direction) return false;
		this.#jump = undefined;
		const kb = getKeybindings();
		if (kb.matches(key, "tui.editor.jumpForward") || kb.matches(key, "tui.editor.jumpBackward")) return true;
		if (!key.text) return false; // A control key cancels the pending jump and keeps its usual meaning.
		const cursor = this.#cursor();
		const text = this.#text();
		const target =
			direction === "forward"
				? text.indexOf(key.text, cursor + 1)
				: cursor > 0
					? text.lastIndexOf(key.text, cursor - 1)
					: -1;
		this.#closeCompletion();
		this.#typingAt = -1;
		this.field.fieldSelection!.anchor = null;
		if (target >= 0) this.#cursor.set(target);
		return true;
	}

	/** With Shift+Enter as submit, backslash + newline-Enter submits even from a legacy terminal. */
	#backslashSubmit(key: KeyEvent): boolean {
		if (key.id !== "enter" || this.completing() || this.#disableSubmit() || this.#options.dictating?.()) return false;
		const kb = getKeybindings();
		const cursor = this.#cursor();
		if (
			cursor === 0 ||
			this.#text()[cursor - 1] !== "\\" ||
			!kb.matchesId("shift+enter", "tui.input.submit") ||
			(key.raw !== "\n" && (kb.matches(key, "tui.input.submit") || !kb.matches(key, "tui.input.newLine")))
		)
			return false;
		this.deleteBeforeCursor(1);
		this.submit();
		return true;
	}

	#onKey(key: KeyEvent): boolean {
		if (key.kind === "release") return false;
		if (this.#options.dictating?.() && getKeybindings().matches(key, "tui.input.submit")) return true;
		const hold = this.#spaceHold;
		if (hold) {
			const typed = holdText(key);
			const step = hold.process(key.id, typed?.length ?? 0);
			if (step === "swallow") return true;
			if (step === "type" && typed !== undefined) {
				const force = this.#forceFiles;
				const previous = this.#completion.peek();
				const { from, to } = this.#insert(typed, "type");
				hold.recordTyped(typed.length);
				this.#atomizeTyped();
				this.#afterEdit(typed, from < to, force, previous);
				this.#notifyEdit({ from, to, insert: typed, typed: from === to });
				return true;
			}
		}
		// An invisible, pending lookup must not reopen a popup after the user cancelled it.
		if (this.#completionRequest && !this.completing() && getKeybindings().matches(key, "tui.select.cancel"))
			this.#closeCompletion();
		for (const handler of this.#keyHandlers) if (handler(key, this)) return true;
		return this.handleDraftKey(key);
	}

	/** Editor-local keys, without the app shortcuts that can replace a dialog owning the draft. */
	handleDraftKey(key: KeyEvent): boolean {
		if (key.kind === "release") return false;
		if (this.#finishJump(key)) return true;
		const vim = this.#vim;
		if (vim) {
			if (vim.mode() === "insert" && (key.id === "escape" || key.id === "ctrl+[") && this.#completion() !== null) {
				this.#closeCompletion();
				return true;
			}
			if (vim.mode() !== "insert") this.#typingAt = -1;
			if (vim.handle(key)) {
				if (vim.mode() !== "insert") this.#closeCompletion();
				return true;
			}
		}
		if (this.#backslashSubmit(key)) return true;
		const bindings = getKeybindings();
		const submit = bindings.matches(key, "tui.input.submit");
		const tab = bindings.matches(key, "tui.input.tab");
		const right = bindings.matches(key, "tui.editor.cursorRight");
		const open = this.#completion();
		if (open) {
			if (bindings.matches(key, "tui.select.cancel")) {
				this.#closeCompletion();
				return true;
			}
			const count = open.items.length;
			let selected: number;
			if (bindings.matches(key, "tui.select.up")) selected = (open.selected + count - 1) % count;
			else if (bindings.matches(key, "tui.select.down")) selected = (open.selected + 1) % count;
			else if (bindings.matches(key, "tui.select.pageUp"))
				selected = Math.max(0, open.selected - this.#autocompleteMaxVisible());
			else if (bindings.matches(key, "tui.select.pageDown"))
				selected = Math.min(count - 1, open.selected + this.#autocompleteMaxVisible());
			else {
				if (submit || key.raw === "\n") {
					this.#accept(open, "enter");
					return true;
				}
				const atEnd =
					right &&
					!this.field.fieldSelection?.range(this.#cursor()) &&
					(this.#cursor() === this.#text().length || this.#text()[this.#cursor()] === "\n");
				if (tab || atEnd) {
					this.#accept(open, "complete");
					return true;
				}
				return false;
			}
			this.#completion.set({ ...open, selected, chosen: true });
			return true;
		}
		if (submit && key.raw !== "\n") {
			this.submit();
			return true;
		}
		if (tab) {
			if (this.#acceptPrediction() || this.#listPredictions() || this.#acceptWord(true)) return true;
			void this.#complete(true);
			return true;
		}
		if (right && this.field.fieldSelection!.anchor === null)
			return this.#acceptPrediction() || this.#acceptWord(false);
		if (bindings.matches(key, "tui.editor.cursorUp")) return this.#historyUp();
		if (bindings.matches(key, "tui.editor.cursorDown")) return this.#historyDown();
		if (bindings.matches(key, "tui.editor.jumpForward")) this.#jump = "forward";
		else if (bindings.matches(key, "tui.editor.jumpBackward")) this.#jump = "backward";
		else return false;
		return true;
	}

	/** The app.exit chord also forward-deletes in a non-empty draft, before any lower-priority binding. */
	deleteCharForward(): void {
		const cursor = this.#cursor();
		const text = this.#text();
		const selection = this.field.fieldSelection!;
		const range = selection.range(cursor);
		const from = range?.from ?? cursor;
		const to = range?.to ?? nextBoundary(text, cursor);
		if (from === to) return;
		selection.anchor = null;
		this.#onEdit({ from, to, text: "", cursor: from, len: text.length });
	}

	/** Send the draft: atoms expanded, the submit transform applied, then the draft cleared into history. */
	submit(): void {
		if (this.#disableSubmit()) return;
		const raw = this.#text();
		if (raw.trim() === "" && !this.onSubmit) return;
		let text = expandAtoms(raw, this.#atoms());
		if (this.#submitTransform) {
			const next = this.#submitTransform(text);
			if (next === undefined) return;
			text = next;
		}
		const entry: HistoryEntry = { text: raw, state: this.#draftState(raw) };
		// The app's handler records what it accepted (`addToHistory`); without one the draft is recorded here.
		if (this.onSubmit) this.#submitted = { entry, sent: text };
		else {
			this.#persistHistory?.(text.trim());
			this.#remember(entry);
		}
		// The handler takes the draft's images (and compacts them against the text's markers).
		const images = this.pendingImages.splice(0);
		const links = this.pendingImageLinks.splice(0);
		this.#resetDraft();
		this.pendingImages.push(...images);
		this.pendingImageLinks.push(...links);
		(this.onSubmit ?? this.#options.onSubmit)?.(text);
	}

	#nativeSendable(): boolean {
		return (
			this.#options.sendable !== false &&
			!this.#disableSubmit() &&
			!this.#passthrough() &&
			!this.#options.dictating?.()
		);
	}

	/** A Tern `send`: `text` goes through the submission path; the draft stays for local recall. */
	#send(text: string): void {
		if (!this.#nativeSendable() || text.trim() === "") return;
		this.clearDraft();
		this.setCollapsedText(text);
		this.submit();
	}

	/** The typed part a popup item's label starts with, lowercased (marked natively): the token's last path segment, without its sigil. */
	#completionMark(prefix: string): string {
		let typed = prefix;
		if (typed.startsWith("@")) typed = extractAtFilePrefix(untrack(() => this.#position()).before) ?? typed;
		typed = typed.replace(/^[/@:#$^]"?/, "");
		return typed.slice(typed.lastIndexOf("/") + 1).toLowerCase();
	}

	// ─── Look and state ─────────────────────────────────────────────────────

	setState(state: ComposerState): void {
		this.#state.set(state);
	}

	/** Its keys are away at an ask above: the terminal dims the composer, Tern folds it. */
	setFaint(faint: boolean): void {
		this.#faint.set(faint);
	}

	/** Status content for shapes that show one in their top chrome. */
	setStatus(status: ComposerStatus | undefined): void {
		this.#status.set(status);
	}

	/** The shape (a registered id; unknown ids draw as `box`). */
	setShape(id: string, paddingX?: number): void {
		batch(() => {
			this.#shape.set(id);
			this.#paddingX.set(paddingX);
		});
	}

	/**
	 * The border's color (the app colors it by mode): a theme color key or a `#rrggbb` hex;
	 * `faint` dims it (a focused subagent's view).
	 */
	setBorderColor(color: string | undefined, faint = false): void {
		batch(() => {
			this.#border.set(color);
			this.#borderFaint.set(faint);
		});
	}

	/** `drawn`: the caret is drawn in the text; `terminal`: the hardware cursor alone shows it. */
	setCaret(caret: "drawn" | "terminal"): void {
		this.#caret.set(caret);
	}

	/** `tui.imeSafeCursor`: move the box bottom border to its own row at the end of input. */
	setImeSafeCursor(enabled: boolean): void {
		this.#imeSafeCursor.set(enabled);
	}

	setDisableSubmit(disabled: boolean): void {
		this.#disableSubmit.set(disabled);
	}

	/** The app's status facts in the native composer. */
	setSlots(slots: ComposerSlots): void {
		this.#slots.set(slots);
	}

	// ─── Extension hooks ────────────────────────────────────────────────────

	/** Consult `handler` for every key before the composer's bindings; returns its removal. */
	addKeyHandler(handler: ComposerKeyHandler): () => void {
		this.#keyHandlers.push(handler);
		return () => {
			const at = this.#keyHandlers.indexOf(handler);
			if (at !== -1) this.#keyHandlers.splice(at, 1);
		};
	}

	/** Consult `handler` for every paste into the field before the composer types or collapses it; returns its removal. */
	addPasteHandler(handler: ComposerPasteHandler): () => void {
		this.#pasteHandlers.push(handler);
		return () => {
			const at = this.#pasteHandlers.indexOf(handler);
			if (at !== -1) this.#pasteHandlers.splice(at, 1);
		};
	}

	/** Hear every edit made in the field (typing, pastes, deletions); returns its removal. */
	addEditListener(listener: ComposerEditListener): () => void {
		this.#editListeners.push(listener);
		return () => {
			const at = this.#editListeners.indexOf(listener);
			if (at !== -1) this.#editListeners.splice(at, 1);
		};
	}

	/**
	 * Replace `[from, to)` of the draft with `insert` (one undo step); a caret after the range
	 * moves with it, one inside it goes to the replacement's end.
	 */
	replaceRange(from: number, to: number, insert: string): void {
		const caret = this.#cursor();
		const cursor = caret >= to ? caret + insert.length - (to - from) : caret > from ? from + insert.length : caret;
		this.#closeCompletion();
		this.#change(from, to, insert, cursor, "edit");
	}

	/**
	 * List `items` to replace `[from, to)` with (spelling guesses) in the completion popup;
	 * accepting one replaces the range while it still reads as it does now.
	 */
	showReplacements(from: number, to: number, items: readonly string[]): void {
		if (items.length === 0 || from < 0 || to <= from || to > this.#text().length) return;
		this.#closeCompletion();
		this.#replacing = { from, to, original: this.#text().slice(from, to) };
		this.#completion.set({ items: items.map(value => ({ value, label: value })), prefix: "", selected: 0 });
	}

	/** Decorate the draft with `decorator`'s ranges; returns its removal. */
	addDecorator(decorator: ComposerDecorator): () => void {
		this.#decorators.set([...this.#decorators(), decorator]);
		return () => this.#decorators.set(this.#decorators().filter(d => d !== decorator));
	}

	/** Rewrite (or cancel) what a submission sends. */
	setSubmitTransform(transform: SubmitTransform | undefined): void {
		this.#submitTransform = transform;
	}

	// ─── View ───────────────────────────────────────────────────────────────

	#view(): UiNode {
		// The first frame that shows a prediction counts it as shown.
		effect(() => {
			if (this.#shownPrediction()) untrack(() => this.#predictions.peek()?.shown());
		});
		const shell = computed(() => this.#state().shell);
		const shape = computed(() => composerShape(this.#shape()));
		const mode = computed(() => this.#vim?.mode() ?? null);

		const decorations = computed(() => {
			const text = this.#text();
			const extra = this.#decorators().flatMap(decorate => decorate(text));
			return { ranges: atomRanges(text, this.#atoms()), extra };
		});
		const nativeDecor = computed((): TspEditorDecoration[] | undefined => {
			const text = this.#text();
			if (shell()) {
				const sigil = SHELL_SIGIL.exec(text)?.[0].length ?? 0;
				return sigil > 0 ? [{ from: 0, to: sigil, s: "hide" }] : undefined;
			}
			const { ranges, extra } = decorations();
			const out: TspEditorDecoration[] = ranges.map(({ from, to, atom }) =>
				atom.kind === "image" && atom.image
					? { from, to, s: "accent strong", blob: draftImageBlob(atom.image) }
					: { from, to, s: (atom.kind === "token" && atom.s) || "accent strong" },
			);
			for (const d of extra)
				out.push(d.fx ? { from: d.from, to: d.to, s: d.s, fx: d.fx } : { from: d.from, to: d.to, s: d.s });
			return out.length > 0 ? out.sort((a, b) => a.from - b.from) : undefined;
		});
		const termDecor = computed((): EditorTermRange[] => {
			// A shell draft is code; a btw draft is prose like any other.
			const kind = shell()?.kind;
			if (kind === "bash" || kind === "python") return [];
			const text = this.#text();
			const { ranges, extra } = decorations();
			const out: EditorTermRange[] = ranges.map(({ from, to, atom }) => {
				if (atom.kind === "token") {
					const href = atom.link && chipHref(atom.link.path, atom.link.line);
					return { from, to, s: atom.s ?? "accent strong", whole: true, ...(href ? { href } : {}) };
				}
				// An image chip links to its file where the terminal draws links.
				const href = chipHref(this.imageLink(atom));
				return { from, to, s: "strong", fg: chipColor(atom.kind, atom.n), whole: true, ...(href ? { href } : {}) };
			});
			for (const d of extra) {
				if (d.gradient && d.gradient.stops.length > 0) out.push(...gradientRanges(text, d, d.gradient));
				else
					out.push({
						from: d.from,
						to: d.to,
						s: d.s,
						...(d.fg ? { fg: d.fg } : {}),
						...(d.label ? { label: d.label } : {}),
					});
			}
			return out.sort((a, b) => a.from - b.from);
		});
		const visual = computed(() => {
			const m = mode();
			return m === "visual" || m === "visual-line" ? (this.#vim?.selection() ?? null) : null;
		});
		const fieldTerm = computed((): EditorTerm => {
			const m = mode();
			const terminal = this.#caret() === "terminal";
			const sel = visual();
			const paddingX = this.#paddingX() ?? shape().paddingX;
			return {
				decor: termDecor(),
				caret: terminal ? "none" : m === "insert" || m === "replace" ? "underline" : "block",
				caretEnd: terminal ? "none" : m === null || m === "insert" || m === "replace" ? "bar" : "block",
				// Its keys away under the terminal's own cursor, the field draws no hint; a notice still shows.
				placeholder:
					this.#notice() ??
					(this.#shownPrediction() || (terminal && this.#faint()) ? null : (this.#placeholder() ?? null)),
				...(sel ? { selection: { from: sel.from, to: sel.to } } : {}),
				caretOverflow: caretOverflow(shape(), paddingX),
				...(this.#caretGlyph() ? { caretGlyph: this.#caretGlyph() } : {}),
			};
		});
		const composerTerm = computed((): ComposerTerm => ({
			shape: this.#shape(),
			...(this.#paddingX() !== undefined ? { paddingX: this.#paddingX() } : {}),
			...(this.#status() ? { status: this.#status() } : {}),
			...(this.#border() ? { border: this.#border() } : {}),
			...(this.#borderFaint() ? { borderFaint: true } : {}),
			...(this.#imeSafeCursor() && this.#caret() === "terminal" ? { imeSafeCursor: true } : {}),
			...(this.#faint() ? { faint: true } : {}),
		}));

		const modeChip = (): JSXNode => {
			const s = shell();
			if (!s && this.#state().btw) {
				const key = formatTooltipKey(getKeybindings().keysFor("app.interrupt")[0] ?? "escape");
				return (
					<row
						key="mode"
						role="omp.composer.mode"
						align="center"
						gap="xs"
						title={`Asking the side question · back to the chat  ${key}`}
						actions={{ click: "interrupt" }}
					>
						<text key="label" spans={[{ s: "accent", t: "btw" }]} wrap="none" />
					</row>
				);
			}
			if (!s && this.#state().skipsAsk) {
				return (
					<row
						key="mode"
						role="omp.composer.mode"
						tone="warning"
						align="center"
						gap="xs"
						title="Sending this message skips the questions above"
					>
						<text key="label" spans={[{ s: "warning", t: "skips ask" }]} wrap="none" />
					</row>
				);
			}
			if (!s) return null;
			const title = s.excluded ? `${SHELL_TITLES[s.kind]} · not sent to the model` : SHELL_TITLES[s.kind];
			return (
				<row key="mode" role="omp.composer.mode" align="center" gap="xs" title={title}>
					{s.excluded && <icon key="excluded" name="eye-off" title="Not sent to the model" />}
					<text key="label" spans={[{ s: `${s.kind}Mode`, t: s.kind }]} wrap="none" />
				</row>
			);
		};
		// The viewing header while a subagent is focused: an eye, the agent's ancestors as links
		// (`omp.composer.crumb`), the agent itself (`omp.composer.agent`), then the way back to the
		// main session (`omp.composer.exit`, the interrupt key's keycap: Esc on an empty draft). Tern's
		// tray reads it: the named agent's card is marked as viewed, and its MAIN bar runs the exit's click.
		const viewingHeader = (): JSXNode => {
			const viewing = this.#state().viewing;
			const agent = viewing?.at(-1);
			if (viewing === undefined || agent === undefined) return null;
			const back = formatTooltipKey(getKeybindings().keysFor("app.interrupt")[0] ?? "escape");
			return (
				<row
					key="focus"
					role="omp.composer.focus"
					align="center"
					gap="xs"
					title={`Viewing subagent ${agent}: what you send goes to it`}
				>
					<icon key="icon" name="eye" />
					<text key="label" text="Viewing" wrap="none" />
					{viewing.slice(0, -1).map(id => (
						<text
							key={`crumb:${id}`}
							role="omp.composer.crumb"
							text={id}
							wrap="none"
							title={`View ${id}`}
							actions={{ click: `${FOCUS_ACTION}${id}` }}
						/>
					))}
					<text key="agent" role="omp.composer.agent" text={agent} wrap="none" />
					<row
						key="exit"
						role="omp.composer.exit"
						align="center"
						gap="xs"
						title={`Back to the main session  ${back}`}
						actions={{ click: `${FOCUS_ACTION}${MAIN_AGENT_ID}` }}
					>
						<kbd key="key" keys={actionKbd("app.interrupt", "escape")} />
						<text key="label" text="main" wrap="none" />
					</row>
				</row>
			);
		};
		const submitControl = (): JSXNode =>
			this.#state().skipsAsk ? (
				<text
					key="skip"
					actions={{ click: "submit" }}
					role="omp.composer.skip"
					text="Skip & send"
					title="Send this message instead of answering the questions  ⏎"
					tone="warning"
				/>
			) : this.#state().running ? (
				<text
					key="stop"
					actions={{ click: "interrupt" }}
					role="omp.composer.stop"
					text="Stop"
					title="Stop  esc"
					tone="error"
				/>
			) : (
				<kbd
					key="send"
					actions={this.#options.dictating?.() ? undefined : { click: "submit" }}
					keys={["enter"]}
					role="omp.composer.send"
					tone={this.#options.dictating?.() ? "muted" : undefined}
					title={this.#options.dictating?.() ? "Finish dictation before sending" : "Send  ⏎"}
				/>
			);
		const popup = (): JSXNode => {
			const open = this.#completion();
			if (!open) return null;
			const mark = this.#completionMark(open.prefix);
			const pick = (value: string) => {
				const index = open.items.findIndex(item => item.value === value);
				if (index !== -1) this.#accept(open, "complete", index);
			};
			const popupTerm: PopupTerm = open.prefix.startsWith("/")
				? { columns: [12, 32], descriptionRows: 2 }
				: { columns: [32, 32] };
			return (
				<overlay key="complete" role="omp.autocomplete" anchor={{ caret: "line/input" }} term={popupTerm}>
					<col role="omp.select">
						<list
							key="list"
							empty="No items"
							max={{ lines: this.#autocompleteMaxVisible() }}
							selected={open.items[open.selected]?.value}
							onSelect={pick}
							onActivate={pick}
						>
							{open.items.map(item => {
								const rowLabel = item.label ?? item.value;
								const label = plainLine(rowLabel);
								const glyph = item.icon && plainLine(item.icon);
								// The terminal look keeps the row as listed; Tern gets a live `Label: state`
								// description split into the static detail and the state as the item's value.
								const term: PopupItemTerm = {
									...(glyph ? { glyph } : {}),
									label: rowLabel,
									detail: item.description ?? "",
								};
								const marked = mark !== "" && label.toLowerCase().startsWith(mark) ? mark.length : 0;
								const spans: TspSpan[] =
									marked === 0 ? [{ t: label }] : [{ s: "mark", t: label.slice(0, marked) }];
								if (marked > 0 && marked < label.length) spans.push({ t: label.slice(marked) });
								if (glyph && !item.iconName) spans.unshift({ s: "muted", t: `${glyph} ` });
								const detail = plainLine(item.nativeDetail ?? item.description ?? "");
								const state = item.state ? plainLine(item.state) : "";
								return (
									<item
										key={item.value}
										icon={item.iconName || undefined}
										label={spans}
										term={term}
										detail={detail ? [{ s: "muted", t: detail }] : undefined}
										value={state ? [{ s: "muted", t: state }] : undefined}
									/>
								);
							})}
						</list>
					</col>
				</overlay>
			);
		};

		const field = (
			<editor
				key="input"
				ref={node => {
					this.field = node;
				}}
				text={() => this.#text()}
				cursor={() => this.#cursor()}
				anchor={() => {
					const m = mode();
					const anchor = m === "visual" || m === "visual-line" ? this.#vim?.anchorOffset() : null;
					if (anchor === null || anchor === undefined) return undefined;
					if (m === "visual-line") return lineStart(this.#text(), anchor);
					return anchor;
				}}
				decor={nativeDecor}
				placeholder={() =>
					this.#text() === "" && !this.#shownPrediction()
						? (this.#nativePlaceholder() ?? NATIVE_PLACEHOLDER)
						: undefined
				}
				ghost={() => this.#ghost()}
				maxLines={() => this.#maxLines()}
				mode={() => {
					if (this.#passthrough()) return "PTY";
					const m = mode();
					if (m === "normal") return "NORMAL";
					if (m === "visual" || m === "visual-line") return "VISUAL";
					return m === "replace" ? "REPLACE" : undefined;
				}}
				lang={() => {
					const kind = shell()?.kind;
					return kind === "btw" ? undefined : kind;
				}}
				sendable={() => this.#nativeSendable()}
				term={fieldTerm}
				onEdit={event => this.#onEdit(event)}
				onUndo={() => this.undo()}
				onKey={key => this.#onKey(key)}
				onPaste={paste => this.#onPaste(paste)}
				onSend={text => this.#send(text)}
			/>
		);

		const view = (
			<col
				role={() => {
					const kind = shell()?.kind;
					if (kind) return `omp.editor.${kind === "btw" ? "btw-ask" : kind}`;
					return this.#state().btw ? "omp.editor.btw" : "omp.editor";
				}}
				tone={() => (this.#state().running ? "pending" : undefined)}
				folded={() => (this.#faint() ? true : undefined)}
				term={composerTerm}
				onAction={(act, event) => {
					if (act === "submit") {
						if (!this.#options.dictating?.()) this.submit();
					} else if (!this.#actionHandlers.some(handler => handler(act, event.value))) {
						logger.debug("Unhandled composer action", { action: act, key: event.key });
					}
				}}
			>
				{() => this.#slots().context}
				{viewingHeader}
				{() => this.#slots().chips}
				<row key="line" role="omp.composer.line" align="start" gap="sm">
					{modeChip}
					{field}
				</row>
				<row key="bar" role="omp.composer.bar" align="center" gap="sm">
					{() => this.#slots().model}
					{() => this.#slots().effort}
					{() => this.#slots().rate}
					{() => this.#slots().extras ?? <row key="gap" grow={1} />}
					{() => this.#slots().usage}
					{() => this.#slots().dictation}
					{submitControl}
				</row>
				{popup}
			</col>
		);
		if (!isUiNode(view)) throw new Error("composer: the view is not a node");
		return view;
	}
}

/** The terminal link target of a chip's file `link` (a path, opened at `line`), if any. */
export function chipHref(link: string | undefined, line?: number): string | undefined {
	return link ? fileUriForTerminal(link, line === undefined ? undefined : { line }, terminalIdentity().id) : undefined;
}

/**
 * One terminal range per character of `decoration`'s span in `text`, colored by its place in the
 * gradient; with a period the colors cycle on the terminal clock.
 */
function gradientRanges(
	text: string,
	decoration: ComposerDecoration,
	gradient: NonNullable<ComposerDecoration["gradient"]>,
): EditorTermRange[] {
	const { stops, periodMs } = gradient;
	const chars = Array.from(text.slice(decoration.from, decoration.to));
	const out: EditorTermRange[] = [];
	let at = decoration.from;
	chars.forEach((char, i) => {
		const stop = (phase: number): string =>
			stops[Math.floor(((i / chars.length + phase) % 1) * stops.length) % stops.length]!;
		const from = at;
		at += char.length;
		out.push(
			periodMs
				? { from, to: at, s: decoration.s, fg: stop(0), fgAt: now => stop((now % periodMs) / periodMs) }
				: { from, to: at, s: decoration.s, fg: stop(0) },
		);
	});
	return out;
}
