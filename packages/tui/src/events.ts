/**
 * The events a node receives, whichever backend renders it.
 *
 * A Tern terminal sends UI events over the Surface Protocol; the terminal
 * backend synthesizes the same events from keys and mouse. Either way a node
 * sees one event model: {@link UiEvent} for semantic actions and
 * {@link KeyEvent} for keys its widget did not consume.
 */

import type { TspPicture } from "@oh-my-pi/pi-wire";

/** A semantic UI event, addressed to the node it names (`key` is that node's keypath in its root). */
export type UiEvent =
	| {
			readonly type: "toggle";
			readonly key: string;
			readonly collapsed: boolean;
			/** The fold's bare wire key (a tree item's id), or the item of a menu toggle, when supplied. */
			readonly item?: string;
	  }
	| { readonly type: "select"; readonly key: string; readonly item: string }
	| { readonly type: "activate"; readonly key: string; readonly item: string }
	| {
			readonly type: "action";
			readonly key: string;
			readonly act: string;
			/** Scope/tab/strip id, sort column, or the prefs row an action control belongs to. */
			readonly value?: string;
			readonly mods: readonly string[];
			/** A `menu` check or radio row's new state. */
			readonly checked?: boolean;
	  }
	/** A typed value changed (prefs rows, picker toggles); `null` resets to the default. */
	| {
			readonly type: "change";
			readonly key: string;
			readonly item: string;
			readonly value: boolean | number | string | readonly string[] | null;
	  }
	/** An `image` node's annotated picture (Tern's annotator, on Done). */
	| { readonly type: "change"; readonly key: string; readonly value: TspPicture }
	/** An edit over the selection of an `editor`/`input` (see {@link TextEdit}). */
	| ({ readonly type: "edit"; readonly key: string } & TextEdit)
	/** Undo the last change to an `editor`/`input`'s text. */
	| { readonly type: "undo"; readonly key: string }
	/** Submit `text` as one prompt through the composer's ordinary submission path. */
	| { readonly type: "send"; readonly key: string; readonly text: string }
	/** The user moved into `editor`/`input`/`prefs` node `key`: move keyboard focus there or ignore it. */
	| { readonly type: "focus"; readonly key: string }
	/** The user edited a `doc` in place: `text` is its full new source. */
	| { readonly type: "docChange"; readonly key: string; readonly text: string }
	/** A new comment on a `doc` quote (`at`: its UTF-16 offset in the source the user saw). */
	| {
			readonly type: "comment";
			readonly key: string;
			readonly quote: string;
			readonly at: number;
			readonly note: string;
	  }
	/** The edited note of comment `comment` on a `doc`. */
	| {
			readonly type: "commentNote";
			readonly key: string;
			readonly comment: string;
			readonly note: string;
	  }
	/** Comment `comment` on a `doc` deleted. */
	| {
			readonly type: "uncomment";
			readonly key: string;
			readonly comment: string;
	  }
	/** In-place editing of a `doc` started or ended. */
	| { readonly type: "editing"; readonly key: string; readonly on: boolean };

/**
 * A primitive text edit over an `editor`/`input`: replace `[from, to)` with
 * `text`, then put the caret at `cursor`. Offsets are UTF-16 code units into
 * the text last described; `len` is that text's length (a mismatch means the
 * edit is stale and must be ignored).
 */
export interface TextEdit {
	readonly from: number;
	readonly to: number;
	readonly text: string;
	readonly cursor: number;
	readonly len: number;
	/** The edit types a bracketed paste: content, not typing (no completion opens for it). */
	readonly paste?: boolean;
}

/** One key press, release or repeat, as the driver decoded it. */
export interface KeyEvent {
	/** Canonical key id: modifiers in `ctrl+alt+shift+super` order, then the key (`ctrl+c`, `shift+enter`, `up`, `a`). */
	readonly id: string;
	/** Printable text the key produces, if any (absent for control keys). */
	readonly text?: string;
	readonly kind: "press" | "repeat" | "release";
	/** The raw input bytes, for components that need them verbatim. */
	readonly raw: string;
	/**
	 * The first key decoded from the same stdin read right after a bracketed paste: sent with
	 * the paste (paste-and-Enter), so nothing shown in between can have been answered.
	 */
	readonly afterPaste?: boolean;
}

/** Text pasted with bracketed paste, delivered whole. */
export interface PasteEvent {
	readonly text: string;
}
