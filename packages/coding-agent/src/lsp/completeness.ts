/**
 * Sanity checks on a language server's location answers. A server answering
 * from an incomplete index (cold tsserver project, clangd without a compile
 * database, sourcekit without an index store) returns a subset or a wrong
 * location without saying so; these checks name what looks missing or off.
 */
import * as path from "node:path";
import { grep } from "@oh-my-pi/pi-natives";
import { formatPathRelativeToCwd } from "../tools/path-utils";
import type { Location } from "./types";
import { uriToFile } from "./uri";
import { readLocationContext } from "./utils";

const TEXT_CHECK_MAX_MATCHES = 2_000;
const TEXT_CHECK_TIMEOUT_MS = 3_000;
const EXAMPLE_LIMIT = 5;

function wordPattern(name: string): RegExp {
	return new RegExp(`(?<![\\w$])${RegExp.escape(name)}(?![\\w$])`);
}

/**
 * Whole-word occurrences of `name` in `root`'s files with `filePath`'s extension
 * that no location in `locations` sits on, as a one-line warning; undefined when
 * there are none or the name is too common to check.
 */
export async function missingOccurrencesNote(
	name: string,
	root: string,
	filePath: string,
	locations: readonly Location[],
	cwd: string,
	signal?: AbortSignal,
	{ where = "are not in the result" }: { where?: string } = {},
): Promise<string | undefined> {
	const ext = path.extname(filePath);
	if (!ext || !/^[\w$]+$/.test(name)) return undefined;
	let matches: Array<{ file: string; line: number }>;
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
		matches = result.matches.map(match => ({ file: path.resolve(root, match.path), line: match.lineNumber }));
	} catch {
		return undefined;
	}
	const covered = new Set<string>();
	for (const location of locations) {
		const file = uriToFile(location.uri);
		for (let line = location.range.start.line; line <= location.range.end.line; line++) {
			covered.add(`${file}:${line + 1}`);
		}
	}
	const missing = matches.filter(match => !covered.has(`${match.file}:${match.line}`));
	if (missing.length === 0) return undefined;
	const files = new Set(missing.map(match => match.file)).size;
	const examples = missing
		.slice(0, EXAMPLE_LIMIT)
		.map(match => `${formatPathRelativeToCwd(match.file, cwd)}:${match.line}`)
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
