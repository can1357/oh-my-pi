/**
 * `omp.app.git.side`: the git sidebar in the terminal. A scrolling list (the
 * change count and branch, the Path/Tree toggle, the unstaged and staged
 * sections with their files, or the HEAD commit on a clean tree) above the
 * commit form pinned to the bottom (amend, summary with its countdown,
 * description, commit button). The selected row carries an accent bar or,
 * while the sidebar has the keyboard, the selection band.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { padTo, spaces, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { hslToHex } from "@oh-my-pi/pi-utils/color";
import { segmentGraphemes } from "@oh-my-pi/pi-utils/graphemes";
import type { ChangedFile } from "../../../../cli/git-tui/model/state";
import { type SidebarLayout, type SidebarModel, type SidebarRow, SUMMARY_LIMIT } from "../../../apps/git/sidebar-model";
import type { LineState } from "../../../overlays/settings/line-edit";
import type { FileEntry } from "../../../apps/git/tree";
import { chipFill, fgHex, pill, selectedRow, softPill, tintChip } from "./colors";

/** Status letter of a change kind. */
export const KIND_LETTER: Readonly<Record<ChangedFile["kind"], string>> = {
	modified: "M",
	added: "A",
	deleted: "D",
	renamed: "R",
	untracked: "?",
	conflicted: "U",
};

/** Status color of a change kind. */
export const KIND_TONE: Readonly<Record<ChangedFile["kind"], "warning" | "success" | "error" | "accent" | "muted">> = {
	modified: "warning",
	added: "success",
	deleted: "error",
	renamed: "accent",
	untracked: "muted",
	conflicted: "error",
};

const nerd = (theme: Theme): boolean => theme.symbols.preset === "nerd";

/** A one-line field: the text with an inverse caret cell, scrolled to keep the caret in `width`. */
export function fieldLine(theme: Theme, line: LineState, width: number): string {
	const graphemes = [...segmentGraphemes(line.text)].map(part => ({
		text: part.segment,
		start: part.index,
		width: visibleWidth(part.segment),
	}));
	let caretCol = 0;
	for (const g of graphemes) if (g.start < line.cursor) caretCol += g.width;
	const start = caretCol < width ? 0 : caretCol - width + 1;
	let col = 0;
	let out = "";
	let caretDrawn = false;
	for (const g of graphemes) {
		const at = col;
		col += g.width;
		if (at < start) continue;
		if (col - start > width) break;
		if (g.start === line.cursor) {
			out += theme.style("inverse", g.text);
			caretDrawn = true;
		} else out += g.text;
	}
	if (!caretDrawn && caretCol - start < width) out += theme.style("inverse", " ");
	return padTo(out, width);
}

/** The md5 identicon of an author: three rows of half blocks in one hue. */
function identicon(email: string, line: number): string {
	const bytes = new Bun.CryptoHasher("md5").update(email.trim().toLowerCase()).digest();
	const hex = hslToHex(((bytes[0]! << 8) | bytes[1]!) % 360, 0.55, 0.58);
	const on = (x: number, y: number): boolean => bytes[3 + (x < 3 ? x : 4 - x) * 5 + y]! % 2 === 0;
	let text = "";
	for (let x = 0; x < 5; x++) {
		const top = on(x, line * 2);
		const bottom = line * 2 + 1 < 5 && on(x, line * 2 + 1);
		text += (top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ").repeat(2);
	}
	return `${fgHex(hex)}${text}\x1b[0m`;
}

function counts(theme: Theme, file: ChangedFile): string {
	if (file.additions === undefined && file.deletions === undefined) return "";
	const parts: string[] = [];
	if (file.additions) parts.push(theme.fg("success", `+${file.additions}`));
	if (file.deletions) parts.push(theme.fg("error", `−${file.deletions}`));
	return parts.join(" ");
}

function fileRow(theme: Theme, file: ChangedFile, width: number, selected: boolean, depth: number | undefined): string {
	const prefix = `${theme.fg(KIND_TONE[file.kind], KIND_LETTER[file.kind])} `;
	const slash = file.path.lastIndexOf("/");
	const dir = depth === undefined && slash >= 0 ? file.path.slice(0, slash + 1) : "";
	const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
	const indent = depth === undefined ? 0 : depth;
	const stats = counts(theme, file);
	const statsWidth = visibleWidth(stats);
	const reserved = 4 + (statsWidth ? statsWidth + 1 : 0) + indent;
	const budget = width - reserved;
	const full = dir + base;
	let path =
		full.length <= budget
			? theme.fg("dim", dir) + base
			: theme.fg("dim", "…") + full.slice(Math.max(0, full.length - budget + 1));
	if (file.kind === "deleted") path = theme.style("strike", path);
	const pad = spaces(Math.max(0, width - reserved - visibleWidth(path)));
	const bar = selected ? theme.fg("accent", "▎") : " ";
	return `${bar}${spaces(indent)}${prefix}${path}${pad}${statsWidth ? ` ${stats}` : ""}`;
}

function entryRow(theme: Theme, entry: FileEntry, width: number, selected: boolean): string {
	if (entry.kind === "file") return fileRow(theme, entry.file, width, selected, entry.depth);
	const bar = selected ? theme.fg("accent", "▎") : " ";
	const text = `${bar}${spaces(entry.depth)}${theme.fg("muted", entry.collapsed ? "▸" : "▾")}${theme.fg("dim", `${entry.name}/`)}`;
	return truncate(padTo(text, Math.max(width, visibleWidth(text))), width, theme.symbols.ellipsis);
}

function sectionRow(theme: Theme, row: Extract<SidebarRow, { kind: "section" }>, width: number): string {
	const label = `${row.folded ? "▸" : "▾"} ${row.area === "unstaged" ? "Unstaged" : "Staged"} Files (${row.count})`;
	const accent = theme.hex("accent");
	const pills =
		row.area === "unstaged"
			? [chipFill(" Stage All ", accent), chipFill(` ${nerd(theme) ? "\uebcf" : "✦"} `, accent)]
			: [chipFill(" Unstage All ", accent)];
	const right = pills.reduce((sum, text) => sum + visibleWidth(text), 0) + pills.length - 1;
	const pad = Math.max(1, width - 2 - visibleWidth(label) - right);
	return ` ${theme.style("strong", label)}${spaces(pad)}${pills.join(" ")} `;
}

function editorLine(theme: Theme, text: string, caret: number | undefined): string {
	const tint = (value: string): string => (value ? theme.fgResolved("text", value) : "");
	if (caret === undefined) return tint(text);
	if (caret >= text.length) return tint(`${text}▏`);
	const chars = Array.from(text.slice(caret));
	const under = chars.shift()!;
	return `${tint(text.slice(0, caret))}${tint(theme.style("inverse", under))}${tint(chars.join(""))}`;
}

const fieldBar = (theme: Theme, selected: boolean): string =>
	selected ? theme.fg("accent", "▎") : theme.fg("borderMuted", "▏");

/** One sidebar row as styled text (not yet cut to the width). */
function rowText(theme: Theme, row: SidebarRow, width: number): string {
	switch (row.kind) {
		case "title": {
			const label = theme.style("strong", `${row.total} file change${row.total === 1 ? "" : "s"} on `);
			const branch = row.branch ? tintChip(theme, ` ${row.branch} `, theme.hex("accent")) : "";
			return ` ${label}${branch}`;
		}
		case "toggle": {
			const path = softPill(theme, ` ${nerd(theme) ? "\ueb84" : "☰"} Path `, row.style === "path");
			const tree = softPill(theme, ` ${nerd(theme) ? "\ueb86" : "└"} Tree `, row.style === "tree");
			return `${spaces(row.left)}${path} ${tree}`;
		}
		case "rule":
			return theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
		case "blank":
			return "";
		case "note":
			return theme.fg("dim", row.text);
		case "section": {
			const text = sectionRow(theme, row, width);
			return row.highlight ? selectedRow(theme, text) : text;
		}
		case "ai": {
			const field = row.line
				? fieldLine(theme, row.line, Math.max(1, width - 4))
				: theme.fg("dim", "What should we stage?");
			return ` ${fieldBar(theme, row.selected)}${field}`;
		}
		case "entry": {
			const text = entryRow(theme, row.entry, width, row.selected);
			return row.highlight ? selectedRow(theme, text) : text;
		}
		case "amend": {
			const text = ` ${row.on ? theme.fg("accent", "▣") : theme.fg("muted", "☐")} Amend previous commit`;
			return row.highlight ? selectedRow(theme, text) : text;
		}
		case "summary-label": {
			const left = SUMMARY_LIMIT - row.length;
			const counter = theme.fg(row.length > SUMMARY_LIMIT ? "warning" : "dim", String(left));
			const label = theme.fg("muted", "Commit summary");
			return ` ${label}${spaces(Math.max(1, width - 2 - visibleWidth(label) - visibleWidth(counter)))}${counter}`;
		}
		case "summary":
			return ` ${fieldBar(theme, row.selected)}${fieldLine(theme, row.line, Math.max(1, width - 4))}`;
		case "description":
			return ` ${fieldBar(theme, row.selected)}${row.text === undefined ? theme.fg("dim", "Description") : editorLine(theme, row.text, row.caret)}`;
		case "button": {
			const pad = spaces(Math.max(0, Math.floor((width - 4 - visibleWidth(row.label)) / 2)));
			return ` ${pill(theme, `${pad}${row.label}${pad}`, theme.hex("accent"), { dim: !row.enabled, selected: row.highlight })}`;
		}
		case "subject":
			return ` ${theme.style("strong", row.text)}`;
		case "body":
			return theme.fg("muted", ` ${row.text}`);
		case "avatar":
			return ` ${identicon(row.email, row.line)}`;
		case "author":
			return ` ${theme.style("strong", row.name)} ${theme.fg("dim", `<${row.email}>`)}`;
		case "authored":
			return theme.fg("dim", ` authored ${row.when}`);
		case "parents":
			return ` ${theme.fg("dim", "parent:")} ${theme.fg("accent", row.parents.map(sha => sha.slice(0, 8)).join(" "))}`;
		case "clean":
			return theme.fg("success", ` Working tree clean — showing committed ${row.sha}`);
		case "commit-files": {
			const count = `${row.count} file${row.count === 1 ? "" : "s"}`;
			return ` ${theme.style("strong", count)} ${theme.fg("dim", `in ${row.sha}`)}  ${theme.fg("success", `+${row.additions}`)} ${theme.fg("error", `−${row.deletions}`)}`;
		}
	}
}

/** The sidebar's rows at a size. */
export function paintSidebar(theme: Theme, layout: SidebarLayout, width: number): string[] {
	return layout.rows.map(row => truncate(rowText(theme, row, width), width, theme.symbols.ellipsis));
}

defineRolePainter("col", "omp.app.git.side", (node: UiNode, cx) => {
	const sidebar = (node.props() as { term?: { sidebar?: SidebarModel } }).term?.sidebar;
	if (!sidebar) return { rows: [] };
	const height = cx.height ?? 24;
	return { rows: paintSidebar(cx.theme, sidebar.layout(cx.width, height), cx.width) };
});
