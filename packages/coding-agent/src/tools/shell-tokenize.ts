// The nested script parser in this file (`SHELL_SCRIPT_MAX_DEPTH` through `parseShellScript`) is
// derived from `src/intern/guard.py` of nace-ai/intern (https://github.com/nace-ai/intern, v0.30.1,
// commit e1bbd096f9), Copyright Nace AI, licensed under the Apache License, Version 2.0
// (http://www.apache.org/licenses/LICENSE-2.0). Modified for omp: rewritten in TypeScript on this
// tokenizer's operators, with `cd` and `( )` subshell tracking, quote-aware heredocs, and scripts
// fed to a shell's stdin. See packages/coding-agent/THIRD-PARTY-NOTICES.txt.
// It reads shell text best-effort for the opt-in guard rules and is not a security boundary: values
// it cannot know (most variables, substitution output) stay unexpanded.

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

/**
 * Nested `bash -c`, `eval`, heredoc-script and substitution levels {@link parseShellScript} follows,
 * and the most `${ }` expansions it reads inside one another.
 */
export const SHELL_SCRIPT_MAX_DEPTH = 8;

/**
 * The most nested script text {@link parseShellScript} reads, all levels together: `bash -c` and
 * `eval` strings, scripts fed to a shell's stdin, and backtick bodies, each counted every time it is read.
 */
export const SHELL_SCRIPT_MAX_NESTED_TEXT = 256 * 1024;

/** One simple command found by {@link parseShellScript}, with its wrappers peeled off. */
export interface ShellCommand {
	/**
	 * Arguments after quote removal and wrapper unwrapping; `argv[0]` is the program's basename.
	 * Empty for a command that is only redirections (`$(< file)`, `done < file`).
	 */
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
	 * Commands whose output can reach this one's input through pipes: the earlier stages of its
	 * pipeline, where a compound command (`( )`, `{ }`, a loop, `if`, `case`) is one stage made of
	 * every command run in it, and whatever is piped into a compound command it runs in.
	 */
	upstream: readonly ShellCommand[];
}

/** A shell script broken into pipelines, nested scripts included. */
export interface ParsedShellScript {
	/** Every pipeline, in order: the top level first, then nested scripts and substitutions. */
	pipelines: ShellCommand[][];
	/** Source text of every nested script (`bash -c` and `eval` strings, shell heredocs, substitution bodies). */
	scripts: string[];
	/**
	 * True when something nested deeper than {@link SHELL_SCRIPT_MAX_DEPTH} levels, or past
	 * {@link SHELL_SCRIPT_MAX_NESTED_TEXT} characters of nested script, was left unparsed, possibly
	 * with the rest of the text after it.
	 */
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
	";;&",
	";;",
	";&",
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

/** Reserved words after which the next word starts a command (a list, not a record: `then` would make it thenable). */
const COMMAND_PREFIXES: readonly string[] = ["!", "{", "if", "then", "else", "elif", "while", "until", "do"];

/** Reserved words that open a compound command, and those that close one. */
const COMPOUND_OPENERS: Record<string, true> = {
	"{": true,
	if: true,
	while: true,
	until: true,
	for: true,
	select: true,
	case: true,
};
const COMPOUND_CLOSERS: Record<string, true> = { "}": true, fi: true, done: true, esac: true };

/** Operators after which a newline does not end the pipeline or list: it goes on on the next line. */
const SHELL_CONTINUATIONS: Record<string, true> = { "|": true, "|&": true, "&&": true, "||": true };

/** A `case` command being read: the `(` depth it started at, and what comes next in it. */
interface CaseReading {
	parens: number;
	/**
	 * `subject` right after `case`, then `in`; `clause` where a clause's patterns (or `esac`) start,
	 * `pattern` within them, and `body` in the clause's commands.
	 */
	next: "subject" | "in" | "clause" | "pattern" | "body";
}

/** What text being read is nested in: where its substitutions run, and the map their keys go in. */
interface ReadScope {
	cwd: string;
	depth: number;
	subs: Map<string, ShellCommand[][]>;
}

/** A substitution's key in a word; it stands for the commands the substitution runs. */
const SUBSTITUTION_KEY_RE = /\0\d+\0/g;

/** Appends `items` to `target`; unlike `push(...items)`, any number of them. */
function append<T>(target: T[], items: Iterable<T>): void {
	for (const item of items) target.push(item);
}

/** A line ending in an odd number of backslashes: in an unquoted heredoc, it continues on the next line. */
const ODD_TRAILING_BACKSLASHES_RE = /(?:^|[^\\])(?:\\\\)*\\$/;

/**
 * The escapes bash removes from a backtick body before parsing it: before `$`, a backtick and `\`,
 * and inside double quotes before `"` too.
 */
const BACKTICK_ESCAPE_RE = /\\([$`\\])/g;
const QUOTED_BACKTICK_ESCAPE_RE = /\\([$`\\"])/g;

/** The one-letter escapes of a `$'...'` string. */
const ANSI_C_ESCAPES: Record<string, string> = {
	a: "\x07",
	b: "\b",
	e: "\x1b",
	E: "\x1b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
	"\\": "\\",
	"'": "'",
	'"': '"',
	"?": "?",
};
/** The numeric escapes of a `$'...'` string: octal, `\x`, `\u`, `\U`, and `\c` control characters. */
const ANSI_C_NUMERIC_RE = /^(?:[0-7]{1,3}|x[\da-fA-F]{1,2}|u[\da-fA-F]{1,4}|U[\da-fA-F]{1,8}|c[^'])/;

/** The character a numeric `$'...'` escape stands for. */
function ansiCCharacter(escape: string): string {
	if (escape[0] === "c") return String.fromCharCode(escape.charCodeAt(1) & 0x1f);
	if (escape[0] === "u" || escape[0] === "U") {
		const code = Number.parseInt(escape.slice(1), 16);
		return code <= 0x10ffff ? String.fromCodePoint(code) : "";
	}
	// Octal and `\x` escapes give one byte.
	const code = escape[0] === "x" ? Number.parseInt(escape.slice(1), 16) : Number.parseInt(escape, 8);
	return String.fromCharCode(code & 0xff);
}

/**
 * Reads a `$'...'` string from `start`, just past its opening quote: its value with the escapes
 * decoded, cut at the first NUL as bash cuts it, and the index of its closing quote. Unlike in a
 * plain single-quoted string, a backslash escapes the quote.
 */
function readAnsiCString(text: string, start: number): { value: string; end: number } {
	let value = "";
	let cut = false;
	let i = start;
	while (i < text.length && text[i] !== "'") {
		let char = text[i++];
		if (char === "\\" && i < text.length) {
			const numeric = ANSI_C_NUMERIC_RE.exec(text.slice(i, i + 9))?.[0];
			if (Object.hasOwn(ANSI_C_ESCAPES, text[i])) {
				char = ANSI_C_ESCAPES[text[i++]];
			} else if (numeric !== undefined) {
				char = ansiCCharacter(numeric);
				i += numeric.length;
			} else {
				char += text[i++];
			}
		}
		cut ||= char === "\0";
		if (!cut) value += char;
	}
	return { value, end: i };
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

/** Long shell options that take the next word as their value (`--rcfile file`). */
const SHELL_VALUE_OPTIONS: Record<string, true> = {
	"--rcfile": true,
	"--init-file": true,
};

/**
 * How a shell (`argv[0]` in {@link SCRIPT_SHELLS}) gets its script: with `-c`, the first word after
 * the options; `"stdin"` when it reads the script from its input (no such word, or `-s`); or
 * `undefined` for a script file. Each `o` or `O` in a short option bundle takes the next word as its
 * value (`-o pipefail`, `-euo pipefail`); long options (`--norc`, `--login`) come before the short ones.
 */
function shellScriptSource(argv: readonly string[]): string | undefined {
	let command = false;
	let stdin = false;
	let i = 1;
	for (; i < argv.length; i++) {
		const arg = argv[i];
		// `-` and `--` end the options.
		if (arg === "-" || arg === "--") {
			i++;
			break;
		}
		if (Object.hasOwn(SHELL_VALUE_OPTIONS, arg)) {
			i++;
		} else if (!arg.startsWith("--")) {
			if (!/^[-+]./.test(arg)) break;
			for (const letter of arg.slice(1)) {
				if (letter === "c") command = true;
				else if (letter === "s") stdin = true;
				else if (letter === "o" || letter === "O") i++;
			}
		}
	}
	if (command) return argv[i] ?? "";
	return stdin || i >= argv.length ? "stdin" : undefined;
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
 * Which commands feed each command's input through pipes, as a script runs. A compound command
 * (`( )`, `{ }`, a loop, `if`, `case`) is one pipeline stage: every command run in it is upstream of
 * the stage after it, and what is piped into it is upstream of every command in it.
 */
class PipelineStages {
	/** The compound commands open around the current command, innermost last. */
	readonly #compounds: { input: readonly ShellCommand[]; inside: ShellCommand[] }[] = [];
	#upstream: readonly ShellCommand[] = [];
	/** The commands of the current stage. */
	#stage: ShellCommand[] = [];

	/** Upstream of the current stage. */
	get upstream(): readonly ShellCommand[] {
		return this.#upstream;
	}

	/** Opens and closes the compound commands whose reserved words start a segment. */
	keywords(words: readonly string[], quoted: readonly boolean[]): void {
		for (let k = 0; k < words.length && !quoted[k]; k++) {
			const word = words[k];
			if (Object.hasOwn(COMPOUND_OPENERS, word)) {
				this.#open();
				// The words after `for`, `select` and `case` are no command.
				if (word === "for" || word === "select" || word === "case") return;
			} else if (Object.hasOwn(COMPOUND_CLOSERS, word)) {
				this.#close();
			} else if (!COMMAND_PREFIXES.includes(word)) {
				return;
			}
		}
	}

	/** A command run in the current stage. */
	add(command: ShellCommand): void {
		this.#stage.push(command);
		this.#compounds.at(-1)?.inside.push(command);
	}

	/** The operator after a segment. */
	operator(operator: string): void {
		if (operator === "(") {
			this.#open();
		} else if (operator === ")") {
			this.#close();
		} else if (Object.hasOwn(SHELL_PIPES, operator)) {
			this.#upstream = [...this.#upstream, ...this.#stage];
			this.#stage = [];
		} else {
			// The pipeline ended: the next one reads what is piped into the compound around it.
			this.#upstream = this.#compounds.at(-1)?.input ?? [];
			this.#stage = [];
		}
	}

	#open(): void {
		this.#compounds.push({ input: this.#upstream, inside: [] });
		this.#stage = [];
	}

	#close(): void {
		const compound = this.#compounds.pop();
		if (!compound) return;
		const outer = this.#compounds.at(-1);
		if (outer) append(outer.inside, compound.inside);
		this.#upstream = compound.input;
		this.#stage = compound.inside;
	}
}

class ShellScriptParser {
	#count = 0;
	/** `${ }`/`$[ ]` expansions being read inside one another. */
	#braces = 0;
	readonly scripts: string[] = [];
	/** Characters of nested script read so far, against {@link SHELL_SCRIPT_MAX_NESTED_TEXT}. */
	#nestedText = 0;
	/** Set when something was left unparsed: nested too deep, or past the nested text budget. */
	truncated = false;
	constructor(readonly home: string) {}

	/** The pipelines `source` runs, nested ones after the top level. */
	parse(source: string, cwd: string, depth: number): ShellCommand[][] {
		if (depth > SHELL_SCRIPT_MAX_DEPTH) {
			this.truncated = true;
			return [];
		}
		if (depth > 0) {
			this.#nestedText += source.length;
			if (this.#nestedText > SHELL_SCRIPT_MAX_NESTED_TEXT) {
				this.truncated = true;
				return [];
			}
			this.scripts.push(source);
		}
		const scope: ReadScope = { cwd, depth, subs: new Map() };
		return this.#pipelines(this.#tokens(source, 0, scope, true, false).tokens, scope);
	}

	/** The pipelines `tokens`, read in `scope`, run, nested ones after the top level. */
	#pipelines(tokens: readonly ShellScriptToken[], scope: ReadScope): ShellCommand[][] {
		const { depth, subs } = scope;
		let cwd = scope.cwd;
		// A `( )` subshell's `cd` ends with the group: the directory is restored at its `)`.
		const subshellCwds: string[] = [];
		const pipelines: ShellCommand[][] = [];
		const nested: ShellCommand[][] = [];
		const stages = new PipelineStages();
		// Per command, the texts it passes on to the next stage when that is a shell.
		const passed = new Map<ShellCommand, string[]>();
		let pipeline: ShellCommand[] = [];
		for (const segment of this.#segments(tokens)) {
			stages.keywords(segment.words, segment.quoted);
			const command = this.#command(segment, cwd, subs, depth, nested, stages.upstream);
			if (command) {
				pipeline.push(command);
				stages.add(command);
				this.#feedShell(command, segment, passed, depth, nested);
			}
			stages.operator(segment.operator);
			if (Object.hasOwn(SHELL_PIPES, segment.operator)) continue;
			if (pipeline.length > 0) {
				pipelines.push(pipeline);
				const only = pipeline.length === 1 ? pipeline[0] : undefined;
				if (only && (only.argv[0] === "cd" || only.argv[0] === "pushd")) {
					const target = shellPositionalArgs(only.argv)[0];
					cwd = target === undefined ? this.home : (resolveShellWordPath(target, cwd, this.home) ?? cwd);
				}
				pipeline = [];
			}
			if (segment.operator === "(") subshellCwds.push(cwd);
			else if (segment.operator === ")") cwd = subshellCwds.pop() ?? cwd;
		}
		return [...pipelines, ...nested, ...[...subs.values()].flat()];
	}

	/**
	 * Records in `passed` what `command` (read from `segment`) passes on to a shell piped after it:
	 * the heredocs and here-strings it reads (`cat <<EOF | sh`), and what `echo`/`printf` prints.
	 * When `command` is a shell that reads its script from stdin, parses what its upstream commands
	 * and its own heredocs and here-strings give it. The first such shell takes that input, so each
	 * text is parsed once: a shell further down reads the output of the one before it instead.
	 */
	#feedShell(
		command: ShellCommand,
		segment: ShellScriptSegment,
		passed: Map<ShellCommand, string[]>,
		depth: number,
		nested: ShellCommand[][],
	): void {
		const { argv, cwd } = command;
		const texts = new Set([...segment.heredocs.map(doc => doc.body), ...segment.herestrings]);
		if (Object.hasOwn(SHELL_ECHOES, argv[0])) {
			texts.add(argv.slice(1).join(" "));
			for (const arg of argv.slice(1)) texts.add(arg);
		}
		passed.set(command, [...texts]);
		if (!Object.hasOwn(SCRIPT_SHELLS, argv[0]) || shellScriptSource(argv) !== "stdin") return;
		for (const source of [...command.upstream, command]) {
			for (const text of passed.get(source) ?? []) append(nested, this.parse(text, cwd, depth + 1));
			passed.delete(source);
		}
	}

	/**
	 * Words and operators from `start`; a quoted word is never an operator. A heredoc body is read
	 * when its line ends and attached to the delimiter word. With `heredocs` off (`$(( ))`), and
	 * inside a `(( ))` command, `<<` is a shift. With `close`, reading stops at the `)` that closes a
	 * `$( )` opened just before `start`: `end` is its index, or the text's length when none comes.
	 * The `)` that ends a `case` pattern list is no parenthesis: it becomes a `;`, and the optional
	 * `(` before the patterns is dropped.
	 */
	#tokens(
		text: string,
		start: number,
		scope: ReadScope,
		heredocs: boolean,
		close: boolean,
	): { tokens: ShellScriptToken[]; end: number } {
		const out: ShellScriptToken[] = [];
		let word = "";
		let started = false;
		let quoted = false;
		// Set after `<<`/`<<-`: the next word is a heredoc delimiter.
		let delimiter: { stripTabs: boolean } | undefined;
		const pending: PendingHeredoc[] = [];
		// `(` operators not closed yet, and how many were open when the `(( ))` command being read
		// started (-1 outside one).
		let parens = 0;
		let arithmetic = -1;
		// `case` commands being read, innermost last.
		const cases: CaseReading[] = [];
		// Whether the next word starts a command, where `case` and `esac` are reserved words.
		const commandPosition = () => {
			const last = out.at(-1);
			if (!last) return true;
			if (last.operator) return !Object.hasOwn(SHELL_REDIRECTS, last.text);
			return !last.quoted && COMMAND_PREFIXES.includes(last.text);
		};
		// Moves the `case` being read past the word just ended, or starts one.
		const caseWord = () => {
			const reading = cases.at(-1);
			const reserved = quoted ? undefined : word;
			if (reading && reading.next !== "body") {
				if (reading.next === "subject") reading.next = "in";
				else if (reading.next === "in" && reserved === "in") reading.next = "clause";
				else if (reading.next === "in") cases.pop();
				else if (reading.next === "clause" && reserved === "esac") cases.pop();
				// Any other word is one of the clause's patterns.
				else reading.next = "pattern";
			} else if (reserved === "case" && commandPosition()) {
				cases.push({ parens, next: "subject" });
			} else if (reading && reserved === "esac" && reading.parens === parens && commandPosition()) {
				cases.pop();
			}
		};
		const flush = () => {
			if (started) {
				const token: ShellScriptToken = { text: word, operator: false, quoted };
				if (delimiter) {
					token.heredoc = { body: "", expands: !quoted, subs: [] };
					pending.push({ delimiter: word, stripTabs: delimiter.stripTabs, doc: token.heredoc });
					delimiter = undefined;
				} else {
					caseWord();
				}
				out.push(token);
			}
			word = "";
			started = false;
			quoted = false;
		};
		let i = start;
		while (i < text.length) {
			const ch = text[i];
			// A carriage return belongs to its word, except in a CRLF line end. A heredoc delimiter
			// keeps even that one, as in bash: a CRLF body ends at a line that ends in one too.
			if (ch === " " || ch === "\t" || (ch === "\r" && text[i + 1] === "\n")) {
				if (ch === "\r" && delimiter && started) word += ch;
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
			} else if (ch === "$" && text[i + 1] === "'") {
				const ansi = readAnsiCString(text, i + 2);
				word += ansi.value;
				started = true;
				quoted = true;
				i = ansi.end + 1;
			} else if (ch === "'") {
				let end = text.indexOf("'", i + 1);
				if (end < 0) end = text.length;
				word += text.slice(i + 1, end);
				started = true;
				quoted = true;
				i = end + 1;
			} else if (ch === '"') {
				const double = this.#double(text, i + 1, scope);
				word += double.value;
				started = true;
				quoted = true;
				i = double.after;
			} else if (ch === "$" && (text[i + 1] === "{" || text[i + 1] === "[")) {
				// `${ }` and `$[ ]` belong to the word: a `<<` inside them is not a heredoc.
				const { end, keys } = this.#parameter(text, i + 2, scope, false);
				word += text.slice(i, end + 1) + keys.join("");
				started = true;
				i = end + 1;
			} else if (ch === "`" || ((ch === "$" || ch === "<" || ch === ">") && text[i + 1] === "(")) {
				const sub = this.#substitution(text, i, scope, false);
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
				const reading = cases.at(-1);
				if (reading?.parens === parens) {
					if (operator === ")" && (reading.next === "clause" || reading.next === "pattern")) {
						out.push({ text: ";", operator: true, quoted: false });
						reading.next = "body";
						i++;
						continue;
					}
					if (operator === "(" && reading.next === "clause") {
						reading.next = "pattern";
						i++;
						continue;
					}
					if (operator === ";;" || operator === ";&" || operator === ";;&") {
						if (reading.next === "body") reading.next = "clause";
					} else if ((reading.next === "subject" || reading.next === "in") && operator !== "\n") {
						cases.pop();
					}
				}
				if (operator === ")" && parens === 0 && close) {
					return { tokens: out, end: i };
				}
				out.push({ text: operator, operator: true, quoted: false });
				i += operator.length;
				if (operator === "(") {
					if (text[i] === "(" && arithmetic < 0) arithmetic = parens;
					parens++;
				} else if (operator === ")" && parens > 0) {
					parens--;
					if (parens <= arithmetic) arithmetic = -1;
					// A `case` left open in the group ends with it.
					while ((cases.at(-1)?.parens ?? -1) > parens) cases.pop();
				}
				if ((operator === "<<" || operator === "<<-") && heredocs && arithmetic < 0) {
					delimiter = { stripTabs: operator === "<<-" };
				}
				if (operator === "\n" && pending.length > 0) {
					i = this.#heredocBodies(text, i, pending, scope, close);
				}
			}
		}
		flush();
		return { tokens: out, end: text.length };
	}

	/**
	 * Reads the bodies of the heredocs opened on the line that just ended, from `start`, and returns
	 * where the script goes on. In an unquoted heredoc, a backslash-newline joins two lines before the
	 * delimiter is looked for. Inside a `$( )` (`close`), a line that starts with the delimiter and
	 * has a `)` after it ends the heredoc too, as in bash, and the script goes on right after the
	 * delimiter (`EOF)`). When a delimiter line never comes, every line stays in place and is parsed
	 * as commands: a `<<` misread as a heredoc must not hide what follows it.
	 */
	#heredocBodies(text: string, start: number, pending: PendingHeredoc[], scope: ReadScope, close: boolean): number {
		const bodies: string[] = [];
		let pos = start;
		for (const { delimiter, stripTabs, doc } of pending) {
			const lines: string[] = [];
			let closed = false;
			while (pos < text.length && !closed) {
				let line = "";
				// Where each physical line joined into `line` starts, in `line` and in `text`.
				const parts: { from: number; at: number }[] = [];
				let joined = true;
				while (joined) {
					const newline = text.indexOf("\n", pos);
					parts.push({ from: line.length, at: pos });
					line += text.slice(pos, newline < 0 ? text.length : newline);
					pos = newline < 0 ? text.length : newline + 1;
					joined = doc.expands && newline >= 0 && ODD_TRAILING_BACKSLASHES_RE.test(line);
					if (joined) line = line.slice(0, -1);
				}
				const stripped = stripTabs ? line.replace(/^\t+/, "") : line;
				const after = line.length - stripped.length + delimiter.length;
				if (stripped === delimiter) {
					closed = true;
				} else if (close && stripped.startsWith(delimiter) && stripped.includes(")", delimiter.length)) {
					const part = parts.findLast(({ from }) => from <= after)!;
					pos = part.at + after - part.from;
					closed = true;
				} else {
					lines.push(stripped);
				}
			}
			if (!closed) {
				pending.length = 0;
				return start;
			}
			bodies.push(lines.join("\n"));
		}
		for (const [index, { doc }] of pending.entries()) {
			doc.body = bodies[index];
			if (doc.expands) doc.subs = this.#expansions(doc.body, scope);
		}
		pending.length = 0;
		return pos;
	}

	/**
	 * Reads a double-quoted string from `start`, just past its opening quote: its value, with a key in
	 * place of each substitution, and the index after its closing quote.
	 */
	#double(text: string, start: number, scope: ReadScope): { value: string; after: number } {
		let value = "";
		let i = start;
		while (i < text.length && text[i] !== '"') {
			const ch = text[i];
			if (ch === "\\" && i + 1 < text.length) {
				const next = text[i + 1];
				if (next === "$" || next === "`" || next === '"' || next === "\\") value += next;
				else if (next !== "\n") value += ch + next;
				i += 2;
			} else if (ch === "`" || (ch === "$" && text[i + 1] === "(")) {
				const sub = this.#substitution(text, i, scope, true);
				value += sub.key;
				i = sub.after;
			} else if (ch === "$" && (text[i + 1] === "{" || text[i + 1] === "[")) {
				const { end, keys } = this.#parameter(text, i + 2, scope, true);
				value += text.slice(i, end + 1) + keys.join("");
				i = end + 1;
			} else {
				value += ch;
				i++;
			}
		}
		return { value, after: i + 1 };
	}

	/**
	 * Reads a `${ }` or `$[ ]` whose opening bracket is just before `start`: the index of its closing
	 * bracket, and the keys of the substitutions in it. Quotes, escapes, nested expansions and
	 * substitutions hide a closing bracket; a bare `{` does not nest, a `[` in `$[ ]` does. `quoted`
	 * tells whether the expansion is inside double quotes.
	 */
	#parameter(text: string, start: number, scope: ReadScope, quoted: boolean): { end: number; keys: string[] } {
		const close = text[start - 1] === "[" ? "]" : "}";
		const keys: string[] = [];
		if (this.#braces >= SHELL_SCRIPT_MAX_DEPTH) {
			this.truncated = true;
			return { end: text.length, keys };
		}
		this.#braces++;
		let brackets = 0;
		let end = text.length;
		let i = start;
		while (i < text.length) {
			const ch = text[i];
			if (ch === "\\") {
				i += 2;
			} else if (ch === "$" && text[i + 1] === "'") {
				i = readAnsiCString(text, i + 2).end + 1;
			} else if (ch === "'") {
				const quote = text.indexOf("'", i + 1);
				i = quote < 0 ? text.length : quote + 1;
			} else if (ch === '"') {
				const double = this.#double(text, i + 1, scope);
				append(keys, double.value.match(SUBSTITUTION_KEY_RE) ?? []);
				i = double.after;
			} else if (ch === "`" || (ch === "$" && text[i + 1] === "(")) {
				const sub = this.#substitution(text, i, scope, quoted);
				keys.push(sub.key);
				i = sub.after;
			} else if (ch === "$" && (text[i + 1] === "{" || text[i + 1] === "[")) {
				const inner = this.#parameter(text, i + 2, scope, quoted);
				append(keys, inner.keys);
				i = inner.end + 1;
			} else if (ch === close && brackets === 0) {
				end = i;
				break;
			} else {
				if (close === "]" && ch === "[") brackets++;
				else if (ch === close) brackets--;
				i++;
			}
		}
		this.#braces--;
		return { end, keys };
	}

	/**
	 * Keys of the `$( )` and backtick substitutions in an unquoted heredoc body, which the shell
	 * expands without running the body as a script. Quotes are not special there.
	 */
	#expansions(text: string, scope: ReadScope): string[] {
		const keys: string[] = [];
		let i = 0;
		while (i < text.length) {
			const ch = text[i];
			if (ch === "\\") {
				i += 2;
			} else if (ch === "`" || (ch === "$" && text[i + 1] === "(")) {
				const sub = this.#substitution(text, i, scope, false);
				keys.push(sub.key);
				i = sub.after;
			} else {
				i++;
			}
		}
		return keys;
	}

	/**
	 * Reads the substitution at `start` (`` ` ``, `$(`, `<(`, `>(`) and parses what it runs: the key
	 * that stands for it in a word, and the index after it. A `$( )` body is read as commands up to
	 * the `)` that closes it, so a `)` in quotes, in a comment or in a heredoc body does not end it.
	 * A backtick body loses the backslashes bash removes before parsing it (`quoted`: inside double
	 * quotes), so `` \` `` nests a substitution and `\"` is a quote again.
	 */
	#substitution(text: string, start: number, scope: ReadScope, quoted: boolean): { key: string; after: number } {
		const key = `\0${this.#count++}\0`;
		const depth = scope.depth + 1;
		if (text[start] === "`") {
			let end = start + 1;
			while (end < text.length && text[end] !== "`") end += text[end] === "\\" ? 2 : 1;
			const body = text.slice(start + 1, end).replace(quoted ? QUOTED_BACKTICK_ESCAPE_RE : BACKTICK_ESCAPE_RE, "$1");
			scope.subs.set(key, this.parse(body, scope.cwd, depth));
			return { key, after: end + 1 };
		}
		if (depth > SHELL_SCRIPT_MAX_DEPTH) {
			// Only parsing the body finds its end, so the rest of the text is left unread.
			this.truncated = true;
			return { key, after: text.length };
		}
		const inner: ReadScope = { cwd: scope.cwd, depth, subs: new Map() };
		// `$(( ))` is arithmetic, or a command substitution that starts with a subshell: it is read as
		// commands either way, but a `<<` in it is never a heredoc.
		const { tokens, end } = this.#tokens(text, start + 2, inner, !text.startsWith("$((", start), true);
		this.scripts.push(text.slice(start + 2, end));
		scope.subs.set(key, this.#pipelines(tokens, inner));
		return { key, after: end + 1 };
	}

	/**
	 * Each command's words, redirections, heredocs, and the operator after it. A newline right after
	 * `|`, `|&`, `&&` or `||` (a comment between them included) separates nothing: the pipeline or
	 * list goes on on the next line.
	 */
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
		let continued = false;
		for (const token of tokens) {
			if (continued && token.operator && token.text === "\n") continue;
			continued = token.operator && Object.hasOwn(SHELL_CONTINUATIONS, token.text);
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
		upstream: readonly ShellCommand[],
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
		// A command that is only redirections still opens its files (`$(< file)`, `done < file`).
		if (argv.length === 0 && writes.length === 0 && reads.length === 0) return undefined;
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
		for (const word of everything) {
			for (const key of word.match(SUBSTITUTION_KEY_RE) ?? []) {
				for (const pipeline of subs.get(key) ?? []) append(used, pipeline);
			}
		}
		const script = argv.length > 0 ? inlineShellScript(argv) : undefined;
		if (script !== undefined) append(nested, this.parse(script, cwd, depth + 1));
		return { argv, quoted, program, wrappers, reads, writes, subs: used, cwd, upstream };
	}
}

/**
 * Parses a shell script into the simple commands it runs, for safety rules that must see through
 * shell syntax. Follows quotes (`$'...'` included), escapes, comments, `;`/`&&`/`||`/`|` chains
 * (continued on the next line after `|`, `&&` or `||`), `( )` groups and the other compound
 * commands (each one pipeline stage), redirections, heredocs (quote-aware, so a quoted `<<` opens
 * none), `$( )`/backtick/`<( )` substitutions (read as commands to the `)` that closes them, and
 * also found inside `${ }` and unquoted heredoc bodies), `bash -c`/`sh -c`/`eval` strings and
 * scripts fed to a shell's stdin (up to {@link SHELL_SCRIPT_MAX_DEPTH} levels), `cd` between
 * commands, and wrappers (`sudo`, `env`, `timeout`, `xargs`, `nohup`, `nice`, ...). It is a
 * tokenizer, not a shell: variables other than `$HOME`/`$PWD`, aliases, functions, and code run by
 * other interpreters are not followed.
 */
export function parseShellScript(command: string, scope: ShellScriptScope): ParsedShellScript {
	const parser = new ShellScriptParser(scope.home);
	const pipelines = parser.parse(command, scope.cwd, 0);
	return { pipelines, scripts: parser.scripts, truncated: parser.truncated };
}
