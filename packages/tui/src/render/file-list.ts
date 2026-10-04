/**
 * Render file listings with optional icons and metadata.
 */
import { getLanguageFromPath } from "../lang-from-path";
import { node, span } from "../native/describe";
import type { NativeNode } from "../native/node";
import type { Theme } from "../theme/theme";
import { fileLinkSpan } from "./hyperlink";
import { renderTreeList } from "./tree-list";

/** A file-list item with optional display metadata. */
export interface FileEntry {
	path: string;
	/** Absolute filesystem path. When provided together with {@link FileListOptions.hyperlinkFn}, the
	 * rendered path text is wrapped in an OSC 8 hyperlink. */
	absPath?: string;
	isDirectory?: boolean;
	meta?: string;
}

/** Files and presentation options for a tree-style listing. */
export interface FileListOptions {
	files: FileEntry[];
	expanded?: boolean;
	maxCollapsed?: number;
	showIcons?: boolean;
	/** When provided, called with the entry's absolute path and the ANSI-styled display string to
	 * optionally wrap the path in an OSC 8 hyperlink. Only invoked when {@link FileEntry.absPath} is set. */
	hyperlinkFn?: (absPath: string, displayText: string) => string;
}

/**
 * The native form of {@link renderFileList}: a `list` of path `item`s keyed
 * by path, linked to their absolute path, with language/folder icons and the
 * meta as detail. Collapsed, the list is clamped to `maxCollapsed` lines and
 * the terminal scrolls the rest.
 */
export function describeFileList(options: Omit<FileListOptions, "hyperlinkFn">): NativeNode {
	const { files, expanded = false, maxCollapsed = 8, showIcons = true } = options;
	const items = files.map(entry => {
		const isDirectory = entry.isDirectory ?? entry.path.endsWith("/");
		const s = isDirectory ? "path accent" : "path";
		const label = entry.absPath ? fileLinkSpan(entry.absPath, entry.path, s) : span(entry.path, s);
		return node(
			"item",
			{
				label: [label],
				icon: showIcons ? (isDirectory ? "folder" : (getLanguageFromPath(entry.path) ?? "file")) : undefined,
				detail: entry.meta ? [span(entry.meta, "dim")] : undefined,
			},
			undefined,
			entry.path,
		);
	});
	return node("list", { max: expanded ? undefined : { lines: maxCollapsed } }, items);
}

/** Render file entries as a themed tree listing. */
export function renderFileList(options: FileListOptions, theme: Theme): string[] {
	const { files, expanded = false, maxCollapsed = 8, showIcons = true, hyperlinkFn } = options;

	return renderTreeList(
		{
			items: files,
			expanded,
			maxCollapsed,
			itemType: "file",
			renderItem: entry => {
				const isDirectory = entry.isDirectory ?? entry.path.endsWith("/");
				const displayPath = entry.path;
				const lang = isDirectory ? undefined : getLanguageFromPath(displayPath);
				const icon = !showIcons
					? ""
					: isDirectory
						? theme.fg("accent", theme.icon.folder)
						: theme.fg("muted", theme.getLangIcon(lang));
				const labelColor = isDirectory ? "accent" : "toolOutput";
				const meta = entry.meta ? ` ${theme.fg("dim", entry.meta)}` : "";
				const iconPrefix = icon ? `${icon} ` : "";
				const pathStr = theme.fg(labelColor, displayPath);
				const linkedPath = entry.absPath && hyperlinkFn ? hyperlinkFn(entry.absPath, pathStr) : pathStr;
				return `${iconPrefix}${linkedPath}${meta}`;
			},
		},
		theme,
	);
}
