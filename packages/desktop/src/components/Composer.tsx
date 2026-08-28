import type { RpcBridge } from "../rpc/bridge";
import { ComposerChips, ComposerSlash } from "./composer/ComposerChips";
import { ComposerEditor } from "./composer/ComposerEditor";
import type { ComposerDraft } from "./composer/useComposerDraft";
import { ExpandIcon } from "./Icons";

/**
 * The composer as it sits under the transcript.
 *
 * It holds no state of its own any more: the draft lives in `useComposerDraft`,
 * one level up, because the expanded modal edits the same text. While the modal
 * is open this renders a summary strip rather than a second `<textarea>` —
 * there is only ever one, and it is wherever the caret is.
 */
export function Composer({
	bridge,
	composer,
	modalOpen,
	disabled = false,
}: {
	bridge: RpcBridge;
	composer: ComposerDraft;
	/**
	 * The agent cannot take a turn yet. Without this the row stayed live while
	 * the session was still coming up: the draft is cleared before the send and
	 * the send is swallowed, so typing here lost the message outright.
	 */
	disabled?: boolean;
	/**
	 * Whether the modal is actually on screen — not merely requested. The route
	 * also withholds it while an approval dialog is up, and keying off `expanded`
	 * alone left the row showing a stand-in with no editor behind it and no
	 * control that could bring one back.
	 */
	modalOpen: boolean;
}) {
	const { streaming } = composer;

	return (
		<div className="omp-composer">
			{/*
			 * The modal renders the same strip, so showing it here too would paint
			 * every chip twice — and give React duplicate keys for the image ones.
			 * Whichever surface holds the editor holds the chips.
			 */}
			{modalOpen ? null : <ComposerChips composer={composer} />}

			<div className="omp-composer__row" style={{ position: "relative" }}>
				{/* The modal renders its own, so this would be a second list floating
				    over the backdrop. Same reason as the chips above. */}
				{modalOpen ? null : <ComposerSlash composer={composer} variant="inline" />}

				{modalOpen ? (
					<button
						className="omp-composer__stand-in"
						type="button"
						title="Return to the expanded editor (⌘E)"
						aria-label="Return to the expanded editor"
						onClick={() => composer.setExpanded(true)}
					>
						{composer.draft.split("\n")[0]?.slice(0, 80) || "Composing…"}
					</button>
				) : (
					<ComposerEditor composer={composer} variant="inline" disabled={disabled} />
				)}

				{/*
				 * Always available, not only once the draft overflows: expanding is
				 * also how you reach the attachment controls, and needing to write a
				 * wall of text first to attach an image would be a strange rule.
				 */}
				<button
					className="omp-composer__expand"
					type="button"
					title="Expand (⌘E)"
					aria-label="Expand the composer"
					aria-pressed={composer.expanded}
					onClick={() => composer.setExpanded(open => !open)}
				>
					<ExpandIcon />
				</button>

				{streaming ? (
					<button
						type="button"
						data-component="button"
						data-size="normal"
						data-variant="ghost"
						onClick={() => void bridge.abort().catch(() => {})}
						title="Abort the current turn (Esc)"
					>
						Stop
					</button>
				) : (
					<button
						type="button"
						data-component="button"
						data-size="normal"
						data-variant="primary"
						disabled={disabled || composer.sending}
						onClick={() => void composer.submit()}
					>
						Send
					</button>
				)}
			</div>
		</div>
	);
}
