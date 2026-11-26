/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Where to save a plan: a path field (empty saves to the suggested path),
 * Save (enter) and Cancel (ctrl+g, escape).
 */
import { type Accessor, type JSXNode, signal, untrack } from "@oh-my-pi/pi-tui";
import type { PlanSaveOverlayResult } from "../../../modes/view-model/overlays/plan-save-overlay";
import "../../styles/panels/plan-save";
import { ActionButton, applyEdit, type LineValue } from "./common";
import { matchesSelectCancel } from "../../../config/keybindings/matchers";
import { actionKbd, actionKeyId, cancelKbd } from "../../keys/hints";
import { getKeybindings } from "../../../config/keybindings/keybindings";
import { keyTitle } from "../../styles/panels/common";
import { rowsRole, type SheetAttributes } from "../sheet";

/** Tern's sheet: a small one at the bottom edge, where the plan review's dock is. */
export const PLAN_SAVE_SHEET: SheetAttributes = {
	role: "omp.overlay.planSave",
	anchor: "bottom",
	size: "sm",
	head: "Save plan",
};

export interface PlanSaveProps {
	/** Where an empty path saves. */
	readonly suggestedPath: Accessor<string>;
	/** The chosen destination; undefined when cancelled. */
	onDone(result: PlanSaveOverlayResult | undefined): void;
}

export function PlanSave(props: PlanSaveProps): JSXNode {
	const line = signal<LineValue>({ text: "", cursor: 0 });
	const save = () => {
		const text = untrack(line).text.trim();
		props.onDone({ path: text || untrack(props.suggestedPath) });
	};
	const cancel = () => props.onDone(undefined);
	return (
		<col
			role={rowsRole("omp.planSave")}
			gap="md"
			term={() => ({ suggested: props.suggestedPath() })}
			onKey={key => {
				if (getKeybindings().matches(key, "tui.input.submit")) save();
				else if (key.id === "ctrl+g" || matchesSelectCancel(key)) cancel();
				else return false;
				return true;
			}}
			onAction={act => {
				if (act === "save") save();
				else if (act === "cancel") cancel();
			}}
		>
			<input
				prompt="Path: "
				text={() => line().text}
				cursor={() => line().cursor}
				sendable={false}
				onEdit={edit => {
					const next = applyEdit(untrack(line), edit);
					if (next) line.set(next);
				}}
			/>
			{() =>
				line().text === "" && (
					<text
						key="default"
						truncate="middle"
						spans={[
							{ s: "dim", t: "Empty saves to " },
							{ s: "path", t: props.suggestedPath() },
						]}
					/>
				)
			}
			<row key="actions" role="omp.actions" align="center" gap="sm">
				<spacer grow={1} />
				<ActionButton
					id="cancel"
					label="Cancel"
					title={`Cancel  ${keyTitle(actionKeyId("tui.select.cancel", "escape"))}`}
					keys={cancelKbd()}
				/>
				<ActionButton
					id="save"
					label="Save"
					title={`Save  ${keyTitle(actionKeyId("tui.input.submit", "enter"))}`}
					tone="accent"
					keys={actionKbd("tui.input.submit", "enter")}
				/>
			</row>
		</col>
	);
}
