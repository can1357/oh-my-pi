/**
 * Terminal look of the deferred command preview (`col` `omp.hud.deferred`):
 * a blank row, the queued panels as they will look in the transcript, then
 * `1 command output — repeated in the transcript when the agent pauses · ⎋ to
 * hide` (dim; the interrupt key). Past the row cap the panels are cut one row
 * short of it and the note reads `… 12 more rows — 1 command output shown in
 * full when the agent pauses · ⎋ to hide`.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import { keyLabel } from "../../keys/hints";
import { type DeferredCommandModel, queuedOutputs } from "../../dock/deferred";
import { termOf } from "../messages/fill";

function paintDeferred(node: UiNode, cx: PaintContext): Block {
	const model = termOf<{ deferred: DeferredCommandModel }>(node).deferred;
	const panels = node.children()[0];
	if (!model || !panels) return EMPTY_BLOCK;
	const rows: string[] = [];
	for (const child of panels.children()) rows.push(...cx.paint(child, cx.width).rows);
	const queued = queuedOutputs(model.commands());
	const maxRows = model.maxRows();
	const hide = `${keyLabel(cx.theme, model.dismissKey())} to hide`;
	const dim = (text: string): string => truncate(cx.theme.fg("dim", text), cx.width);
	if (rows.length <= maxRows)
		return {
			rows: ["", ...rows, dim(`${queued} — repeated in the transcript when the agent pauses · ${hide}`)],
		};
	const shown = rows.slice(0, Math.max(1, maxRows - 1));
	const hidden = rows.length - shown.length;
	return {
		rows: ["", ...shown, dim(`… ${hidden} more rows — ${queued} shown in full when the agent pauses · ${hide}`)],
	};
}

defineRolePainter("col", "omp.hud.deferred", paintDeferred);
