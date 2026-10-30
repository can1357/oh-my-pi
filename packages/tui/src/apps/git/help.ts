/**
 * Keyboard shortcuts sheet of the git TUI (`?`).
 *
 * The keys are the git TUI's own (see `git-tui.ts` and `sidebar.ts`); this
 * sheet only lists them. ANSI draws grouped `key  description` rows; the
 * native render is the hotkeys sheet (NATIVE_REDESIGN §9.7): a glass sheet
 * titled "Keyboard shortcuts" with one section per group and a two-column
 * table whose key cells carry the `key` span token, so Tern draws keycaps.
 */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { formatKeyHint } from "../../app-keybindings";
import type { KeyName } from "../../key-hint-format";
import { matchesKey } from "../../keys";
import { col, node, span } from "../../native/describe";
import type { NativeNode, NativeUiEvent } from "../../native/node";
import { actionBar, actionButton } from "../../native/overlay";
import { theme } from "../../theme/theme";
import type { Component } from "../../tui";
import { truncateToWidth, visibleWidth } from "../../utils";

interface Shortcut {
	readonly keys: readonly KeyName[];
	readonly label: string;
}

const GROUPS: readonly { readonly title: string; readonly rows: readonly Shortcut[] }[] = [
	{
		title: __ompTranslate("Move"),
		rows: [
			{ keys: ["up", "down"], label: __ompTranslate("Move the selection") },
			{ keys: ["left", "right"], label: __ompTranslate("Fold or unfold a folder or section") },
			{ keys: ["enter"], label: __ompTranslate("Open the file in the diff") },
			{ keys: ["tab"], label: __ompTranslate("Switch between the diff and the changes") },
			{ keys: ["]", "["], label: __ompTranslate("Next or previous file") },
			{ keys: ["alt+down", "alt+up"], label: __ompTranslate("Next or previous change") },
			{ keys: ["g", "shift+g"], label: __ompTranslate("First or last row") },
		],
	},
	{
		title: __ompTranslate("Stage"),
		rows: [
			{ keys: ["space"], label: __ompTranslate("Stage or unstage the row") },
			{ keys: ["s", "u"], label: __ompTranslate("Stage or unstage (the hunk or selected lines in the diff)") },
			{ keys: ["shift+up", "shift+down"], label: __ompTranslate("Select lines in the diff") },
			{ keys: ["x"], label: __ompTranslate("Discard the hunk or selected lines (press twice)") },
			{ keys: ["delete"], label: __ompTranslate("Discard the file or folder (press twice)") },
		],
	},
	{
		title: __ompTranslate("View"),
		rows: [
			{ keys: ["v"], label: __ompTranslate("Cycle the diff view") },
			{ keys: ["1", "2", "3", "4"], label: __ompTranslate("File, split, inline or hunk view") },
			{ keys: ["w"], label: __ompTranslate("Wrap long lines") },
			{ keys: ["b"], label: __ompTranslate("Ignore whitespace, then formatting") },
			{ keys: ["t"], label: __ompTranslate("Paths or folder tree") },
			{ keys: ["r"], label: __ompTranslate("Refresh") },
		],
	},
	{
		title: __ompTranslate("Commit"),
		rows: [
			{ keys: ["c"], label: __ompTranslate("Write the commit message (empty: generate one)") },
			{ keys: ["escape"], label: __ompTranslate("Leave the field") },
			{ keys: ["q"], label: __ompTranslate("Quit") },
		],
	},
];

/** The shortcuts overlay; any of `?`, escape or `q` closes it. */
export class GitHelpSheet implements Component {
	readonly nativeOverlay = {
		role: "omp.overlay.hotkeys",
		head: __ompTranslate("Keyboard shortcuts"),
		size: "lg",
	} as const;
	readonly #close: () => void;
	#native: NativeNode | undefined;

	constructor(close: () => void) {
		this.#close = close;
	}

	handleInput(data: string): void {
		if (data === "?" || data === "q" || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.#close();
	}

	/** Close runs what Esc runs. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "close") this.#close();
	}

	describe(): NativeNode {
		this.#native ??= col(
			[
				...GROUPS.map(group =>
					node(
						"section",
						{ head: group.title, role: "omp.hotkeys.group" },
						[
							node("table", {
								role: "omp.hotkeys.table",
								cols: [
									{ id: "keys", head: __ompTranslate("Keys") },
									{ id: "does", head: __ompTranslate("Action"), grow: 1 },
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
				actionBar([null, actionButton(__ompTranslate("Close"), "close", { keys: "escape" })]),
			],
			{ gap: "lg", role: "omp.app.git.help" },
		);
		return this.#native;
	}

	render(width: number): readonly string[] {
		const keyWidth = Math.max(
			...GROUPS.flatMap(group => group.rows.map(row => visibleWidth(row.keys.map(formatKeyHint).join(" ")))),
		);
		const lines = [truncateToWidth(` ${theme.bold(__ompTranslate("Keyboard shortcuts"))}`, width), ""];
		for (const group of GROUPS) {
			lines.push(truncateToWidth(` ${theme.fg("muted", group.title)}`, width));
			for (const row of group.rows) {
				const keys = row.keys.map(formatKeyHint).join(" ");
				const pad = " ".repeat(Math.max(1, keyWidth - visibleWidth(keys) + 2));
				lines.push(truncateToWidth(`   ${theme.fg("accent", keys)}${pad}${row.label}`, width));
			}
			lines.push("");
		}
		lines.push(
			truncateToWidth(` ${theme.fg("dim", __ompTranslate("{0} close", `${formatKeyHint("escape")}`))}`, width),
		);
		return lines;
	}

	invalidate(): void {
		this.#native = undefined;
	}
}
