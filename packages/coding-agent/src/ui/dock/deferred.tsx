/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Command output queued while the agent streams (`deferredCommand` slot):
 * `/usage` and friends answer at once from the dock, and the real panels
 * enter the transcript when the agent pauses.
 *
 * - Natively (role `omp.hud.deferred`): the panels in a column capped at
 *   `maxRows` lines, then a dim note.
 * - In a text terminal (`src/ui/styles/dock/deferred.ts`): a blank row, the
 *   panels' rows, then the dim note; past `maxRows` the panels are cut and the
 *   note counts the rows left out.
 */
import { For, type JSXNode, signal } from "@oh-my-pi/pi-tui";
import "../styles/dock";

/** Never shrink the preview below this, even on a short terminal. */
export const DEFERRED_MIN_ROWS = 6;
/** Ceiling of the preview as a share of the viewport. */
export const DEFERRED_VIEWPORT_SHARE = 0.4;

/** The preview's row cap on a terminal `rows` tall. */
export function deferredMaxRows(rows: number): number {
	return Math.max(DEFERRED_MIN_ROWS, Math.floor(rows * DEFERRED_VIEWPORT_SHARE));
}

/** What the preview shows; the controller feeds it while command output waits. */
export class DeferredCommandModel {
	/** The queued panels, as they will enter the transcript. */
	readonly panels = signal<readonly (() => JSXNode)[]>([]);
	/** Commands whose output waits (one command may queue several panels). */
	readonly commands = signal(0);
	readonly maxRows = signal(DEFERRED_MIN_ROWS);
}

/** `1 command output`, `3 command outputs`. */
export function queuedOutputs(count: number): string {
	return count === 1 ? "1 command output" : `${count} command outputs`;
}

/** See the module docs. */
export function DeferredCommand(props: { readonly model: DeferredCommandModel }): JSXNode {
	const model = props.model;
	return () => {
		if (model.panels().length === 0) return undefined;
		return (
			<col role="omp.hud.deferred" term={{ deferred: model }}>
				<col max={{ h: `${model.maxRows()}lines` }}>
					<For each={model.panels}>{panel => panel()}</For>
				</col>
				<text
					spans={[
						{
							t: `${queuedOutputs(model.commands())} — shown in full in the transcript when the agent pauses`,
							s: "dim",
						},
					]}
				/>
			</col>
		);
	};
}
