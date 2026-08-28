import { useLayoutEffect } from "react";
import { decideComposerKey } from "./keymap";
import type { ComposerDraft } from "./useComposerDraft";

/**
 * The composer's only `<textarea>`.
 *
 * Rendered by the inline row *or* by the expanded modal, never by both. React
 * remounts it when it moves between the two, which is why focus and caret
 * restoration are an explicit step here rather than something we hope survives.
 */
export function ComposerEditor({
	composer,
	variant,
	disabled = false,
}: {
	composer: ComposerDraft;
	variant: "inline" | "modal";
	/** The agent cannot take a turn yet; typing here would be discarded. */
	disabled?: boolean;
}) {
	const { draft, changeDraft, matches, editorRef, selection, pendingCaret } = composer;
	/*
	 * A send that has not landed yet owns this draft. It is no longer cleared
	 * before the round trip, so without this a second Enter would send it twice
	 * and anything typed meanwhile would edit text already on the wire.
	 */
	const busy = disabled || composer.sending;

	/*
	 * Take focus and put the caret back where it was, in both directions.
	 *
	 * Keyed on `variant` and `busy`, not on the refs. Refs never change
	 * identity, so this ran exactly once — during the first commit, while the
	 * session was still booting and the textarea was `disabled`. `focus()` on a
	 * disabled element does nothing, and nothing ever tried again: the composer
	 * came up unfocused and stayed that way until you clicked it. `variant` is
	 * what carries the other half, the move between the inline row and the
	 * expanded dialog.
	 */
	useLayoutEffect(() => {
		const node = editorRef.current;
		if (!node || busy) return;
		/*
		 * Never take focus away from something else the user is using. This effect
		 * now runs when the textarea stops being disabled — which is when the
		 * session finishes booting, several seconds in, by which time you may well
		 * be typing in the session filter. Claiming focus then would eat the rest
		 * of what you were writing.
		 */
		const active = document.activeElement;
		const busyElsewhere =
			active !== null &&
			active !== node &&
			active !== document.body &&
			(active instanceof HTMLInputElement ||
				active instanceof HTMLTextAreaElement ||
				(active instanceof HTMLElement && active.isContentEditable));
		if (busyElsewhere) return;

		node.focus();
		node.setSelectionRange(selection.current.start, selection.current.end);
	}, [editorRef, selection, variant, busy]);

	/**
	 * Grow to fit the draft — inline only. In the modal the box is already as
	 * tall as the dialog and CSS gives it the space, so measuring content height
	 * there would fight the layout.
	 *
	 * Keyed on `draft` rather than wired into `onChange`, because several places
	 * write the draft — typing, accepting a completion, inserting a file
	 * reference, and the clear inside `submit` — and all of them have to resize.
	 * A layout effect is the one choke point they all pass through, and it runs
	 * before paint so the box is never a frame stale.
	 *
	 * The height is written imperatively rather than held in state: state would
	 * be a second render per keystroke. A `ResizeObserver` would be worse — it
	 * writes `height` for the element it observes, which is a resize loop.
	 *
	 * The cap stays in CSS. This only sets the height the content wants;
	 * `max-height` clamps it and `overflow-y` produces the scrollbar.
	 */
	useLayoutEffect(() => {
		const node = editorRef.current;
		if (!node || variant !== "inline") return;

		// Collapse first, or `scrollHeight` reports the old height when text shrinks.
		node.style.height = "0px";
		// Borders are 0 top and bottom and `*` is `box-sizing: border-box`, so
		// scrollHeight is exact. If a vertical border ever returns, this becomes
		// `scrollHeight + offsetHeight - clientHeight`.
		const wanted = node.scrollHeight;
		node.style.height = `${wanted}px`;
	}, [draft, variant, editorRef]);

	// Apply a caret position requested by a programmatic insert.
	useLayoutEffect(() => {
		const node = editorRef.current;
		const caret = pendingCaret.current;
		if (!node || caret === null) return;
		pendingCaret.current = null;
		node.setSelectionRange(caret, caret);
		selection.current = { start: caret, end: caret };
		// `draft` is the dependency that matters: the other three are refs, whose
		// identity never changes, so without it this ran once on mount and never
		// again — and every programmatic insert left the caret at the end.
	}, [draft, editorRef, pendingCaret, selection]);

	const remember = (node: HTMLTextAreaElement) => {
		selection.current = { start: node.selectionStart, end: node.selectionEnd };
	};

	return (
		<textarea
			ref={editorRef}
			className="omp-composer__input"
			data-variant={variant}
			// Without these the slash menu is invisible to assistive tech: twelve
			// commands appear, arrows move a highlight, and nothing is announced.
			role="combobox"
			aria-expanded={matches.length > 0}
			aria-controls={composer.slashListId}
			aria-activedescendant={matches.length > 0 ? `${composer.slashListId}-${composer.highlight}` : undefined}
			aria-autocomplete="list"
			data-dropping={composer.dropping || undefined}
			disabled={busy}
			placeholder={disabled ? "Waiting for the agent…" : composer.streaming ? "Steer the agent…" : "Ask omp…"}
			value={draft}
			rows={1}
			onChange={event => {
				changeDraft(event.target.value);
				remember(event.currentTarget);
			}}
			onSelect={event => remember(event.currentTarget)}
			onKeyUp={event => remember(event.currentTarget)}
			onPaste={event => {
				const files = [...(event.clipboardData?.files ?? [])];
				if (files.length) {
					event.preventDefault();
					void composer.addImages(files);
				}
			}}
			onDragOver={event => {
				event.preventDefault();
				composer.setDropping(true);
			}}
			onDragLeave={() => composer.setDropping(false)}
			onDrop={event => {
				event.preventDefault();
				// The modal body is also a drop target. Without this a drop landing on
				// the textarea ran both handlers and attached the image twice.
				event.stopPropagation();
				composer.setDropping(false);
				// A drop with no `dataTransfer` threw and took the whole session view
				// down with it. Cheaper to tolerate than to trust every event source.
				void composer.addImages([...(event.dataTransfer?.files ?? [])]);
			}}
			onKeyDown={event => {
				const action = decideComposerKey(
					{
						key: event.key,
						shiftKey: event.shiftKey,
						metaKey: event.metaKey,
						ctrlKey: event.ctrlKey,
						altKey: event.altKey,
						isComposing: event.nativeEvent.isComposing,
					},
					{ variant, slashOpen: matches.length > 0 },
				);
				if (action.type === "none") return;

				// Every action we recognise claims the key. `defaultPrevented` is also
				// how session.tsx knows not to abort the running turn on Escape.
				event.preventDefault();

				switch (action.type) {
					case "toggleExpand":
						composer.setExpanded(open => !open);
						break;
					case "slashMove":
						composer.setHighlight(index => (index + action.delta + matches.length) % matches.length);
						break;
					case "slashAccept": {
						const command = matches[composer.highlight] ?? matches[0];
						if (command) composer.applyCompletion(command);
						break;
					}
					case "slashDismiss":
						// Stops the modal's backdrop handler closing the dialog as well:
						// one Escape should dismiss one thing.
						event.stopPropagation();
						composer.dismissSlash();
						break;
					case "collapse":
						composer.setExpanded(false);
						break;
					case "submit":
						void composer.submit();
						break;
				}
			}}
		/>
	);
}
