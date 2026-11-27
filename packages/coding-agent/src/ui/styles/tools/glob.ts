/**
 * The `glob` look: a head line (`🔍 Glob: src/*.ts 25 files · in src · truncated`,
 * the globs' wildcards highlighted) and a branch tree of the paths with
 * file-type icons; collapsed keeps the first eight under `… N more files`.
 * Notes (limits, skipped paths) follow in the warning color.
 */
import * as path from "node:path";
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { languageFromPath } from "@oh-my-pi/pi-tui/text/lang";
import { truncate, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import type { GlobTerm } from "../../tools/glob";
import { fileLink } from "./file-common";
import { standaloneError } from "./frame";
import { defineToolLook, toolProps } from "./look";
import { moreItem, pathText, searchGlyph, searchHeadRows, type TreeItem, treeRows } from "./search";

/** Paths listed while collapsed. */
const COLLAPSED_FILES = 8;

/** A path's icon: a folder, else its file type's. */
export function fileIcon(theme: Theme, path: string): string {
	const icon = path.endsWith("/") ? theme.symbols.icon("folder") : theme.symbols.langIcon(languageFromPath(path));
	return theme.fg("muted", icon);
}

/** Note rows in the warning color, each cut to the width. */
export function noteRows(theme: Theme, notes: readonly string[] | undefined, width: number): string[] {
	return (notes ?? []).map(note => truncate(theme.fg("warning", note), width, ""));
}

function paintGlob(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = (props.term ?? { look: "glob" }) as GlobTerm;
	const theme = cx.theme;
	if (term.error !== undefined) return standaloneError(cx, term.error);
	if (!term.result) {
		const meta = (props.meta ?? []).filter((fact): fact is string => typeof fact === "string");
		return {
			rows: searchHeadRows(cx, {
				glyph: "pending",
				title: props.title,
				target: props.target,
				meta,
			}),
		};
	}
	const truncated = props.badges?.some(badge => badge.text === "truncated") ?? false;
	const meta = (props.meta ?? []).filter((fact): fact is string => typeof fact === "string");
	if (typeof props.note === "string") meta.push(theme.fg("warning", props.note));
	if (truncated) meta.push(theme.fg("warning", "truncated"));
	const warning = props.tone === "warning" || truncated;
	const rows = searchHeadRows(cx, {
		glyph: warning ? "warning" : "search",
		title: props.title,
		target: term.target ? props.target : undefined,
		meta,
	});
	if (term.empty !== undefined) {
		const empty = `${searchGlyph(theme, "warning")} ${theme.fg("muted", term.empty)}`;
		return {
			rows: [...(term.headless ? [] : rows), ...wrap(empty, cx.width), ...noteRows(theme, term.notes, cx.width)],
		};
	}
	const files = term.files ?? [];
	const expanded = props.collapsed === false;
	const shown = expanded || files.length <= COLLAPSED_FILES ? files : files.slice(0, COLLAPSED_FILES);
	// Files (not directories) link under the checkout the paths are relative to.
	const link = (file: string): string =>
		term.cwd && !file.endsWith("/")
			? fileLink(cx, pathText(theme, file), path.resolve(term.cwd, file))
			: pathText(theme, file);
	const items: TreeItem[] = shown.map(file => [term.plain ? link(file) : `${fileIcon(theme, file)} ${link(file)}`]);
	if (shown.length < files.length) items.push(moreItem(theme, files.length - shown.length, "files"));
	return {
		rows: [...rows, ...treeRows(theme, items, cx.width), ...noteRows(theme, term.notes, cx.width)],
	};
}

defineToolLook("glob", { paint: paintGlob, margin: true, inset: true });
