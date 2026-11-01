import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Tab-time path glob expansion for the composer: a token like `~/computing/…/pixivfe`
 * becomes the single path it names, so a shell-shaped path can be typed whole instead
 * of walked one directory at a time. Several matches are left alone — the completion
 * popup then lists them, which is what an ambiguous pattern wants.
 */

/** Characters that make a bare word a shell glob. */
const GLOB_MAGIC = /[*?[]/;
/** Characters that end the token a Tab press acts on. */
const TOKEN_DELIMITER = /[\s"'`]/;
/** Either separator, so a `/`-shaped pattern works on a `\`-shaped host. */
const SEPARATORS = /[/\\]/;

export interface PathGlobExpansion {
	/** Index in the line where the replaced token begins. */
	start: number;
	/** The token as typed, from `start` to the cursor. */
	token: string;
	/** The text that takes the token's place. */
	replacement: string;
}

/** Start index of the token ending at `cursorCol`: the run after the last whitespace or quote. */
export function pathGlobTokenStart(line: string, cursorCol: number): number {
	let i = cursorCol;
	while (i > 0 && !TOKEN_DELIMITER.test(line[i - 1] ?? "")) i--;
	return i;
}

/**
 * Expand the path glob ending at the cursor on `line`.
 *
 * Returns `null` when the token is not a glob, names nothing, or names more than one
 * path — the caller then keeps Tab's completion role. The replacement keeps the
 * token's own root shape (`~/…` stays `~/…`, an absolute path stays absolute), and a
 * directory match gains the trailing separator that names it as one.
 */
export function expandPathGlobAt(line: string, cursorCol: number, cwd: string): PathGlobExpansion | null {
	const start = pathGlobTokenStart(line, cursorCol);
	const token = line.slice(start, cursorCol);
	if (!GLOB_MAGIC.test(token)) return null;
	// A URL carries `?` and `[` too; it is not a path and no directory walk applies.
	if (token.includes("://")) return null;

	let root: string;
	let displayRoot: string;
	let pattern: string;
	if (token === "~" || token.startsWith("~/") || token.startsWith("~\\")) {
		root = os.homedir();
		displayRoot = `~${path.sep}`;
		pattern = token.slice(2);
	} else {
		const parsedRoot = path.parse(token).root;
		if (parsedRoot.length > 0) {
			root = parsedRoot;
			displayRoot = parsedRoot;
			pattern = token.slice(parsedRoot.length);
		} else if (token.startsWith("~")) {
			// Another user's home: its expansion is not ours to compute.
			return null;
		} else {
			root = cwd;
			displayRoot = "";
			pattern = token;
		}
	}

	// The literal directories in front of the first wildcard become the scan root, so
	// the pattern handed to Bun never repeats a prefix the walk already resolved.
	const firstMagic = pattern.search(GLOB_MAGIC);
	if (firstMagic < 0) return null;
	const literalPrefix = pattern.slice(0, firstMagic);
	const cut = Math.max(literalPrefix.lastIndexOf("/"), literalPrefix.lastIndexOf("\\"));
	const scanBase = cut < 0 ? "" : literalPrefix.slice(0, cut + 1);
	const scanPattern = pattern.slice(scanBase.length).replace(/\\/g, "/");
	if (scanPattern.length === 0) return null;

	const scanRoot = path.join(root, scanBase);
	const entries: string[] = [];
	try {
		// `scanSync` yields lazily; only "nothing", "exactly one", and "several" matter here.
		for (const entry of new Bun.Glob(scanPattern).scanSync({ cwd: scanRoot, onlyFiles: false, dot: false })) {
			entries.push(entry);
			if (entries.length > 1) break;
		}
	} catch {
		// A malformed pattern (an unterminated `[`) is the user still typing it.
		return null;
	}
	if (entries.length !== 1) return null;

	const match = entries[0]!;
	const replacement = displayRoot + scanBase + match;
	if (replacement === token) return null;
	if (!SEPARATORS.test(replacement.at(-1) ?? "") && isDirectory(path.join(root, scanBase, match))) {
		return { start, token, replacement: `${replacement}${path.sep}` };
	}
	return { start, token, replacement };
}

function isDirectory(target: string): boolean {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}
