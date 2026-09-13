import * as os from "node:os";

/**
 * Replace home-directory paths embedded in display text without matching a
 * longer path component. Windows-style homes are matched case-insensitively.
 */
export function shortenEmbeddedPaths(text: string, homeDir = os.homedir()): string {
	if (!homeDir) return text;
	let shortened = text;
	const isWindowsPath = homeDir.includes("\\") || /^(?:[A-Za-z]:\/|\/\/)/.test(homeDir);
	const homePaths = isWindowsPath
		? [...new Set([homeDir, homeDir.replaceAll("\\", "/"), homeDir.replaceAll("/", "\\")])]
		: [homeDir];
	const caseInsensitive = isWindowsPath;
	const trailingBoundary =
		"(?=$|[\\\\/]|\\s|\\x1b|&(?:quot|apos|gt);|[\"'`)\\]}>]|[\"'`()\\[\\]{}<>=:;,|&.!?]+(?=$|\\s))";
	const uriPathContext = /[A-Za-z][A-Za-z\d+.-]*:\/\/[^\s"'`<>()[\]{}]*$/u;
	for (const homePath of homePaths) {
		const hasLeadingSeparator = /^[\\/]/.test(homePath);
		const leadingBoundary = hasLeadingSeparator ? "" : "(?<![\\p{L}\\p{N}_-])";
		const homePrefix = new RegExp(
			`${leadingBoundary}${RegExp.escape(homePath)}${trailingBoundary}`,
			caseInsensitive ? "giu" : "gu",
		);
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
