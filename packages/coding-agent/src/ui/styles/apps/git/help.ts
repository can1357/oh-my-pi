/**
 * `omp.app.git.help`: the git app's shortcuts sheet in the terminal. A bold
 * title, then per group a blank row, the muted group title and one
 * `  keys  description` row per shortcut (keys in `accent`, all in one
 * column), then a blank row and the dim close hint. Every row is indented one
 * cell and cut with an ellipsis at the width.
 */
import { defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { padTo, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { GitShortcutGroup } from "../../../apps/git/help";
import { keyLabel } from "../../../keys/hints";
import { termOf } from "../../panels/common";

defineRolePainter("col", "omp.app.git.help", (node, cx) => {
	const theme = cx.theme;
	const source = termOf<{ groups: readonly GitShortcutGroup[] }>(node).groups ?? [];
	const groups = source.map(group => ({
		head: group.title,
		rows: group.rows.map(row => ({ keys: row.keys.map(key => keyLabel(theme, key)).join(" "), does: row.label })),
	}));
	const keyWidth = Math.max(0, ...groups.flatMap(group => group.rows.map(row => visibleWidth(row.keys)))) + 2;
	const limit = Math.max(1, cx.width - 1);
	const fit = (text: string): string => ` ${truncate(text, limit, theme.symbols.ellipsis)}`;
	const rows = [fit(theme.style("strong", "Keyboard shortcuts"))];
	for (const group of groups) {
		rows.push("");
		rows.push(fit(theme.fg("muted", group.head)));
		for (const row of group.rows) {
			const keys = theme.fg("accent", row.keys);
			rows.push(fit(`  ${padTo(keys, keyWidth)}${row.does}`));
		}
	}
	rows.push("", fit(theme.fg("dim", `${keyLabel(theme, "escape")} close`)));
	return { rows };
});
