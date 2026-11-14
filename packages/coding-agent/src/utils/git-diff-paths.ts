export interface GitDiffSectionPaths {
	oldPath?: string;
	newPath?: string;
}

const C_ESCAPES: Readonly<Record<string, string>> = {
	'"': '"',
	"\\": "\\",
	a: "\x07",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\x0b",
};

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

/** Decode a Git C-quoted path token (`"..."`, including octal UTF-8 escapes) or return an unquoted path verbatim. */
export function decodeGitDiffPath(token: string): string {
	if (!(token.startsWith('"') && token.endsWith('"'))) return token;
	const bytes: number[] = [];
	for (let index = 1; index < token.length - 1; index++) {
		const character = token[index]!;
		if (character !== "\\") {
			bytes.push(...UTF8_ENCODER.encode(character));
			continue;
		}
		const escaped = token[++index];
		if (escaped === undefined) break;
		const decoded = C_ESCAPES[escaped];
		if (decoded !== undefined) {
			bytes.push(...UTF8_ENCODER.encode(decoded));
			continue;
		}
		if (/[0-7]/.test(escaped)) {
			let octal = escaped;
			while (octal.length < 3 && /[0-7]/.test(token[index + 1] ?? "")) octal += token[++index];
			bytes.push(Number.parseInt(octal, 8));
			continue;
		}
		bytes.push(...UTF8_ENCODER.encode(escaped));
	}
	return UTF8_DECODER.decode(Uint8Array.from(bytes));
}

function stripDiffSidePrefix(path: string): string {
	return path.replace(/^[^/]+\//, "");
}

function sidePath(token: string): string | undefined {
	const decoded = decodeGitDiffPath(token);
	if (!decoded || decoded === "/dev/null") return undefined;
	const stripped = stripDiffSidePrefix(decoded);
	return stripped || undefined;
}

function readQuotedGitToken(input: string, offset: number): { token: string; next: number } | undefined {
	if (input[offset] !== '"') return undefined;
	let index = offset + 1;
	let escaped = false;
	while (index < input.length) {
		const character = input[index++];
		if (character === '"' && !escaped) {
			return { token: input.slice(offset, index), next: index };
		}
		escaped = character === "\\" && !escaped;
	}
	return undefined;
}

/**
 * Split an unquoted `diff --git` payload into its `a/` and `b/` tokens.
 * The native renderer writes names verbatim, including spaces, so splitting on
 * whitespace turns `my file.txt` into `my` and `file.txt`. Prefer the split
 * whose sides name the same path; a rename has one ` b/` separator.
 */
function splitUnquotedDiffPaths(rest: string): [string, string] | undefined {
	const candidates: Array<[string, string]> = [];
	if (rest.startsWith("a/")) {
		let from = 0;
		while (from < rest.length) {
			const index = rest.indexOf(" b/", from);
			if (index < 0) break;
			const right = rest.slice(index + 1);
			if (right.length > "b/".length) candidates.push([rest.slice(0, index), right]);
			from = index + 1;
		}
	}
	const equal = candidates.find(([left, right]) => left.slice("a/".length) === right.slice("b/".length));
	if (equal) return equal;
	if (candidates.length === 1) return candidates[0];
	if (rest.startsWith("/dev/null ")) return ["/dev/null", rest.slice("/dev/null ".length)];
	if (rest.endsWith(" /dev/null")) return [rest.slice(0, -" /dev/null".length), "/dev/null"];
	const space = rest.indexOf(" ");
	if (space <= 0 || space >= rest.length - 1) return undefined;
	return [rest.slice(0, space), rest.slice(space + 1)];
}

function splitDiffGitHeaderTokens(rest: string): [string, string] | undefined {
	if (rest.startsWith('"')) {
		const left = readQuotedGitToken(rest, 0);
		if (!left || rest[left.next] !== " ") return undefined;
		const rightRaw = rest.slice(left.next + 1);
		if (rightRaw.startsWith('"')) {
			const right = readQuotedGitToken(rightRaw, 0);
			return right && right.next === rightRaw.length ? [left.token, right.token] : undefined;
		}
		return rightRaw ? [left.token, rightRaw] : undefined;
	}
	if (rest.endsWith('"')) {
		let from = 0;
		while (from < rest.length) {
			const space = rest.indexOf(' "', from);
			if (space < 0) break;
			const right = readQuotedGitToken(rest, space + 1);
			if (right && right.next === rest.length && space > 0) {
				return [rest.slice(0, space), right.token];
			}
			from = space + 1;
		}
	}
	return splitUnquotedDiffPaths(rest);
}

function parseDiffGitHeader(line: string): GitDiffSectionPaths {
	if (!line.startsWith("diff --git ")) return {};
	const split = splitDiffGitHeaderTokens(line.slice("diff --git ".length));
	if (!split) return {};
	return { oldPath: sidePath(split[0]), newPath: sidePath(split[1]) };
}

/** Drop git's tab terminator and optional timestamp from an unquoted marker path. */
function stripDiffTimestamp(path: string): string {
	const tab = path.lastIndexOf("\t");
	if (tab < 0) return path;
	const after = path.slice(tab + 1);
	if (after === "" || /^\d{4}-\d{2}-\d{2} /.test(after)) return path.slice(0, tab);
	return path;
}

function parseMarkerPath(payload: string): string | undefined {
	if (payload.startsWith('"')) {
		const quoted = readQuotedGitToken(payload, 0);
		return quoted ? sidePath(quoted.token) : undefined;
	}
	return sidePath(stripDiffTimestamp(payload));
}

const NON_PATH_METADATA_PREFIX =
	/^(?:index |similarity index |dissimilarity index |old mode |new mode |new file mode |deleted file mode |--- \/dev\/null|\+\+\+ \/dev\/null|@@ |GIT binary patch|Binary files )/;

/**
 * Whether a diff section uses CRLF line terminators (`\r\n`) rather than LF
 * (`\n`) with literal `\r` bytes inside POSIX filenames. In an LF diff, non-path
 * metadata lines (`index`, `similarity index`, `old/new/deleted file mode`,
 * `@@`, etc.) never end in `\r`, and a `diff --git` header for an unchanged
 * CR-suffixed path carries `\r` on both the `a/` and `b/` sides.
 */
function hasCrlfDiffLineEndings(section: string): boolean {
	for (const line of section.split("\n")) {
		if (NON_PATH_METADATA_PREFIX.test(line)) return line.endsWith("\r");
	}
	const headerEnd = section.indexOf("\n");
	const header = headerEnd < 0 ? section : section.slice(0, headerEnd);
	if (!header.endsWith("\r")) return false;
	const withoutCr = parseDiffGitHeader(header.slice(0, -1));
	return withoutCr.oldPath !== undefined && withoutCr.oldPath === withoutCr.newPath;
}

/**
 * Parse the old and new paths touched by one `diff --git` section.
 * `rename from`/`rename to` and `---`/`+++` override the header, matching how
 * native patch application resolves headers with spaces or ambiguous ` b/`.
 * `normalizeCrlf` suits supplied review diffs; native patches use auto-detection
 * to preserve literal carriage returns in filenames.
 */
export function parseGitDiffSectionPaths(section: string, options?: { normalizeCrlf?: boolean }): GitDiffSectionPaths {
	const stripCr = options?.normalizeCrlf === true || hasCrlfDiffLineEndings(section);
	const rawLines = section.split("\n");
	const trimLine = (line: string): string => (stripCr && line.endsWith("\r") ? line.slice(0, -1) : line);
	const header = trimLine(rawLines[0] ?? "");
	if (!header.startsWith("diff --git ")) return {};
	let { oldPath, newPath } = parseDiffGitHeader(header);
	for (let index = 1; index < rawLines.length; index++) {
		const line = trimLine(rawLines[index]!);
		if (line.startsWith("@@") || line === "GIT binary patch" || line.startsWith("diff --git ")) break;
		if (line.startsWith("new file mode ")) oldPath = undefined;
		else if (line.startsWith("deleted file mode ")) newPath = undefined;
		else if (line.startsWith("rename from "))
			oldPath = decodeGitDiffPath(line.slice("rename from ".length)) || undefined;
		else if (line.startsWith("rename to ")) newPath = decodeGitDiffPath(line.slice("rename to ".length)) || undefined;
		else if (line.startsWith("--- ")) oldPath = parseMarkerPath(line.slice("--- ".length));
		else if (line.startsWith("+++ ")) newPath = parseMarkerPath(line.slice("+++ ".length));
	}
	return { oldPath, newPath };
}

/** Unique paths one `diff --git` section touches. */
export function patchSectionPaths(section: string): string[] {
	const { oldPath, newPath } = parseGitDiffSectionPaths(section);
	return [...new Set([oldPath, newPath].filter((path): path is string => !!path))];
}

export function splitPatchSections(patch: string): string[] {
	return patch.split(/^(?=diff --git )/m);
}
