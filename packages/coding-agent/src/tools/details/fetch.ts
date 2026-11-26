import { isReadableUrlPath, readSelectorRangeStart } from "./read";
import type { OutputMeta } from "../output-meta-format";

/** Display metadata for fetch tool results. */
export interface ReadUrlToolDetails {
	kind: "url";
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	raw?: boolean;
	truncated: boolean;
	notes: string[];
	meta?: OutputMeta;
}

// =============================================================================
// TUI Rendering
// =============================================================================

/** Restore the double slash in a collapsed HTTP URL scheme. */
export function repairCollapsedScheme(value: string): string {
	const m = value.match(/^(https?):\/(?!\/)/i);
	return m ? `${m[1]}://${value.slice(m[0].length)}` : value;
}

/** Recognize a valid raw, tail, or line-range URL selector token. */
function isUrlSelectorToken(token: string): boolean {
	if (token.toLowerCase() === "raw") return true;
	if (/^-\d+$/.test(token)) return Number.parseInt(token.slice(1), 10) > 0;
	return readSelectorRangeStart(token) !== undefined;
}

/**
 * Peel one or more selector tokens off the right of a URL string. Walks back through
 * trailing `:tok` segments while each token (a) looks like a selector and (b) leaves
 * behind a string that still parses as a URL. Returns selectors left-to-right so callers
 * can apply them in source order.
 */
export function tryExtractEmbeddedUrlSelector(readPath: string): { path: string; sels: string[] } | null {
	let basePath = readPath;
	const sels: string[] = [];
	while (true) {
		const lastColonIndex = basePath.lastIndexOf(":");
		if (lastColonIndex <= 0) break;

		const candidate = basePath.slice(lastColonIndex + 1);
		const remainder = basePath.slice(0, lastColonIndex);
		if (!isReadableUrlPath(remainder)) break;
		if (!isUrlSelectorToken(candidate)) break;

		try {
			new URL(
				remainder.startsWith("http://") || remainder.startsWith("https://") ? remainder : `https://${remainder}`,
			);
		} catch {
			break;
		}

		sels.unshift(candidate);
		basePath = remainder;
	}
	if (sels.length === 0) return null;
	return { path: basePath, sels };
}
