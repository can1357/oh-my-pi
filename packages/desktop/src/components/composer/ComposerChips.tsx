import { FileIcon } from "../Icons";
import type { ComposerDraft } from "./useComposerDraft";

/**
 * What is riding along with the message.
 *
 * Two kinds, and they look different because they are different: an image is
 * sent as content, a reference is a path the agent opens itself. Calling both
 * "attached" would be a lie about where the bytes go.
 */
export function ComposerChips({ composer }: { composer: ComposerDraft }) {
	const { attachments, references, notice } = composer;
	if (attachments.length === 0 && references.length === 0 && !notice) return null;

	return (
		<div className="omp-composer__attachments" role="status" aria-live="polite">
			{attachments.map(attachment => (
				<span className="omp-chip omp-chip--image" key={attachment.id}>
					<img className="omp-chip__thumb" src={attachment.previewUrl} alt="" />
					<span className="omp-chip__name">{attachment.name}</span>
					<button
						className="omp-chip__remove"
						type="button"
						aria-label={`Remove ${attachment.name}`}
						onClick={() => composer.removeAttachment(attachment.id)}
					>
						×
					</button>
				</span>
			))}

			{references.map(path => (
				<span className="omp-chip omp-chip--file" key={path} title={`${path}\nRead by the agent, not uploaded`}>
					<FileIcon />
					<span className="omp-chip__name">{basename(path)}</span>
					<button
						className="omp-chip__remove"
						type="button"
						aria-label={`Remove ${basename(path)}`}
						onClick={() => composer.removeReference(path)}
					>
						×
					</button>
				</span>
			))}

			{notice ? (
				<span className="omp-chip omp-chip--notice">
					<span className="omp-chip__name">{notice}</span>
					<button className="omp-chip__remove" type="button" aria-label="Dismiss" onClick={composer.dismissNotice}>
						×
					</button>
				</span>
			) : null}
		</div>
	);
}

/** The last path segment, which is the only part worth reading in a chip. */
function basename(path: string): string {
	return path.split("/").filter(Boolean).at(-1) || path;
}

/**
 * The slash-command list.
 *
 * Inline it floats above the row; in the modal it is a static block under the
 * editor. `.omp-slash` is `position: absolute; bottom: 100%`, which inside a
 * tall dialog would open upward out of the box and get clipped the moment the
 * body scrolls — so the modal passes `static` and the CSS drops the positioning.
 */
export function ComposerSlash({ composer, variant }: { composer: ComposerDraft; variant: "inline" | "modal" }) {
	const { matches, highlight } = composer;
	if (matches.length === 0) return null;

	return (
		<div className="omp-slash" data-variant={variant} id={composer.slashListId} role="listbox">
			{matches.map((command, index) => (
				<button
					className="omp-slash__item"
					data-active={index === highlight || undefined}
					key={command.name}
					id={`${composer.slashListId}-${index}`}
					role="option"
					aria-selected={index === highlight}
					type="button"
					onMouseEnter={() => composer.setHighlight(index)}
					onClick={() => composer.applyCompletion(command)}
				>
					<span className="omp-slash__name">/{command.name}</span>
					<span className="omp-slash__desc">{command.description ?? command.source}</span>
				</button>
			))}
		</div>
	);
}
