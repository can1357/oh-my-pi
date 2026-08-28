/**
 * What a keypress means in the composer.
 *
 * Pulled out of the component because the branch order is the part that keeps
 * going wrong, and in a component it is only reachable through a real DOM and a
 * real React tree — which this package has no test environment for. As a pure
 * function it is exercised directly in `test/composer-keymap.test.ts`.
 *
 * Two regressions this encodes, both found by review rather than by use:
 *  - Shift+Enter (a newline, the most ordinary key in the expanded editor) was
 *    accepting the highlighted slash command and replacing the whole draft.
 *  - ⌘↵, the modal's send, was doing the same thing before it could send.
 */
export type ComposerKeyAction =
	| { type: "none" }
	| { type: "toggleExpand" }
	| { type: "slashMove"; delta: 1 | -1 }
	| { type: "slashAccept" }
	| { type: "slashDismiss" }
	| { type: "collapse" }
	| { type: "submit" };

export interface ComposerKey {
	key: string;
	shiftKey: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	/** True while an IME is mid-candidate; every Enter branch must stand down. */
	isComposing: boolean;
}

export function decideComposerKey(
	event: ComposerKey,
	context: { variant: "inline" | "modal"; slashOpen: boolean },
): ComposerKeyAction {
	const mod = event.metaKey || event.ctrlKey;
	const bare = !event.shiftKey && !mod && !event.altKey;

	// Before everything: expanding is available wherever the caret is.
	if (mod && event.key.toLowerCase() === "e") return { type: "toggleExpand" };

	if (context.slashOpen) {
		if (event.key === "ArrowDown") return { type: "slashMove", delta: 1 };
		if (event.key === "ArrowUp") return { type: "slashMove", delta: -1 };
		// Only the unmodified keys accept. Anything else is the user asking for a
		// newline or a send, and accepting there destroys what they wrote.
		if (bare && (event.key === "Tab" || (event.key === "Enter" && !event.isComposing))) {
			return { type: "slashAccept" };
		}
		if (event.key === "Escape") return { type: "slashDismiss" };
	}

	if (context.variant === "modal") {
		if (event.key === "Escape") return { type: "collapse" };
		// Enter is a newline here — that is what the modal is for — so sending
		// needs a chord or the button.
		if (event.key === "Enter" && mod && !event.isComposing) return { type: "submit" };
		return { type: "none" };
	}

	if (event.key === "Enter" && !event.shiftKey && !event.isComposing) return { type: "submit" };
	return { type: "none" };
}

/**
 * Build the message that goes on the wire.
 *
 * Referenced files are not in the draft — the editor shows tags, because two
 * absolute iCloud paths filled it before a word had been typed. The mentions are
 * assembled here instead, which is the one place their shape has to be right.
 *
 * Always quoted: `@"…"` is what the agent's regex accepts for paths with
 * spaces, and on macOS those are the norm, not the exception.
 */
export function composeMessage(draft: string, references: readonly string[]): string {
	const body = draft.trim();
	const mentions = references.map(path => `@"${path}"`).join(" ");
	if (!body) return mentions;
	if (!mentions) return body;
	return `${body}\n\n${mentions}`;
}
