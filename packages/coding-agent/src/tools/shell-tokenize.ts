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

/**
 * The most text {@link parseShellScript} reads looking for heredoc delimiter lines that never come,
 * all searches together. A `<<` whose delimiter line is missing makes the search run to the end of
 * the text, so many of them would read it again and again.
 */
export const SHELL_SCRIPT_MAX_HEREDOC_SEARCH = 256 * 1024;

/**
 * The longest directory, in characters, {@link parseShellScript} follows a script into: the one
 * it starts in, or one a `cd`, `pushd`, `env -C` or `sudo -D` changes to; past it the script is
 * truncated. Every later path is resolved against that directory, so following longer ones would
 * cost the directory's length per path, and a chain of directory changes, each a step deeper, the
 * square of the script's length. No real directory a command runs in comes near it.
 */
export const SHELL_SCRIPT_MAX_DIRECTORY = 1024;

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
	/** Targets of `<` and `<>` input redirections. */
	reads: string[];
	/**
	 * Commands inside the substitutions (`$( )`, backticks, `<( )`) in this command's words, its
	 * redirections, and its unquoted heredoc bodies, which the shell expands even when the body is data.
	 */
	subs: ShellCommand[];
	/**
	 * Directory the program runs in: where the shell is after the `cd`, `pushd` and `popd` before the
	 * command, moved by a wrapper's directory option (`env -C`, `sudo -D`). `undefined` when the
	 * guard cannot tell (`cd "$dir"`), so relative paths are not resolved.
	 */
	cwd: string | undefined;
	/**
	 * Directory the shell is in when it runs the command, where it opens its redirections: `cwd`
	 * without the wrapper's directory option.
	 */
	shellCwd: string | undefined;
	/**
	 * Commands whose output can reach this one's input: the earlier stages of its pipeline, where a
	 * compound command (`( )`, `{ }`, a loop, `if`, `case`) is one stage made of every command run in
	 * it; whatever is piped into a compound command it runs in, or that compound command's own input
	 * redirections give it (`done < .env`); and in a substitution, the input of the command the
	 * substitution is in, or for a `>( )` that command itself.
	 */
	upstream: ShellUpstream | undefined;
	/**
	 * Arguments and redirection targets whose leading `~` was quoted or escaped (`"~/.ssh/id_rsa"`,
	 * `\~/x`), so the shell does not expand it; a word the command also has with a bare `~` is not here.
	 */
	literalTildes: ReadonlySet<string>;
	/**
	 * Arguments and redirection targets with a `{`, every one of which was quoted or escaped
	 * (`'{"a":1,"b":2}'`, `\{a,b}`), so the shell brace-expands nothing in them; a word the command
	 * also has with an unquoted `{` is not here.
	 */
	literalBraces: ReadonlySet<string>;
}

/**
 * Commands upstream of a pipeline stage ({@link ShellCommand.upstream}), as a chain every command
 * downstream shares: `commands[from]` to `commands[to - 1]` ran in the stage just before, and
 * `before` is what is upstream of that stage.
 */
export interface ShellUpstream {
	readonly commands: readonly ShellCommand[];
	readonly from: number;
	readonly to: number;
	readonly before: ShellUpstream | undefined;
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
	 * with the rest of the text after it, when heredocs whose delimiter line never comes took
	 * more than {@link SHELL_SCRIPT_MAX_HEREDOC_SEARCH} characters of searching, so later ones were
	 * not read as heredocs, when a directory change went past {@link SHELL_SCRIPT_MAX_DIRECTORY}
	 * characters, so the directory was not followed, or when a command had more than
	 * {@link SHELL_SCRIPT_MAX_DEPTH} `env -S` strings, so the later ones were not split.
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
 * expand; any other expansion makes the path unknown (`undefined`), and so does a relative path,
 * or `$PWD`, when `cwd` is unknown.
 */
export function resolveShellWordPath(word: string, cwd: string | undefined, home: string): string | undefined {
	let expanded = word.replace(/\$(?:\{HOME\}|HOME\b)/g, () => home);
	if (cwd !== undefined) expanded = expanded.replace(/\$(?:\{PWD\}|PWD\b)/g, () => cwd);
	if (expanded === "~" || expanded.startsWith("~/")) expanded = home + expanded.slice(1);
	if (!expanded || expanded.includes("$") || expanded.includes("\0") || expanded.startsWith("~")) return undefined;
	if (cwd === undefined) return path.isAbsolute(expanded) ? path.resolve(expanded) : undefined;
	return path.resolve(cwd, expanded);
}

/**
 * The absolute path a word of `command` names, as {@link resolveShellWordPath} resolves it, except
 * that a leading `~` the source quoted ({@link ShellCommand.literalTildes}) stays a plain character.
 */
export function resolveCommandWordPath(
	command: ShellCommand,
	word: string,
	cwd: string | undefined,
	home: string,
): string | undefined {
	return resolveShellWordPath(command.literalTildes.has(word) ? `./${word}` : word, cwd, home);
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
/**
 * Commands that run the rest of their arguments as a command, with the options that take a value
 * as a separate word, long forms included.
 */
const SHELL_WRAPPERS: Record<string, readonly string[]> = {
	sudo: [
		"-u",
		"-g",
		"-h",
		"-p",
		"-C",
		"-D",
		"-R",
		"-r",
		"-t",
		"-U",
		"-T",
		"--user",
		"--group",
		"--host",
		"--prompt",
		"--close-from",
		"--chdir",
		"--chroot",
		"--role",
		"--type",
		"--other-user",
		"--command-timeout",
	],
	doas: ["-u", "-C"],
	env: ["-u", "-C", "-S", "-P", "-a", "--unset", "--chdir", "--split-string", "--argv0"],
	nohup: [],
	exec: ["-a"],
	command: [],
	builtin: [],
	nice: ["-n", "--adjustment"],
	ionice: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"],
	time: ["-f", "-o", "--format", "--output"],
	timeout: ["-s", "-k", "--signal", "--kill-after"],
	stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
	xargs: [
		"-n",
		"-I",
		"-P",
		"-L",
		"-d",
		"-E",
		"-s",
		"-a",
		"--max-args",
		"--max-procs",
		"--max-chars",
		"--delimiter",
		"--arg-file",
		"--process-slot-var",
	],
	caffeinate: ["-t", "-w"],
	unbuffer: [],
};
/**
 * Wrappers that run their command in another directory, with the option that names it: its letter
 * and its long form, which may be abbreviated down to `shortest` (`sudo --ch` is also `--chroot`).
 */
const SHELL_WRAPPER_CHDIRS: Record<string, { letter: string; long: string; shortest: string }> = {
	env: { letter: "C", long: "--chdir", shortest: "--c" },
	sudo: { letter: "D", long: "--chdir", shortest: "--chd" },
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
	/** Set on a word whose leading `~` was quoted or escaped (`"~/x"`, `\~/x`), so the shell does not expand it. */
	literalTilde?: true;
	/** Set on a word with a `{`, none of them unquoted (`'{"a":1}'`, `\{a,b}`), so the shell brace-expands nothing in it. */
	literalBraces?: true;
	/** Set on a `case` pattern: no command word, though its substitutions run. */
	pattern?: true;
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
	/** Words whose substitutions run although they are no argument or file: `case` patterns and `<&` targets. */
	other: string[];
	/** Words and redirection targets whose leading `~` the shell keeps, as in {@link ShellCommand.literalTildes}. */
	literalTildes: Set<string>;
	/** Words and redirection targets the shell brace-expands nothing in, as in {@link ShellCommand.literalBraces}. */
	literalBraces: Set<string>;
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

/**
 * A substitution read but not parsed into commands yet: what it runs depends on the directory of
 * the command it is in, known only once the `cd`s before that command are applied, and on what
 * that command reads, or for `>( )` writes.
 */
interface Substitution {
	/** Its pipelines, nested ones after the top level, run from `cwd` with `input` upstream of them. */
	read: (cwd: string | undefined, input: ShellUpstream | undefined) => ShellCommand[][];
	/** Set on a `>( )`: it reads what the command it is in writes there, not that command's input. */
	output?: true;
	/** Set by the first {@link ShellScriptParser#substitute}: a substitution runs in one place. */
	pipelines?: ShellCommand[][];
}

/** What text being read is nested in, and the map the keys of its substitutions go in. */
interface ReadScope {
	depth: number;
	subs: Map<string, Substitution>;
}

/** Directories `pushd` saved, the one `popd` returns to first; what is below them is unknown. */
interface DirectoryStack {
	readonly dir: string | undefined;
	readonly below: DirectoryStack | undefined;
}

/** Where the shell is as a script runs, each `undefined` where the guard cannot tell. */
interface ShellDirectories {
	readonly cwd: string | undefined;
	/** `OLDPWD`, where `cd -` goes. */
	readonly previous: string | undefined;
	readonly stack: DirectoryStack | undefined;
}

/** Builtins that change the shell's directory, run on their own ({@link changeDirectory}). */
const DIRECTORY_CHANGERS: Record<string, true> = { cd: true, pushd: true, popd: true };

/**
 * Where the shell is after `command`, a {@link DIRECTORY_CHANGERS} builtin, runs from `dirs`,
 * taking it to succeed. `cd -` goes back to `OLDPWD`, `pushd dir` saves the directory it leaves,
 * `pushd` alone swaps it with the saved one, and `popd` returns to that one. A target the guard
 * cannot resolve (`cd "$dir"`), a `popd` past what the script pushed, and the stack's other
 * operations (`+N`, `-N`) leave the directory unknown, so relative paths after them are not
 * resolved; `-n` changes only the stack, which it leaves unknown.
 */
function changeDirectory(command: ShellCommand, dirs: ShellDirectories, home: string): ShellDirectories {
	const [name, ...rest] = command.argv;
	const operands = shellPositionalArgs(command.argv);
	const moveTo = (cwd: string | undefined, stack: DirectoryStack | undefined): ShellDirectories => ({
		cwd,
		previous: dirs.cwd,
		stack,
	});
	if (name === "cd") {
		const target = operands[0];
		if (target === undefined) return moveTo(home, dirs.stack);
		if (target === "-") return moveTo(dirs.previous, dirs.stack);
		return moveTo(resolveCommandWordPath(command, target, dirs.cwd, home), dirs.stack);
	}
	if (rest.length === 0) {
		const saved = dirs.stack;
		if (name === "popd") return moveTo(saved?.dir, saved?.below);
		return moveTo(saved?.dir, saved && { dir: dirs.cwd, below: saved.below });
	}
	if (name === "pushd" && rest.length === 1 && operands.length === 1 && !/^\+\d+$/.test(operands[0])) {
		const target = resolveCommandWordPath(command, operands[0], dirs.cwd, home);
		return moveTo(target, { dir: dirs.cwd, below: dirs.stack });
	}
	return rest.includes("-n") ? { ...dirs, stack: undefined } : moveTo(undefined, undefined);
}

/** A substitution's key in a word; it stands for the commands the substitution runs. */
const SUBSTITUTION_KEY_RE = /\0\d+\0/g;

/** Characters a `${ }` reads differently once a single quote around them is a plain character. */
const QUOTE_SENSITIVE_RE = /[[\]}"\\$`]/;

/** Appends `items` to `target`; unlike `push(...items)`, any number of them. */
export function append<T>(target: T[], items: Iterable<T>): void {
	for (const item of items) target.push(item);
}

/**
 * Records one occurrence of `word` in a segment: kept in `literal` while every occurrence so far
 * was `quoted` (the shell expands nothing in it), and moved to `bare` for good at the first that
 * was not, since the guard sees one word for both.
 */
function markLiteral(literal: Set<string>, bare: Set<string>, word: string, quoted: boolean): void {
	if (quoted && !bare.has(word)) {
		literal.add(word);
	} else {
		bare.add(word);
		literal.delete(word);
	}
}

/**
 * The first index from `i` that `taken` does not link past (`taken[i]` is the next index to look
 * at once `i` is taken), shortening every link it follows to point there.
 */
function untaken(taken: number[], i: number): number {
	let end = i;
	while (taken[end] !== undefined) end = taken[end];
	while (i !== end) {
		const next = taken[i];
		taken[i] = end;
		i = next;
	}
	return end;
}

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

/** The command a wrapper chain runs ({@link unwrapShellCommand}). */
interface UnwrappedCommand {
	/** Its words, the program first, with the words of an `env -S` string in place of the string. */
	argv: string[];
	/** Per `argv` word, whether it was quoted or escaped, in the source or in an `env -S` string. */
	quoted: boolean[];
	/** The wrappers, outermost first. */
	wrappers: string[];
	/** The directories a wrapper's directory option ({@link SHELL_WRAPPER_CHDIRS}) moves the command to, in order. */
	chdirs: string[];
	/** Set when more than {@link SHELL_SCRIPT_MAX_DEPTH} `env -S` strings were found, so the later ones were not split. */
	truncated: boolean;
}

/** env's option that splits its value into words and reads them as its arguments, with the shortest abbreviation of its long form. */
const ENV_SPLIT_OPTION = { letter: "S", long: "--split-string", shortest: "--s" };

/** The one-letter escapes of an `env -S` string that stand for a control character. */
const ENV_STRING_ESCAPES: Record<string, string> = { f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

/**
 * The words GNU env splits an `env -S` string into, each with whether it was quoted or escaped:
 * whitespace separates them; `'...'` keeps its text but for `\\` and `\'`; in `"..."` and unquoted,
 * a backslash escapes the next character, `\f`, `\n`, `\r`, `\t` and `\v` are control characters,
 * `\_` is a space in double quotes and ends the word outside them, and an unquoted `\c` ends the
 * string; a `#` that starts a word starts a comment. `${NAME}` stays as written. env expands no
 * `~` and no braces, but the words are checked as if it did. A string env rejects (an unknown
 * escape, an unclosed quote) is split all the same.
 */
function splitEnvString(text: string): { word: string; quoted: boolean }[] {
	const words: { word: string; quoted: boolean }[] = [];
	let word = "";
	let started = false;
	let quoted = false;
	let quote: string | undefined;
	const end = () => {
		if (started) words.push({ word, quoted });
		word = "";
		started = false;
		quoted = false;
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			else word += ch === "\\" && (text[i + 1] === "\\" || text[i + 1] === "'") ? text[++i] : ch;
		} else if (ch === "\\" && i + 1 < text.length) {
			const next = text[++i];
			if (next === "c" && quote === undefined) break;
			if (next === "_" && quote === undefined) {
				end();
				continue;
			}
			word += next === "_" ? " " : Object.hasOwn(ENV_STRING_ESCAPES, next) ? ENV_STRING_ESCAPES[next] : next;
			started = true;
			quoted = true;
		} else if (quote === '"') {
			if (ch === '"') quote = undefined;
			else word += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			started = true;
			quoted = true;
		} else if (/\s/.test(ch)) {
			end();
		} else if (ch === "#" && !started) {
			break;
		} else {
			word += ch;
			started = true;
		}
	}
	end();
	return words;
}

/**
 * The command a wrapper chain runs in `words` (`sudo env X=1 timeout 5 rm ...` runs `rm ...`), after
 * any reserved words and a `function name` header before a function body. A long option may be
 * abbreviated, as getopt allows (`--us root`); in a bundle of short options (`-nu root`), the first
 * that takes a value takes the rest of the word, or the next word when it ends the bundle. A
 * directory option's value ({@link SHELL_WRAPPER_CHDIRS}) in the same word as its option (`-C~/x`,
 * `--chdir=~/x`) gets no tilde expansion, so a leading `~` in it is kept as a name (`./~/x`). The
 * words of an `env -S` string ({@link splitEnvString}) are read in its place, as env reads them,
 * options and command alike, up to {@link SHELL_SCRIPT_MAX_DEPTH} such strings: each can hold
 * another one (`env -S'-S-S...'`), so splitting more would cost the square of the word's length.
 */
function unwrapShellCommand(words: readonly string[], quoted: readonly boolean[]): UnwrappedCommand {
	const inWord = (value: string) => (value.startsWith("~") ? `./${value}` : value);
	const wrappers: string[] = [];
	const chdirs: string[] = [];
	let strings = 0;
	let truncated = false;
	// Words of `env -S` strings not read yet, the next one last; `words[i]` comes after them.
	const split: { word: string; quoted: boolean }[] = [];
	let i = 0;
	const peek = (ahead: number): string | undefined =>
		ahead < split.length ? split[split.length - 1 - ahead].word : words[i + ahead - split.length];
	const skip = (count: number) => {
		for (; count > 0; count--) if (split.pop() === undefined) i++;
	};
	for (let word = peek(0); word !== undefined; word = peek(0)) {
		if (SHELL_ASSIGNMENT.test(word) || SHELL_KEYWORDS.includes(word)) {
			skip(1);
			continue;
		}
		if (word === "function") {
			skip(2);
			continue;
		}
		const name = path.posix.basename(word);
		const valued = Object.hasOwn(SHELL_WRAPPERS, name) ? SHELL_WRAPPERS[name] : undefined;
		if (!valued || (name === "command" && (peek(1) === "-v" || peek(1) === "-V"))) break;
		const chdir = Object.hasOwn(SHELL_WRAPPER_CHDIRS, name) ? SHELL_WRAPPER_CHDIRS[name] : undefined;
		const splits = name === "env" ? ENV_SPLIT_OPTION : undefined;
		wrappers.push(name);
		skip(1);
		let positional = name === "timeout" ? 1 : 0; // timeout's duration
		for (let arg = peek(0); arg !== undefined; arg = peek(0)) {
			if (arg === "--") {
				skip(1);
				break;
			}
			let dir: string | undefined;
			let string: string | undefined;
			if (name === "env" && (SHELL_ASSIGNMENT.test(arg) || arg === "-")) {
				// A lone `-` is `env -i`.
				skip(1);
			} else if (arg.startsWith("--")) {
				const eq = arg.indexOf("=");
				const flag = eq < 0 ? arg : arg.slice(0, eq);
				const value = eq < 0 ? peek(1) : arg.slice(eq + 1);
				if (chdir && flag.length >= chdir.shortest.length && chdir.long.startsWith(flag)) {
					dir = eq < 0 ? value : inWord(value!);
				}
				if (splits && flag.length >= splits.shortest.length && splits.long.startsWith(flag)) string = value;
				skip(eq < 0 && valued.some(option => option.startsWith(arg)) ? 2 : 1);
			} else if (arg.startsWith("-") && arg.length > 1) {
				let k = 1;
				while (k < arg.length && !valued.includes(`-${arg[k]}`)) k++;
				const value = k === arg.length - 1 ? peek(1) : arg.slice(k + 1);
				if (chdir && arg[k] === chdir.letter) dir = k === arg.length - 1 ? value : inWord(value!);
				if (splits && arg[k] === splits.letter) string = value;
				skip(k === arg.length - 1 ? 2 : 1);
			} else if (positional > 0) {
				positional--;
				skip(1);
			} else {
				break;
			}
			if (dir !== undefined) chdirs.push(dir);
			if (string !== undefined && ++strings > SHELL_SCRIPT_MAX_DEPTH) truncated = true;
			else if (string !== undefined) append(split, splitEnvString(string).reverse());
		}
	}
	const argv: string[] = [];
	const argvQuoted: boolean[] = [];
	for (let k = split.length - 1; k >= 0; k--) {
		argv.push(split[k].word);
		argvQuoted.push(split[k].quoted);
	}
	for (let k = i; k < words.length; k++) {
		argv.push(words[k]);
		argvQuoted.push(quoted[k]);
	}
	return { argv, quoted: argvQuoted, wrappers, chdirs, truncated };
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

/** The script a `bash -c '...'` or `eval ...` runs; eval takes a leading `--` as the end of its options. */
function inlineShellScript(argv: readonly string[]): string | undefined {
	if (argv[0] === "eval") return argv.slice(argv[1] === "--" ? 2 : 1).join(" ");
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
 * The compound commands the reserved words at the start of a segment open and close, in order; a
 * `function name` header before a function body opens none.
 */
function* compoundKeywords(words: readonly string[], quoted: readonly boolean[]): Generator<"open" | "close"> {
	for (let k = 0; k < words.length && !quoted[k]; k++) {
		const word = words[k];
		if (Object.hasOwn(COMPOUND_OPENERS, word)) {
			yield "open";
			// The words after `for`, `select` and `case` are no command.
			if (word === "for" || word === "select" || word === "case") return;
		} else if (Object.hasOwn(COMPOUND_CLOSERS, word)) {
			yield "close";
		} else if (word === "function") {
			k++;
		} else if (!COMMAND_PREFIXES.includes(word)) {
			return;
		}
	}
}

/**
 * Per compound command that redirects its own input with a `<` file, a heredoc or a here-string
 * (`done < file`, `} <<EOF`, `) < file`), numbered in the order they open, the index of the
 * segment with those redirections: the one its closing reserved word starts, or the one with no
 * words right after its `)`.
 */
function compoundInputs(segments: readonly ShellScriptSegment[]): Map<number, number> {
	const redirects = segments.map(
		segment => segment.reads.length > 0 || segment.heredocs.length > 0 || segment.herestrings.length > 0,
	);
	const inputs = new Map<number, number>();
	const open: number[] = [];
	let opened = 0;
	for (const [index, segment] of segments.entries()) {
		let closed: number | undefined;
		for (const keyword of compoundKeywords(segment.words, segment.quoted)) {
			if (keyword === "open") open.push(opened++);
			else closed = open.pop();
		}
		if (closed !== undefined && redirects[index]) inputs.set(closed, index);
		if (segment.operator === "(") {
			open.push(opened++);
		} else if (segment.operator === ")") {
			const group = open.pop();
			if (group !== undefined && redirects[index + 1] && segments[index + 1].words.length === 0) {
				inputs.set(group, index + 1);
			}
		}
	}
	return inputs;
}

/**
 * Which commands feed each command's input through pipes, as a script runs. A compound command
 * (`( )`, `{ }`, a loop, `if`, `case`) is one pipeline stage: every command run in it is upstream of
 * the stage after it, and what is piped into it, or what its own redirections give it, is upstream
 * of every command in it. The commands are kept in one list, where a stage and a compound command
 * are each a run of it, so an upstream chain costs the same at every pipe however long the
 * pipeline gets.
 */
class PipelineStages {
	/** Every command added, in order. */
	readonly #commands: ShellCommand[] = [];
	/**
	 * The compound commands open around the current command, innermost last: what is piped into
	 * each, and where its commands start in {@link #commands}.
	 */
	readonly #compounds: { input: ShellUpstream | undefined; from: number }[] = [];
	#upstream: ShellUpstream | undefined;
	/** Where the commands of the current stage start. */
	#stage = 0;
	/** Compound commands opened so far. */
	#opened = 0;

	/**
	 * @param input What the script reads: upstream of every pipeline in it that no compound command
	 *   around it gives other input.
	 * @param redirection The command made of the input redirections of the compound command opened
	 *   `opened`-th (counted from 0), if it has any.
	 */
	constructor(
		readonly input: ShellUpstream | undefined,
		readonly redirection: (opened: number) => ShellCommand | undefined,
	) {
		this.#upstream = input;
	}

	/** Upstream of the current stage. */
	get upstream(): ShellUpstream | undefined {
		return this.#upstream;
	}

	/** Opens and closes the compound commands whose reserved words start a segment. */
	keywords(words: readonly string[], quoted: readonly boolean[]): void {
		for (const keyword of compoundKeywords(words, quoted)) {
			if (keyword === "open") this.#open();
			else this.#close();
		}
	}

	/** A command run in the current stage. */
	add(command: ShellCommand): void {
		this.#commands.push(command);
	}

	/** The operator after a segment. */
	operator(operator: string): void {
		const end = this.#commands.length;
		if (operator === "(") {
			this.#open();
		} else if (operator === ")") {
			this.#close();
		} else if (Object.hasOwn(SHELL_PIPES, operator)) {
			if (end > this.#stage) {
				this.#upstream = { commands: this.#commands, from: this.#stage, to: end, before: this.#upstream };
			}
			this.#stage = end;
		} else {
			// The pipeline ended: the next one reads what the compound around it, or the script, reads.
			this.#upstream = this.#compounds.length > 0 ? this.#compounds.at(-1)!.input : this.input;
			this.#stage = end;
		}
	}

	/** Opens a compound command: its input redirections, if any, feed every command in it. */
	#open(): void {
		const redirection = this.redirection(this.#opened++);
		if (redirection) {
			const at = this.#commands.push(redirection) - 1;
			this.#upstream = { commands: this.#commands, from: at, to: at + 1, before: this.#upstream };
		}
		this.#compounds.push({ input: this.#upstream, from: this.#commands.length });
		this.#stage = this.#commands.length;
	}

	/** Closes the innermost compound command: everything run in it, nested ones included, is the current stage. */
	#close(): void {
		const compound = this.#compounds.pop();
		if (!compound) return;
		this.#upstream = compound.input;
		this.#stage = compound.from;
	}
}

class ShellScriptParser {
	#count = 0;
	/** `${ }`/`$[ ]` expansions being read inside one another. */
	#braces = 0;
	readonly scripts: string[] = [];
	/** Characters of nested script read so far, against {@link SHELL_SCRIPT_MAX_NESTED_TEXT}. */
	#nestedText = 0;
	/**
	 * Whether a `'` in a double-quoted `${ }` is read as a quote, as bash reads it, rather than as
	 * a plain character, as POSIX shells (dash, `bash --posix`) read it in `"${v:-it's}"`.
	 */
	#bashQuotes = false;
	/** Set when the text being read has such a `'` that the two readings take differently. */
	#ambiguous = false;
	/**
	 * Set when something was left unparsed: nested too deep, past the nested text budget, or past
	 * the budget for searching delimiters of heredocs that never close; or when a directory change
	 * went past {@link SHELL_SCRIPT_MAX_DIRECTORY}, or a command had too many `env -S` strings.
	 */
	truncated = false;
	/** Characters read looking for heredoc delimiter lines that never came, against {@link SHELL_SCRIPT_MAX_HEREDOC_SEARCH}. */
	#heredocSearch = 0;
	/** Per command, the texts it passes on to a shell after it in its pipeline, until a shell takes them. */
	readonly #passed = new Map<ShellCommand, string[]>();
	/** Upstream stages a shell took the texts of, with everything upstream of them. */
	readonly #fed = new Set<ShellUpstream>();
	/**
	 * Per command list of a {@link ShellUpstream}, links past the commands a shell took the texts of
	 * (see {@link untaken}), so a stage nested in many taken ones is not walked again for each.
	 */
	readonly #taken = new Map<readonly ShellCommand[], number[]>();
	constructor(readonly home: string) {}

	/**
	 * `dir`, the directory a change takes the script to, or `undefined`, with the script truncated,
	 * when it is longer than {@link SHELL_SCRIPT_MAX_DIRECTORY}.
	 */
	directory(dir: string | undefined): string | undefined {
		if (dir === undefined || dir.length <= SHELL_SCRIPT_MAX_DIRECTORY) return dir;
		this.truncated = true;
		return undefined;
	}

	/**
	 * The pipelines `source` runs, nested ones after the top level, with `input` upstream of it.
	 * When a `'` in a double-quoted `${ }` makes bash and POSIX shells read `source` differently,
	 * the commands of both readings.
	 */
	parse(source: string, cwd: string | undefined, depth: number, input?: ShellUpstream): ShellCommand[][] {
		if (depth > SHELL_SCRIPT_MAX_DEPTH) {
			this.truncated = true;
			return [];
		}
		if (!this.#budget(source, depth)) return [];
		if (depth > 0) this.scripts.push(source);
		const outer = { bashQuotes: this.#bashQuotes, ambiguous: this.#ambiguous };
		this.#bashQuotes = false;
		this.#ambiguous = false;
		const pipelines = this.#read(source, cwd, depth, input);
		if (this.#ambiguous && this.#budget(source, depth)) {
			this.#bashQuotes = true;
			append(pipelines, this.#read(source, cwd, depth, input));
		}
		this.#bashQuotes = outer.bashQuotes;
		this.#ambiguous = outer.ambiguous;
		return pipelines;
	}

	/** Counts a nested `source` against the nested text budget: false, and truncated, once past it. */
	#budget(source: string, depth: number): boolean {
		if (depth === 0) return true;
		this.#nestedText += source.length;
		if (this.#nestedText <= SHELL_SCRIPT_MAX_NESTED_TEXT) return true;
		this.truncated = true;
		return false;
	}

	#read(source: string, cwd: string | undefined, depth: number, input: ShellUpstream | undefined): ShellCommand[][] {
		const scope: ReadScope = { depth, subs: new Map() };
		return this.#pipelines(this.#tokens(source, 0, scope, true, false).tokens, scope, cwd, input);
	}

	/** The commands `substitution` runs from `cwd` with `input`, parsed the first time it is asked for. */
	#substitute(
		substitution: Substitution,
		cwd: string | undefined,
		input: ShellUpstream | undefined,
	): ShellCommand[][] {
		substitution.pipelines ??= substitution.read(cwd, input);
		return substitution.pipelines;
	}

	/**
	 * The pipelines `tokens`, read in `scope`, run from `start` with `input` upstream of them,
	 * nested ones after the top level. Neither `OLDPWD` nor the `pushd` stack is known at the start.
	 */
	#pipelines(
		tokens: readonly ShellScriptToken[],
		scope: ReadScope,
		start: string | undefined,
		input: ShellUpstream | undefined,
	): ShellCommand[][] {
		const { depth, subs } = scope;
		let dirs: ShellDirectories = { cwd: start, previous: undefined, stack: undefined };
		// A `( )` subshell's `cd` ends with the group: the directories are restored at its `)`.
		const subshellDirs: ShellDirectories[] = [];
		const pipelines: ShellCommand[][] = [];
		const nested: ShellCommand[][] = [];
		const segments = this.#segments(tokens);
		const inputs = compoundInputs(segments);
		// Segments whose redirections were read when the compound command they belong to opened.
		const opened = new Set<number>();
		const stages = new PipelineStages(input, compound => {
			const index = inputs.get(compound);
			if (index === undefined) return undefined;
			opened.add(index);
			// The shell opens the files before it runs the compound command, from where it starts.
			const command = this.#command(segments[index], dirs.cwd, subs, depth, nested, stages.upstream);
			if (command) pipelines.push([command]);
			return command;
		});
		let pipeline: ShellCommand[] = [];
		for (const [index, segment] of segments.entries()) {
			stages.keywords(segment.words, segment.quoted);
			const command = opened.has(index)
				? undefined
				: this.#command(segment, dirs.cwd, subs, depth, nested, stages.upstream);
			if (command) {
				pipeline.push(command);
				stages.add(command);
			}
			stages.operator(segment.operator);
			if (Object.hasOwn(SHELL_PIPES, segment.operator)) continue;
			if (pipeline.length > 0) {
				pipelines.push(pipeline);
				const only = pipeline.length === 1 ? pipeline[0] : undefined;
				if (only && Object.hasOwn(DIRECTORY_CHANGERS, only.argv[0])) {
					const changed = changeDirectory(only, dirs, this.home);
					dirs = { ...changed, cwd: this.directory(changed.cwd) };
				}
				pipeline = [];
			}
			if (segment.operator === "(") subshellDirs.push(dirs);
			else if (segment.operator === ")") dirs = subshellDirs.pop() ?? dirs;
		}
		// A substitution no command took (one in a heredoc delimiter) is read from where the script starts.
		return [...pipelines, ...nested, ...[...subs.values()].flatMap(sub => this.#substitute(sub, start, input))];
	}

	/**
	 * Parses what the upstream commands of `command`, a shell that reads its script from stdin, and
	 * its own heredocs and here-strings give it (see {@link #command}). The first such shell takes
	 * that input, so each text is parsed once: a shell further down reads the output of the one
	 * before it instead.
	 */
	#feedShell(command: ShellCommand, depth: number, nested: ShellCommand[][]): void {
		const { cwd } = command;
		// A stage a shell took from was taken with everything upstream of it.
		const stages: ShellUpstream[] = [];
		for (let stage = command.upstream; stage && !this.#fed.has(stage); stage = stage.before) {
			this.#fed.add(stage);
			stages.push(stage);
		}
		const sources: ShellCommand[] = [];
		for (const { commands, from, to } of stages.reverse()) {
			let taken = this.#taken.get(commands);
			if (!taken) {
				taken = [];
				this.#taken.set(commands, taken);
			}
			for (let i = untaken(taken, from); i < to; i = untaken(taken, i + 1)) {
				sources.push(commands[i]);
				taken[i] = i + 1;
			}
		}
		sources.push(command);
		for (const source of sources) {
			for (const text of this.#passed.get(source) ?? []) append(nested, this.parse(text, cwd, depth + 1));
			this.#passed.delete(source);
		}
	}

	/**
	 * Words and operators from `start`; a quoted word is never an operator. A heredoc body is read
	 * when its line ends and attached to the delimiter word. With `heredocs` off (`$(( ))`), and
	 * inside a `(( ))` command, `<<` is a shift. With `close`, reading stops at the `)` that closes a
	 * `$( )` opened just before `start`: `end` is its index, or the text's length when none comes.
	 * The `)` that ends a `case` pattern list is no parenthesis: it becomes a `;`, the patterns are
	 * marked as such, and the `|` between them and the optional `(` before them are dropped.
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
		// Whether the word starts with an unquoted `~`, which the shell expands.
		let bareTilde = false;
		// Whether the word has an unquoted `{`, which can start a brace list the shell expands.
		let bareBrace = false;
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
				if (word.startsWith("~") && !bareTilde) token.literalTilde = true;
				if (!bareBrace && word.includes("{")) token.literalBraces = true;
				if (delimiter) {
					token.heredoc = { body: "", expands: !quoted, subs: [] };
					pending.push({ delimiter: word, stripTabs: delimiter.stripTabs, doc: token.heredoc });
					delimiter = undefined;
					out.push(token);
				} else {
					caseWord();
					// A `case` pattern is no command; substitutions in it still run.
					if (cases.at(-1)?.next === "pattern") token.pattern = true;
					out.push(token);
				}
			}
			word = "";
			started = false;
			quoted = false;
			bareTilde = false;
			bareBrace = false;
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
			} else if (ch === "$" && text[i + 1] === '"') {
				// A `$"..."` string (translated by locale) is a double-quoted one.
				i++;
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
					bareTilde ||= !started && ch === "~";
					bareBrace ||= ch === "{";
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
					if (
						(operator === "(" && reading.next === "clause") ||
						(operator === "|" && reading.next === "pattern")
					) {
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
	 * as commands: a `<<` misread as a heredoc must not hide what follows it. Such searches read to
	 * the end of the text, so past {@link SHELL_SCRIPT_MAX_HEREDOC_SEARCH} characters of them no more
	 * are made and the script is truncated.
	 */
	#heredocBodies(text: string, start: number, pending: PendingHeredoc[], scope: ReadScope, close: boolean): number {
		if (this.#heredocSearch > SHELL_SCRIPT_MAX_HEREDOC_SEARCH) {
			pending.length = 0;
			return start;
		}
		const bodies: string[] = [];
		let pos = start;
		for (const { delimiter, stripTabs, doc } of pending) {
			const lines: string[] = [];
			let closed = false;
			while (pos < text.length && !closed) {
				// The physical lines joined into this line, and where each starts in it and in `text`.
				const pieces: string[] = [];
				const parts: { from: number; at: number }[] = [];
				let length = 0;
				// The backslashes the line ends in so far.
				let trailing = 0;
				let joined = true;
				while (joined) {
					const newline = text.indexOf("\n", pos);
					const end = newline < 0 ? text.length : newline;
					let run = 0;
					while (run < end - pos && text[end - 1 - run] === "\\") run++;
					trailing = run === end - pos ? trailing + run : run;
					joined = doc.expands && newline >= 0 && trailing % 2 === 1;
					if (joined) trailing--;
					const piece = text.slice(pos, joined ? end - 1 : end);
					parts.push({ from: length, at: pos });
					pieces.push(piece);
					length += piece.length;
					pos = newline < 0 ? text.length : newline + 1;
				}
				const line = pieces.join("");
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
				this.#heredocSearch += text.length - start;
				if (this.#heredocSearch > SHELL_SCRIPT_MAX_HEREDOC_SEARCH) this.truncated = true;
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
	 * tells whether the expansion is inside double quotes, where a `'` is read as
	 * {@link #bashQuotes} says.
	 */
	#parameter(text: string, start: number, scope: ReadScope, quoted: boolean): { end: number; keys: string[] } {
		const close = text[start - 1] === "[" ? "]" : "}";
		const keys: string[] = [];
		if (this.#braces >= SHELL_SCRIPT_MAX_DEPTH) {
			this.truncated = true;
			return { end: text.length, keys };
		}
		this.#braces++;
		const plainQuotes = quoted && !this.#bashQuotes;
		let brackets = 0;
		let end = text.length;
		let i = start;
		while (i < text.length) {
			const ch = text[i];
			if (ch === "\\") {
				i += 2;
			} else if (ch === "$" && text[i + 1] === "'") {
				const ansi = readAnsiCString(text, i + 2);
				if (quoted && (ansi.end >= text.length || QUOTE_SENSITIVE_RE.test(text.slice(i + 2, ansi.end)))) {
					this.#ambiguous = true;
				}
				// Read plainly, the `$` is a character and the `'` after it is read on its own.
				i = plainQuotes ? i + 1 : ansi.end + 1;
			} else if (ch === "'") {
				const quote = text.indexOf("'", i + 1);
				if (quoted && (quote < 0 || QUOTE_SENSITIVE_RE.test(text.slice(i + 1, quote)))) this.#ambiguous = true;
				i = plainQuotes ? i + 1 : quote < 0 ? text.length : quote + 1;
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
	 * Reads the substitution at `start` (`` ` ``, `$(`, `<(`, `>(`): the key that stands for it in a
	 * word, and the index after it. What it runs is parsed when the command it is in is built, from
	 * that command's directory and with its input (for `>( )`, its output). A `$( )` body is read as
	 * commands up to the `)` that closes it, so a `)` in quotes, in a comment or in a heredoc body
	 * does not end it. A backtick body loses the backslashes bash removes before parsing it
	 * (`quoted`: inside double quotes), so `` \` `` nests a substitution and `\"` is a quote again.
	 */
	#substitution(text: string, start: number, scope: ReadScope, quoted: boolean): { key: string; after: number } {
		const key = `\0${this.#count++}\0`;
		const depth = scope.depth + 1;
		if (text[start] === "`") {
			let end = start + 1;
			while (end < text.length && text[end] !== "`") end += text[end] === "\\" ? 2 : 1;
			const body = text.slice(start + 1, end).replace(quoted ? QUOTED_BACKTICK_ESCAPE_RE : BACKTICK_ESCAPE_RE, "$1");
			scope.subs.set(key, { read: (cwd, input) => this.parse(body, cwd, depth, input) });
			return { key, after: end + 1 };
		}
		if (depth > SHELL_SCRIPT_MAX_DEPTH) {
			// Only parsing the body finds its end, so the rest of the text is left unread.
			this.truncated = true;
			return { key, after: text.length };
		}
		const inner: ReadScope = { depth, subs: new Map() };
		// `$(( ))` is arithmetic, or a command substitution that starts with a subshell: it is read as
		// commands either way, but a `<<` in it is never a heredoc.
		const { tokens, end } = this.#tokens(text, start + 2, inner, !text.startsWith("$((", start), true);
		this.scripts.push(text.slice(start + 2, end));
		const read: Substitution["read"] = (cwd, input) => this.#pipelines(tokens, inner, cwd, input);
		scope.subs.set(key, text[start] === ">" ? { read, output: true } : { read });
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
			other: [],
			literalTildes: new Set(),
			literalBraces: new Set(),
			operator: ";",
		});
		let current = empty();
		// Words of the current segment written with a bare `~`, or an unquoted `{`, which the shell expands.
		let bareTildes = new Set<string>();
		let bareBraces = new Set<string>();
		let redirect: string | undefined;
		let continued = false;
		for (const token of tokens) {
			if (token.pattern) {
				current.other.push(token.text);
				continue;
			}
			if (continued && token.operator && token.text === "\n") continue;
			if (!token.operator && token.text.startsWith("~")) {
				markLiteral(current.literalTildes, bareTildes, token.text, token.literalTilde === true);
			}
			if (!token.operator && token.text.includes("{")) {
				markLiteral(current.literalBraces, bareBraces, token.text, token.literalBraces === true);
			}
			continued = token.operator && Object.hasOwn(SHELL_CONTINUATIONS, token.text);
			if (redirect !== undefined && !token.operator) {
				// `<>` opens its file for reading and writing, as the command's input.
				if (redirect === "<" || redirect === "<>") current.reads.push(token.text);
				if (
					Object.hasOwn(SHELL_WRITE_REDIRECTS, redirect) ||
					(redirect === ">&" && !(/^\d+$/.test(token.text) || token.text === "-"))
				) {
					current.writes.push(token.text);
				} else if (redirect === "<<<") {
					current.herestrings.push(token.text);
				} else if (token.heredoc) {
					current.heredocs.push(token.heredoc);
				} else if (redirect !== "<") {
					current.other.push(token.text);
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
				bareTildes = new Set();
				bareBraces = new Set();
				redirect = undefined;
			}
		}
		segments.push(current);
		return segments;
	}

	/**
	 * The simple command `segment` runs from `cwd` with `upstream` feeding it, or `undefined` when
	 * it runs none. Records what it passes on to a shell after it: the heredocs and here-strings it
	 * reads (`cat <<EOF | sh`), and what `echo`/`printf` prints. The substitutions in its words run
	 * from `cwd` too, even when it runs no command (`x=$(...)`), and read its input, or for `>( )`
	 * what it writes there. A shell that reads its script from stdin is fed it ({@link #feedShell}).
	 * The program, and a script it runs, run where a wrapper's directory option moves it (`env -C`).
	 */
	#command(
		segment: ShellScriptSegment,
		cwd: string | undefined,
		subs: Map<string, Substitution>,
		depth: number,
		nested: ShellCommand[][],
		upstream: ShellUpstream | undefined,
	): ShellCommand | undefined {
		const { words, writes, reads, herestrings, heredocs } = segment;
		const { argv, quoted, wrappers, chdirs, truncated } = unwrapShellCommand(words, segment.quoted);
		if (truncated) this.truncated = true;
		// `env` alone prints the environment.
		if (argv.length === 0 && wrappers.length > 0) {
			argv.push(wrappers.pop()!);
			quoted.push(false);
		}
		const program = argv[0] ?? "";
		if (argv.length > 0 && argv[0].includes("/")) argv[0] = path.posix.basename(argv[0]);
		let programCwd = cwd;
		for (const dir of chdirs) {
			programCwd = this.directory(
				resolveShellWordPath(segment.literalTildes.has(dir) ? `./${dir}` : dir, programCwd, this.home),
			);
		}
		const command: ShellCommand = {
			argv,
			quoted,
			program,
			wrappers,
			reads,
			subs: [],
			cwd: programCwd,
			shellCwd: cwd,
			upstream,
			literalTildes: segment.literalTildes,
			literalBraces: segment.literalBraces,
		};
		// A command that is only redirections still opens its files (`$(< file)`, `done < file`) and
		// passes its heredocs on.
		const runs =
			argv.length > 0 || writes.length > 0 || reads.length > 0 || herestrings.length > 0 || heredocs.length > 0;
		if (runs) {
			const texts = new Set([...heredocs.map(doc => doc.body), ...herestrings]);
			if (Object.hasOwn(SHELL_ECHOES, argv[0])) {
				texts.add(argv.slice(1).join(" "));
				for (const arg of argv.slice(1)) texts.add(arg);
			}
			this.#passed.set(command, [...texts]);
		}
		let output: ShellUpstream | undefined;
		// A `<>` target is both written and read, and its substitutions run once.
		const everything = new Set([
			...words,
			...writes,
			...reads,
			...herestrings,
			...heredocs.flatMap(doc => doc.subs),
			...segment.other,
		]);
		for (const word of everything) {
			for (const key of word.match(SUBSTITUTION_KEY_RE) ?? []) {
				const sub = subs.get(key);
				if (!sub) continue;
				const input = sub.output
					? (output ??= { commands: [command], from: 0, to: 1, before: upstream })
					: upstream;
				for (const pipeline of this.#substitute(sub, cwd, input)) append(command.subs, pipeline);
			}
		}
		if (!runs) return undefined;
		const script = argv.length > 0 ? inlineShellScript(argv) : undefined;
		if (script !== undefined) append(nested, this.parse(script, command.cwd, depth + 1));
		if (Object.hasOwn(SCRIPT_SHELLS, argv[0]) && shellScriptSource(argv) === "stdin") {
			this.#feedShell(command, depth, nested);
		}
		return command;
	}
}

/**
 * Parses a shell script into the simple commands it runs, for safety rules that must see through
 * shell syntax. Follows quotes (`$'...'` included), escapes, comments, `;`/`&&`/`||`/`|` chains
 * (continued on the next line after `|`, `&&` or `||`), `( )` groups and the other compound
 * commands (each one pipeline stage, fed by its own input redirections too; a function body's
 * commands are read where it is defined, after `f()` or `function f`), redirections,
 * heredocs (quote-aware, so a quoted `<<` opens none), `$( )`/backtick/`<( )`/`>( )` substitutions
 * (read as commands to the `)` that closes them, fed what the command they are in reads, or for
 * `>( )` writes, and also found inside `${ }` and unquoted heredoc bodies), `bash -c`/`sh -c`/`eval`
 * strings and scripts fed to a shell's stdin (up to {@link SHELL_SCRIPT_MAX_DEPTH} levels), `cd`
 * (`cd -` included), `pushd` and `popd` between commands (up to directories of
 * {@link SHELL_SCRIPT_MAX_DIRECTORY} characters), and wrappers (`sudo`, `env`, `timeout`, `xargs`,
 * `nohup`, `nice`, ..., with the directory `env -C` or `sudo -D` runs the command in, and the
 * command an `env -S` string holds). It is a tokenizer, not a shell: variables other than
 * `$HOME`/`$PWD`, aliases, calls to functions, and code run by other interpreters are not
 * followed, and after a `cd` to a directory it cannot resolve, relative paths are not resolved.
 */
export function parseShellScript(command: string, scope: ShellScriptScope): ParsedShellScript {
	const parser = new ShellScriptParser(scope.home);
	// A call's own `cwd` is a directory the script starts in, bounded like one it changes to.
	const pipelines = parser.parse(command, parser.directory(scope.cwd), 0);
	return { pipelines, scripts: parser.scripts, truncated: parser.truncated };
}
