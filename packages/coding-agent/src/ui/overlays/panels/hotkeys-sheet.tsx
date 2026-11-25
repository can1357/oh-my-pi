/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * `/hotkeys` under a native terminal: one `section` per shortcut group, each a
 * two-column table whose key cells carry `key` spans holding the key id
 * (`ctrl+r`; Tern draws them as keycaps), then Close. Esc or Close dismisses
 * it. A terminal drawing rows gets the markdown report instead.
 */
import type { JSXNode } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { KeybindingsManager } from "../../../config/keybindings/keybindings";
import { matchesSelectCancel } from "../../../config/keybindings/matchers";
import { type HotkeyPart, hotkeyGroups } from "../../keys/hotkeys";
import { ActionButton } from "./common";

/** A shortcut cell as spans: each key alternative a `key` span, typed tokens as code, prose dim. */
function keySpans(parts: readonly HotkeyPart[]): TspSpan[] {
	const spans: TspSpan[] = [];
	for (const part of parts) {
		if ("text" in part) spans.push({ t: part.text, s: "dim" });
		else if ("token" in part) spans.push({ t: part.token, s: "code" });
		else if (part.keys.length === 0) spans.push({ t: "Disabled", s: "dim" });
		else {
			for (const [index, id] of part.keys.entries()) {
				if (index > 0) spans.push({ t: " ", s: "dim" });
				spans.push({ t: id, s: "key" });
			}
		}
	}
	return spans;
}

/** An action description as spans: backtick runs are code, the rest plain. */
function actionSpans(action: string): TspSpan[] {
	const spans: TspSpan[] = [];
	for (const piece of action.split(/(`[^`]+`)/)) {
		if (piece === "") continue;
		spans.push(piece.startsWith("`") && piece.endsWith("`") ? { t: piece.slice(1, -1), s: "code" } : { t: piece });
	}
	return spans;
}

/** Props of {@link HotkeysSheet}. */
export interface HotkeysSheetProps {
	/** The effective bindings the reference lists. */
	readonly keybindings: KeybindingsManager;
	onClose(): void;
}

/** The body of the "Keyboard shortcuts" sheet (see the module docs). */
export function HotkeysSheet(props: HotkeysSheetProps): JSXNode {
	return (
		<col
			gap="lg"
			onKey={key => {
				if (!matchesSelectCancel(key)) return false;
				props.onClose();
				return true;
			}}
			onAction={act => {
				if (act === "close") props.onClose();
			}}
		>
			{hotkeyGroups(props.keybindings).map((group, index) => (
				<section key={`g${index}`} head={group.title} role="omp.hotkeys.group">
					<table
						role="omp.hotkeys.table"
						cols={[
							{ id: "keys", head: "Key" },
							{ id: "action", head: "Action", grow: 1 },
						]}
						rows={group.rows.map((row, rowIndex) => ({
							id: String(rowIndex),
							cells: { keys: keySpans(row.keys), action: actionSpans(row.action) },
						}))}
					/>
				</section>
			))}
			<row key="actions" role="omp.actions" align="center" gap="sm">
				<spacer grow={1} />
				<ActionButton id="close" label="Close" title="Close  esc" keys={["escape"]} />
			</row>
		</col>
	);
}
