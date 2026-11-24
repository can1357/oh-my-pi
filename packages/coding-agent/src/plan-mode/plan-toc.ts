/**
 * Collapse inline markdown emphasis/link/code syntax to readable text. This is
 * a deliberately light strip (not a full markdown render) just so ToC entries
 * read cleanly — `**Goal** & [docs](x)` becomes `Goal & docs`. With
 * `keepIntrawordUnderscores`, `_`/`__` mark emphasis only at word edges (as
 * CommonMark has it), so `snake_case_name` survives.
 */
export function stripInlineMarkdown(text: string, options: { keepIntrawordUnderscores?: boolean } = {}): string {
	let out = text;
	// Images first (so the link pass below does not eat the `(url)`), then links.
	out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
	out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
	out = out.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");
	// Autolinks `<https://…>` keep their URL as the readable text.
	out = out.replace(/<([^>\s]+)>/g, "$1");
	// Inline code, then bold/italic/strikethrough emphasis runs.
	out = out.replace(/`([^`]+)`/g, "$1");
	if (options.keepIntrawordUnderscores) {
		out = out.replace(/\*\*(.+?)\*\*/g, "$1");
		out = out.replace(/(?<![\p{L}\p{N}_])__(.+?)__(?![\p{L}\p{N}_])/gu, "$1");
		out = out.replace(/\*(.+?)\*/g, "$1");
		out = out.replace(/(?<![\p{L}\p{N}_])_(.+?)_(?![\p{L}\p{N}_])/gu, "$1");
	} else {
		out = out.replace(/(\*\*|__)(.+?)\1/g, "$2");
		out = out.replace(/(\*|_)(.+?)\1/g, "$2");
	}
	out = out.replace(/~~(.+?)~~/g, "$1");
	return out.replace(/\s+/g, " ").trim();
}
