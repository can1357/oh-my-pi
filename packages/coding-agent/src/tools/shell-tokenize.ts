// The top-level command parser in this file (`SHELL_MAX_DIRECTORY` through `parseShellCommands`) is
// derived from `src/intern/guard.py` of nace-ai/intern (https://github.com/nace-ai/intern, v0.30.1,
// commit e1bbd096f9), Copyright Nace AI, licensed under the Apache License, Version 2.0
// (http://www.apache.org/licenses/LICENSE-2.0). Modified for omp: rewritten in TypeScript, reading
// only top-level commands, with `cd` tracking and quote-aware heredocs. See
// packages/coding-agent/THIRD-PARTY-NOTICES.txt.
// It reads shell text best-effort for the opt-in guard rules and is not a security boundary: it
// reads into no nested script, and values it cannot know (most variables) stay unexpanded.

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
 * cannot find the structure they need.
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
 * The longest directory, in characters, {@link parseShellCommands} follows a command line into: the
 * one it starts in, or one a `cd`, `pushd`, `popd`, `env -C`, `sudo -D` or `tar -C` changes to. Past
 * it the directory is unknown, so relative paths after it are not resolved. Every later path is
 * resolved against the directory, so following longer ones would cost the directory's length per
 * path, and a chain of changes one step deeper each the square of the command's length.
 */
const SHELL_MAX_DIRECTORY = 1024;

/** `dir`, or `undefined` (unknown) when it is longer than {@link SHELL_MAX_DIRECTORY}. */
export function boundedDirectory(dir: string | undefined): string | undefined {
	return dir !== undefined && dir.length > SHELL_MAX_DIRECTORY ? undefined : dir;
}

/** One top-level simple command found by {@link parseShellCommands}, with its wrappers peeled off. */
export interface ShellCommand {
	/**
	 * Arguments after quote removal and wrapper unwrapping; `argv[0]` is the program's basename.
	 * Empty for a command that is only redirections (`< file`) and for one whose program the guard
	 * does not read (`env -S '...'`). A nested region in a word stands as {@link NESTED}, so a path
	 * with one is unknown.
	 */
	argv: string[];
	/** Targets of `<` and `<>` input redirections. */
	reads: string[];
	/** Whether an earlier stage of its pipeline, or an input redirection (`<`, `<>`, `<&`, a heredoc, a here-string), gives it input. */
	fedInput: boolean;
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

/** Where a command line runs: its starting directory and the home `~` and `$HOME` expand to. */
export interface ShellScope {
	cwd: string;
	home: string;
}

/** `$HOME` or `$PWD` (also in braces) at the start of a word. */
const LEADING_DIRECTORY_RE = /^\$(?:\{(HOME|PWD)\}|(HOME|PWD)\b)/;

/**
 * The absolute path a shell word names, resolved lexically against `cwd`. `~`, and `$HOME` or `$PWD`
 * at the start of the word, expand; any other expansion makes the path unknown (`undefined`), and so
 * does a relative path, or `$PWD`, when `cwd` is unknown. Expanding only a leading one keeps a word
 * of many (`$PWD$PWD...`) from growing past the word and one directory.
 */
export function resolveShellWordPath(word: string, cwd: string | undefined, home: string): string | undefined {
	let expanded = word;
	const leading = LEADING_DIRECTORY_RE.exec(word);
	if (leading) {
		const dir = (leading[1] ?? leading[2]) === "HOME" ? home : cwd;
		if (dir === undefined) return undefined;
		expanded = dir + word.slice(leading[0].length);
	}
	if (expanded === "~" || expanded.startsWith("~/")) expanded = home + expanded.slice(1);
	if (!expanded || expanded.includes("$") || expanded.includes(NESTED) || expanded.startsWith("~")) return undefined;
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

/**
 * An option's value given in the same word as the option (`--file=~/x`, `-C~/x`): the shell expands
 * no `~` there, so a leading one stays a name (`./~/x`).
 */
export function attachedValue(value: string): string {
	return value.startsWith("~") ? `./${value}` : value;
}

/** Appends `items` to `target`; unlike `push(...items)`, any number of them. */
export function append<T>(target: T[], items: Iterable<T>): void {
	for (const item of items) target.push(item);
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
 * What a nested region of a word stands as: a `$( )`, backtick or `$(( ))` substitution, a `<( )` or
 * `>( )` process substitution, an array literal's `( )`, or a `${ }` expansion other than `${HOME}`
 * and `${PWD}`. The guard does not read into it, and a NUL character, which no path holds, makes
 * the word's path unknown.
 */
const NESTED = "\0";

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
/** The characters an operator starts with, so ordinary characters skip the operator lookup. */
const OPERATOR_STARTS = "&|;<>()\n";
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
/** Redirections that give a command input. */
const SHELL_INPUT_REDIRECTS: Record<string, true> = {
	"<<<": true,
	"<<-": true,
	"<<": true,
	"<&": true,
	"<>": true,
	"<": true,
};
/** Operators after which a newline does not end the pipeline or list: it goes on on the next line. */
const SHELL_CONTINUATIONS: Record<string, true> = { "|": true, "|&": true, "&&": true, "||": true };

/** Reserved words after which the next word starts a command (a list, not a record: `then` would make it thenable). */
const COMMAND_PREFIXES: readonly string[] = ["!", "{", "if", "then", "else", "elif", "while", "until", "do", "time"];

/** Reserved words that open a compound command, each with the word that closes it. */
const COMPOUND_CLOSERS: Record<string, string> = {
	"{": "}",
	"[[": "]]",
	if: "fi",
	case: "esac",
	for: "done",
	select: "done",
	while: "done",
	until: "done",
};

/** An assignment word whose value is an array literal when a `(` follows (`files=(`, `a+=(`). */
const ARRAY_ASSIGNMENT_RE = /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=$/;

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

/** A heredoc whose body starts after the current line. */
interface PendingHeredoc {
	delimiter: string;
	/** Set for `<<-`, which strips each line's leading tabs. */
	stripTabs: boolean;
}

/**
 * Skips the bodies of `heredocs`, opened on the line that ends just before `start`, and returns where
 * the text goes on, or `undefined` when a delimiter line never comes: bash then ends the heredoc at
 * the end of the text. Inside a substitution (`substitution`), a line that starts with the delimiter
 * and has a `)` after it ends the heredoc too, as in bash, and the text goes on right after the
 * delimiter (`EOF)`).
 */
function skipHeredocBodies(
	text: string,
	start: number,
	heredocs: readonly PendingHeredoc[],
	substitution: boolean,
): number | undefined {
	let pos = start;
	for (const { delimiter, stripTabs } of heredocs) {
		for (;;) {
			if (pos >= text.length) return undefined;
			const newline = text.indexOf("\n", pos);
			let at = pos;
			if (stripTabs) while (text[at] === "\t") at++;
			const line = text.slice(at, newline < 0 ? text.length : newline);
			pos = newline < 0 ? text.length : newline + 1;
			if (line === delimiter) break;
			if (substitution && line.startsWith(delimiter) && line.includes(")", delimiter.length)) {
				return at + delimiter.length;
			}
		}
	}
	return pos;
}

/** The characters that end a heredoc delimiter word. */
const DELIMITER_END_RE = /[ \t\n;&|()<>]/;

/** Reads the delimiter word after `<<` or `<<-` from `start`: its text without quotes and escapes, and where it ends. */
function readDelimiter(text: string, start: number): { delimiter: string; end: number } {
	let i = start;
	while (text[i] === " " || text[i] === "\t") i++;
	let delimiter = "";
	while (i < text.length && !DELIMITER_END_RE.test(text[i])) {
		const ch = text[i];
		if (ch === "'" || ch === '"') {
			const close = text.indexOf(ch, i + 1);
			const end = close < 0 ? text.length : close;
			delimiter += text.slice(i + 1, end);
			i = end + 1;
		} else if (ch === "\\" && i + 1 < text.length) {
			delimiter += text[i + 1];
			i += 2;
		} else {
			delimiter += ch;
			i++;
		}
	}
	return { delimiter, end: i };
}

/** Commands inside a nested region, up to the `)` that closes them: a `$( )`, `<( )`, `>( )` or array literal body. */
interface CommandsFrame {
	kind: "commands";
	/** `(` not closed yet. */
	parens: number;
	/** `case` commands not closed yet: inside one, a pattern's `)` closes nothing. */
	cases: number;
	/** The plain word being read, {@link NESTED} once part of it is quoted or nested. */
	word: string;
	heredocs: PendingHeredoc[];
}

/** A part of a nested region {@link skipRegion} reads past; a `${ }` is `quoted` inside double quotes, where a `'` is a plain character. */
type RegionFrame =
	| CommandsFrame
	| { kind: "arithmetic"; parens: number }
	| { kind: "double" }
	| { kind: "parameter"; quoted: boolean }
	| { kind: "backtick" };

function commandsFrame(): CommandsFrame {
	return { kind: "commands", parens: 0, cases: 0, word: "", heredocs: [] };
}

/**
 * The nested region that starts at `i`, if one does: its first part and where that starts. `quoted`
 * inside double quotes, where `<( )` and `>( )` are plain text and a `${ }` reads `'` plainly.
 */
function regionStart(text: string, i: number, quoted: boolean): { frame: RegionFrame; from: number } | undefined {
	const ch = text[i];
	const next = text[i + 1];
	if (ch === "`") return { frame: { kind: "backtick" }, from: i + 1 };
	if (ch === "$" && next === "(") {
		if (text[i + 2] === "(") return { frame: { kind: "arithmetic", parens: 0 }, from: i + 3 };
		return { frame: commandsFrame(), from: i + 2 };
	}
	if (ch === "$" && next === "{") return { frame: { kind: "parameter", quoted }, from: i + 2 };
	if (!quoted && (ch === "<" || ch === ">") && next === "(") return { frame: commandsFrame(), from: i + 2 };
	return undefined;
}

/** Counts the plain word a commands frame just finished: `case` opens a case, `esac` closes one. */
function endRegionWord(frame: CommandsFrame): void {
	if (frame.word === "case") frame.cases++;
	else if (frame.word === "esac" && frame.cases > 0) frame.cases--;
	frame.word = "";
}

/**
 * Where a nested region ends, read from `start` past its opening as `first`: the index after its
 * closing character, or `undefined` when the guard cannot tell, as for an unclosed quote,
 * substitution or heredoc, or a `<<` in arithmetic, which bash reads as a heredoc when the text is
 * a command substitution after all. Nothing in it is read as commands: quotes, escapes, comments,
 * heredoc bodies, `case` patterns and inner regions are followed only to find the end. It keeps a
 * stack instead of recursing, so no depth of nesting runs out of stack.
 */
function skipRegion(text: string, start: number, first: RegionFrame): number | undefined {
	const frames: RegionFrame[] = [first];
	let i = start;
	// Opens the inner region at `i`, if one starts there; `quoted` inside double quotes.
	const open = (quoted: boolean): boolean => {
		const inner = regionStart(text, i, quoted);
		if (inner) {
			frames.push(inner.frame);
			i = inner.from;
		}
		return inner !== undefined;
	};
	// Skips the `'...'` or `$'...'` string at `i`; false when it never closes.
	const quote = (): boolean => {
		if (text[i] === "$") {
			i += 2;
			while (i < text.length && text[i] !== "'") i += text[i] === "\\" ? 2 : 1;
		} else {
			const close = text.indexOf("'", i + 1);
			i = close < 0 ? text.length : close;
		}
		i++;
		return i <= text.length;
	};
	while (i < text.length) {
		const frame = frames[frames.length - 1];
		const ch = text[i];
		const quoteStart = ch === "'" || (ch === "$" && text[i + 1] === "'");
		if (frame.kind === "backtick") {
			if (ch === "`") frames.pop();
			i += ch === "\\" ? 2 : 1;
		} else if (ch === "\\") {
			i += 2;
			if (frame.kind === "commands") frame.word = NESTED;
		} else if (frame.kind === "double") {
			if (ch === '"') {
				frames.pop();
				i++;
			} else if (!open(true)) {
				i++;
			}
		} else if (frame.kind === "parameter") {
			if (ch === "}") {
				frames.pop();
				i++;
			} else if (ch === '"') {
				frames.push({ kind: "double" });
				i++;
			} else if (quoteStart && !frame.quoted) {
				if (!quote()) return undefined;
			} else if (!open(frame.quoted)) {
				i++;
			}
		} else if (quoteStart) {
			if (!quote()) return undefined;
			if (frame.kind === "commands") frame.word = NESTED;
		} else if (ch === '"') {
			frames.push({ kind: "double" });
			i++;
			if (frame.kind === "commands") frame.word = NESTED;
		} else if (frame.kind === "arithmetic") {
			if (open(false)) continue;
			if (text.startsWith("<<", i)) return undefined;
			i++;
			if (ch === "(") {
				frame.parens++;
			} else if (ch === ")" && frame.parens > 0) {
				frame.parens--;
			} else if (ch === ")" && text[i] === ")") {
				frames.pop();
				i++;
			} else if (ch === ")") {
				// `$((cmd) ...)`: a command substitution whose body starts with a subshell, just closed.
				frames[frames.length - 1] = commandsFrame();
			}
		} else if (open(false)) {
			frame.word = NESTED;
		} else if (ch === "#" && frame.word === "") {
			const newline = text.indexOf("\n", i);
			i = newline < 0 ? text.length : newline;
		} else if (text.startsWith("<<<", i)) {
			endRegionWord(frame);
			i += 3;
		} else if (text.startsWith("<<", i)) {
			endRegionWord(frame);
			const stripTabs = text[i + 2] === "-";
			const read = readDelimiter(text, i + (stripTabs ? 3 : 2));
			frame.heredocs.push({ delimiter: read.delimiter, stripTabs });
			i = read.end;
		} else if (ch === "\n") {
			endRegionWord(frame);
			i++;
			if (frame.heredocs.length > 0) {
				const next = skipHeredocBodies(text, i, frame.heredocs, true);
				if (next === undefined) return undefined;
				frame.heredocs = [];
				i = next;
			}
		} else if (ch === "(" || ch === ")" || /[ \t;&|<>]/.test(ch)) {
			endRegionWord(frame);
			i++;
			if (frame.cases > 0) continue;
			if (ch === "(") frame.parens++;
			else if (ch === ")" && frame.parens > 0) frame.parens--;
			else if (ch === ")") frames.pop();
		} else {
			frame.word += ch;
			i++;
		}
		if (frames.length === 0) return i;
	}
	return undefined;
}

/** `${HOME}` and `${PWD}`, which a word keeps as written for {@link resolveShellWordPath} to expand. */
const KEPT_EXPANSION_RE = /\$\{(?:HOME|PWD)\}/y;

/**
 * The nested region a word has at `i`, if one starts there: what it stands for in the word
 * ({@link NESTED}, or `${HOME}` and `${PWD}` as written), and the index after it, `undefined` when
 * the guard cannot tell where it ends ({@link skipRegion}).
 */
function nestedRegion(
	text: string,
	i: number,
	quoted: boolean,
): { value: string; end: number | undefined } | undefined {
	KEPT_EXPANSION_RE.lastIndex = i;
	const kept = KEPT_EXPANSION_RE.exec(text)?.[0];
	if (kept !== undefined) return { value: kept, end: i + kept.length };
	const region = regionStart(text, i, quoted);
	return region && { value: NESTED, end: skipRegion(text, region.from, region.frame) };
}

/**
 * Reads a double-quoted string from `start`, just past its opening quote: its value, with each nested
 * region as {@link nestedRegion} gives it, and the index after its closing quote, `undefined` when a
 * nested region in it does not end.
 */
function readDouble(text: string, start: number): { value: string; after: number | undefined } {
	let value = "";
	let i = start;
	while (i < text.length && text[i] !== '"') {
		if (text[i] === "\\" && i + 1 < text.length) {
			const next = text[i + 1];
			if (next === "$" || next === "`" || next === '"' || next === "\\") value += next;
			else if (next !== "\n") value += text.slice(i, i + 2);
			i += 2;
			continue;
		}
		const region = nestedRegion(text, i, true);
		if (!region) {
			value += text[i++];
			continue;
		}
		value += region.value;
		if (region.end === undefined) return { value, after: undefined };
		i = region.end;
	}
	return { value, after: i + 1 };
}

/** A word or operator of a command line. */
interface LexedToken {
	text: string;
	operator: boolean;
	/** Whether any part of the word was quoted or escaped. */
	quoted: boolean;
	/** Set on a word whose leading `~` was quoted or escaped (`"~/x"`, `\~/x`), so the shell does not expand it. */
	literalTilde?: true;
	/** Set on a word with a `{`, none of them unquoted (`'{"a":1}'`, `\{a,b}`), so the shell brace-expands nothing in it. */
	literalBraces?: true;
}

/**
 * The words and operators of a command line; a quoted word is never an operator. Heredoc bodies are
 * skipped where their line ends, and nested regions are not read into ({@link NESTED}): a `( )`
 * right after an assignment word is an array literal, and `((` where a command starts is an
 * arithmetic command. When the guard cannot tell where a nested region ends, lexing stops in it,
 * and the rest of the line is not read.
 */
function lexCommandLine(text: string): LexedToken[] {
	const out: LexedToken[] = [];
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
	const flush = () => {
		if (started) {
			const token: LexedToken = { text: word, operator: false, quoted };
			if (word.startsWith("~") && !bareTilde) token.literalTilde = true;
			if (!bareBrace && word.includes("{")) token.literalBraces = true;
			if (delimiter) pending.push({ delimiter: word, stripTabs: delimiter.stripTabs });
			delimiter = undefined;
			out.push(token);
		}
		word = "";
		started = false;
		quoted = false;
		bareTilde = false;
		bareBrace = false;
	};
	// Whether a word here starts a command: after an operator other than a redirection, or a reserved word a command follows.
	const commandPosition = () => {
		const last = out.at(-1);
		if (!last) return true;
		if (last.operator) return !Object.hasOwn(SHELL_REDIRECTS, last.text);
		return !last.quoted && COMMAND_PREFIXES.includes(last.text);
	};
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		// A carriage return belongs to its word, except in a CRLF line end. A heredoc delimiter keeps
		// even that one, as in bash: a CRLF body ends at a line that ends in one too.
		if (ch === " " || ch === "\t" || (ch === "\r" && text[i + 1] === "\n")) {
			if (ch === "\r" && delimiter && started) word += ch;
			flush();
			i++;
			continue;
		}
		if (ch === "\\") {
			if (text[i + 1] !== "\n") {
				word += text.slice(i + 1, i + 2);
				started = true;
				quoted = true;
			}
			i += 2;
			continue;
		}
		if (ch === "$" && text[i + 1] === "'") {
			const ansi = readAnsiCString(text, i + 2);
			word += ansi.value;
			started = true;
			quoted = true;
			i = ansi.end + 1;
			continue;
		}
		if (ch === "$" && text[i + 1] === '"') {
			// A `$"..."` string (translated by locale) is a double-quoted one.
			i++;
			continue;
		}
		if (ch === "'") {
			let end = text.indexOf("'", i + 1);
			if (end < 0) end = text.length;
			word += text.slice(i + 1, end);
			started = true;
			quoted = true;
			i = end + 1;
			continue;
		}
		if (ch === '"') {
			const double = readDouble(text, i + 1);
			word += double.value;
			started = true;
			quoted = true;
			if (double.after === undefined) break;
			i = double.after;
			continue;
		}
		let region: { value: string; end: number | undefined } | undefined;
		if (!started && text.startsWith("((", i) && commandPosition()) {
			region = { value: NESTED, end: skipRegion(text, i + 2, { kind: "arithmetic", parens: 0 }) };
		} else if (ch === "(" && started && !quoted && ARRAY_ASSIGNMENT_RE.test(word)) {
			region = { value: NESTED, end: skipRegion(text, i + 1, commandsFrame()) };
		} else {
			region = nestedRegion(text, i, false);
		}
		if (region) {
			word += region.value;
			started = true;
			if (region.end === undefined) break;
			i = region.end;
			continue;
		}
		if (ch === "#" && !started) {
			const end = text.indexOf("\n", i);
			i = end < 0 ? text.length : end;
			continue;
		}
		const operator = OPERATOR_STARTS.includes(ch) ? SHELL_OPERATORS.find(op => text.startsWith(op, i)) : undefined;
		if (operator === undefined) {
			bareTilde ||= !started && ch === "~";
			bareBrace ||= ch === "{";
			word += ch;
			started = true;
			i++;
			continue;
		}
		// The file descriptor of `2>`.
		if ((operator[0] === "<" || operator[0] === ">") && started && !quoted && /^\d+$/.test(word)) {
			word = "";
			started = false;
		}
		flush();
		delimiter = undefined;
		out.push({ text: operator, operator: true, quoted: false });
		i += operator.length;
		if (operator === "<<" || operator === "<<-") delimiter = { stripTabs: operator === "<<-" };
		if (operator === "\n" && pending.length > 0) {
			const next = skipHeredocBodies(text, i, pending, false);
			pending.length = 0;
			if (next === undefined) break;
			i = next;
		}
	}
	flush();
	return out;
}

/** For a `case`: whether its subject, a clause's patterns, or a clause's commands come next. */
type CasePart = "subject" | "patterns" | "commands";

/** A compound command or `( )` group open in a {@link CompoundSkipper}. */
interface OpenCompound {
	closer: string;
	part?: CasePart;
	/** Set on a `(` where a function's body is due: the `()` after its name when a `)` follows at once. */
	header?: boolean;
}

/**
 * Follows a compound command (`{ }`, `if`, a loop, `case`, `[[ ]]`), a `( )` group, or a function
 * definition (`name()`, `function name`, `function name()`, then its body) to its end without
 * reading into it: only the reserved words and parentheses that open and close it are tracked, so
 * no command in it is checked.
 */
class CompoundSkipper {
	readonly #open: OpenCompound[] = [];
	/** `body` while a function's body is still to come, `inBody` once it opened. */
	#function: "body" | "inBody" | undefined;
	/** Whether the next word is a function's name, after `function`. */
	#name = false;
	#atCommand = true;
	#redirect = false;
	/** Whether it can change the shell's directory: a `{ }`, `if`, loop or `case`, not a subshell, `[[ ]]` or function definition. */
	changesShell = false;

	/** `functionBody`: it starts at the `(` after a function's name. */
	constructor(functionBody: boolean) {
		if (functionBody) this.#function = "body";
	}

	/** Whether the command has ended. */
	get done(): boolean {
		return this.#open.length === 0 && this.#function === undefined;
	}

	add(token: LexedToken): void {
		const top = this.#open.at(-1);
		const word = token.operator || token.quoted ? undefined : token.text;
		if (top?.header) {
			top.header = false;
			if (token.operator && token.text === ")") {
				this.#open.pop();
				this.#atCommand = true;
				return;
			}
			this.#function = "inBody";
		}
		if (top?.closer === "]]") {
			if (word === "]]") this.#close();
			return;
		}
		if (top?.part === "subject") {
			if (word === "in") top.part = "patterns";
			return;
		}
		if (top?.part === "patterns") {
			if (word === "esac") {
				this.#close();
			} else if (token.operator && token.text === ")") {
				top.part = "commands";
				this.#atCommand = true;
			}
			return;
		}
		if (token.operator) {
			const op = token.text;
			this.#redirect = Object.hasOwn(SHELL_REDIRECTS, op);
			this.#atCommand = !this.#redirect;
			if (op === "(") {
				this.#push(")");
			} else if (op === ")" && top?.closer === ")") {
				this.#close();
			} else if (top?.part === "commands" && (op === ";;" || op === ";&" || op === ";;&")) {
				top.part = "patterns";
			} else if (this.#function === "body" && this.#open.length === 0 && op !== "\n" && !this.#redirect) {
				// A function whose body does not follow its name: bash rejects it.
				this.#function = undefined;
			}
			return;
		}
		if (this.#redirect || this.#name) {
			this.#atCommand = this.#name;
			this.#redirect = false;
			this.#name = false;
			return;
		}
		// A reserved word counts only where a command starts.
		const reserved = this.#atCommand ? word : undefined;
		this.#atCommand = false;
		if (reserved !== undefined && Object.hasOwn(COMPOUND_CLOSERS, reserved)) {
			this.#push(COMPOUND_CLOSERS[reserved], reserved === "case" ? "subject" : undefined);
			this.#atCommand = COMMAND_PREFIXES.includes(reserved);
		} else if (reserved === "function") {
			this.#name = true;
			if (this.done) this.#function = "body";
		} else if (reserved !== undefined && reserved === top?.closer) {
			this.#close();
		} else if (reserved !== undefined && COMMAND_PREFIXES.includes(reserved)) {
			this.#atCommand = true;
		} else if (this.#function === "body" && this.#open.length === 0) {
			// A function whose body is no compound command: bash rejects it.
			this.#function = undefined;
		}
	}

	#push(closer: string, part?: CasePart): void {
		if (this.done) this.changesShell = closer !== ")" && closer !== "]]";
		const due = this.#function === "body" && this.#open.length === 0;
		if (due && closer === ")") {
			this.#open.push({ closer, header: true });
			return;
		}
		if (due) this.#function = "inBody";
		this.#open.push({ closer, part });
	}

	#close(): void {
		this.#open.pop();
		if (this.#open.length === 0 && this.#function === "inBody") this.#function = undefined;
	}
}

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
/** env's option whose value holds the command it runs, with the shortest abbreviation of its long form. */
const ENV_SPLIT_OPTION = { letter: "S", long: "--split-string", shortest: "--s" };

/**
 * The command a wrapper chain runs in `words` (`sudo env X=1 timeout 5 rm ...` runs `rm ...`), after
 * the shell's own assignments (`NAME=value`) and a `!`, with the directories a wrapper's directory
 * option ({@link SHELL_WRAPPER_CHDIRS}) moves it to, in order. A long option may be abbreviated, as
 * getopt allows (`--us root`); in a bundle of short options (`-nu root`), the first that takes a
 * value takes the rest of the word, or the next word when it ends the bundle. env and sudo also take
 * the variables they set. `undefined` when env runs the command an `env -S` string holds, which the
 * guard does not split.
 */
function unwrapShellCommand(words: readonly string[]): { argv: string[]; chdirs: string[] } | undefined {
	let i = 0;
	while (i < words.length && (SHELL_ASSIGNMENT.test(words[i]) || words[i] === "!")) i++;
	const chdirs: string[] = [];
	let wrapper: string | undefined;
	while (i < words.length) {
		const name = path.posix.basename(words[i]);
		const valued = Object.hasOwn(SHELL_WRAPPERS, name) ? SHELL_WRAPPERS[name] : undefined;
		if (!valued || (name === "command" && (words[i + 1] === "-v" || words[i + 1] === "-V"))) break;
		const chdir = Object.hasOwn(SHELL_WRAPPER_CHDIRS, name) ? SHELL_WRAPPER_CHDIRS[name] : undefined;
		const assigns = name === "env" || name === "sudo";
		wrapper = name;
		let positional = name === "timeout" ? 1 : 0; // timeout's duration
		let options = true;
		for (i++; i < words.length; i++) {
			const arg = words[i];
			if (options && arg === "--") {
				options = false;
			} else if (assigns && SHELL_ASSIGNMENT.test(arg)) {
				// A variable it sets.
			} else if (options && name === "env" && arg === "-") {
				// `env -`, the same as `env -i`.
			} else if (options && arg.startsWith("--")) {
				const eq = arg.indexOf("=");
				const flag = eq < 0 ? arg : arg.slice(0, eq);
				if (
					name === "env" &&
					flag.length >= ENV_SPLIT_OPTION.shortest.length &&
					ENV_SPLIT_OPTION.long.startsWith(flag)
				) {
					return undefined;
				}
				const dir = eq < 0 ? words[i + 1] : attachedValue(arg.slice(eq + 1));
				if (chdir && flag.length >= chdir.shortest.length && chdir.long.startsWith(flag) && dir !== undefined) {
					chdirs.push(dir);
				}
				if (eq < 0 && valued.some(option => option.startsWith(arg))) i++;
			} else if (options && arg.startsWith("-") && arg.length > 1) {
				let k = 1;
				while (k < arg.length && !valued.includes(`-${arg[k]}`)) k++;
				if (name === "env" && arg[k] === ENV_SPLIT_OPTION.letter) return undefined;
				const dir = k === arg.length - 1 ? words[i + 1] : attachedValue(arg.slice(k + 1));
				if (chdir && arg[k] === chdir.letter && dir !== undefined) chdirs.push(dir);
				if (k === arg.length - 1) i++;
			} else if (positional > 0) {
				positional--;
			} else {
				break;
			}
		}
	}
	const argv = words.slice(i);
	// `env` alone prints the environment.
	if (argv.length === 0 && wrapper !== undefined) argv.push(wrapper);
	return { argv, chdirs };
}

/** Directories `pushd` saved, the one `popd` returns to first; what is below them is unknown. */
interface DirectoryStack {
	readonly dir: string | undefined;
	readonly below: DirectoryStack | undefined;
}

/** Where the shell is as a command line runs, each `undefined` where the guard cannot tell. */
interface ShellDirectories {
	readonly cwd: string | undefined;
	/** `OLDPWD`, where `cd -` goes. */
	readonly previous: string | undefined;
	readonly stack: DirectoryStack | undefined;
}

const UNKNOWN_DIRECTORIES: ShellDirectories = { cwd: undefined, previous: undefined, stack: undefined };

/** Builtins that change the shell's directory, run on their own ({@link changeDirectory}). */
const DIRECTORY_CHANGERS: Record<string, true> = { cd: true, pushd: true, popd: true };
/** Builtins that run code the guard does not read in the shell itself, where it can change the directory. */
const SHELL_EVALUATORS: Record<string, true> = { eval: true, source: true, ".": true };

/**
 * Where the shell is after `command`, a {@link DIRECTORY_CHANGERS} builtin, runs from `dirs`,
 * taking it to succeed. `cd -` goes back to `OLDPWD`, `pushd dir` saves the directory it leaves,
 * `pushd` alone swaps it with the saved one, and `popd` returns to that one. A target the guard
 * cannot resolve (`cd "$dir"`), one longer than {@link SHELL_MAX_DIRECTORY}, a `popd` past what the
 * command line pushed, and the stack's other operations (`+N`, `-N`) leave the directory unknown,
 * so relative paths after them are not resolved; `-n` changes only the stack, which it leaves unknown.
 */
function changeDirectory(command: ShellCommand, dirs: ShellDirectories, home: string): ShellDirectories {
	const [name, ...rest] = command.argv;
	const operands = shellPositionalArgs(command.argv);
	const moveTo = (cwd: string | undefined, stack: DirectoryStack | undefined): ShellDirectories => ({
		cwd: boundedDirectory(cwd),
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

/** A top-level simple command's words and redirections, as read. */
class Segment {
	words: string[] = [];
	reads: string[] = [];
	/** Whether an input redirection gives it input. */
	input = false;
	/** Whether it has a word or a redirection. */
	used = false;
	literalTildes = new Set<string>();
	literalBraces = new Set<string>();
	/** Words written with a bare `~`, or an unquoted `{`, which the shell expands. */
	bareTildes = new Set<string>();
	bareBraces = new Set<string>();
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
 * The simple command `segment` runs from `cwd`, or `undefined` when it runs none that reads
 * anything; `piped` when an earlier pipeline stage feeds it. The program runs where a wrapper's
 * directory option moves it (`env -C`).
 */
function shellCommand(
	segment: Segment,
	cwd: string | undefined,
	home: string,
	piped: boolean,
): ShellCommand | undefined {
	const unwrapped = unwrapShellCommand(segment.words);
	const argv = unwrapped?.argv ?? [];
	if (argv.length === 0 && segment.reads.length === 0) return undefined;
	if (argv.length > 0 && argv[0].includes("/")) argv[0] = path.posix.basename(argv[0]);
	let programCwd = cwd;
	for (const dir of unwrapped?.chdirs ?? []) {
		const word = segment.literalTildes.has(dir) ? `./${dir}` : dir;
		programCwd = boundedDirectory(resolveShellWordPath(word, programCwd, home));
	}
	return {
		argv,
		reads: segment.reads,
		fedInput: piped || segment.input,
		cwd: programCwd,
		shellCwd: cwd,
		literalTildes: segment.literalTildes,
		literalBraces: segment.literalBraces,
	};
}

/**
 * The top-level simple commands of a command line, by pipeline, for the guard rules. Follows quotes
 * (`$'...'` and `$"..."` included), escapes, comments, `;`/`&&`/`||`/`|` chains (continued on the
 * next line after `|`, `&&` or `||`), redirections, heredocs (skipped as data), wrappers (`sudo`,
 * `env`, `timeout`, `xargs`, `nohup`, `nice`, ..., with the directory `env -C` or `sudo -D` runs the
 * command in), and `cd`, `cd -`, `pushd` and `popd` between commands. It reads into nothing nested:
 * a `( )` group, a compound command (`{ }`, `if`, a loop, `case`, `[[ ]]`, `(( ))`) or a function
 * definition is a pipeline stage with no command in it; a substitution, process substitution or
 * `${ }` stays in its word as {@link NESTED}; `bash -c`, `eval` and `env -S` strings and scripts
 * fed to a shell are arguments like any other. After a `{ }`, `if`, loop or `case`, or an `eval`
 * or `source`, each of which can change the directory, the directory is unknown. It is a
 * tokenizer, not a shell: variables other than a leading `$HOME` or `$PWD`, aliases, and calls to
 * functions are not followed.
 */
export function parseShellCommands(command: string, scope: ShellScope): ShellCommand[][] {
	const pipelines: ShellCommand[][] = [];
	let dirs: ShellDirectories = { cwd: boundedDirectory(scope.cwd), previous: undefined, stack: undefined };
	let segment = new Segment();
	let skipper: CompoundSkipper | undefined;
	let pipeline: ShellCommand[] = [];
	// Stages of the current pipeline, compound ones included; the last one's simple command, and
	// whether the last one was a compound command that can change the directory.
	let stages = 0;
	let last: ShellCommand | undefined;
	let changesShell = false;
	let redirect: string | undefined;
	// Whether a word here starts a command, where a reserved word opens a compound command: the
	// words before it can only be `!`, `time`, and the `-p` and `--` of `time`.
	let atCommand = true;
	let afterTime = false;
	let continued = false;
	const endStage = () => {
		if (skipper) {
			stages++;
			last = undefined;
			changesShell = skipper.changesShell;
		} else if (segment.used) {
			stages++;
			last = shellCommand(segment, dirs.cwd, scope.home, stages > 1);
			if (last) pipeline.push(last);
			changesShell = false;
		}
		skipper = undefined;
		segment = new Segment();
		redirect = undefined;
		atCommand = true;
		afterTime = false;
	};
	const endPipeline = () => {
		if (pipeline.length > 0) pipelines.push(pipeline);
		if (stages === 1 && last && Object.hasOwn(DIRECTORY_CHANGERS, last.argv[0])) {
			dirs = changeDirectory(last, dirs, scope.home);
		} else if (stages === 1 && (changesShell || (last && Object.hasOwn(SHELL_EVALUATORS, last.argv[0])))) {
			dirs = UNKNOWN_DIRECTORIES;
		}
		pipeline = [];
		stages = 0;
		last = undefined;
		changesShell = false;
	};
	for (const token of lexCommandLine(command)) {
		if (token.operator && token.text === "\n" && continued) continue;
		continued = token.operator && Object.hasOwn(SHELL_CONTINUATIONS, token.text);
		if (skipper && !skipper.done) {
			skipper.add(token);
			continue;
		}
		const op = token.operator ? token.text : undefined;
		// After a compound command come its redirections, up to the operator that ends it.
		if (skipper && (op === undefined || op === "(" || Object.hasOwn(SHELL_REDIRECTS, op))) continue;
		if (op === undefined) {
			segment.used = true;
			if (token.text.startsWith("~")) {
				markLiteral(segment.literalTildes, segment.bareTildes, token.text, token.literalTilde === true);
			}
			if (token.text.includes("{")) {
				markLiteral(segment.literalBraces, segment.bareBraces, token.text, token.literalBraces === true);
			}
			if (redirect !== undefined) {
				// `<>` opens its file for reading and writing, as the command's input.
				if (redirect === "<" || redirect === "<>") segment.reads.push(token.text);
				redirect = undefined;
				continue;
			}
			const reserved = token.quoted ? undefined : token.text;
			if (
				atCommand &&
				reserved !== undefined &&
				(Object.hasOwn(COMPOUND_CLOSERS, reserved) || reserved === "function")
			) {
				skipper = new CompoundSkipper(false);
				skipper.add(token);
				continue;
			}
			segment.words.push(token.text);
			atCommand = reserved === "!" || reserved === "time" || (afterTime && (reserved === "-p" || reserved === "--"));
			afterTime = reserved === "time" || (afterTime && reserved === "-p");
		} else if (Object.hasOwn(SHELL_REDIRECTS, op)) {
			segment.used = true;
			segment.input ||= Object.hasOwn(SHELL_INPUT_REDIRECTS, op);
			redirect = op;
			atCommand = false;
		} else if (op === "(") {
			// A `( )` group, or the `()` after a function's name: a lone word before it.
			skipper = new CompoundSkipper(!atCommand && segment.words.length === 1);
			skipper.add(token);
		} else {
			endStage();
			if (!Object.hasOwn(SHELL_PIPES, op)) endPipeline();
		}
	}
	endStage();
	endPipeline();
	return pipelines;
}
