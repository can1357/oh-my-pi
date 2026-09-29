/**
 * Keyboard shortcuts sheet of the git TUI (`?`).
 *
 * The keys are the git TUI's own (see `git-tui.ts` and `sidebar.ts`); this
 * sheet only lists them. ANSI draws grouped `key  description` rows; the
 * native render is the hotkeys sheet (NATIVE_REDESIGN §9.7): a glass sheet
 * titled "Keyboard shortcuts" with one section per group and a two-column
 * table whose key cells carry the `key` span token, so Tern draws keycaps.
 */
import { formatKeyHint } from "../../app-keybindings";
import type { KeyName } from "../../key-hint-format";
import { matchesKey } from "../../keys";
import { col, node, span } from "../../native/describe";
import type { NativeNode } from "../../native/node";
import { theme } from "../../theme/theme";
import type { Component } from "../../tui";
import { truncateToWidth, visibleWidth } from "../../utils";

interface Shortcut {
	readonly keys: readonly KeyName[];
	readonly label: string;
}

const GROUPS: readonly { readonly title: string; readonly rows: readonly Shortcut[] }[] = [
	{
		title: "Move",
		rows: [
			{ keys: ["up", "down"], label: "Move the selection" },
			{ keys: ["left", "right"], label: "Fold or unfold a folder or section" },
			{ keys: ["enter"], label: "Open the file in the diff" },
			{ keys: ["tab"], label: "Switch between the diff and the changes" },
			{ keys: ["]", "["], label: "Next or previous file" },
			{ keys: ["alt+down", "alt+up"], label: "Next or previous change" },
			{ keys: ["g", "shift+g"], label: "First or last row" },
		],
	},
	{
		title: "Stage",
		rows: [
			{ keys: ["space"], label: "Stage or unstage the row" },
			{ keys: ["s", "u"], label: "Stage or unstage (the hunk or selected lines in the diff)" },
			{ keys: ["shift+up", "shift+down"], label: "Select lines in the diff" },
			{ keys: ["x"], label: "Discard the hunk or selected lines (press twice)" },
			{ keys: ["delete"], label: "Discard the file or folder (press twice)" },
		],
	},
	{
		title: "View",
		rows: [
			{ keys: ["v"], label: "Cycle the diff view" },
			{ keys: ["1", "2", "3", "4"], label: "File, split, inline or hunk view" },
			{ keys: ["w"], label: "Wrap long lines" },
			{ keys: ["b"], label: "Ignore whitespace, then formatting" },
			{ keys: ["t"], label: "Paths or folder tree" },
			{ keys: ["r"], label: "Refresh" },
		],
	},
	{
		title: "Commit",
		rows: [
			{ keys: ["c"], label: "Write the commit message (empty: generate one)" },
			{ keys: ["escape"], label: "Leave the field" },
			{ keys: ["q"], label: "Quit" },
		],
	},
];

/** The shortcuts overlay; any of `?`, escape or `q` closes it. */
export class GitHelpSheet implements Component {
	readonly nativeOverlay = { role: "omp.overlay.hotkeys", head: "Keyboard shortcuts", size: "lg" } as const;
	readonly #close: () => void;
	#native: NativeNode | undefined;

	constructor(close: () => void) {
		this.#close = close;
	}

	handleInput(data: string): void {
		if (data === "?" || data === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.#close();
	}

	describe(): NativeNode {
		this.#native ??= col(
			GROUPS.map(group =>
				node(
					"section",
					{ head: group.title, role: "omp.hotkeys.group" },
					[
						node("table", {
							role: "omp.hotkeys.table",
							cols: [
								{ id: "keys", head: "Keys" },
								{ id: "does", head: "Action", grow: 1 },
							],
							rows: group.rows.map((row, index) => ({
								id: String(index),
								cells: { keys: row.keys.map(key => span(formatKeyHint(key), "key")), does: row.label },
							})),
						}),
					],
					group.title,
				),
			),
			{ gap: "lg", role: "omp.app.git.help" },
		);
		return this.#native;
	}

	render(width: number): readonly string[] {
		const keyWidth = Math.max(
			...GROUPS.flatMap(group => group.rows.map(row => visibleWidth(row.keys.map(formatKeyHint).join(" ")))),
		);
		const lines = [truncateToWidth(` ${theme.bold("Keyboard shortcuts")}`, width), ""];
		for (const group of GROUPS) {
			lines.push(truncateToWidth(` ${theme.fg("muted", group.title)}`, width));
			for (const row of group.rows) {
				const keys = row.keys.map(formatKeyHint).join(" ");
				const pad = " ".repeat(Math.max(1, keyWidth - visibleWidth(keys) + 2));
				lines.push(truncateToWidth(`   ${theme.fg("accent", keys)}${pad}${row.label}`, width));
			}
			lines.push("");
		}
		lines.push(truncateToWidth(` ${theme.fg("dim", `${formatKeyHint("escape")} close`)}`, width));
		return lines;
	}

	invalidate(): void {
		this.#native = undefined;
	}
}
