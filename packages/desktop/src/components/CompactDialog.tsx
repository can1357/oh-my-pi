import { useCallback } from "react";
import { compactTokens } from "../rpc/compaction";
import { useEscape } from "../shell/useEscape";

/**
 * Confirms a compaction before it runs.
 *
 * It is the only one-click action in the window that destroys something: the
 * messages above the cut are replaced by a summary and are gone from the
 * model's context for good. Worth a sentence and a second click.
 *
 * The turn warning is not hypothetical — `session.compact()` calls
 * `host.abort()` before it starts, so compacting mid-answer throws that answer
 * away. Nothing said so before.
 */
export function CompactDialog({
	tokens,
	contextWindow,
	streaming,
	onConfirm,
	onCancel,
}: {
	tokens?: number;
	contextWindow?: number;
	streaming: boolean;
	onConfirm(): void;
	onCancel(): void;
}) {
	// Escape closes it, and `preventDefault` keeps the session's own handler
	// from reading the same key as "abort the turn".
	useEscape(
		useCallback(
			(event: KeyboardEvent) => {
				event.preventDefault();
				onCancel();
			},
			[onCancel],
		),
	);

	return (
		<div className="omp-backdrop" role="dialog" aria-modal="true" aria-label="Compact this session">
			<div className="omp-modal">
				<h2 className="omp-modal__title">Compact this session?</h2>
				<p className="omp-modal__message">
					{tokens !== undefined
						? `The session is using ${compactTokens(tokens)} tokens${
								contextWindow ? ` of ${compactTokens(contextWindow)}` : ""
							}. `
						: ""}
					Compacting replaces the older messages with a summary. It cannot be undone, and the agent will no longer
					remember the detail of what was replaced.
					{streaming ? " The answer in flight will be aborted." : ""}
				</p>
				<div className="omp-modal__actions">
					<button type="button" data-component="button" data-variant="ghost" data-size="normal" onClick={onCancel}>
						Keep everything
					</button>
					<button
						type="button"
						data-component="button"
						data-variant="primary"
						data-size="normal"
						onClick={onConfirm}
					>
						Compact
					</button>
				</div>
			</div>
		</div>
	);
}
