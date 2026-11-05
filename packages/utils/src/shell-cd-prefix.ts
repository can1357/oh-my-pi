/**
 * The leading `cd <path> &&` prefix convention for shell commands.
 *
 * Both halves of a bash call read this one parser: the executor routes the
 * target through its structured `cwd` parameter, and the transcript renderer
 * shows that same directory as the call's working directory instead of leaving
 * the path inside the command body. Keeping them on one implementation is what
 * keeps the card honest about where the command actually ran.
 */

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
 * Parses a leading `cd <path> && ...` prefix so the bash tool can route the
 * target through its structured `cwd` parameter when the model omits it.
 *
 * Returns the single path token (quotes and backslash escapes resolved to their
 * literal value) and the command remainder after the top-level `&&`, or `null`
 * when the command does not begin with exactly `cd`, one path token, and a
 * top-level `&&`. The scanner deliberately bails on anything else in the prefix
 * — redirects (`cd /tmp 2>/dev/null && ...`), extra arguments, or paths needing
 * shell expansion (`$`, backticks, `(`) — leaving the whole command for the
 * shell instead of absorbing shell syntax into `cwd`.
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
	// Skip inter-token whitespace, then require a top-level `&&` (a single `&`,
	// `||`, `;`, `|`, or a redirect all mean this is not a bare `cd <path>`).
	while (command[i] === " " || command[i] === "\t") i++;
	if (command[i] !== "&" || command[i + 1] !== "&") return null;
	i += 2;
	while (command[i] === " " || command[i] === "\t") i++;
	return { path, rest: command.slice(i) };
}
