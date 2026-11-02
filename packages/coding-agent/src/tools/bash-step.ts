/**
 * What one bash step does, for the bash interceptor: whether the dedicated tool a rule names can
 * perform that exact step. A rule's regex says which command a step runs; this module reads the
 * step's options, operands and redirections and answers whether the named tool can express them.
 *
 * It parses only a command's first pipeline (`a | b | c`, up to the first `;`, `&&`, `||`, `&` or
 * newline), with quoting, escapes, command substitution and redirections. Anything it cannot model
 * (a leading subshell, group or compound keyword, unbalanced quotes) leaves the rule's decision as
 * it is. It never adds a refusal: it only withdraws one the named tool cannot carry out.
 */

/** One shell word of a simple command. */
interface Word {
	/** Source text, quotes and escapes kept. */
	raw: string;
	/** Text after quote and escape removal; substitutions stay as written. */
	value: string;
	/** Has an unquoted `*`, `?` or `[`, so the shell expands it to file names. */
	glob: boolean;
	/** Has a command or process substitution (`$(…)`, backticks, `<(…)`, `>(…)`). */
	substitution: boolean;
	/** Expands a parameter only the running shell knows (`$?`, `$!`, `$$`, `$RANDOM`). */
	runtime: boolean;
}

/** Parameters whose value exists only inside the running shell, never in the agent's context. */
const RUNTIME_PARAMETER =
	/^\$\{?[#!]?(?:[?!$#@*0-9-]|(?:RANDOM|SECONDS|EPOCHSECONDS|EPOCHREALTIME|BASHPID|PPID|LINENO)(?![A-Za-z0-9_]))/u;
/** A `$name` or special-parameter expansion without braces. */
const PLAIN_PARAMETER = /^\$(?:[?!$#@*0-9-]|[A-Za-z_][A-Za-z0-9_]*)/u;

/** One redirection of a simple command. */
interface Redirect {
	/** The explicit file descriptor (`2` in `2>f`), `&` for `&>`, or "" when omitted. */
	fd: string;
	op: string;
	target: Word | undefined;
}

/** One simple command: its words (leading `NAME=value` assignments removed) and redirections. */
interface SimpleCommand {
	words: Word[];
	redirects: Redirect[];
}

const COMPOUND_KEYWORDS: Record<string, true> = {
	"!": true,
	"[[": true,
	case: true,
	coproc: true,
	for: true,
	function: true,
	if: true,
	select: true,
	time: true,
	until: true,
	while: true,
	"{": true,
};

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/u;

/** Consumes a `$(…)`, `${…}` or backtick run starting at `start`; returns the index after it, or -1. */
function skipSubstitution(text: string, start: number): number {
	if (text[start] === "`") {
		for (let i = start + 1; i < text.length; i++) {
			if (text[i] === "\\") i++;
			else if (text[i] === "`") return i + 1;
		}
		return -1;
	}
	const open = text[start + 1] === "{" ? "{" : "(";
	const close = open === "{" ? "}" : ")";
	let depth = 0;
	let inSingle = false;
	let inDouble = false;
	for (let i = start + 1; i < text.length; i++) {
		const ch = text[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (inDouble) {
			if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "'") inSingle = true;
		else if (ch === '"') inDouble = true;
		else if (ch === open) depth++;
		else if (ch === close && --depth === 0) return i + 1;
	}
	return -1;
}

const WORD_END = /[ \t\n;&|<>()]/u;

/** Reads one word at `start`; returns it and the index after it, or undefined on unbalanced syntax. */
function readWord(text: string, start: number): { word: Word; end: number } | undefined {
	let value = "";
	let glob = false;
	let substitution = false;
	let runtime = false;
	let i = start;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "'") {
			const close = text.indexOf("'", i + 1);
			if (close < 0) return undefined;
			value += text.slice(i + 1, close);
			i = close + 1;
			continue;
		}
		if (ch === '"') {
			i++;
			for (;;) {
				if (i >= text.length) return undefined;
				const c = text[i];
				if (c === '"') break;
				if (c === "\\" && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) {
					value += text[i + 1];
					i += 2;
					continue;
				}
				if (c === "`" || (c === "$" && (text[i + 1] === "(" || text[i + 1] === "{"))) {
					const end = skipSubstitution(text, i);
					if (end < 0) return undefined;
					if (c === "`" || (text[i + 1] === "(" && text[i + 2] !== "(")) substitution = true;
					else if (RUNTIME_PARAMETER.test(text.slice(i, end))) runtime = true;
					value += text.slice(i, end);
					i = end;
					continue;
				}
				if (c === "$" && RUNTIME_PARAMETER.test(text.slice(i, i + 16))) runtime = true;
				value += c;
				i++;
			}
			i++;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= text.length) return undefined;
			// A backslash-newline joins lines; it contributes nothing to the word.
			if (text[i + 1] !== "\n") value += text[i + 1];
			i += 2;
			continue;
		}
		if (ch === "`" || (ch === "$" && (text[i + 1] === "(" || text[i + 1] === "{"))) {
			const end = skipSubstitution(text, i);
			if (end < 0) return undefined;
			// `$((…))` is arithmetic, not a command.
			if (ch === "`" || (text[i + 1] === "(" && text[i + 2] !== "(")) substitution = true;
			else if (RUNTIME_PARAMETER.test(text.slice(i, end))) runtime = true;
			value += text.slice(i, end);
			i = end;
			continue;
		}
		const parameter = ch === "$" ? PLAIN_PARAMETER.exec(text.slice(i, i + 256)) : null;
		if (parameter) {
			// `$?` and `$*` are parameters, not file-name globs.
			if (RUNTIME_PARAMETER.test(parameter[0])) runtime = true;
			value += parameter[0];
			i += parameter[0].length;
			continue;
		}
		if ((ch === "<" || ch === ">") && text[i + 1] === "(" && i === start) {
			const end = skipSubstitution(text, i);
			if (end < 0) return undefined;
			substitution = true;
			value += text.slice(i, end);
			i = end;
			continue;
		}
		if (WORD_END.test(ch)) break;
		if (ch === "*" || ch === "?" || ch === "[") glob = true;
		value += ch;
		i++;
	}
	return { word: { raw: text.slice(start, i), value, glob, substitution, runtime }, end: i };
}

/** A redirection operator with its optional descriptor, matched in place (sticky) so long commands stay linear. */
const REDIRECT = /(\d*|&)(>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)/uy;

/**
 * Parses the first pipeline of `text`. Returns undefined when the first command is a construct
 * this parser does not model, or when quoting is unbalanced.
 */
function parseLeadingPipeline(text: string): SimpleCommand[] | undefined {
	const pipeline: SimpleCommand[] = [];
	let current: SimpleCommand = { words: [], redirects: [] };
	let sawCommandWord = false;
	let i = 0;
	const finish = () => {
		pipeline.push(current);
		current = { words: [], redirects: [] };
		sawCommandWord = false;
	};
	while (i < text.length) {
		const ch = text[i];
		if (ch === " " || ch === "\t") {
			i++;
			continue;
		}
		if (ch === "\\" && text[i + 1] === "\n") {
			i += 2;
			continue;
		}
		if (ch === "\n" || ch === ";" || ch === ")") break;
		if (ch === "#" && current.words.length === 0 && current.redirects.length === 0) break;
		if (ch === "&") {
			if (text[i + 1] !== ">") break;
		}
		if (ch === "|") {
			if (text[i + 1] === "|") break;
			i += text[i + 1] === "&" ? 2 : 1;
			finish();
			// A pipe continues across blank and comment-only lines.
			for (;;) {
				while (i < text.length && /[ \t\n]/u.test(text[i])) i++;
				if (text[i] !== "#") break;
				const newline = text.indexOf("\n", i);
				i = newline < 0 ? text.length : newline + 1;
			}
			continue;
		}
		if (ch === "(") {
			if (pipeline.length === 0 && current.words.length === 0) return undefined;
			break;
		}
		REDIRECT.lastIndex = i;
		const redirect = REDIRECT.exec(text);
		if (redirect && !(redirect[2] === ">" || redirect[2] === "<" ? text[i + redirect[0].length] === "(" : false)) {
			i += redirect[0].length;
			while (text[i] === " " || text[i] === "\t") i++;
			const target = i < text.length && !WORD_END.test(text[i]) ? readWord(text, i) : undefined;
			if (target) i = target.end;
			current.redirects.push({ fd: redirect[1], op: redirect[2], target: target?.word });
			continue;
		}
		const read = readWord(text, i);
		if (!read) return undefined;
		if (read.end === i) break;
		i = read.end;
		if (!sawCommandWord && ASSIGNMENT.test(read.word.raw)) continue;
		if (!sawCommandWord && pipeline.length === 0 && COMPOUND_KEYWORDS[read.word.value]) return undefined;
		sawCommandWord = true;
		current.words.push(read.word);
	}
	if (current.words.length > 0 || current.redirects.length > 0 || pipeline.length > 0) finish();
	if (pipeline[0] === undefined || pipeline[0].words.length === 0) return undefined;
	return pipeline;
}

/** Files whose writes still reach the bash result the agent reads. */
const AGENT_VISIBLE_SINKS: Record<string, true> = { "/dev/stdout": true, "/dev/stderr": true, "/dev/tty": true };

/** How a command's stdout leaves it: to the agent (or the next stage), or to a file. */
function stdoutGoesToFile(command: SimpleCommand): boolean {
	let toFile = false;
	for (const { fd, op, target } of command.redirects) {
		if (fd !== "" && fd !== "1" && fd !== "&") continue;
		if (op === ">&") {
			// `>&2`/`>&-` duplicate or close a descriptor; `>&name` sends stdout and stderr to a file.
			const value = target?.value ?? "";
			toFile = !/^(?:\d+|-)$/u.test(value);
			continue;
		}
		if (op === ">" || op === ">>" || op === ">|") toFile = !AGENT_VISIBLE_SINKS[target?.value ?? ""];
	}
	return toFile;
}

/** Commands that consume a pipeline's output to act on it rather than show it. */
const STREAM_CONSUMERS: Record<string, true> = {
	bash: true,
	dash: true,
	ksh: true,
	parallel: true,
	sh: true,
	until: true,
	while: true,
	xargs: true,
	zsh: true,
};

function commandName(command: SimpleCommand): string {
	const first = command.words[0]?.value ?? "";
	return first.slice(first.lastIndexOf("/") + 1);
}

/**
 * Whether what the pipeline's first command prints reaches the agent. It does not when the
 * command or the pipeline's last stage writes stdout to a file, when a later stage hands the
 * stream to a command (`xargs`, `while read`, a shell), or when `tee` copies it to a file.
 */
function outputReachesAgent(pipeline: SimpleCommand[]): boolean {
	if (stdoutGoesToFile(pipeline[0]) || stdoutGoesToFile(pipeline[pipeline.length - 1])) return false;
	for (const stage of pipeline.slice(1)) {
		const name = commandName(stage);
		if (STREAM_CONSUMERS[name]) return false;
		if (
			name === "tee" &&
			stage.words.slice(1).some(word => !word.value.startsWith("-") && !AGENT_VISIBLE_SINKS[word.value])
		) {
			return false;
		}
	}
	return true;
}

/** Long option kinds: a plain flag, a flag with an optional `=value`, or a valued option and the values the tool can express. */
type LongOption = "flag" | "optional" | ((value: string) => boolean);

/** The options of one command that a dedicated tool can express. */
interface OptionSpec {
	/** Short flags without an argument. */
	flags: string;
	/** Short options that take an argument, with the arguments the tool can express. */
	valued: Record<string, (value: string) => boolean>;
	long: Record<string, LongOption>;
	/** `-NUM` (a bare count, as in `head -5` or `grep -3`) is expressible. */
	numeric?: boolean;
	/** Options stop at the first operand (perl-style) instead of anywhere (GNU-style). */
	stopAtOperand?: boolean;
}

const ANY = (): boolean => true;
const COUNT = (value: string): boolean => /^\d+$/u.test(value);

/** Splits `words` into options and operands; returns undefined when an option is outside `spec`. */
function expressibleOperands(words: Word[], spec: OptionSpec): Word[] | undefined {
	const operands: Word[] = [];
	let optionsEnded = false;
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		const text = word.value;
		if (optionsEnded || text === "-" || !text.startsWith("-") || word.substitution) {
			operands.push(word);
			if (spec.stopAtOperand) optionsEnded = true;
			continue;
		}
		if (text === "--") {
			optionsEnded = true;
			continue;
		}
		if (text.startsWith("--")) {
			const eq = text.indexOf("=");
			const name = text.slice(2, eq < 0 ? undefined : eq);
			const kind = spec.long[name];
			if (kind === undefined) return undefined;
			if (kind === "flag") {
				if (eq >= 0) return undefined;
				continue;
			}
			if (kind === "optional") continue;
			let value: string;
			if (eq >= 0) value = text.slice(eq + 1);
			else {
				const next = words[++i];
				if (!next) return undefined;
				value = next.value;
			}
			if (!kind(value)) return undefined;
			continue;
		}
		if (spec.numeric && /^-\d+$/u.test(text)) continue;
		for (let j = 1; j < text.length; j++) {
			const letter = text[j];
			const valued = spec.valued[letter];
			if (valued) {
				let value = text.slice(j + 1);
				if (value === "") {
					const next = words[++i];
					if (!next) return undefined;
					value = next.value;
				}
				if (!valued(value)) return undefined;
				break;
			}
			if (!spec.flags.includes(letter)) return undefined;
		}
	}
	return operands;
}

// ── read: cat, head, tail, less, more ────────────────────────────────────────

const READ_SPECS: Record<string, OptionSpec> = {
	cat: { flags: "nu", valued: {}, long: { number: "flag" } },
	head: {
		flags: "qv",
		valued: { n: COUNT },
		long: { lines: COUNT, quiet: "flag", silent: "flag", verbose: "flag" },
		numeric: true,
	},
	tail: {
		flags: "qv",
		valued: { n: value => /^\+?\d+$/u.test(value) },
		long: { lines: value => /^\+?\d+$/u.test(value), quiet: "flag", silent: "flag", verbose: "flag" },
		numeric: true,
	},
	less: { flags: "", valued: {}, long: {} },
	more: { flags: "", valued: {}, long: {} },
};

/**
 * The read tool reads named files by line: it cannot read bytes (`head -c`), follow a growing file
 * (`tail -f`), drop a file's last lines (`head -n -5`), read stdin, or expand a file-name glob.
 */
function readCanPerform(name: string, command: SimpleCommand): boolean {
	const spec = READ_SPECS[name];
	if (!spec) return true;
	const operands = expressibleOperands(command.words.slice(1), spec);
	if (!operands) return false;
	if (operands.some(word => word.value === "-" || word.glob || word.substitution)) return false;
	const stdinRedirects = command.redirects.filter(r => (r.fd === "" || r.fd === "0") && r.op.startsWith("<"));
	if (stdinRedirects.some(r => r.op !== "<")) return false;
	return operands.length > 0 || stdinRedirects.length > 0;
}

// ── grep: grep, egrep, fgrep, rg, ag, ack ────────────────────────────────────

const GNU_GREP: OptionSpec = {
	flags: "EFGPiywxnHhrRsIlqT",
	valued: { A: COUNT, B: COUNT, C: COUNT, m: COUNT, e: ANY },
	long: {
		"after-context": COUNT,
		"basic-regexp": "flag",
		"before-context": COUNT,
		"binary-files": value => value === "without-match",
		color: "optional",
		colour: "optional",
		context: COUNT,
		"dereference-recursive": "flag",
		exclude: ANY,
		"exclude-dir": ANY,
		"extended-regexp": "flag",
		"files-with-matches": "flag",
		"fixed-strings": "flag",
		"ignore-case": "flag",
		include: ANY,
		"initial-tab": "flag",
		"line-number": "flag",
		"line-regexp": "flag",
		"max-count": COUNT,
		"no-filename": "flag",
		"no-ignore-case": "flag",
		"no-messages": "flag",
		"perl-regexp": "flag",
		quiet: "flag",
		recursive: "flag",
		regexp: ANY,
		silent: "flag",
		"with-filename": "flag",
		"word-regexp": "flag",
	},
	numeric: true,
};

const RIPGREP: OptionSpec = {
	flags: "isSFwxnNHIlUPqu.",
	valued: { A: COUNT, B: COUNT, C: COUNT, e: ANY, g: ANY, m: COUNT, t: ANY, T: ANY, M: COUNT, j: COUNT },
	long: {
		"after-context": COUNT,
		"before-context": COUNT,
		"case-sensitive": "flag",
		color: "optional",
		colors: ANY,
		column: "flag",
		context: COUNT,
		engine: ANY,
		"files-with-matches": "flag",
		"fixed-strings": "flag",
		glob: ANY,
		heading: "flag",
		hidden: "flag",
		"ignore-case": "flag",
		"line-number": "flag",
		"line-regexp": "flag",
		"max-columns": COUNT,
		"max-count": COUNT,
		multiline: "flag",
		"multiline-dotall": "flag",
		"no-filename": "flag",
		"no-heading": "flag",
		"no-ignore": "flag",
		"no-ignore-dot": "flag",
		"no-ignore-exclude": "flag",
		"no-ignore-files": "flag",
		"no-ignore-global": "flag",
		"no-ignore-parent": "flag",
		"no-ignore-vcs": "flag",
		"no-line-number": "flag",
		"no-messages": "flag",
		pcre2: "flag",
		quiet: "flag",
		regexp: ANY,
		"smart-case": "flag",
		sort: ANY,
		sortr: ANY,
		threads: COUNT,
		trim: "flag",
		type: ANY,
		"type-add": ANY,
		"type-not": ANY,
		unrestricted: "flag",
		"with-filename": "flag",
		"word-regexp": "flag",
	},
};

const SILVER_SEARCHER: OptionSpec = {
	flags: "isSQwlUuH",
	valued: { A: COUNT, B: COUNT, C: COUNT },
	long: {
		"after-context": COUNT,
		"before-context": COUNT,
		"case-sensitive": "flag",
		context: COUNT,
		"files-with-matches": "flag",
		hidden: "flag",
		ignore: ANY,
		"ignore-case": "flag",
		literal: "flag",
		nocolor: "flag",
		nogroup: "flag",
		noheading: "flag",
		numbers: "flag",
		"skip-vcs-ignores": "flag",
		"smart-case": "flag",
		unrestricted: "flag",
		"word-regexp": "flag",
	},
};

const ACK: OptionSpec = {
	flags: "iIsQwlhH",
	valued: { A: COUNT, B: COUNT, C: COUNT },
	long: {
		"after-context": COUNT,
		"before-context": COUNT,
		context: COUNT,
		"files-with-matches": "flag",
		"ignore-case": "flag",
		literal: "flag",
		nocolor: "flag",
		nogroup: "flag",
		noheading: "flag",
		"no-filename": "flag",
		"smart-case": "flag",
		type: ANY,
		"with-filename": "flag",
		"word-regexp": "flag",
	},
};

const GREP_SPECS: Record<string, OptionSpec> = {
	grep: GNU_GREP,
	egrep: GNU_GREP,
	fgrep: GNU_GREP,
	rg: RIPGREP,
	ripgrep: RIPGREP,
	ag: SILVER_SEARCHER,
	ack: ACK,
};

/**
 * The grep tool searches files and directories for one regular expression and shows matching
 * lines with their numbers. It cannot print only the matched text (`-o`), count (`-c`), invert
 * (`-v`), list files without matches (`-L`), print byte offsets, read patterns from a file, or
 * search stdin, a heredoc or a here-string.
 */
function grepCanPerform(name: string, command: SimpleCommand): boolean {
	const spec = GREP_SPECS[name];
	if (!spec) return true;
	const options = command.words.slice(1);
	const operands = expressibleOperands(options, spec);
	if (!operands) return false;
	const stdinRedirects = command.redirects.filter(r => (r.fd === "" || r.fd === "0") && r.op.startsWith("<"));
	if (stdinRedirects.some(r => r.op !== "<")) return false;
	if (operands.some(word => word.value === "-" || word.substitution)) return false;
	if (spec !== GNU_GREP) return true;
	// GNU grep without a file operand reads stdin unless it recurses.
	const patternGiven = options.some(word => /^(?:-[^-]*e|--regexp)/u.test(word.value));
	const files = patternGiven ? operands.length : operands.length - 1;
	const recursive = options.some(word => /^(?:-[^-]*[rR]|--(?:dereference-)?recursive$)/u.test(word.value));
	return files > 0 || recursive || stdinRedirects.length > 0;
}

// ── glob: find, fd ───────────────────────────────────────────────────────────

const FIND_FILE_TYPES = /^[fd](?:,[fd])*$/u;
/** `find` primaries the glob tool expresses through its path patterns, each with its argument count. */
const FIND_PRIMARIES: Record<string, number> = { "-name": 1, "-path": 1, "-wholename": 1, "-type": 1, "-print": 0 };
const FIND_OPERATORS: Record<string, true> = {
	"(": true,
	")": true,
	"-o": true,
	"-or": true,
	"-a": true,
	"-and": true,
};
/** A name or path test for a directory the glob tool never descends into (`.git`, `node_modules`). */
const PRUNED_BY_GLOB = /^(?:\.\/|\*\/)?(?:\.git|node_modules)(?:\/\*?)?$|^\*\/(?:\.git|node_modules)\/\*$/u;

/**
 * The glob tool matches path patterns under one or more roots, files and directories alike, and
 * never descends into `.git` or `node_modules`. It has no depth limit, case-insensitive match,
 * size, time, permission or symlink-type test, negation or pruning of other paths, or action
 * (`-exec`, `-delete`, `-printf`).
 */
function findCanPerform(command: SimpleCommand): boolean {
	const words = command.words.slice(1);
	let i = 0;
	while (i < words.length && (words[i].value === "-P" || words[i].value === "-H")) i++;
	for (; i < words.length; i++) {
		const value = words[i].value;
		if (value.startsWith("-") || value === "!" || FIND_OPERATORS[value]) break;
		if (words[i].substitution) return false;
	}
	let negated = false;
	let prunedTest = false;
	for (; i < words.length; i++) {
		const value = words[i].value;
		if (value === "!" || value === "-not") {
			negated = true;
			continue;
		}
		if (FIND_OPERATORS[value]) continue;
		if (value === "-prune") {
			// `-path ./node_modules -prune` restates the glob tool's own pruning.
			if (!prunedTest) return false;
			prunedTest = false;
			continue;
		}
		const arity = FIND_PRIMARIES[value];
		if (arity === undefined) return false;
		const arg = arity === 1 ? words[++i] : undefined;
		if (arity === 1 && (!arg || arg.substitution)) return false;
		if (value === "-type" && !FIND_FILE_TYPES.test(arg?.value ?? "")) return false;
		prunedTest = value !== "-type" && value !== "-print" && PRUNED_BY_GLOB.test(arg?.value ?? "");
		if (negated && !prunedTest) return false;
		// The glob tool never lists `.git`, so a search for it is not expressible unless it is pruned.
		if (!negated && prunedTest && arg?.value.includes(".git") && words[i + 1]?.value !== "-prune") return false;
		negated = false;
	}
	return true;
}

const FD: OptionSpec = {
	flags: "HIusSga1",
	valued: { t: value => /^(?:f|d|file|dir|directory)$/u.test(value), e: ANY, j: COUNT, c: ANY },
	long: {
		"absolute-path": "flag",
		"case-sensitive": "flag",
		color: ANY,
		extension: ANY,
		glob: "flag",
		hidden: "flag",
		"max-results": COUNT,
		"no-ignore": "flag",
		"no-ignore-vcs": "flag",
		threads: COUNT,
		type: value => /^(?:f|d|file|dir|directory)$/u.test(value),
		unrestricted: "flag",
	},
};

/**
 * `fd` matches a regular expression against names, case-insensitively for an all-lowercase pattern.
 * The glob tool can express a literal or `--glob` pattern under fd's case rule only.
 */
function fdCanPerform(command: SimpleCommand): boolean {
	const options = command.words.slice(1);
	const operands = expressibleOperands(options, FD);
	if (!operands) return false;
	const pattern = operands[0]?.value;
	if (pattern === undefined || pattern === "") return true;
	const globMode = options.some(word => /^(?:-[^-]*g|--glob$)/u.test(word.value));
	if (!globMode && !/^[A-Za-z0-9_-]+$/u.test(pattern)) return false;
	const caseSensitive = options.some(word => /^(?:-[^-]*s|--case-sensitive$)/u.test(word.value));
	return caseSensitive || /[A-Z]/u.test(pattern);
}

// ── write: echo, printf, cat ─────────────────────────────────────────────────

/**
 * The write tool writes text the agent supplies; to append, the interceptor's write rule points at
 * `edit`. It cannot copy or concatenate files (`cat a b > f`), capture a command's output
 * (`echo "$(date)" > f`), or know what only the running shell knows (`echo "exit=$?" >> log`).
 */
function writeCanPerform(name: string, command: SimpleCommand, availableTools: readonly string[]): boolean {
	if (name !== "echo" && name !== "printf" && name !== "cat") return true;
	const stdout = command.redirects.filter(r => r.fd === "" || r.fd === "1" || r.fd === "&");
	if (stdout.some(r => r.op === ">>") && !availableTools.includes("edit")) return false;
	if (command.words.some(word => word.substitution || word.runtime)) return false;
	if (name !== "cat") return true;
	if (command.redirects.some(r => (r.fd === "" || r.fd === "0") && r.op === "<")) return false;
	return command.words.slice(1).every(word => word.value.startsWith("-") && word.value !== "-");
}

// ── edit: sed -i, perl -i, awk -i inplace ────────────────────────────────────

/** Perl switches that take the rest of their word as an argument (`-Ilib`, `-Mstrict`). */
const PERL_REST_SWITCHES = "CdDFIlmMVx";

/** Whether perl's command line asks for in-place editing (`-i`, `-pi.bak`, `-0777 -i -pe`). */
function perlEditsInPlace(words: Word[]): boolean {
	for (let i = 0; i < words.length; i++) {
		const text = words[i].value;
		if (text === "--" || !text.startsWith("-") || text === "-") return false;
		for (let j = 1; j < text.length; j++) {
			const letter = text[j];
			if (letter === "i") return true;
			if (letter === "e" || letter === "E") {
				if (j === text.length - 1) i++;
				break;
			}
			if (letter === "0") {
				while (/[0-9a-fA-Fx]/u.test(text[j + 1] ?? "")) j++;
				continue;
			}
			if (PERL_REST_SWITCHES.includes(letter)) break;
		}
	}
	return false;
}

/**
 * The edit tool edits named files. It cannot edit files a glob names, and the perl and awk rules'
 * regexes also match commands that do not edit in place (`perl x.pl -input`, a quoted `-i inplace`).
 */
function editCanPerform(name: string, command: SimpleCommand): boolean {
	const words = command.words.slice(1);
	if (words.some(word => !word.value.startsWith("-") && word.glob)) return false;
	if (name === "perl") return perlEditsInPlace(words);
	if (name === "awk" || name === "gawk") {
		return words.some(
			(word, i) =>
				word.value === "-iinplace" ||
				word.value === "--include=inplace" ||
				((word.value === "-i" || word.value === "--include") && words[i + 1]?.value === "inplace"),
		);
	}
	return true;
}

/**
 * Whether the dedicated `tool` can perform the step `text` starts with. `true` when the step is a
 * command this module does not know or a construct it cannot parse: the rule's own match decides.
 */
export function dedicatedToolCanPerformStep(tool: string, text: string, availableTools: readonly string[]): boolean {
	const pipeline = parseLeadingPipeline(text);
	if (!pipeline) return true;
	const command = pipeline[0];
	const name = commandName(command);
	switch (tool) {
		case "read":
			return !READ_SPECS[name] || (outputReachesAgent(pipeline) && readCanPerform(name, command));
		case "grep":
			return !GREP_SPECS[name] || (outputReachesAgent(pipeline) && grepCanPerform(name, command));
		case "glob":
			if (name === "locate") return false;
			if (name !== "find" && name !== "fd") return true;
			return outputReachesAgent(pipeline) && (name === "find" ? findCanPerform(command) : fdCanPerform(command));
		case "write":
			return writeCanPerform(name, command, availableTools);
		case "edit":
			return editCanPerform(name, command);
		default:
			return true;
	}
}
