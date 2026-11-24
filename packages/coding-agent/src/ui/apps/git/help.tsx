/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The git app's keyboard-shortcuts sheet (`?`): one `section` per group with
 * a two-column hotkeys `table` (key cells carry the `key` span token so a Tern
 * terminal draws keycaps), then a `Close esc` action. The terminal draws it
 * as a titled list of `keys  description` rows (`omp.app.git.help` look).
 */
import { type Accessor, type JSXNode, type KeyEvent, nativeRendering } from "@oh-my-pi/pi-tui";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import "../../styles/apps/git/help";
import "../../styles/overlays/bare-sheet";
import { formatKey } from "../../keys/format";
import { ActionButton } from "../../overlays/panels/common";
import { formatKeyHint } from "../../keys/hints";
import type { SheetAttributes } from "../../overlays/sheet";

/** One shortcut: its keys (`alt+down`) and what it does. */
export interface GitShortcut {
	readonly keys: readonly string[];
	readonly label: string;
}

/** A titled group of shortcuts. */
export interface GitShortcutGroup {
	readonly title: string;
	readonly rows: readonly GitShortcut[];
}

/** Every shortcut of the git app, grouped as the sheet lists them. */
export const GIT_SHORTCUTS: readonly GitShortcutGroup[] = [
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

/** Keys that close the sheet. */
const CLOSE_KEYS: Readonly<Record<string, true>> = { "?": true, "shift+/": true, escape: true, q: true };

/** Whether `key` closes the help sheet (`?`, escape, `q`). */
export function closesGitHelp(key: KeyEvent): boolean {
	return key.kind !== "release" && (CLOSE_KEYS[key.id] === true || key.text === "?");
}

/**
 * The sheet's `overlay` attributes: Tern's large titled sheet, or in terminal
 * rows the bare help text over four fifths of the `columns`.
 */
export function gitHelpSheet(native: boolean, columns: Accessor<number>): SheetAttributes {
	return native
		? { anchor: "center", size: "lg", modal: true, role: "omp.overlay.hotkeys", head: "Keyboard shortcuts" }
		: {
				anchor: "center",
				modal: true,
				role: "omp.sheet.bare",
				term: () => ({ width: Math.floor(columns() * 0.8) }),
			};
}

/** Props of {@link GitHelp}. */
export interface GitHelpProps {
	onClose(): void;
}

/**
 * Keycap glyphs of `keys` (`⌥↓` on macOS, `Alt+↓` elsewhere): unicode keycaps
 * in terminal rows, the theme's own glyphs where Tern draws the sheet.
 */
const keySpans = (keys: readonly string[], native: boolean): TspSpan[] =>
	keys.map(key => ({
		s: "key",
		t: native ? formatKeyHint(key) : formatKey(key, { preset: "unicode", platform: process.platform }),
	}));

/** The shortcuts sheet (see the module docs). */
export function GitHelp(props: GitHelpProps): JSXNode {
	const native = nativeRendering();
	return (
		<col
			role="omp.app.git.help"
			gap="lg"
			term={{ title: "Keyboard shortcuts", hint: "⎋ close" }}
			onAction={act => {
				if (act === "close") props.onClose();
			}}
			onKey={key => {
				if (!closesGitHelp(key)) return false;
				props.onClose();
				return true;
			}}
		>
			{GIT_SHORTCUTS.map(group => (
				<section key={group.title} head={group.title} role="omp.hotkeys.group">
					<table
						role="omp.hotkeys.table"
						cols={[
							{ id: "keys", head: "Keys" },
							{ id: "does", head: "Action", grow: 1 },
						]}
						rows={group.rows.map((row, index) => ({
							id: String(index),
							cells: { keys: keySpans(row.keys, native), does: row.label },
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
