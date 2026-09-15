import * as os from "node:os";

let cachedHomeDir: string | undefined;

const homePatternCache = new Map<string, RegExp>();

/**
 * Memoized home-prefix matcher. The trailing boundary also accepts ANSI escapes
 * and HTML entities so home paths embedded in rendered transcripts (progress
 * output, error strings) are shortened without swallowing the next token.
 */
function homePatternFor(homePath: string, caseInsensitive: boolean): RegExp {
	const key = `${caseInsensitive ? 1 : 0} ${homePath}`;
	let pattern = homePatternCache.get(key);
	if (pattern === undefined) {
		const leadingBoundary = /^[\\/]/.test(homePath) ? "" : "(?<![\\p{L}\\p{N}_-])";
		const trailingBoundary =
			"(?=$|[\\\\/]|\\s|\\x1b|&(?:quot|apos|gt);|[\"'`)\\]}>]|[\"'`()\\[\\]{}<>=:;,|&.!?]+(?=$|\\s))";
		pattern = new RegExp(
			`${leadingBoundary}${RegExp.escape(homePath)}${trailingBoundary}`,
			caseInsensitive ? "giu" : "gu",
		);
		if (homePatternCache.size >= 16) homePatternCache.clear();
		homePatternCache.set(key, pattern);
	}
	return pattern;
}

/**
 * Replace home-directory paths embedded in display text without matching a
 * longer path component. Windows-style homes are matched case-insensitively.
 */
export function shortenEmbeddedPaths(text: string, homeDir?: string): string {
	const resolvedHome = homeDir ?? (cachedHomeDir ??= os.homedir());
	if (!resolvedHome) return text;
	let shortened = text;
	const isWindowsPath = resolvedHome.includes("\\") || /^(?:[A-Za-z]:\/|\/\/)/.test(resolvedHome);
	const homePaths = isWindowsPath
		? [...new Set([resolvedHome, resolvedHome.replaceAll("\\", "/"), resolvedHome.replaceAll("/", "\\")])]
		: [resolvedHome];
	const caseInsensitive = isWindowsPath;
	const uriPathContext = /[A-Za-z][A-Za-z\d+.-]*:\/\/[^\s"'`<>()[\]{}]*$/u;
	for (const homePath of homePaths) {
		const hasLeadingSeparator = /^[\\/]/.test(homePath);
		const homePrefix = homePatternFor(homePath, caseInsensitive);
		shortened = shortened.replace(homePrefix, (matchedHome, offset: number) => {
			const prefix = shortened.slice(0, offset);
			const schemeConsumesUncHome = /^[A-Za-z][A-Za-z\d+.-]*:$/u.test(prefix) && /^[\\/]{2}/.test(matchedHome);
			const uriPath = hasLeadingSeparator && (uriPathContext.test(prefix) || schemeConsumesUncHome);
			if (!uriPath && /[\p{L}\p{N}_-]$/u.test(prefix)) return matchedHome;
			if (!uriPath) return "~";
			if (schemeConsumesUncHome) return `${/^file:$/iu.test(prefix) ? "/" : ""}//~`;
			return `${matchedHome[0]}~`;
		});
	}
	return shortened
		.split(" ")
		.map(segment => {
			const leading = segment.match(/^[("'`[]*/)?.[0] ?? "";
			const trailing = segment.match(/[)"'`,.;:\]]*$/)?.[0] ?? "";
			const end = segment.length - trailing.length;
			if (leading.length >= end) return segment;
			const embeddedPath = segment.slice(leading.length, end);
			const normalized = embeddedPath.startsWith("~") ? embeddedPath.replaceAll("\\", "/") : embeddedPath;
			return `${leading}${normalized}${trailing}`;
		})
		.join(" ");
}
