// The nested script parser in this file (`SHELL_SCRIPT_MAX_DEPTH` through `parseShellScript`) is
// derived from `src/intern/guard.py` of nace-ai/intern (https://github.com/nace-ai/intern, v0.30.1,
// commit e1bbd096f9), Copyright Nace AI, licensed under the Apache License, Version 2.0
// (http://www.apache.org/licenses/LICENSE-2.0). Modified for omp: rewritten in TypeScript on this
// tokenizer's operators, with `cd` and `( )` subshell tracking, `&&`-chain tracking, quote-aware
// heredocs, and scripts fed to a shell's stdin. See packages/coding-agent/THIRD-PARTY-NOTICES.txt.

import * as path from "node:path";

/**
 * Conservative shell command tokenizer shared by the bash approval-pattern
 * matcher, the gh-cache invalidator, and the session anonymizer.
 *
 * Splits a bash command into independent command segments, each a list of word
 * tokens. Handles single/double-quoted strings, backslash escapes, and the
 * standard operators (`;`, `&&`, `||`, `|`, `&`, `(`, `)`, newlines) as segment
 * boundaries so callers treat the pieces as independent command sequences.
 *
 * It is deliberately not a full POSIX parser — heredocs, command substitution,
 * and arithmetic expansion are out of scope; callers fall through when they
 * cannot find the structure they need. Safety rules that must see through
 * that syntax use {@link parseShellScript} instead.
 */
export function tokenizeShellSegments(command: string): string[][] {
	const segments: string[][] = [];
	let current: string[] = [];
	for (const token of lexShellCommand(command)) {
		if (token.kind === "word") {
			// Empty quoted words (`''`) carry no argument text.
			if (token.value.length > 0) current.push(token.value);
		} else if (/[\n;&|()]/.test(token.raw) && current.length > 0) {
			segments.push(current);
			current = [];
		}
	}
	if (current.length > 0) segments.push(current);
	return segments;
}

/** One lexical piece of a shell command: a word, or the whitespace/operator run between words. */
export type ShellToken = { kind: "word"; raw: string; value: string } | { kind: "separator"; raw: string };

/**
 * Lex a command into words and separators with their source text, so callers can rewrite words
 * and reassemble the command. Word boundaries match {@link tokenizeShellSegments}: `value` is the
 * quote/escape-removed word, `raw` its verbatim spelling; separators are runs of spaces, tabs, and
 * the operator characters `\n ; & | ( )`.
 */
export function lexShellCommand(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let value = "";
	let wordStart = -1;
	let separatorStart = -1;
	let inSingle = false;
	let inDouble = false;
	const startWord = (index: number) => {
		if (wordStart >= 0) return;
		if (separatorStart >= 0) {
			tokens.push({ kind: "separator", raw: command.slice(separatorStart, index) });
			separatorStart = -1;
		}
		wordStart = index;
	};
	const endWord = (index: number) => {
		if (wordStart < 0) return;
		tokens.push({ kind: "word", raw: command.slice(wordStart, index), value });
		value = "";
		wordStart = -1;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else value += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < command.length) {
				const next = command[i + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					value += next;
					i++;
					continue;
				}
			}
			if (ch === '"') inDouble = false;
			else value += ch;
			continue;
		}
		if (
			ch === " " ||
			ch === "\t" ||
			ch === "\n" ||
			ch === ";" ||
			ch === "&" ||
			ch === "|" ||
			ch === "(" ||
			ch === ")"
		) {
			endWord(i);
			if (separatorStart < 0) separatorStart = i;
			continue;
		}
		startWord(i);
		if (ch === "'") {
			inSingle = true;
		} else if (ch === '"') {
			inDouble = true;
		} else if (ch === "\\" && i + 1 < command.length) {
			value += command[i + 1];
			i++;
		} else {
			value += ch;
		}
	}
	endWord(command.length);
	if (separatorStart >= 0) tokens.push({ kind: "separator", raw: command.slice(separatorStart) });
	return tokens;
}

/** A command in a conservative, flat `&&` chain. */
export interface LiteralShellCommandSegment {
	/** Original segment text with quoting and escaping preserved. */
	text: string;
	/** Literal argv after shell quote removal. */
	argv: string[];
}

/** One segment of a top-level `&&` chain, paired with its literal parse when eligible. */
export interface AndChainSegment {
	/** Original segment text with quoting and escaping preserved. */
	text: string;
	/** Parsed literal command when the segment is eligible for compound allow, else `null`. */
	literal: LiteralShellCommandSegment | null;
	/** True when executing this clause can mutate current-shell state for later clauses. */
	mutatesShellState: boolean;
}
const SHELL_STATEFUL_COMMANDS = new Set([
	"!",
	":",
	".",
	// Bash test -v evaluates array subscripts, including command substitutions.
	"test",
	"[",
	"[[",
	// Zsh also runs behind the Bash tool; its builtins can mutate shell state.
	"-",
	"autoload",
	"bindkey",
	"bye",
	"chdir",
	"disable",
	"emulate",
	"functions",
	"limit",
	"print",
	"rehash",
	// Zsh's short `repeat N cmd && …` runs the whole sublist as the loop body.
	"repeat",
	"sched",
	"setopt",
	"unfunction",
	"unhash",
	"unlimit",
	"unsetopt",
	"vared",
	"zle",
	"zmodload",
	"zparseopts",
	"zstyle",
	"alias",
	"bg",
	"break",
	"builtin",
	"case",
	"cd",
	"command",
	"coproc",
	"continue",
	"declare",
	"dirs",
	"disown",
	"do",
	"done",
	"elif",
	"else",
	"enable",
	"esac",
	"eval",
	"exec",
	"exit",
	"export",
	"fc",
	"fg",
	"fi",
	"for",
	"function",
	"getopts",
	"hash",
	"history",
	"if",
	"in",
	"jobs",
	"let",
	"logout",
	"mapfile",
	"local",
	"popd",
	// Bash's printf -v can write BASH_CMDS and retarget a later command.
	"printf",
	"pushd",
	"readonly",
	"read",
	"readarray",
	"return",
	"select",
	"set",
	"shift",
	"shopt",
	"source",
	"suspend",
	"then",
	"time",
	"times",
	"trap",
	"typeset",
	"ulimit",
	"umask",
	"unalias",
	"unset",
	"until",
	"wait",
	"while",
]);

const SHELL_INTERPRETER_COMMANDS: Record<string, true> = {
	ash: true,
	bash: true,
	busybox: true,
	csh: true,
	dash: true,
	env: true,
	nocorrect: true,
	noglob: true,
	fish: true,
	ksh: true,
	sh: true,
	sudo: true,
	tcsh: true,
	zsh: true,
};

const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/u;
const SHELL_ASSIGNMENT_NAME = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/u;
const SHELL_REINTERPRET_OPTION = /^(?:-[^-]*[ce]|--(?:command|eval)(?:=.*)?)$/u;

/** Whether `word` begins with a POSIX shell variable assignment prefix (`NAME=` or `NAME+=`). */
export function isShellEnvironmentAssignment(word: string): boolean {
	return SHELL_ASSIGNMENT.test(word);
}

/** Finds the end of a shell word, respecting quotes and escapes; returns null for incomplete syntax. */
function skipShellWord(command: string, start: number): number | null {
	let inSingle = false;
	let inDouble = false;
	for (let i = start; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				if (i + 1 >= command.length) return null;
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
		if (ch === "\\") {
			if (i + 1 >= command.length) return null;
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") return i;
	}
	return inSingle || inDouble ? null : command.length;
}

/**
 * Removes leading `NAME=value` (or `NAME+=value`) assignments without interpreting shell syntax.
 * When `allowName` is supplied, stops stripping at the first assignment whose variable name it rejects.
 */
export function withoutLeadingEnvironmentAssignments(
	command: string,
	allowName?: (name: string) => boolean,
): string | null {
	let index = 0;
	let foundAssignment = false;
	while (index < command.length) {
		while (command[index] === " " || command[index] === "\t") index++;
		const match = SHELL_ASSIGNMENT_NAME.exec(command.slice(index));
		if (!match) break;
		if (allowName && !allowName(match[1])) break;
		const wordEnd = skipShellWord(command, index + match[0].length);
		if (wordEnd === null) return null;
		foundAssignment = true;
		index = wordEnd;
	}
	if (!foundAssignment) return null;
	const commandWithoutAssignments = command.slice(index).trimStart();
	return commandWithoutAssignments.length > 0 ? commandWithoutAssignments : null;
}

/**
 * Parses the deliberately small command language eligible for compound-command
 * approval: two or more literal argv commands joined only by `&&`.
 *
 * Anything that needs shell interpretation beyond quote removal is rejected.
 * In particular, this excludes expansion, globbing, redirection, comments,
 * assignments, control flow, shell wrappers/interpreters, and commands that
 * mutate the current shell. Rejection is a normal result: callers must retain
 * their existing approval behavior.
 */
export function extractLiteralAndChainSegments(command: string): LiteralShellCommandSegment[] | null {
	for (let i = 0; i < command.length; i++) {
		const code = command.charCodeAt(i);
		if ((code < 0x20 && code !== 0x09) || code === 0x7f) return null;
	}
	const segments: LiteralShellCommandSegment[] = [];
	let argv: string[] = [];
	let token = "";
	let tokenStarted = false;
	let quote: "'" | '"' | undefined;
	let segmentStart = 0;

	const pushToken = () => {
		if (!tokenStarted) return;
		argv.push(token);
		token = "";
		tokenStarted = false;
	};
	const pushSegment = (end: number): boolean => {
		pushToken();
		if (argv.length === 0) return false;
		const executable = argv[0];
		if (executable.length === 0) return false;
		const commandName = executable.slice(Math.max(executable.lastIndexOf("/"), executable.lastIndexOf("\\")) + 1);
		if (
			argv.some(argument => SHELL_ASSIGNMENT.test(argument)) ||
			argv.some((argument, index) => index > 0 && SHELL_REINTERPRET_OPTION.test(argument)) ||
			SHELL_STATEFUL_COMMANDS.has(commandName) ||
			Object.hasOwn(SHELL_INTERPRETER_COMMANDS, commandName)
		) {
			return false;
		}
		segments.push({ text: command.slice(segmentStart, end).trim(), argv });
		argv = [];
		return true;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") {
				quote = undefined;
			} else {
				token += ch;
			}
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
				continue;
			}
			if (ch === "$" || ch === "`" || ch === "\n" || ch === "\r") return null;
			if (ch === "\\") {
				const next = command[i + 1];
				if (next === undefined || next === "\n" || next === "\r") return null;
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					token += next;
					i++;
				} else {
					token += ch;
				}
				continue;
			}
			token += ch;
			continue;
		}

		if (ch === "'" || ch === '"') {
			quote = ch;
			tokenStarted = true;
			continue;
		}
		if (ch === "\\") {
			const next = command[i + 1];
			if (next === undefined || next === "\n" || next === "\r") return null;
			token += next;
			tokenStarted = true;
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") {
			pushToken();
			continue;
		}
		if (ch === "&" && command[i + 1] === "&") {
			if (!pushSegment(i)) return null;
			i++;
			segmentStart = i + 1;
			continue;
		}
		if (
			ch === "\n" ||
			ch === "\r" ||
			ch === "&" ||
			ch === "|" ||
			ch === ";" ||
			ch === "<" ||
			ch === ">" ||
			ch === "`" ||
			ch === "$" ||
			ch === "(" ||
			ch === ")" ||
			ch === "*" ||
			ch === "?" ||
			ch === "[" ||
			ch === "]" ||
			ch === "{" ||
			ch === "}" ||
			ch === "~" ||
			(ch === "#" && !tokenStarted)
		) {
			return null;
		}
		if (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) return null;
		token += ch;
		tokenStarted = true;
	}

	if (quote || !pushSegment(command.length) || segments.length < 2) return null;
	return segments;
}

function parseLiteralShellCommandSegment(segmentText: string): LiteralShellCommandSegment | null {
	const pair = extractLiteralAndChainSegments(`${segmentText} && true`);
	return pair ? pair[0]! : null;
}

function segmentMutatesShellState(segmentText: string, literal: LiteralShellCommandSegment | null): boolean {
	if (literal !== null) return false;
	if (/[$`(){}[\]\n\r]/u.test(segmentText)) return true;
	const segments = tokenizeShellSegments(segmentText);
	if (segments.length === 0) return true;
	for (const words of segments) {
		let index = 0;
		while (index < words.length) {
			const word = words[index]!;
			if (SHELL_ASSIGNMENT.test(word)) {
				if (word.includes("[")) return true;
				index++;
			} else if (/^[0-9]*[<>]+$/u.test(word)) {
				index += 2;
			} else if (/^[0-9]*[<>]/u.test(word)) {
				index++;
			} else {
				break;
			}
		}
		const executable = words[index];
		if (!executable) return true;
		const commandName = executable.slice(Math.max(executable.lastIndexOf("/"), executable.lastIndexOf("\\")) + 1);
		if (
			SHELL_STATEFUL_COMMANDS.has(commandName) ||
			Object.hasOwn(SHELL_INTERPRETER_COMMANDS, commandName) ||
			words.slice(index + 1).some(arg => SHELL_REINTERPRET_OPTION.test(arg))
		) {
			return true;
		}
	}
	return false;
}

/**
 * Splits a single-line command on top-level unquoted `&&` (two or more clauses)
 * and annotates each clause with {@link LiteralShellCommandSegment} when that
 * clause alone qualifies for literal compound-command approval.
 *
 * Top-level `;`, `&`, and `||` have equal or lower precedence than `&&` and
 * alter short-circuit flow, so commands containing them outside quotes/parens
 * are rejected (`null`). Higher-precedence constructs inside a clause (pipes,
 * redirections, expansions, globs, stateful builtins) stay inside that clause
 * with `literal: null`.
 */
export function extractAndChainSegments(command: string): AndChainSegment[] | null {
	for (let i = 0; i < command.length; i++) {
		const code = command.charCodeAt(i);
		if ((code < 0x20 && code !== 0x09) || code === 0x7f) return null;
	}
	const rawSegments: string[] = [];
	let quote: "'" | '"' | undefined;
	let parenDepth = 0;
	let inBacktick = false;
	let inDoubleBracket = false;
	let braceDepth = 0;
	let atWordStart = true;
	let segmentStart = 0;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\") {
				if (i + 1 >= command.length) return null;
				i++;
				continue;
			}
			if (ch === '"') quote = undefined;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= command.length) return null;
			i++;
			atWordStart = false;
			continue;
		}
		if (ch === "`") {
			inBacktick = !inBacktick;
			atWordStart = false;
			continue;
		}
		if (inBacktick) continue;
		if (ch === "'" || ch === '"') {
			quote = ch;
			atWordStart = false;
			continue;
		}
		if (ch === "#" && atWordStart) {
			break;
		}
		if (
			!inDoubleBracket &&
			atWordStart &&
			ch === "[" &&
			command[i + 1] === "[" &&
			(command[i + 2] === " " || command[i + 2] === "\t")
		) {
			inDoubleBracket = true;
			i++;
			atWordStart = false;
			continue;
		}
		if (inDoubleBracket && atWordStart && ch === "]" && command[i + 1] === "]") {
			const after = command[i + 2];
			if (
				after === undefined ||
				after === " " ||
				after === "\t" ||
				after === ";" ||
				after === "&" ||
				after === "|" ||
				after === ")"
			) {
				inDoubleBracket = false;
				i++;
				atWordStart = false;
				continue;
			}
		}
		// `${…}` expansions and `{ …; }` groups (zsh also accepts `{ … }`) keep their `&&` inside.
		if (ch === "$" && command[i + 1] === "{") {
			braceDepth++;
			i++;
			atWordStart = false;
			continue;
		}
		if (ch === "{" && atWordStart && (command[i + 1] === " " || command[i + 1] === "\t")) {
			braceDepth++;
			continue;
		}
		if (ch === "}" && braceDepth > 0) {
			braceDepth--;
			atWordStart = false;
			continue;
		}
		if (ch === "(") {
			parenDepth++;
			atWordStart = true;
			continue;
		}
		if (ch === ")") {
			if (parenDepth === 0) return null;
			parenDepth--;
			atWordStart = false;
			continue;
		}
		if (parenDepth > 0 || inDoubleBracket || braceDepth > 0) {
			atWordStart = ch === " " || ch === "\t" || ch === "&" || ch === "|" || ch === "(" || ch === ")";
			continue;
		}
		if (ch === ";") return null;
		if (ch === "|" && command[i + 1] === "|") return null;
		if (ch === "&") {
			const prev = command[i - 1];
			const next = command[i + 1];
			if (prev === ">" || prev === "<" || next === ">") {
				atWordStart = false;
				continue;
			}
			if (next === "&" && command[i + 2] !== "&") {
				const segment = command.slice(segmentStart, i).trim();
				if (segment.length === 0) return null;
				rawSegments.push(segment);
				i++;
				segmentStart = i + 1;
				atWordStart = true;
				continue;
			}
			return null;
		}
		atWordStart = ch === " " || ch === "\t";
	}

	if (quote || inBacktick || parenDepth !== 0 || inDoubleBracket || braceDepth !== 0) return null;
	const tail = command.slice(segmentStart).trim();
	if (tail.length === 0) return null;
	rawSegments.push(tail);
	if (rawSegments.length < 2) return null;
	return rawSegments.map(text => {
		const literal = parseLiteralShellCommandSegment(text);
		return {
			text,
			literal,
			mutatesShellState: segmentMutatesShellState(text, literal),
		};
	});
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
 * literal value), the command remainder after the separator, and which
 * separator it was, or `null` when the command does not begin with exactly
 * `cd`, one path token, and a top-level `&&` or `;`. The scanner deliberately
 * bails on anything else in the prefix — redirects (`cd /tmp 2>/dev/null && ...`),
 * extra arguments, or paths needing shell expansion (`$`, backticks, `(`) —
 * leaving the whole command for the shell instead of absorbing shell syntax
 * into `cwd`.
 */
export function extractLeadingCdTarget(command: string): { path: string; rest: string; separator: "&&" | ";" } | null {
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
	// Skip inter-token whitespace, then require a top-level `&&` or `;` (a single
	// `&`, `||`, `|`, a `case` terminator `;;`/`;&`, or a redirect all mean this
	// is not a bare `cd <path>`).
	while (command[i] === " " || command[i] === "\t") i++;
	let separator: "&&" | ";";
	if (command[i] === "&" && command[i + 1] === "&") {
		separator = "&&";
	} else if (command[i] === ";" && command[i + 1] !== ";" && command[i + 1] !== "&") {
		separator = ";";
	} else {
		return null;
	}
	i += separator.length;
	while (command[i] === " " || command[i] === "\t") i++;
	return { path, rest: command.slice(i), separator };
}

/**
 * Reads one shell-style word from the start of `text`: quoted and unquoted
 * runs concatenate as a shell would (`a"b c"d` → `ab cd`), quoting/escaping
 * follows the same rules as {@link tokenizeShellSegments} (no escapes inside
 * single quotes; `\"`, `\\`, `\$`, `` \` `` inside double quotes; backslash
 * escapes the next character when unquoted), and the word ends at the first
 * unquoted whitespace character (space, tab, `\n`, or `\r`) or the end of
 * the string.
 *
 * Shared so callers reading one quoted flag value (`/loop --until "…"`) do not
 * each maintain their own `indexOf`-based quote scanner, which breaks on an
 * escaped instance of the closing delimiter.
 *
 * Returns `undefined` when `text` is empty or all leading whitespace, and
 * `"unterminated"` for an unclosed quote.
 */
export function readShellWord(text: string): { value: string; rest: string } | "unterminated" | undefined {
	let i = 0;
	while (i < text.length && /[ \t\n\r]/.test(text[i])) i++;
	if (i >= text.length) return undefined;

	let value = "";
	let inSingle = false;
	let inDouble = false;
	for (; i < text.length; i++) {
		const ch = text[i];
		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
				continue;
			}
			value += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < text.length) {
				const next = text[i + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					value += next;
					i++;
					continue;
				}
			}
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			value += ch;
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
		if (ch === "\\" && i + 1 < text.length) {
			value += text[i + 1];
			i++;
			continue;
		}
		if (/[ \t\n\r]/.test(ch)) break;
		value += ch;
	}
	if (inSingle || inDouble) return "unterminated";
	return { value, rest: text.slice(i).trim() };
}

/** Nested `bash -c`, `eval`, heredoc-script and substitution levels {@link parseShellScript} follows. */
export const SHELL_SCRIPT_MAX_DEPTH = 8;

/** One simple command found by {@link parseShellScript}, with its wrappers peeled off. */
export interface ShellCommand {
	/** Arguments after quote removal and wrapper unwrapping; `argv[0]` is the program's basename. */
	argv: string[];
	/** Per `argv` entry, whether the word was quoted or escaped in the source (`"reboot"`, `\rm`). */
	quoted: boolean[];
	/** The program word as written (`./run.sh`, `/usr/bin/rm`). */
	program: string;
	/** Wrappers that ran the command, outermost first (`sudo`, `env`, `timeout`, `xargs`, ...). */
	wrappers: string[];
	/** Targets of `<` input redirections. */
	reads: string[];
	/** Targets of output redirections (`>`, `>>`, `&>`, ...). */
	writes: string[];
	/**
	 * Commands inside the substitutions (`$( )`, backticks, `<( )`) in this command's words, its
	 * redirections, and its unquoted heredoc bodies, which the shell expands even when the body is data.
	 */
	subs: ShellCommand[];
	/** Directory the command runs in, after the `cd`s that precede it in the script. */
	cwd: string;
	/**
	 * Commands known to have succeeded by the time this one starts: the earlier members of its `&&`
	 * chain (none once an `||` makes them optional) and of the chains around the `( )` group or
	 * nested script it is in, in order.
	 */
	succeeded: readonly ShellCommand[];
}

/** A shell script broken into pipelines, nested scripts included. */
export interface ParsedShellScript {
	/** Every pipeline, in order: the top level first, then nested scripts and substitutions. */
	pipelines: ShellCommand[][];
	/** Source text of every nested script (`bash -c` and `eval` strings, shell heredocs, substitution bodies). */
	scripts: string[];
	/** True when a script nested deeper than {@link SHELL_SCRIPT_MAX_DEPTH} levels was not parsed. */
	truncated: boolean;
}

/** Where a parsed script runs: its starting directory and the home `~` and `$HOME` expand to. */
export interface ShellScriptScope {
	cwd: string;
	home: string;
}

/**
 * The absolute path a shell word names, resolved lexically against `cwd`. `~`, `$HOME`, and `$PWD`
 * expand; any other expansion makes the path unknown (`undefined`).
 */
export function resolveShellWordPath(word: string, cwd: string, home: string): string | undefined {
	let expanded = word.replace(/\$(?:\{HOME\}|HOME\b)/g, () => home);
	expanded = expanded.replace(/\$(?:\{PWD\}|PWD\b)/g, () => cwd);
	if (expanded === "~" || expanded.startsWith("~/")) expanded = home + expanded.slice(1);
	if (!expanded || expanded.includes("$") || expanded.includes("\0") || expanded.startsWith("~")) return undefined;
	return path.resolve(cwd, expanded);
}

// Longest first, so `&&` is never read as two `&`.
const SHELL_OPERATORS = [
	"&&",
	"||",
	"|&",
	";;",
	"&>>",
	"&>",
	">>",
	">|",
	">&",
	"<<<",
	"<<-",
	"<<",
	"<&",
	"<>",
	"|",
	";",
	"&",
	"\n",
	"(",
	")",
	">",
	"<",
];
const SHELL_PIPES: Record<string, true> = { "|": true, "|&": true };
const SHELL_REDIRECTS: Record<string, true> = {
	"&>>": true,
	"&>": true,
	">>": true,
	">|": true,
	">&": true,
	"<<<": true,
	"<<-": true,
	"<<": true,
	"<&": true,
	"<>": true,
	">": true,
	"<": true,
};
const SHELL_WRITE_REDIRECTS: Record<string, true> = {
	"&>>": true,
	"&>": true,
	">>": true,
	">|": true,
	"<>": true,
	">": true,
};
const SHELL_KEYWORDS: readonly string[] = [
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"do",
	"done",
	"while",
	"until",
	"!",
	"{",
	"}",
	"esac",
];
/** Commands that run the rest of their arguments as a command, with the options that take a value. */
const SHELL_WRAPPERS: Record<string, readonly string[]> = {
	sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"],
	doas: ["-u", "-C"],
	env: ["-u", "-C", "-S", "--unset", "--chdir"],
	nohup: [],
	exec: ["-a"],
	command: [],
	builtin: [],
	nice: ["-n"],
	ionice: ["-c", "-n", "-p"],
	time: [],
	timeout: ["-s", "-k", "--signal", "--kill-after"],
	stdbuf: ["-i", "-o", "-e"],
	xargs: ["-n", "-I", "-P", "-L", "-d", "-E", "-s", "-a", "--max-args", "--max-procs", "--delimiter"],
	caffeinate: ["-t", "-w"],
	unbuffer: [],
};
const SCRIPT_SHELLS: Record<string, true> = {
	sh: true,
	bash: true,
	zsh: true,
	dash: true,
	ksh: true,
	ash: true,
	fish: true,
};

/** Commands whose arguments become their output; piped into a shell, that output is a script. */
const SHELL_ECHOES: Record<string, true> = { echo: true, printf: true };

/** A heredoc: its body, and what the shell runs while expanding it. */
interface ShellHeredoc {
	body: string;
	/** Whether the delimiter was unquoted, so the shell expands the body. */
	expands: boolean;
	/** Keys of the substitutions in an expanding body: they run even when the body is data. */
	subs: string[];
}

interface ShellScriptToken {
	text: string;
	operator: boolean;
	/** Whether any part of the word was quoted or escaped. */
	quoted: boolean;
	/** Set on the delimiter word after `<<`/`<<-`. */
	heredoc?: ShellHeredoc;
}

interface ShellScriptSegment {
	words: string[];
	/** Per word, whether it was quoted or escaped. */
	quoted: boolean[];
	writes: string[];
	reads: string[];
	/** `<<<` words. */
	herestrings: string[];
	heredocs: ShellHeredoc[];
	operator: string;
}

/** A heredoc whose body starts after the current line. */
interface PendingHeredoc {
	delimiter: string;
	stripTabs: boolean;
	doc: ShellHeredoc;
}

/** Index of the `close` ending the group `open` started just before `start`. */
function closingDelimiter(text: string, start: number, open: string, close: string): number {
	let depth = 1;
	let i = start;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			const end = text.indexOf(ch, i + 1);
			i = end < 0 ? text.length : end + 1;
			continue;
		}
		if (ch === open) depth++;
		else if (ch === close && --depth === 0) return i;
		i++;
	}
	return text.length;
}

/** Where the command a wrapper chain runs starts in `words` (`sudo env X=1 timeout 5 rm ...` runs `rm ...`). */
function unwrapShellCommand(words: readonly string[], wrappers: string[]): number {
	let i = 0;
	while (i < words.length) {
		const word = words[i];
		if (SHELL_ASSIGNMENT.test(word) || SHELL_KEYWORDS.includes(word)) {
			i++;
			continue;
		}
		const name = path.posix.basename(word);
		const valued = Object.hasOwn(SHELL_WRAPPERS, name) ? SHELL_WRAPPERS[name] : undefined;
		if (!valued || (name === "command" && (words[i + 1] === "-v" || words[i + 1] === "-V"))) break;
		wrappers.push(name);
		i++;
		let positional = name === "timeout" ? 1 : 0; // timeout's duration
		while (i < words.length) {
			const arg = words[i];
			if (arg === "--") {
				i++;
				break;
			}
			if (name === "env" && SHELL_ASSIGNMENT.test(arg)) {
				i++;
			} else if (arg.startsWith("-") && arg.length > 1) {
				i += valued.includes(arg) ? 2 : 1;
			} else if (positional > 0) {
				positional--;
				i++;
			} else {
				break;
			}
		}
	}
	return i;
}

/** Shell options that take the next word as their value (`-o pipefail`, `--rcfile file`). */
const SHELL_VALUE_OPTIONS: Record<string, true> = {
	"-o": true,
	"+o": true,
	"-O": true,
	"+O": true,
	"--rcfile": true,
	"--init-file": true,
};

/**
 * How a shell (`argv[0]` in {@link SCRIPT_SHELLS}) gets its script: the `-c` string, `"stdin"` when
 * it reads the script from its input (no script file, or `-s`), or `undefined` for a script file.
 * Long options (`--norc`, `--login`) come before the short ones.
 */
function shellScriptSource(argv: readonly string[]): string | undefined {
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		// `-` and `--` end the options; a word after them is a script file.
		if (arg === "-" || arg === "--") return i + 1 < argv.length ? undefined : "stdin";
		if (Object.hasOwn(SHELL_VALUE_OPTIONS, arg)) {
			i++;
			continue;
		}
		if (arg.startsWith("--")) continue;
		if (!(arg.startsWith("-") || arg.startsWith("+"))) return undefined;
		if (arg.slice(1).includes("c")) return argv[i + 1] ?? "";
		if (arg.slice(1).includes("s")) return "stdin";
	}
	return "stdin";
}

/** The script a `bash -c '...'` or `eval ...` runs. */
function inlineShellScript(argv: readonly string[]): string | undefined {
	if (argv[0] === "eval") return argv.slice(1).join(" ");
	if (!Object.hasOwn(SCRIPT_SHELLS, argv[0])) return undefined;
	const source = shellScriptSource(argv);
	return source === "stdin" ? undefined : source;
}

/** A command's operands: the arguments after `argv[0]` that are not options (everything after `--` counts). */
export function shellPositionalArgs(argv: readonly string[]): string[] {
	const out: string[] = [];
	let options = true;
	for (const arg of argv.slice(1)) {
		if (options && arg === "--") options = false;
		else if (!(options && arg.startsWith("-") && arg !== "-")) out.push(arg);
	}
	return out;
}

/**
 * Which commands are known to have succeeded before the next one starts, as a script runs: the
 * members of the current `&&` chain, until an `||` makes earlier members optional, on top of what
 * had succeeded when the enclosing `( )` group or nested script started.
 */
class SucceededCommands {
	/** Succeeded before the current and-or list started. */
	#base: readonly ShellCommand[];
	/** `#base` plus the current list's `&&` members so far. */
	#chain: readonly ShellCommand[];
	/** An `||` in the current list: what follows may run without its earlier members. */
	#optional = false;
	/** The last pipeline, until the operator after it says whether it counts. */
	#last: readonly ShellCommand[] = [];
	readonly #groups: { base: readonly ShellCommand[]; chain: readonly ShellCommand[]; optional: boolean }[] = [];

	constructor(initial: readonly ShellCommand[]) {
		this.#base = initial;
		this.#chain = initial;
	}

	get current(): readonly ShellCommand[] {
		return this.#optional ? this.#base : this.#chain;
	}

	/** A pipeline ended; a negated (`!`) pipeline succeeds when its commands fail, so it counts as none. */
	finish(pipeline: readonly ShellCommand[]): void {
		this.#last = pipeline;
	}

	operator(operator: string): void {
		if (operator === "&&") {
			if (!this.#optional) this.#chain = [...this.#chain, ...this.#last];
			this.#last = [];
		} else if (operator === "||") {
			this.#optional = true;
			this.#last = [];
		} else if (operator === "(") {
			this.#groups.push({ base: this.#base, chain: this.#chain, optional: this.#optional });
			this.#base = this.current;
			this.#chain = this.#base;
			this.#optional = false;
			this.#last = [];
		} else if (operator === ")") {
			const group = this.#groups.pop();
			if (!group) return;
			// The group's last pipeline stays in `#last`, judged by the operator after `)`.
			if (this.#optional) this.#chain = group.chain;
			this.#optional ||= group.optional;
			this.#base = group.base;
		} else {
			// `;`, a newline, `&`, `;;`: a new and-or list, which runs whatever the last one did.
			this.#chain = this.#base;
			this.#optional = false;
			this.#last = [];
		}
	}
}

class ShellScriptParser {
	#count = 0;
	readonly scripts: string[] = [];
	/** Set when a script nested deeper than {@link SHELL_SCRIPT_MAX_DEPTH} was left unparsed. */
	truncated = false;
	constructor(readonly home: string) {}

	/**
	 * The pipelines `source` runs, nested ones after the top level. `succeeded` is what had
	 * succeeded when it started. In `arithmetic` text (`$(( ))`), `<<` is a shift, never a heredoc.
	 */
	parse(
		source: string,
		startCwd: string,
		depth: number,
		succeeded: readonly ShellCommand[],
		arithmetic = false,
	): ShellCommand[][] {
		if (depth > SHELL_SCRIPT_MAX_DEPTH) {
			this.truncated = true;
			return [];
		}
		if (depth > 0) this.scripts.push(source);
		let cwd = startCwd;
		// A `( )` subshell's `cd` ends with the group: the directory is restored at its `)`.
		const subshellCwds: string[] = [];
		const subs = new Map<string, ShellCommand[][]>();
		const segments = this.#segments(this.#tokens(source, cwd, depth, subs, succeeded, !arithmetic));
		const pipelines: ShellCommand[][] = [];
		const nested: ShellCommand[][] = [];
		const done = new SucceededCommands(succeeded);
		let pipeline: ShellCommand[] = [];
		let feeding: ShellScriptSegment[] = [];
		let negated = false;
		for (const segment of segments) {
			if (pipeline.length === 0 && segment.words[0] === "!" && !segment.quoted[0]) negated = true;
			const command = this.#command(segment, cwd, subs, depth, nested, done.current);
			if (command) {
				pipeline.push(command);
				feeding.push(segment);
			}
			if (Object.hasOwn(SHELL_PIPES, segment.operator)) continue;
			if (pipeline.length > 0) {
				pipelines.push(pipeline);
				this.#feedShells(pipeline, feeding, depth, nested);
				const only = pipeline.length === 1 ? pipeline[0] : undefined;
				if (only && (only.argv[0] === "cd" || only.argv[0] === "pushd")) {
					const target = shellPositionalArgs(only.argv)[0];
					cwd = target === undefined ? this.home : (resolveShellWordPath(target, cwd, this.home) ?? cwd);
				}
				done.finish(negated ? [] : pipeline);
				pipeline = [];
				feeding = [];
				negated = false;
			}
			done.operator(segment.operator);
			if (segment.operator === "(") subshellCwds.push(cwd);
			else if (segment.operator === ")") cwd = subshellCwds.pop() ?? cwd;
		}
		return [...pipelines, ...nested, ...[...subs.values()].flat()];
	}

	/**
	 * Parses the scripts a shell in `pipeline` reads on its stdin: heredocs and here-strings fed to it
	 * or to an earlier stage (`cat <<EOF | sh`), and what `echo`/`printf` pipe into it.
	 */
	#feedShells(
		pipeline: readonly ShellCommand[],
		feeding: readonly ShellScriptSegment[],
		depth: number,
		nested: ShellCommand[][],
	): void {
		const shell = pipeline.findIndex(
			command => Object.hasOwn(SCRIPT_SHELLS, command.argv[0]) && shellScriptSource(command.argv) === "stdin",
		);
		if (shell < 0) return;
		const { cwd, succeeded } = pipeline[shell];
		for (let stage = 0; stage <= shell; stage++) {
			const texts = [...feeding[stage].heredocs.map(doc => doc.body), ...feeding[stage].herestrings];
			const argv = pipeline[stage].argv;
			if (stage < shell && Object.hasOwn(SHELL_ECHOES, argv[0]))
				texts.push(argv.slice(1).join(" "), ...argv.slice(1));
			for (const text of texts) nested.push(...this.parse(text, cwd, depth + 1, succeeded));
		}
	}

	/**
	 * Words and operators; a quoted word is never an operator. A heredoc body is read when its line
	 * ends and attached to the delimiter word; with `heredocs` off (arithmetic), `<<` is a shift.
	 */
	#tokens(
		text: string,
		cwd: string,
		depth: number,
		subs: Map<string, ShellCommand[][]>,
		succeeded: readonly ShellCommand[],
		heredocs: boolean,
	): ShellScriptToken[] {
		const out: ShellScriptToken[] = [];
		let word = "";
		let started = false;
		let quoted = false;
		// Set after `<<`/`<<-`: the next word is a heredoc delimiter.
		let delimiter: { stripTabs: boolean } | undefined;
		const pending: PendingHeredoc[] = [];
		// End of the `(( ))` arithmetic command being read: `<<` inside it is a shift.
		let arithmeticEnd = -1;
		const flush = () => {
			if (started) {
				const token: ShellScriptToken = { text: word, operator: false, quoted };
				if (delimiter) {
					token.heredoc = { body: "", expands: !quoted, subs: [] };
					pending.push({ delimiter: word, stripTabs: delimiter.stripTabs, doc: token.heredoc });
					delimiter = undefined;
				}
				out.push(token);
			}
			word = "";
			started = false;
			quoted = false;
		};
		let i = 0;
		while (i < text.length) {
			const ch = text[i];
			if (ch === " " || ch === "\t" || ch === "\r") {
				flush();
				i++;
			} else if (ch === "\\") {
				if (text[i + 1] === "\n") {
					i += 2;
					continue;
				}
				word += text.slice(i + 1, i + 2);
				started = true;
				quoted = true;
				i += 2;
			} else if (ch === "'") {
				let end = text.indexOf("'", i + 1);
				if (end < 0) end = text.length;
				word += text.slice(i + 1, end);
				started = true;
				quoted = true;
				i = end + 1;
			} else if (ch === '"') {
				i = this.#double(text, i + 1, cwd, depth, subs, succeeded, part => {
					word += part;
				});
				started = true;
				quoted = true;
			} else if (ch === "$" && (text[i + 1] === "{" || text[i + 1] === "[")) {
				// `${ }` and `$[ ]` belong to the word: a `<<` inside them is not a heredoc.
				const end = closingDelimiter(text, i + 2, text[i + 1], text[i + 1] === "{" ? "}" : "]");
				const keys = this.#expansions(text.slice(i + 2, end), cwd, depth, subs, succeeded);
				word += text.slice(i, end + 1) + keys.join("");
				started = true;
				i = end + 1;
			} else if (ch === "`" || ((ch === "$" || ch === "<" || ch === ">") && text[i + 1] === "(")) {
				const sub = this.#substitution(text, i, cwd, depth, subs, succeeded);
				word += sub.key;
				i = sub.after;
				started = true;
			} else if (ch === "#" && !started) {
				const end = text.indexOf("\n", i);
				i = end < 0 ? text.length : end;
			} else {
				const operator = SHELL_OPERATORS.find(op => text.startsWith(op, i));
				if (operator === undefined) {
					word += ch;
					started = true;
					i++;
					continue;
				}
				// The file descriptor of `2>`.
				if ((operator[0] === "<" || operator[0] === ">") && started && /^\d+$/.test(word)) {
					word = "";
					started = false;
				}
				flush();
				delimiter = undefined;
				out.push({ text: operator, operator: true, quoted: false });
				i += operator.length;
				if (operator === "(" && text[i] === "(" && i > arithmeticEnd) {
					arithmeticEnd = closingDelimiter(text, i, "(", ")");
				}
				if ((operator === "<<" || operator === "<<-") && heredocs && i > arithmeticEnd) {
					delimiter = { stripTabs: operator === "<<-" };
				}
				if (operator === "\n" && pending.length > 0) {
					i = this.#heredocBodies(text, i, pending, cwd, depth, subs, succeeded);
				}
			}
		}
		flush();
		return out;
	}

	/**
	 * Reads the bodies of the heredocs opened on the line that just ended, from `start`, and returns
	 * where the script goes on. When a delimiter line never comes, every line stays in place and is
	 * parsed as commands: a `<<` misread as a heredoc must not hide what follows it.
	 */
	#heredocBodies(
		text: string,
		start: number,
		pending: PendingHeredoc[],
		cwd: string,
		depth: number,
		subs: Map<string, ShellCommand[][]>,
		succeeded: readonly ShellCommand[],
	): number {
		const bodies: string[] = [];
		let pos = start;
		for (const { delimiter, stripTabs } of pending) {
			const lines: string[] = [];
			let closed = false;
			while (pos < text.length && !closed) {
				const newline = text.indexOf("\n", pos);
				const end = newline < 0 ? text.length : newline;
				const line = stripTabs ? text.slice(pos, end).replace(/^\t+/, "") : text.slice(pos, end);
				pos = newline < 0 ? text.length : newline + 1;
				if (line === delimiter) closed = true;
				else lines.push(line);
			}
			if (!closed) {
				pending.length = 0;
				return start;
			}
			bodies.push(lines.join("\n"));
		}
		for (const [index, { doc }] of pending.entries()) {
			doc.body = bodies[index];
			if (doc.expands) doc.subs = this.#expansions(doc.body, cwd, depth, subs, succeeded);
		}
		pending.length = 0;
		return pos;
	}

	#double(
		text: string,
		start: number,
		cwd: string,
		depth: number,
		subs: Map<string, ShellCommand[][]>,
		succeeded: readonly ShellCommand[],
		append: (part: string) => void,
	): number {
		let i = start;
		while (i < text.length && text[i] !== '"') {
			const ch = text[i];
			if (ch === "\\" && i + 1 < text.length) {
				const next = text[i + 1];
				if (next === "$" || next === "`" || next === '"' || next === "\\") append(next);
				else if (next !== "\n") append(ch + next);
				i += 2;
			} else if (ch === "`" || (ch === "$" && text[i + 1] === "(")) {
				const sub = this.#substitution(text, i, cwd, depth, subs, succeeded);
				append(sub.key);
				i = sub.after;
			} else {
				append(ch);
				i++;
			}
		}
		return i + 1;
	}

	/**
	 * Keys of the `$( )` and backtick substitutions in text the shell expands without running it as a
	 * script: an unquoted heredoc body, the inside of `${ }` or `$[ ]`. Quotes are not special there.
	 */
	#expansions(
		text: string,
		cwd: string,
		depth: number,
		subs: Map<string, ShellCommand[][]>,
		succeeded: readonly ShellCommand[],
	): string[] {
		const keys: string[] = [];
		let i = 0;
		while (i < text.length) {
			const ch = text[i];
			if (ch === "\\") {
				i += 2;
			} else if (ch === "`" || (ch === "$" && text[i + 1] === "(")) {
				const sub = this.#substitution(text, i, cwd, depth, subs, succeeded);
				keys.push(sub.key);
				i = sub.after;
			} else {
				i++;
			}
		}
		return keys;
	}

	#substitution(
		text: string,
		start: number,
		cwd: string,
		depth: number,
		subs: Map<string, ShellCommand[][]>,
		succeeded: readonly ShellCommand[],
	): { key: string; after: number } {
		let inner: string;
		let after: number;
		if (text[start] === "`") {
			let end = start + 1;
			while (end < text.length && text[end] !== "`") end += text[end] === "\\" ? 2 : 1;
			inner = text.slice(start + 1, end);
			after = end + 1;
		} else {
			const end = closingDelimiter(text, start + 2, "(", ")");
			inner = text.slice(start + 2, end);
			after = end + 1;
		}
		const key = `\0${this.#count++}\0`;
		// `$(( ))` is arithmetic, or a command substitution that starts with a subshell: it is parsed
		// as commands either way, but a `<<` in it is never a heredoc.
		subs.set(key, this.parse(inner, cwd, depth + 1, succeeded, text.startsWith("$((", start)));
		return { key, after };
	}

	/** Each command's words, redirections, heredocs, and the operator after it. */
	#segments(tokens: readonly ShellScriptToken[]): ShellScriptSegment[] {
		const segments: ShellScriptSegment[] = [];
		const empty = (): ShellScriptSegment => ({
			words: [],
			quoted: [],
			writes: [],
			reads: [],
			herestrings: [],
			heredocs: [],
			operator: ";",
		});
		let current = empty();
		let redirect: string | undefined;
		for (const token of tokens) {
			if (redirect !== undefined && !token.operator) {
				if (
					Object.hasOwn(SHELL_WRITE_REDIRECTS, redirect) ||
					(redirect === ">&" && !(/^\d+$/.test(token.text) || token.text === "-"))
				) {
					current.writes.push(token.text);
				} else if (redirect === "<") {
					current.reads.push(token.text);
				} else if (redirect === "<<<") {
					current.herestrings.push(token.text);
				} else if (token.heredoc) {
					current.heredocs.push(token.heredoc);
				}
				redirect = undefined;
			} else if (!token.operator) {
				current.words.push(token.text);
				current.quoted.push(token.quoted);
			} else if (Object.hasOwn(SHELL_REDIRECTS, token.text)) {
				redirect = token.text;
			} else {
				current.operator = token.text;
				segments.push(current);
				current = empty();
				redirect = undefined;
			}
		}
		segments.push(current);
		return segments;
	}

	#command(
		segment: ShellScriptSegment,
		cwd: string,
		subs: Map<string, ShellCommand[][]>,
		depth: number,
		nested: ShellCommand[][],
		succeeded: readonly ShellCommand[],
	): ShellCommand | undefined {
		const { words, writes, reads } = segment;
		const wrappers: string[] = [];
		const start = unwrapShellCommand(words, wrappers);
		const argv = words.slice(start);
		const quoted = segment.quoted.slice(start);
		// `env` alone prints the environment.
		if (argv.length === 0 && wrappers.length > 0) {
			argv.push(wrappers.pop()!);
			quoted.push(false);
		}
		if (argv.length === 0 && writes.length === 0) return undefined;
		const program = argv[0] ?? "";
		if (argv.length > 0 && argv[0].includes("/")) argv[0] = path.posix.basename(argv[0]);
		const everything = [
			...words,
			...writes,
			...reads,
			...segment.herestrings,
			...segment.heredocs.flatMap(doc => doc.subs),
		];
		const used: ShellCommand[] = [];
		for (const [key, pipelines] of subs) {
			if (everything.some(word => word.includes(key))) used.push(...pipelines.flat());
		}
		const script = argv.length > 0 ? inlineShellScript(argv) : undefined;
		if (script !== undefined) nested.push(...this.parse(script, cwd, depth + 1, succeeded));
		return { argv, quoted, program, wrappers, reads, writes, subs: used, cwd, succeeded };
	}
}

/**
 * Parses a shell script into the simple commands it runs, for safety rules that must see through
 * shell syntax. Follows quotes, escapes, comments, `;`/`&&`/`||`/`|` chains, `( )` groups,
 * redirections, heredocs (quote-aware, so a quoted `<<` opens none), `$( )`/backtick/`<( )`
 * substitutions (also inside unquoted heredoc bodies), `bash -c`/`sh -c`/`eval` strings and scripts
 * fed to a shell's stdin (up to {@link SHELL_SCRIPT_MAX_DEPTH} levels), `cd` between commands, and
 * wrappers (`sudo`, `env`, `timeout`, `xargs`, `nohup`, `nice`, ...). It is a tokenizer, not a
 * shell: variables other than `$HOME`/`$PWD`, aliases, functions, and code run by other interpreters
 * are not followed.
 */
export function parseShellScript(command: string, scope: ShellScriptScope): ParsedShellScript {
	const parser = new ShellScriptParser(scope.home);
	const pipelines = parser.parse(command, scope.cwd, 0, []);
	return { pipelines, scripts: parser.scripts, truncated: parser.truncated };
}
