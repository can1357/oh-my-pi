/**
 * Sanity checks on a language server's location answers. A server answering
 * from an incomplete index (cold tsserver project, clangd without a compile
 * database, sourcekit without an index store) returns a subset or a wrong
 * location without saying so; these checks name what looks missing or off.
 */
import * as path from "node:path";
import { grep, type GrepMatch } from "@oh-my-pi/pi-natives";
import { formatPathRelativeToCwd } from "../tools/path-utils";
import { foreignCheckout, realPathOf } from "./client";
import type { Location, LspClient } from "./types";
import { uriToFile } from "./uri";
import { readLocationContext } from "./utils";

const TEXT_CHECK_MAX_MATCHES = 2_000;
const TEXT_CHECK_TIMEOUT_MS = 3_000;
const EXAMPLE_LIMIT = 5;

function wordPattern(name: string): RegExp {
	return new RegExp(`(?<![\\w$])${RegExp.escape(name)}(?![\\w$])`);
}

/**
 * Whole-word occurrences of `name` with `filePath`'s extension that no location
 * in `locations` sits on. Scan the file's checkout when it differs from the
 * client's, otherwise scan the client's cwd.
 */
export async function missingOccurrencesNote(
	name: string,
	client: LspClient,
	filePath: string,
	locations: readonly Location[],
	cwd: string,
	signal?: AbortSignal,
	{ where = "are not in the result" }: { where?: string } = {},
): Promise<string | undefined> {
	const ext = path.extname(filePath);
	if (!ext || !/^[\w$]+$/.test(name)) return undefined;
	const checkout = await foreignCheckout(client, filePath);
	const root = checkout ?? client.cwd;
	let matches: GrepMatch[];
	try {
		const result = await grep({
			pattern: `(^|[^\\w$])${RegExp.escape(name)}([^\\w$]|$)`,
			path: root,
			glob: `*${ext}`,
			maxCount: TEXT_CHECK_MAX_MATCHES,
			signal,
			timeoutMs: TEXT_CHECK_TIMEOUT_MS,
		});
		if (result.limitReached) return undefined;
		matches = result.matches;
	} catch {
		return undefined;
	}
	let missing = matches;
	if (locations.length > 0 && matches.length > 0) {
		// The server can name the same checkout via a symlink, even when grep
		// scanned its real path. Resolve the root and each distinct URI once.
		const realRoot = checkout ?? (await realPathOf(root));
		const resolvedUris = new Map<string, string>();
		const covered = new Set<string>();
		for (const location of locations) {
			let file = resolvedUris.get(location.uri);
			if (file === undefined) {
				file = await realPathOf(uriToFile(location.uri));
				resolvedUris.set(location.uri, file);
			}
			for (let line = location.range.start.line; line <= location.range.end.line; line++) {
				covered.add(`${file}:${line + 1}`);
			}
		}
		missing = matches.filter(match => !covered.has(`${path.resolve(realRoot, match.path)}:${match.lineNumber}`));
	}
	if (missing.length === 0) return undefined;
	const files = new Set(missing.map(match => match.path)).size;
	const examples = missing
		.slice(0, EXAMPLE_LIMIT)
		.map(match => `${formatPathRelativeToCwd(path.resolve(root, match.path), cwd)}:${match.lineNumber}`)
		.join(", ");
	return `⚠ ${missing.length} textual occurrence(s) of ${name} in ${files} file(s) ${where} (comments and strings included; the server's index may be incomplete): ${examples}`;
}

/**
 * Locations whose line does not contain `name`: a server resolving the cursor
 * without full build context (clangd's fallback flags) can answer with the
 * enclosing namespace or an unrelated spot.
 */
export async function locationsNotMentioning(locations: readonly Location[], name: string): Promise<Location[]> {
	const pattern = wordPattern(name);
	const misses: Location[] = [];
	for (const location of locations) {
		const [line] = await readLocationContext(uriToFile(location.uri), location.range.start.line + 1, 0);
		if (line !== undefined && !pattern.test(line)) misses.push(location);
	}
	return misses;
}
