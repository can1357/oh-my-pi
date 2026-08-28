import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useRef } from "react";
import { isTauri } from "../../rpc/transport";
import { useEscape } from "../../shell/useEscape";
import { ComposerChips, ComposerSlash } from "./ComposerChips";
import { ComposerEditor } from "./ComposerEditor";
import type { ComposerDraft } from "./useComposerDraft";

/**
 * The composer, full size.
 *
 * Deliberately *not* a portal. `hidden` on `.omp-main` is the only thing keeping
 * the other open sessions off screen, and it works through an `!important` in
 * the vendored base stylesheet. A portal to `document.body` escapes that
 * ancestor, so every background session's modal would paint on top of the one
 * you are looking at. Rendered as a sibling of `<main>` instead, in the same
 * slot `ApprovalDialog` uses, and gated on `visible` by the caller.
 */
export function ComposerModal({ composer }: { composer: ComposerDraft }) {
	const fileInput = useRef<HTMLInputElement>(null);
	const dialog = useRef<HTMLDivElement>(null);
	/** Where the press started, so a drag-select that ends outside does not close. */
	const pressedBackdrop = useRef(false);

	/**
	 * Escape at the window, not only on the backdrop.
	 *
	 * React only delivers a key event to the backdrop's handler when it bubbles
	 * from a descendant. Click the dialog's title or its padding — neither is
	 * focusable — and focus falls to `<body>`, from where Escape reached nothing
	 * here and went straight to the abort-the-turn listener in session.tsx.
	 */
	const setExpanded = composer.setExpanded;
	useEscape(
		useCallback(
			(event: KeyboardEvent) => {
				// Deferring to whoever claimed it first: a context menu opened over
				// this dialog should close itself, not the dialog under it.
				if (event.defaultPrevented) return;
				event.preventDefault();
				setExpanded(false);
			},
			[setExpanded],
		),
	);

	const pickFiles = useCallback(async () => {
		if (!isTauri()) return;
		const picked = await open({ multiple: true, title: "Reference files" });
		const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
		composer.addReferences(paths.filter((path): path is string => typeof path === "string"));
	}, [composer]);

	return (
		<div
			className="omp-backdrop"
			role="dialog"
			aria-modal="true"
			aria-label="Compose a message"
			onMouseDown={event => {
				pressedBackdrop.current = event.target === event.currentTarget;
			}}
			onClick={event => {
				// A click fires on the nearest common ancestor of press and release,
				// so selecting text and releasing outside the dialog reported a click
				// on the backdrop and threw the draft's selection away.
				if (event.target === event.currentTarget && pressedBackdrop.current) composer.setExpanded(false);
			}}
			onKeyDown={event => {
				// The editor handles Escape too; this covers focus sitting on a
				// footer button. `preventDefault` is what stops session.tsx's window
				// listener from also aborting the turn — see its `defaultPrevented` guard.
				if (event.key === "Escape") {
					event.preventDefault();
					composer.setExpanded(false);
				}
			}}
		>
			{/* Swallows the backdrop's click-to-close; the dialog itself is not a control. */}
			<div
				className="omp-modal omp-composer-modal"
				ref={dialog}
				onClick={event => event.stopPropagation()}
				onKeyDown={event => {
					/*
					 * Keep Tab inside the dialog. It declares `aria-modal`, but that is
					 * a promise to assistive tech, not an enforcement: without this,
					 * Tab from the Send button walks on to the title bar and sidebar
					 * sitting under the dim overlay — reachable by keyboard, invisible
					 * to the eye, and with focus out there Escape stopped closing the
					 * dialog and started aborting the turn instead.
					 */
					if (event.key !== "Tab" || !dialog.current) return;
					const focusable = [
						...dialog.current.querySelectorAll<HTMLElement>("button, textarea, [href], input:not([hidden])"),
					].filter(node => !node.hasAttribute("disabled") && node.tabIndex !== -1);
					if (focusable.length === 0) return;
					const first = focusable[0];
					const last = focusable[focusable.length - 1];
					const active = document.activeElement;
					if (event.shiftKey && (active === first || !dialog.current.contains(active))) {
						event.preventDefault();
						last.focus();
					} else if (!event.shiftKey && active === last) {
						event.preventDefault();
						first.focus();
					}
				}}
			>
				<div className="omp-composer-modal__head">
					<span className="omp-modal__title">{composer.streaming ? "Steer the agent" : "Message"}</span>
					<button
						className="omp-titlebar__button"
						type="button"
						title="Collapse (⌘E or Esc)"
						aria-label="Collapse"
						onClick={() => composer.setExpanded(false)}
					>
						×
					</button>
				</div>

				<div
					className="omp-composer-modal__body"
					onDragOver={event => {
						event.preventDefault();
						composer.setDropping(true);
					}}
					onDragLeave={() => composer.setDropping(false)}
					onDrop={event => {
						event.preventDefault();
						composer.setDropping(false);
						// A drop with no `dataTransfer` threw and took the whole session view
						// down with it. Cheaper to tolerate than to trust every event source.
						void composer.addImages([...(event.dataTransfer?.files ?? [])]);
					}}
				>
					<ComposerEditor composer={composer} variant="modal" />
					<ComposerSlash composer={composer} variant="modal" />
				</div>

				<ComposerChips composer={composer} />

				<div className="omp-composer-modal__foot">
					{/*
					 * Images go over the wire as content, so we need their bytes — which
					 * is why this is the DOM picker and not Tauri's. Tauri's dialog
					 * returns paths, and the app grants no filesystem permission to read
					 * them, so a native picker could not produce an image to send.
					 */}
					<input
						ref={fileInput}
						type="file"
						accept="image/*"
						multiple
						hidden
						onChange={event => {
							void composer.addImages([...(event.target.files ?? [])]);
							event.target.value = "";
						}}
					/>
					<button
						type="button"
						data-component="button"
						data-variant="ghost"
						data-size="normal"
						onClick={() => fileInput.current?.click()}
					>
						Add images
					</button>

					{/*
					 * Anything that is not an image can only travel as text: the agent
					 * expands `@path` on its side and reads the file itself.
					 */}
					{isTauri() ? (
						<button
							type="button"
							data-component="button"
							data-variant="ghost"
							data-size="normal"
							title="Insert an @path the agent will read"
							onClick={() => void pickFiles()}
						>
							Reference a file
						</button>
					) : null}

					<span className="omp-composer-modal__hint">Enter adds a line · ⌘↵ sends</span>

					{composer.streaming ? (
						<button
							type="button"
							data-component="button"
							data-variant="ghost"
							data-size="normal"
							title="Abort the current turn"
							disabled={composer.sending}
							onClick={() => void composer.submit()}
						>
							Steer
						</button>
					) : (
						<button
							type="button"
							data-component="button"
							data-variant="primary"
							data-size="normal"
							disabled={composer.sending}
							onClick={() => void composer.submit()}
						>
							Send
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
