/**
 * `omp.app.git` / `omp.app.git-narrow`: the git app in the terminal, at full
 * screen size. Row 0 is the header (the shown file and its `+a −d`, key hints
 * or the latest status centered in the free space, the content kind, the
 * Stage/Unstage File pill, close); row 1 the toolbar (scope chip, change
 * navigation and the view switch centered over the diff, whitespace and wrap
 * toggles at the right); below, the diff pane, a divider (accent while the
 * sidebar has the keyboard) and the sidebar. Pointer input reaches the app
 * through its role widget.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { defineRolePainter, type PaintContext, type PaintImages } from "@oh-my-pi/pi-tui/term/paint";
import { defineRoleWidget } from "@oh-my-pi/pi-tui/term/widgets";
import { padTo, spaces, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { type ChromeHit, type GitAppModel, type GitFocus, gitLayout } from "../../../apps/git/app-model";
import type { ViewMode } from "../../../apps/git/diff-pane-model";
import { keyLabel } from "../../../keys/hints";
import { pill, softPill, tintChip } from "./colors";
import { paintDiffPane } from "./diff-pane";
import { paintSidebar } from "./sidebar";

type Glyph = "close" | "hunk" | "inline" | "split" | "file" | "ws" | "wrap" | "up" | "down";

const UNICODE_GLYPHS: Readonly<Record<Glyph, string>> = {
	close: "✕",
	hunk: "⊟",
	inline: "≡",
	split: "◫",
	file: "▤",
	ws: "¶",
	wrap: "⏎",
	up: "↑",
	down: "↓",
};

const NERD_GLYPHS: Readonly<Record<Glyph, string>> = {
	close: "\uea76",
	hunk: "\ueab3",
	inline: "\ueb17",
	split: "\ueb57",
	file: "\ueae9",
	ws: "\ueb7d",
	wrap: "\ueb80",
	up: "\ueaa1",
	down: "\uea9a",
};

/** Key hints of the header for a pane; a clean tree drops what cannot fire there. */
export function gitKeyHints(theme: Theme, clean: boolean, focus: GitFocus): string {
	const key = (...keys: string[]): string => keys.map(name => keyLabel(theme, name)).join("/");
	const edit = clean
		? ""
		: focus === "diff"
			? ` · ${key("s", "u")} stage · ${key("x", "delete")} discard`
			: ` · ${key("space")} stage · ${key("delete")} discard`;
	const commit = clean ? "" : ` · ${key("c")} commit`;
	const select = clean || focus !== "diff" ? "" : ` · ${key("shift+up", "shift+down")} select`;
	return focus === "diff"
		? `${key("alt+down", "alt+up")} hunk · ${key("]", "[")} file${select}${edit} · ${key("v")} view${commit} · ${key("?")} keys · ${key("q")} quit`
		: `${key("up", "down")} move · ${key("left", "right")} fold${edit} · ${key("enter")} open · ${key("alt+down", "alt+up")} hunk${commit} · ${key("t")} tree · ${key("?")} keys · ${key("q")} quit`;
}

/** One chrome row being built: text plus the clickable ranges in it. */
class ChromeRow {
	text = "";
	width = 0;
	readonly hits: ChromeHit[] = [];

	add(text: string): this {
		this.text += text;
		this.width += visibleWidth(text);
		return this;
	}

	button(text: string, act: string): this {
		const from = this.width;
		this.add(text);
		this.hits.push({ from, to: this.width, act });
		return this;
	}

	shifted(by: number): ChromeHit[] {
		return this.hits.map(hit => ({ ...hit, from: hit.from + by, to: hit.to + by }));
	}
}

function header(
	app: GitAppModel,
	theme: Theme,
	width: number,
	glyphs: Record<Glyph, string>,
): { text: string; hits: ChromeHit[] } {
	const left = new ChromeRow().add(" ");
	const file = app.currentFile();
	if (file) {
		const slash = file.path.lastIndexOf("/");
		left.add(`${theme.fg("dim", file.path.slice(0, slash + 1))}${theme.style("strong", file.path.slice(slash + 1))}`);
		const doc = app.pane.doc;
		if (doc) left.add(`  ${theme.fg("success", `+${doc.additions}`)} ${theme.fg("error", `−${doc.deletions}`)}`);
	} else left.add(theme.fg("dim", "no file selected"));

	const right = new ChromeRow();
	const contents = app.contents();
	const asset = contents?.kind === "asset" ? contents : null;
	const kind =
		asset && (asset.old.kind === "image" || asset.new.kind === "image") ? "Media" : asset ? "Binary" : "UTF-8";
	right.add(theme.fg("dim", kind)).add("  ");
	if (file?.area === "unstaged") right.button(pill(theme, " Stage File ", theme.hex("toolDiffAdded")), "stage-file");
	else if (file?.area === "staged") right.button(pill(theme, " Unstage File ", theme.hex("warning")), "stage-file");
	right.add(" ").button(softPill(theme, ` ${glyphs.close} `, false), "close");

	const status = app.visibleStatus();
	const middle = status
		? theme.fg(status.tone, status.text)
		: theme.fg("dim", gitKeyHints(theme, app.model.clean, app.focus()));
	const free = width - left.width - right.width - 1;
	const shown =
		free > visibleWidth(middle) + 4 ? middle : truncate(middle, Math.max(0, free - 4), theme.symbols.ellipsis);
	const leftPad = Math.max(1, Math.floor((free - visibleWidth(shown)) / 2));
	const pad = Math.max(1, free - leftPad - visibleWidth(shown));
	const offset = left.width + leftPad + visibleWidth(shown) + pad;
	return {
		text: truncate(
			`${left.text}${spaces(leftPad)}${shown}${spaces(pad)}${right.text}`,
			width,
			theme.symbols.ellipsis,
		),
		hits: [...left.hits, ...right.shifted(offset)],
	};
}

function toolbar(
	app: GitAppModel,
	theme: Theme,
	width: number,
	centerWidth: number,
	glyphs: Record<Glyph, string>,
): { text: string; hits: ChromeHit[] } {
	const file = app.currentFile();
	const row = new ChromeRow().add(" ");
	row.add(
		file?.area === "staged"
			? tintChip(theme, " Staged ", theme.hex("success"))
			: file?.area === "unstaged"
				? tintChip(theme, file.kind === "untracked" ? " Untracked " : " Unstaged ", theme.hex("warning"))
				: file
					? tintChip(theme, ` ${app.model.headCommit?.shortSha ?? "commit"} `, theme.hex("accent"))
					: theme.fg("dim", ` ${app.model.branch ?? "detached"} `),
	);
	const segments: [string, ViewMode][] = [
		[` ${glyphs.file} `, "file"],
		[` ${glyphs.split} `, "split"],
		[` ${glyphs.inline} `, "inline"],
		[` ${glyphs.hunk} `, "hunk"],
	];
	const up = theme.fg("muted", ` ${glyphs.up} `);
	const down = theme.fg("muted", ` ${glyphs.down} `);
	const segmentsWidth = segments.reduce((sum, [label]) => sum + visibleWidth(label), 0);
	const groupWidth = visibleWidth(up) + visibleWidth(down) + 2 + segmentsWidth;
	const groupStart = Math.max(row.width + 2, Math.floor((centerWidth - groupWidth) / 2));
	row.add(spaces(groupStart - row.width));
	row.button(up, "prev-hunk").button(down, "next-hunk").add("  ");
	const mode = app.pane.mode;
	for (const [label, view] of segments) row.button(softPill(theme, label, mode === view), `view:${view}`);

	const whitespace = app.whitespace();
	const right = new ChromeRow();
	const wsLabel = whitespace === "formatting" ? `${glyphs.ws}+` : glyphs.ws;
	right.button(softPill(theme, ` ${wsLabel} `, whitespace !== "off"), "whitespace").add(" ");
	right.button(softPill(theme, ` ${glyphs.wrap} `, app.pane.wrap), "wrap").add(" ");
	const pad = Math.max(1, width - row.width - right.width);
	return {
		text: truncate(`${row.text}${spaces(pad)}${right.text}`, width, theme.symbols.ellipsis),
		hits: [...row.hits, ...right.shifted(row.width + pad)],
	};
}

/** The app's rows at a size (records the layout and chrome buttons for the pointer). */
export function paintGitApp(
	app: GitAppModel,
	theme: Theme,
	width: number,
	height: number,
	images?: PaintImages,
): string[] {
	const layout = gitLayout(width, height);
	const glyphs = theme.symbols.preset === "nerd" ? NERD_GLYPHS : UNICODE_GLYPHS;
	const top = header(app, theme, width, glyphs);
	const tools = toolbar(app, theme, width, layout.centerWidth, glyphs);
	app.recordChrome(layout, top.hits, tools.hits);
	const left = paintDiffPane(app.pane, theme, layout.centerWidth, layout.contentHeight, images);
	const right = paintSidebar(
		theme,
		app.sidebar.layout(layout.sidebarWidth, layout.contentHeight),
		layout.sidebarWidth,
	);
	const divider = app.focus() === "sidebar" ? theme.fg("accent", "│") : theme.fg("borderMuted", "│");
	const rows = [top.text, tools.text];
	for (let i = 0; i < layout.contentHeight; i++) {
		const pane = truncate(left[i] ?? "", layout.centerWidth, theme.symbols.ellipsis);
		rows.push(`${padTo(pane, layout.centerWidth)}${divider}${right[i] ?? ""}`);
	}
	return rows;
}

const appOf = (node: UiNode): GitAppModel | undefined => (node.props() as { term?: { app?: GitAppModel } }).term?.app;

function paint(node: UiNode, cx: PaintContext) {
	const app = appOf(node);
	if (!app) return { rows: [] };
	const height = Math.max(10, cx.height ?? 30);
	const rows = paintGitApp(app, cx.theme, cx.width, height, cx.images);
	return { rows, hits: [{ row: 0, col: 0, width: cx.width, height: rows.length, node }] };
}

const widget = {
	mouse(node: UiNode, mouse: Parameters<GitAppModel["handleMouse"]>[0], at: { row: number; col: number }) {
		return appOf(node)?.handleMouse({ ...mouse, row: at.row, col: at.col }) ?? false;
	},
};

defineRolePainter("row", "omp.app.git", paint);
defineRolePainter("col", "omp.app.git-narrow", paint);
defineRoleWidget("row", "omp.app.git", widget);
defineRoleWidget("col", "omp.app.git-narrow", widget);
