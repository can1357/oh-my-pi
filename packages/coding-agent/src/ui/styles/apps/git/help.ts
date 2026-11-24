/**
 * `omp.app.git.help`: the git app's shortcuts sheet in the terminal. A bold
 * title, then per group a blank row, the muted group title and one
 * `  keys  description` row per shortcut (keys in `accent`, all in one
 * column), then a blank row and the dim close hint. Every row is indented one
 * cell and cut with an ellipsis at the width.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { plainText } from "@oh-my-pi/pi-tui/term/painters/picker";
import { padTo, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { TspSectionProps, TspTableProps, TspText } from "@oh-my-pi/pi-wire";

interface HelpTerm {
	readonly title?: string;
	readonly hint?: string;
}

interface HelpGroup {
	readonly head: string;
	readonly rows: readonly { readonly keys: string; readonly does: string }[];
}

const keysText = (cell: unknown): string =>
	Array.isArray(cell) ? cell.map(span => (span as { t: string }).t).join(" ") : plainText(cell as TspText);

function groupsOf(node: UiNode): HelpGroup[] {
	const groups: HelpGroup[] = [];
	for (const section of node.children()) {
		if (section.kind !== "section") continue;
		const head = plainText((section.props() as TspSectionProps).head);
		const table = section.children().find(child => child.kind === "table");
		const records = table ? ((table.props() as TspTableProps).rows ?? []) : [];
		groups.push({
			head,
			rows: records.map(record => ({
				keys: keysText(record.cells.keys),
				does: plainText(record.cells.does as TspText),
			})),
		});
	}
	return groups;
}

defineRolePainter("col", "omp.app.git.help", (node, cx) => {
	const theme = cx.theme;
	const term = ((node.props() as { term?: HelpTerm }).term ?? {}) as HelpTerm;
	const groups = groupsOf(node);
	const keyWidth = Math.max(0, ...groups.flatMap(group => group.rows.map(row => visibleWidth(row.keys)))) + 2;
	const limit = Math.max(1, cx.width - 1);
	const fit = (text: string): string => ` ${truncate(text, limit, theme.symbols.ellipsis)}`;
	const rows: string[] = [];
	if (term.title) rows.push(fit(theme.style("strong", term.title)));
	for (const group of groups) {
		rows.push("");
		rows.push(fit(theme.fg("muted", group.head)));
		for (const row of group.rows) {
			const keys = theme.fg("accent", row.keys);
			rows.push(fit(`  ${padTo(keys, keyWidth)}${row.does}`));
		}
	}
	if (term.hint) {
		rows.push("");
		rows.push(fit(theme.fg("dim", term.hint)));
	}
	return { rows };
});
