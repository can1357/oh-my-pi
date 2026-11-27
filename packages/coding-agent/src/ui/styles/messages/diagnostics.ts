/**
 * Late diagnostics (`card` role `omp.diagnostics.late`): the edit/write
 * diagnostics tree titled "Late diagnostics", one cell in (five diagnostics
 * and a `… N more` row while collapsed).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { languageFromPath } from "@oh-my-pi/pi-tui/text/lang";
import type { FileDiagnostics } from "../../tools/file-common";
import { diagnosticsRows } from "../tools/file-common";
import { paddedText, propsOf, termOf } from "./fill";

function paintLateDiagnostics(node: UiNode, cx: PaintContext): Block {
	const report = termOf<{ diagnostics: FileDiagnostics }>(node).diagnostics;
	if (!report) return { rows: [] };
	const theme = cx.theme;
	const expanded = propsOf<{ collapsed: boolean }>(node).collapsed === false;
	const tree = diagnosticsRows(
		theme,
		report,
		expanded,
		file => theme.symbols.langIcon(languageFromPath(file)),
		"Late diagnostics",
	);
	return paddedText(tree.join("\n"), cx.width).done();
}

defineRolePainter("card", "omp.diagnostics.late", paintLateDiagnostics);
