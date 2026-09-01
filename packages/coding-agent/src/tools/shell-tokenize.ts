/**
 * Conservative shell command tokenizer shared by the bash approval-pattern
 * matcher and the gh-cache invalidator.
 *
 * Splits a bash command into independent command segments, each a list of word
 * tokens. Handles single/double-quoted strings, backslash escapes, and the
 * standard operators (`;`, `&&`, `||`, `|`, `&`, `(`, `)`, newlines) as segment
 * boundaries so callers treat the pieces as independent command sequences.
 *
 * It is deliberately not a full POSIX parser — heredocs, command substitution,
 * and arithmetic expansion are out of scope; callers fall through when they
 * cannot find the structure they need.
 */
import * as path from "node:path";

export function tokenizeShellSegments(command: string): string[][] {
	const segments: string[][] = [];
	let current: string[] = [];
	let buffer = "";
	let inSingle = false;
	let inDouble = false;
	const pushBuffer = () => {
		if (buffer.length > 0) {
			current.push(buffer);
			buffer = "";
		}
	};
	const pushSegment = () => {
		pushBuffer();
		if (current.length > 0) segments.push(current);
		current = [];
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
				continue;
			}
			buffer += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < command.length) {
				const next = command[i + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					buffer += next;
					i++;
					continue;
				}
			}
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			buffer += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			buffer += command[i + 1];
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") {
			pushBuffer();
			continue;
		}
		if (ch === "\n" || ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
			pushSegment();
			// `&&`, `||` already collapsed by the segment break above.
			continue;
		}
		buffer += ch;
	}
	pushSegment();
	return segments;
}

/**
 * A flat shell command segment with the context needed to decide interception.
 *
 * @see extractFlatShellCommandSegments
 */
interface FlatShellCommandSegment {
	/** Original segment text with quoting and escaping preserved. */
	text: string;
	/**
	 * True when this segment consumes the previous stage's stdout via an
	 * unquoted `|` or `|&`. Blank and comment-only continuation lines preserve
	 * the pending pipe state. Such a stage reads piped stdin, so path-based
	 * dedicated tools (read/grep/glob) cannot replace it. `||`, `;`, `&`, and
	 * `&&` start an independent command and leave this false.
	 */
	pipedStdin: boolean;
}

/**
 * Returns the flat shell command segments with the original text of each. Unlike
 * `tokenizeShellSegments`, this preserves quoting and escaping so the results
 * are safe to match against user-configured regular expressions, and flags
 * segments that receive piped stdin.
 *
 * The extractor deliberately declines to split syntax whose execution context
 * cannot be determined with this small scanner (heredocs, command substitution,
 * backticks, grouping, and malformed quoting). Callers must still check the
 * complete input in that case.
 */
export function extractFlatShellCommandSegments(command: string): FlatShellCommandSegment[] {
	const segments: FlatShellCommandSegment[] = [];
	let segmentStart = 0;
	let inSingle = false;
	let inDouble = false;
	let atWordStart = true;
	let currentPiped = false;

	const pushSegment = (end: number): boolean => {
		const segment = command.slice(segmentStart, end).trim();
		if (segment.length === 0) return false;
		segments.push({ text: segment, pipedStdin: currentPiped });
		return true;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				if (i + 1 >= command.length) return [];
				i++;
				continue;
			}
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			if (ch === "`" || (ch === "$" && command[i + 1] === "(")) return [];
			continue;
		}

		if (ch === "'") {
			inSingle = true;
			atWordStart = false;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			atWordStart = false;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= command.length) return [];
			i++;
			atWordStart = false;
			continue;
		}
		if (
			ch === "`" ||
			ch === "(" ||
			ch === ")" ||
			(ch === "$" && command[i + 1] === "(") ||
			(ch === "$" && command[i + 1] === "{") ||
			(ch === "<" && command[i + 1] === "<") ||
			((ch === "{" || ch === "}") &&
				atWordStart &&
				(command[i + 1] === undefined || /[ \t\n;]/.test(command[i + 1])))
		) {
			return [];
		}
		if (ch === "#" && atWordStart) {
			const pushed = pushSegment(i);
			const newline = command.indexOf("\n", i + 1);
			if (newline === -1) return segments;
			i = newline;
			segmentStart = newline + 1;
			atWordStart = true;
			// Preserve a pending pipe through a comment-only continuation.
			if (pushed) currentPiped = false;
			continue;
		}
		const isRedirectionOperatorCharacter =
			ch === "|"
				? command[i - 1] === ">"
				: ch === "&"
					? command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">"
					: false;
		if ((ch === "\n" || ch === ";" || ch === "|" || ch === "&") && !isRedirectionOperatorCharacter) {
			const pushed = pushSegment(i);
			const doubled = (ch === "|" || ch === "&") && command[i + 1] === ch;
			const pipeStderr = ch === "|" && command[i + 1] === "&";
			if (doubled || pipeStderr) i++;
			// `|` and `|&` pipe into the next segment. Blank continuation
			// lines preserve that pending state; all other operators reset it.
			if (pushed || ch !== "\n") currentPiped = ch === "|" && !doubled;
			segmentStart = i + 1;
			atWordStart = true;
			continue;
		}
		atWordStart = ch === " " || ch === "\t";
	}

	if (inSingle || inDouble) return [];
	pushSegment(command.length);
	return segments;
}

/**
 * Shell metacharacters that end an unquoted `cd` target token. A redirect,
 * extra argument, or any operator in this set means the leading construct is
 * more than a bare `cd <path>`, so extraction must bail.
 */
const CD_TARGET_TERMINATORS: Record<string, true> = {
	" ": true,
	"\t": true,
	"\n": true,
	"\r": true,
	"&": true,
	"|": true,
	";": true,
	"<": true,
	">": true,
	"(": true,
	")": true,
};

/**
 * Parses a leading `cd <path> && ...` or `cd <path>; ...` prefix so the bash
 * tool can route the target through its structured `cwd` parameter when the
 * model omits it.
 *
 * Returns the single path token (quotes and backslash escapes resolved to their
 * literal value) and the command remainder after the top-level `&&` or `;`, or
 * `null` when the command does not begin with exactly `cd`, one path token, and
 * a top-level `&&` / `;`. The scanner deliberately bails on anything else in
 * the prefix — redirects (`cd /tmp 2>/dev/null && ...`), extra arguments, or
 * paths needing shell expansion (`$`, backticks, `(`) — leaving the whole
 * command for the shell instead of absorbing shell syntax into `cwd`.
 */
export function extractLeadingCdTarget(command: string): { path: string; rest: string } | null {
	const prefix = /^cd[ \t]+/.exec(command);
	if (!prefix) return null;
	let i = prefix[0].length;
	let path = "";
	let inSingle = false;
	let inDouble = false;
	for (; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
				continue;
			}
			path += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < command.length) {
				const next = command[i + 1];
				// A line continuation crosses the first physical line. Leave it to
				// the shell rather than turning the escaped newline into cwd text.
				if (next === "\n" || next === "\r") return null;
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					path += next;
					i++;
					continue;
				}
			}
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			path += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			// Preserve shell line-continuation semantics by declining extraction.
			if (command[i + 1] === "\n" || command[i + 1] === "\r") return null;
			path += command[i + 1];
			i++;
			continue;
		}
		if (CD_TARGET_TERMINATORS[ch]) break;
		path += ch;
	}
	// Unterminated quote or empty target: leave the command for the shell.
	if (inSingle || inDouble || path.length === 0) return null;
	// A path needing shell expansion can't be resolved literally through cwd.
	if (/[$`(]/.test(path)) return null;
	// Skip inter-token whitespace, then require a top-level `&&` or `;`
	// (a single `&`, `||`, `|`, or a redirect means this is not a bare `cd <path>`).
	while (command[i] === " " || command[i] === "\t") i++;
	if (command[i] === ";") {
		i += 1;
	} else if (command[i] === "&" && command[i + 1] === "&") {
		i += 2;
	} else {
		return null;
	}
	while (command[i] === " " || command[i] === "\t") i++;
	return { path, rest: command.slice(i) };
}

/** Strip leading `NAME=value` tokens and a single `sudo` for cwd/`cd` analysis. */
export function stripLeadingEnvAndSudo(command: string): string {
	let rest = command.trim();
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) {
		const space = rest.search(/[ \t]/);
		if (space < 0) return rest;
		rest = rest.slice(space).trimStart();
	}
	return rest.replace(/^sudo[ \t]+/, "");
}

/**
 * Walk a leading `cd … &&|; cd …` chain after env/sudo stripping.
 * Returns the last extractable path (relative targets resolved against the
 * preceding effective cwd), or `{ unresolvable: true }` when any leading `cd`
 * cannot be safely extracted (redirects, expansion, extra args).
 */
/**
 * True when a subshell / group / command substitution may change cwd without a
 * leading top-level `cd` (e.g. `(cd /tmp && bun test)`). Callers that need a
 * trusted verify cwd must treat these as unresolvable rather than falling back
 * to the session/structured cwd.
 */
export function hasHiddenCwdChangeInShellGroup(command: string): boolean {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < command.length) {
				i++;
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			i++;
			continue;
		}
		if (ch === "$" && command[i + 1] === "(") {
			const end = findMatchingClose(command, i + 2, ")");
			if (end >= 0 && commandWordCdIn(command.slice(i + 2, end))) return true;
			if (end >= 0) i = end;
			continue;
		}
		if (ch === "`") {
			const end = command.indexOf("`", i + 1);
			if (end > i && commandWordCdIn(command.slice(i + 1, end))) return true;
			if (end > i) i = end;
			continue;
		}
		if (ch === "(" || ch === "{") {
			const close = ch === "(" ? ")" : "}";
			const end = findMatchingClose(command, i + 1, close);
			if (end >= 0 && commandWordCdIn(command.slice(i + 1, end))) return true;
			if (end >= 0) i = end;
		}
	}
	return false;
}

function findMatchingClose(command: string, start: number, close: string): number {
	const open = close === ")" ? "(" : "{";
	let depth = 1;
	let inSingle = false;
	let inDouble = false;
	for (let i = start; i < command.length; i++) {
		const ch = command[i]!;
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < command.length) {
				i++;
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			i++;
			continue;
		}
		if (ch === open) depth++;
		else if (ch === close) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** True when `cd` appears as a shell command word (not inside a path/arg alone). */
function commandWordCdIn(body: string): boolean {
	return /(?:^|[\s;&|])cd(?:[\s;|&)]|$)/.test(body);
}

export function resolveLeadingCdChain(command: string): { path?: string; unresolvable?: boolean } {
	if (hasHiddenCwdChangeInShellGroup(command)) return { unresolvable: true };
	let rest = stripLeadingEnvAndSudo(command);
	let lastPath: string | undefined;
	let sawCd = false;
	while (/^cd([ \t]|$)/.test(rest)) {
		sawCd = true;
		const cd = extractLeadingCdTarget(rest);
		if (!cd) return { unresolvable: true };
		lastPath = joinCdChainPath(lastPath, cd.path);
		rest = cd.rest.trim();
	}
	if (sawCd && lastPath === undefined) return { unresolvable: true };
	// A later `cd` after non-cd setup (`echo x && cd /tmp && bun test`) is not
	# captured by the leading-only loop — treat as unresolvable so the latch
	# cannot trust the structured/session cwd.
	if (commandWordCdIn(rest)) return { unresolvable: true };
	if (lastPath !== undefined) return { path: lastPath };
	return {};
}

/**
 * Resolve a subsequent `cd` target against the previous chain cwd.
 * Absolute/`~` targets replace the chain; relative targets append.
 */
export function joinCdChainPath(base: string | undefined, next: string): string {
	const trimmed = next.trim();
	if (trimmed.startsWith("~") || path.isAbsolute(trimmed)) return trimmed;
	if (base === undefined || base.trim() === "") return trimmed;
	return path.join(base, trimmed);
}

/**
 * True when the command contains a top-level shell background operator (`&`
 * that is not part of `&&` and not part of redirection `>&` / `<&` / `&>`).
 * Sync bash success then races the backgrounded work.
 */
export function hasTopLevelShellBackground(command: string): boolean {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < command.length) {
				i++;
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			i++;
			continue;
		}
		if (ch === "&") {
			if (command[i + 1] === "&") {
				i++;
				continue;
			}
			// Redirection: `2>&1`, `>&2`, `<&0`, `&>file`, `&>>file`.
			const prev = i > 0 ? command[i - 1] : "";
			if (prev === ">" || prev === "<") continue;
			if (command[i + 1] === ">") {
				i++;
				continue;
			}
			return true;
		}
	}
	return false;
}

/**
 * True when the command contains a top-level status-masking operator (`||`,
 * `;`, or `|`) so a trailing `true` / pipe consumer can report exit 0 even when
 * the real check failed. `&&` is not masking — failure short-circuits.
 */
export function hasTopLevelStatusMaskingOperator(command: string): boolean {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < command.length) {
				i++;
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			i++;
			continue;
		}
		if (ch === ";") return true;
		if (ch === "|") {
			if (command[i + 1] === "|") return true;
			return true;
		}
	}
	return false;
}

/**
 * True when the command begins with `cd` but {@link extractLeadingCdTarget}
 * cannot safely resolve the path (redirects, extra args, expansion). The shell
 * still changes directory — callers that need a trusted cwd must treat this as
 * unverifiable rather than falling back to the session/structured cwd.
 */
export function hasUnresolvableLeadingCdPrefix(command: string): boolean {
	return resolveLeadingCdChain(command).unresolvable === true;
}
