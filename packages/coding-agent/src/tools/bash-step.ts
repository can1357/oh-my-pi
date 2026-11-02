/**
 * What one bash step does, for the bash interceptor: whether the dedicated tool a rule names can
 * perform that exact step. A rule's regex says which command a step runs; this module reads the
 * step's options, operands and redirections and answers whether the named tool can express them.
 *
 * It parses only a command's first pipeline (`a | b | c`, up to the first `;`, `&&`, `||`, `&` or
 * newline), with quoting (including `$'…'`), escapes, expansions, redirections and heredoc
 * bodies. For the built-in tools a step it cannot parse (a leading subshell, group or compound
 * keyword, unbalanced quotes) is not refused, since nothing shows the tool can do it. It never
 * adds a refusal: it only withdraws one the named tool cannot carry out.
 */

/** One shell word of a simple command. */
interface Word {
	/** Source text, quotes and escapes kept. */
	raw: string;
	/** Text after quote and escape removal; substitutions stay as written. */
	value: string;
	/** Has an unquoted `*`, `?` or `[`, so the shell expands it to file names. */
	glob: boolean;
	/**
	 * Its value is something the agent cannot write down itself: a command or process
	 * substitution, a parameter only the running shell knows (`$?`, `$!`, `$$`, `$RANDOM`), a
	 * `${…}` with an operator, or arithmetic over names.
	 */
	computed: boolean;
	/** Any part of it is quoted or escaped (a heredoc delimiter so spelled keeps its body literal). */
	quoted: boolean;
}

/**
 * Variables whose value the agent knows without asking the shell (its own home, working
 * directory and user). Any other parameter (`$OUT`, `$PIPESTATUS`, `$BASH_REMATCH`, `$?`) may
 * hold anything, so a word that expands it is computed.
 */
const KNOWN_NAMES: Record<string, true> = { HOME: true, PWD: true, USER: true, LOGNAME: true };
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
	/** Leading `NAME=value` words, which set the command's environment. */
	assignments: Word[];
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

/**
 * Decodes the body of an ANSI-C `$'…'` string as bash does. `bytes` is set when a `\x` or octal
 * escape yields a byte at or above 0x80, which bash passes as a raw byte, not as text.
 */
function decodeAnsiC(body: string): { text: string; bytes: boolean } {
	let bytes = false;
	const simple: Record<string, string> = {
		n: "\n",
		t: "\t",
		r: "\r",
		a: "\x07",
		b: "\b",
		e: "\x1b",
		E: "\x1b",
		f: "\f",
		v: "\v",
		"\\": "\\",
		"'": "'",
		'"': '"',
		"?": "?",
	};
	const text = body.replace(
		/\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|c.|[0-7]{1,3}|.)/gsu,
		(_, esc: string) => {
			if (esc[0] === "u" || esc[0] === "U") {
				const code = Number.parseInt(esc.slice(1), 16);
				return code <= 0x10ffff ? String.fromCodePoint(code) : "";
			}
			if (esc[0] === "x" || /^[0-7]/u.test(esc)) {
				const code = esc[0] === "x" ? Number.parseInt(esc.slice(1), 16) : Number.parseInt(esc, 8) & 0xff;
				if (code >= 0x80) bytes = true;
				return String.fromCharCode(code);
			}
			if (esc[0] === "c") return esc[1] === "?" ? "\x7f" : String.fromCharCode(esc.charCodeAt(1) & 0x1f);
			return own(simple, esc) ?? `\\${esc}`;
		},
	);
	return { text, bytes };
}

/**
 * Whether the expansion text `$…` (a parameter, `${…}` or `$((…))`) has a value the agent cannot
 * write down itself. Only a plain `$NAME`/`${NAME}` for a variable whose value the agent knows
 * is literal text to it; every other parameter, operator, indirection and length is computed, as
 * is arithmetic over anything but numbers.
 */
function expansionIsComputed(expansion: string): boolean {
	if (expansion.startsWith("$((")) return /[^\d\s+\-*/%()<>=!&|^~?:,]/u.test(expansion.slice(3, -2));
	const name = expansion.startsWith("${") ? expansion.slice(2, -1) : expansion.slice(1);
	return !own(KNOWN_NAMES, name);
}

/** Reads one word at `start`; returns it and the index after it, or undefined on unbalanced syntax. */
function readWord(text: string, start: number): { word: Word; end: number } | undefined {
	let value = "";
	let glob = false;
	let computed = false;
	let quoted = false;
	let i = start;
	/** Consumes a `$…` expansion or backtick at `i`; false when there is none there. */
	const expansion = (): boolean | undefined => {
		const ch = text[i];
		if (ch === "`" || (ch === "$" && (text[i + 1] === "(" || text[i + 1] === "{"))) {
			const end = skipSubstitution(text, i);
			if (end < 0) return undefined;
			const piece = text.slice(i, end);
			// A command substitution always runs code; `${…}` and `$((…))` only when not plain.
			const commandSubstitution = ch === "`" || (piece.startsWith("$(") && !piece.startsWith("$(("));
			if (commandSubstitution || expansionIsComputed(piece)) computed = true;
			value += piece;
			i = end;
			return true;
		}
		const parameter = ch === "$" ? PLAIN_PARAMETER.exec(text.slice(i, i + 256)) : null;
		if (parameter) {
			// `$?` and `$*` are parameters, not file-name globs.
			if (expansionIsComputed(parameter[0])) computed = true;
			value += parameter[0];
			i += parameter[0].length;
			return true;
		}
		return false;
	};
	while (i < text.length) {
		const ch = text[i];
		if (ch === "'") {
			const close = text.indexOf("'", i + 1);
			if (close < 0) return undefined;
			quoted = true;
			value += text.slice(i + 1, close);
			i = close + 1;
			continue;
		}
		if (ch === "$" && text[i + 1] === "'") {
			let close = i + 2;
			while (close < text.length && text[close] !== "'") close += text[close] === "\\" ? 2 : 1;
			if (close >= text.length) return undefined;
			quoted = true;
			const decoded = decodeAnsiC(text.slice(i + 2, close));
			// A raw byte is not text the agent can hand to a tool.
			if (decoded.bytes) computed = true;
			value += decoded.text;
			i = close + 1;
			continue;
		}
		if (ch === '"' || (ch === "$" && text[i + 1] === '"')) {
			quoted = true;
			i += ch === "$" ? 2 : 1;
			for (;;) {
				if (i >= text.length) return undefined;
				const c = text[i];
				if (c === '"') break;
				if (c === "\\" && text[i + 1] === "\n") {
					// Inside double quotes a backslash-newline still joins lines.
					i += 2;
					continue;
				}
				if (c === "\\" && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) {
					value += text[i + 1];
					i += 2;
					continue;
				}
				const consumed = expansion();
				if (consumed === undefined) return undefined;
				if (consumed) continue;
				value += c;
				i++;
			}
			i++;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= text.length) return undefined;
			// A backslash-newline joins lines: it contributes nothing and quotes nothing.
			if (text[i + 1] !== "\n") {
				quoted = true;
				value += text[i + 1];
			}
			i += 2;
			continue;
		}
		const consumed = expansion();
		if (consumed === undefined) return undefined;
		if (consumed) continue;
		if ((ch === "<" || ch === ">") && text[i + 1] === "(" && i === start) {
			const end = skipSubstitution(text, i);
			if (end < 0) return undefined;
			computed = true;
			value += text.slice(i, end);
			i = end;
			continue;
		}
		if (WORD_END.test(ch)) break;
		if (ch === "*" || ch === "?" || ch === "[") glob = true;
		value += ch;
		i++;
	}
	return { word: { raw: text.slice(start, i), value, glob, computed, quoted }, end: i };
}

/** A redirection operator with its optional descriptor, matched in place (sticky) so long commands stay linear. */
const REDIRECT = /(\d*|&)(>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)/uy;

/** The first pipeline of a command line and the text after that line (where heredoc bodies start). */
interface ParsedStep {
	pipeline: SimpleCommand[];
	/** Text after the newline that ends the pipeline's line; "" when the line is the last. */
	afterLine: string;
}

/**
 * Parses the first pipeline of `text`. Returns undefined when the first command is a construct
 * this parser does not model, or when quoting is unbalanced.
 */
function parseLeadingPipeline(text: string): ParsedStep | undefined {
	const pipeline: SimpleCommand[] = [];
	let current: SimpleCommand = { words: [], redirects: [], assignments: [] };
	let sawCommandWord = false;
	let i = 0;
	const finish = () => {
		pipeline.push(current);
		current = { words: [], redirects: [], assignments: [] };
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
		// Every position the loop stops at begins a word, so `#` here starts a comment.
		if (ch === "#") break;
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
		if (!sawCommandWord && ASSIGNMENT.test(read.word.raw)) {
			current.assignments.push(read.word);
			continue;
		}
		if (!sawCommandWord && pipeline.length === 0 && own(COMPOUND_KEYWORDS, read.word.value)) return undefined;
		sawCommandWord = true;
		current.words.push(read.word);
	}
	if (current.words.length > 0 || current.redirects.length > 0 || pipeline.length > 0) finish();
	if (pipeline[0] === undefined || pipeline[0].words.length === 0) return undefined;
	const newline = text.indexOf("\n", i);
	return { pipeline, afterLine: newline < 0 ? "" : text.slice(newline + 1) };
}

/**
 * The bodies of `command`'s heredocs in order, each with whether the shell expands it (an
 * unquoted delimiter); undefined when a body has no closing delimiter line.
 */
function heredocBodies(
	command: SimpleCommand,
	afterLine: string,
): Array<{ body: string; expands: boolean }> | undefined {
	const bodies: Array<{ body: string; expands: boolean }> = [];
	const lines = afterLine.split("\n");
	let next = 0;
	for (const { op, target } of command.redirects) {
		if (op !== "<<" && op !== "<<-") continue;
		if (!target) return undefined;
		let end = next;
		while (end < lines.length && (op === "<<-" ? lines[end].replace(/^\t+/u, "") : lines[end]) !== target.value)
			end++;
		if (end >= lines.length) return undefined;
		bodies.push({ body: lines.slice(next, end).join("\n"), expands: !target.quoted });
		next = end + 1;
	}
	return bodies;
}

/** `table[key]` when `key` is the table's own property; a command word must never reach `Object.prototype`. */
function own<T>(table: Record<string, T>, key: string): T | undefined {
	return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** A descriptor number as the shell reads it (`01` is `1`); undefined for a non-numeric word. */
function fdNumber(text: string): string | undefined {
	return /^\d+$/u.test(text) ? String(Number(text)) : undefined;
}

/**
 * Where a file descriptor of one simple command points after its redirections: the agent, the
 * next stage's pipe, a discard, input, nothing, or a file (with the redirection that opened it).
 */
type FdTarget =
	| { kind: "agent" | "pipe" | "null" | "input" | "closed" }
	| { kind: "file"; redirect: Redirect; viaDuplicate: boolean };

/** Paths that name a descriptor or device rather than a file the step creates. */
const DEVICE_PATHS = /^\/dev\/(?:null|tty|stdout|stderr|stdin|fd\/\d+)$/u;

/** The target a redirection opening the file named by `redirect` gives, given the descriptors so far. */
function fileTarget(redirect: Redirect, fds: Map<string, FdTarget>): FdTarget {
	const path = redirect.target?.value ?? "";
	if (redirect.target && !redirect.target.computed && !redirect.target.glob) {
		if (path === "/dev/null") return { kind: "null" };
		if (path === "/dev/tty") return { kind: "agent" };
		if (path === "/dev/stdout") return fds.get("1") ?? { kind: "closed" };
		if (path === "/dev/stderr") return fds.get("2") ?? { kind: "closed" };
		const fdPath = /^\/dev\/fd\/(\d+)$/u.exec(path);
		if (fdPath) return fds.get(String(Number(fdPath[1]))) ?? { kind: "closed" };
	}
	return { kind: "file", redirect, viaDuplicate: false };
}

/** What one simple command's redirections do, applied in order as the shell applies them. */
interface RedirectEffect {
	/** Where stdout ends up. */
	stdout: FdTarget;
	/** Whether stdin still comes from the previous stage (or the shell's own stdin). */
	stdinFromPipe: boolean;
	/** Every redirection that opens a file for writing (not a device or descriptor), in order. */
	opened: Redirect[];
}

/**
 * Applies `command`'s redirections in order: `n>f`, `n>>f`, `n>|f`, `n<>f`, `&>f`, `&>>f`,
 * `>&f`, `n>&m`, `n<&m`, `n>&-` and input redirections. `initial` is where stdout starts: the
 * next stage's pipe, or the agent for the last stage.
 */
function redirectEffect(command: SimpleCommand, initial: FdTarget): RedirectEffect {
	const fds = new Map<string, FdTarget>([
		["0", { kind: "pipe" }],
		["1", initial],
		["2", { kind: "agent" }],
	]);
	const opened: Redirect[] = [];
	const open = (redirect: Redirect): FdTarget => {
		const to = fileTarget(redirect, fds);
		if (to.kind === "file") opened.push(redirect);
		return to;
	};
	for (const redirect of command.redirects) {
		const { fd, op, target } = redirect;
		const value = target?.value ?? "";
		const n = fdNumber(fd);
		if (op === ">&" || op === "<&") {
			const into = n ?? (op === ">&" ? "1" : "0");
			const from = fdNumber(value);
			if (value === "-") fds.set(into, { kind: "closed" });
			else if (from !== undefined) {
				const source = fds.get(from) ?? { kind: "closed" };
				fds.set(into, source.kind === "file" ? { ...source, viaDuplicate: true } : source);
			} else if (op === ">&" && fd === "") {
				// `>&name` sends stdout and stderr to the file `name`.
				const to = open(redirect);
				fds.set("1", to);
				fds.set("2", to);
			} else fds.set(into, { kind: "closed" });
			continue;
		}
		if (fd === "&") {
			const to = open(redirect);
			fds.set("1", to);
			fds.set("2", to);
			continue;
		}
		if (op === ">" || op === ">>" || op === ">|") {
			fds.set(n ?? "1", open(redirect));
			continue;
		}
		if (op === "<>") {
			const into = n ?? "0";
			if (DEVICE_PATHS.test(value) && target && !target.computed) fds.set(into, { kind: "input" });
			else {
				opened.push(redirect);
				fds.set(into, { kind: "file", redirect, viaDuplicate: false });
			}
			continue;
		}
		// `<`, `<<`, `<<-`, `<<<`: the descriptor (stdin unless named) now reads input.
		fds.set(n ?? "0", { kind: "input" });
	}
	return { stdout: fds.get("1") ?? { kind: "closed" }, stdinFromPipe: fds.get("0")?.kind === "pipe", opened };
}

function commandName(command: SimpleCommand): string {
	const first = command.words[0]?.value ?? "";
	return first.slice(first.lastIndexOf("/") + 1);
}

/** One pass-through filter: its option letters without a value, those with one, its long options, and its operands. */
interface FilterSpec {
	flags: string;
	valued: string;
	/** Long options by exact name: `true` takes a value, `false` does not. */
	long: Record<string, boolean>;
	operands?: "any" | "pattern" | "sed";
}

const GREP_FILTER: FilterSpec = {
	flags: "EFGPiywxnHhsIlqTcvoLb",
	valued: "eABCm",
	long: {
		regexp: true,
		"after-context": true,
		"before-context": true,
		context: true,
		"max-count": true,
		"extended-regexp": false,
		"fixed-strings": false,
		"ignore-case": false,
		"invert-match": false,
		"only-matching": false,
		count: false,
		"line-number": false,
		"word-regexp": false,
		"line-regexp": false,
	},
	operands: "pattern",
};

/**
 * Later pipeline stages that only reshape the text they read and print it, with every option
 * they may carry. Anything else in a later stage (a writer such as `tee` or `sort -o`, an
 * option that reads or runs something such as `--files0-from` or `--compress-program`, a stream
 * consumer such as `xargs` or `while read`, a wrapper such as `env tee`) means the first
 * command's output does not simply reach the agent. Long options must be spelled out: GNU's
 * abbreviations (`--out` for `--output`) are not accepted.
 */
const FILTERS: Record<string, FilterSpec> = {
	head: { flags: "qv", valued: "nc", long: { lines: true, bytes: true, quiet: false, silent: false } },
	tail: { flags: "qvr", valued: "nc", long: { lines: true, bytes: true, quiet: false, silent: false } },
	cut: {
		flags: "sz",
		valued: "dfcb",
		long: {
			delimiter: true,
			fields: true,
			characters: true,
			bytes: true,
			"output-delimiter": true,
			complement: false,
		},
	},
	sort: {
		flags: "bdfghinMRruVs",
		valued: "kt",
		long: {
			key: true,
			"field-separator": true,
			numeric: false,
			"numeric-sort": false,
			"human-numeric-sort": false,
			reverse: false,
			unique: false,
			"version-sort": false,
			"ignore-case": false,
			stable: false,
		},
	},
	uniq: {
		flags: "cdDiuz",
		valued: "fsw",
		long: { count: false, repeated: false, unique: false, "ignore-case": false },
	},
	wc: { flags: "lwcmL", valued: "", long: { lines: false, words: false, bytes: false, chars: false } },
	tr: { flags: "cdsCt", valued: "", long: {}, operands: "any" },
	nl: { flags: "p", valued: "bdfhilnsvw", long: {} },
	column: { flags: "tnex", valued: "scoNRlW", long: {} },
	fold: { flags: "bs", valued: "w", long: { width: true } },
	rev: { flags: "", valued: "", long: {} },
	tac: { flags: "br", valued: "s", long: { separator: true } },
	cat: { flags: "nbsAEvT", valued: "", long: {} },
	grep: GREP_FILTER,
	egrep: GREP_FILTER,
	fgrep: GREP_FILTER,
	rg: GREP_FILTER,
	sed: {
		flags: "nEr",
		valued: "e",
		long: { expression: true, quiet: false, silent: false, "regexp-extended": false },
		operands: "sed",
	},
};

/** Whether a later pipeline stage only reshapes its input and prints the result. */
function isPassThroughFilter(stage: SimpleCommand): boolean {
	const filter = own(FILTERS, commandName(stage));
	if (!filter) return false;
	const operands: Word[] = [];
	const scripts: string[] = [];
	const words = stage.words.slice(1);
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		const text = word.value;
		if (word.computed) return false;
		if (text === "-" || !text.startsWith("-")) {
			operands.push(word);
			continue;
		}
		if (text.startsWith("--")) {
			const eq = text.indexOf("=");
			const name = text.slice(2, eq < 0 ? undefined : eq);
			const takesValue = own(filter.long, name);
			if (takesValue === undefined || (!takesValue && eq >= 0)) return false;
			let value: string | undefined = eq >= 0 ? text.slice(eq + 1) : undefined;
			if (takesValue && value === undefined) {
				const next = words[++i];
				if (!next || next.computed) return false;
				value = next.value;
			}
			if (name === "regexp" || name === "expression") scripts.push(value ?? "");
			continue;
		}
		if (/^-\d+$/u.test(text)) continue;
		for (let j = 1; j < text.length; j++) {
			const letter = text[j];
			if (filter.valued.includes(letter)) {
				let value = text.slice(j + 1);
				if (value === "") {
					const next = words[++i];
					if (!next || next.computed) return false;
					value = next.value;
				}
				if (letter === "e") scripts.push(value);
				break;
			}
			if (!filter.flags.includes(letter)) return false;
		}
	}
	if (filter.operands === "any") return true;
	if (filter.operands === "pattern") return operands.length <= (scripts.length > 0 ? 0 : 1);
	if (filter.operands === "sed") {
		const all = scripts.length > 0 ? scripts : operands.length > 0 ? [operands[0].value] : [];
		const files = scripts.length > 0 ? operands.length : operands.length - 1;
		return files === 0 && all.length > 0 && all.every(script => sedScriptIsSafe(script, "filter"));
	}
	// Any other operand is a file the filter reads in place of the pipe.
	return operands.length === 0;
}

/**
 * Whether what the pipeline's first command prints reaches the agent and nothing else happens:
 * no stage opens a file for writing, every stage's stdout goes on down the pipe (the last one's
 * to the agent), and every later stage is a pass-through filter that still reads the pipe.
 */
function outputReachesAgent(pipeline: SimpleCommand[]): boolean {
	for (let i = 0; i < pipeline.length; i++) {
		const last = i === pipeline.length - 1;
		const effect = redirectEffect(pipeline[i], { kind: last ? "agent" : "pipe" });
		if (effect.opened.length > 0 || effect.stdout.kind !== (last ? "agent" : "pipe")) return false;
		if (i > 0 && (!effect.stdinFromPipe || !isPassThroughFilter(pipeline[i]))) return false;
	}
	return true;
}

/**
 * Whether a sed script only rewrites lines. `filter` (a later pipeline stage) allows every
 * command that only shapes stdout; `edit` (`sed -i`) allows substitutions, transliterations and
 * deletions, the changes the edit tool can make. Neither allows `r`, `R`, `w`, `W`, `e`, or an
 * `s` command's `w`/`e` flags, which read or write other files or run commands.
 */
function sedScriptIsSafe(script: string, mode: "filter" | "edit"): boolean {
	const filterOnly = "pPqQ=lnNgGhHxDz";
	let i = 0;
	const skipDelimited = (delim: string): boolean => {
		for (; i < script.length; i++) {
			if (script[i] === "\\") i++;
			else if (script[i] === delim) {
				i++;
				return true;
			}
		}
		return false;
	};
	const address = (): boolean => {
		if (/\d/u.test(script[i] ?? "")) while (/\d/u.test(script[i] ?? "")) i++;
		else if (script[i] === "$") i++;
		else if (script[i] === "/") {
			i++;
			if (!skipDelimited("/")) return false;
			while (/[IM]/u.test(script[i] ?? "")) i++;
		} else if (script[i] === "\\") {
			const delim = script[i + 1];
			if (delim === undefined) return false;
			i += 2;
			if (!skipDelimited(delim)) return false;
		}
		return true;
	};
	while (i < script.length) {
		const ch = script[i];
		if (/[\s;{}]/u.test(ch)) {
			i++;
			continue;
		}
		const start = i;
		if (!address()) return false;
		if (i > start && (script[i] === "," || script[i] === "~")) {
			i++;
			if (script[i] === "+" || script[i] === "~") i++;
			if (!address()) return false;
		}
		while (/[\s!]/u.test(script[i] ?? "")) i++;
		const cmd = script[i];
		if (cmd === undefined) return i > start ? false : true;
		if (cmd === "s" || cmd === "y") {
			const delim = script[i + 1];
			if (delim === undefined || delim === "\\" || delim === "\n") return false;
			i += 2;
			if (!skipDelimited(delim) || !skipDelimited(delim)) return false;
			if (cmd === "s") {
				const flags = /^[gpiImM0-9]*/u.exec(script.slice(i))?.[0] ?? "";
				i += flags.length;
				if (mode === "edit" && flags.includes("p")) return false;
				// Any other flag (`w file`, `e`) reads, writes or runs something.
				if (i < script.length && !/[\s;}]/u.test(script[i])) return false;
			}
			continue;
		}
		if (cmd === "d" || cmd === "{" || cmd === "}") {
			i++;
			continue;
		}
		if (mode === "filter" && filterOnly.includes(cmd)) {
			i++;
			if (cmd === "q" || cmd === "Q") while (/\d/u.test(script[i] ?? "")) i++;
			continue;
		}
		return false;
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
		if (optionsEnded || text === "-" || !text.startsWith("-") || word.computed) {
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
			const kind = own(spec.long, text.slice(2, eq < 0 ? undefined : eq));
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
				if (!next || next.computed) return undefined;
				value = next.value;
			}
			if (!kind(value)) return undefined;
			continue;
		}
		if (spec.numeric && /^-\d+$/u.test(text)) continue;
		for (let j = 1; j < text.length; j++) {
			const letter = text[j];
			const valued = own(spec.valued, letter);
			if (valued) {
				let value = text.slice(j + 1);
				if (value === "") {
					const next = words[++i];
					if (!next || next.computed) return undefined;
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

/** Whether `word` names one file the agent can pass to a tool: no glob, no computed part, not stdin. */
function namesOneFile(word: Word): boolean {
	return word.value !== "-" && !word.glob && !word.computed;
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
function readCanPerform(spec: OptionSpec, command: SimpleCommand): boolean {
	const operands = expressibleOperands(command.words.slice(1), spec);
	if (!operands || !operands.every(namesOneFile)) return false;
	const stdin = command.redirects.filter(r => (fdNumber(r.fd) ?? "0") === "0" && r.fd !== "&" && r.op.startsWith("<"));
	if (stdin.some(r => r.op !== "<" || !r.target || !namesOneFile(r.target))) return false;
	return operands.length > 0 || stdin.length > 0;
}

// ── grep: grep, egrep, fgrep, rg, ag, ack ────────────────────────────────────

// The grep tool takes a pattern, paths (with globs and `!glob` excludes), `case` and `gitignore`,
// searches hidden files, and shows each match with a fixed number of context lines. So context
// widths (`-A/-B/-C`, `-NUM`), match caps (`-m`) and output modes it lacks are not in these tables.
const GNU_GREP: OptionSpec = {
	flags: "EFGPiywxnHhrRsIlqT",
	valued: { e: ANY },
	long: {
		"basic-regexp": "flag",
		"binary-files": value => value === "without-match",
		color: "optional",
		colour: "optional",
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
};

const RIPGREP: OptionSpec = {
	flags: "isSFwxnNHIlUPqu.",
	valued: { e: ANY, g: ANY, t: ANY, T: ANY, M: COUNT, j: COUNT },
	long: {
		"case-sensitive": "flag",
		color: "optional",
		colors: ANY,
		column: "flag",
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
	valued: {},
	long: {
		"case-sensitive": "flag",
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
	valued: {},
	long: {
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
 * lines with their numbers and fixed context. It cannot print only the matched text (`-o`),
 * count (`-c`), invert (`-v`), list files without matches (`-L`), print byte offsets, change the
 * context width or cap matches, read patterns from a file, or search stdin, a heredoc or a
 * here-string.
 */
function grepCanPerform(spec: OptionSpec, command: SimpleCommand): boolean {
	const options = command.words.slice(1);
	const operands = expressibleOperands(options, spec);
	if (!operands) return false;
	const stdin = command.redirects.filter(r => (fdNumber(r.fd) ?? "0") === "0" && r.fd !== "&" && r.op.startsWith("<"));
	if (stdin.some(r => r.op !== "<" || !r.target || !namesOneFile(r.target))) return false;
	const patternGiven = options.some(word => /^(?:-[^-]*e|--regexp)/u.test(word.value));
	const paths = patternGiven ? operands : operands.slice(1);
	if (operands.some(word => word.computed) || paths.some(word => word.value === "-")) return false;
	if (spec !== GNU_GREP) return true;
	// GNU grep without a file operand reads stdin unless it recurses.
	const recursive = options.some(word => /^(?:-[^-]*[rR]|--(?:dereference-)?recursive$)/u.test(word.value));
	return paths.length > 0 || recursive || stdin.length > 0;
}

// ── glob: find, fd ───────────────────────────────────────────────────────────

/**
 * `find` primaries the glob tool expresses through its path patterns, each with its argument
 * count. `-type` is not among them: glob lists symlinks to files as files and cannot leave out
 * directories or symlinks, so `-type f`/`-type d` are not expressible.
 */
const FIND_PRIMARIES: Record<string, number> = { "-name": 1, "-path": 1, "-wholename": 1, "-print": 0 };
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
 * The glob tool matches path patterns under one or more roots and lists files, directories and
 * symlinks alike. It never descends into `.git`, and into `node_modules` only for a pattern
 * that names it. It has no depth limit, type, case-insensitive, size, time or permission test,
 * negation or pruning of other paths, or action (`-exec`, `-delete`, `-printf`).
 */
function findCanPerform(command: SimpleCommand): boolean {
	const words = command.words.slice(1);
	if (words.some(word => word.computed)) return false;
	let i = 0;
	while (i < words.length && (words[i].value === "-P" || words[i].value === "-H")) i++;
	for (; i < words.length; i++) {
		const value = words[i].value;
		if (value.startsWith("-") || value === "!" || own(FIND_OPERATORS, value)) break;
	}
	let negated = false;
	let prunedTest = false;
	for (; i < words.length; i++) {
		const value = words[i].value;
		if (value === "!" || value === "-not") {
			negated = true;
			continue;
		}
		if (own(FIND_OPERATORS, value)) continue;
		if (value === "-prune") {
			// `-path ./node_modules -prune` restates the glob tool's own pruning.
			if (!prunedTest) return false;
			prunedTest = false;
			continue;
		}
		const arity = own(FIND_PRIMARIES, value);
		if (arity === undefined) return false;
		const arg = arity === 1 ? words[++i] : undefined;
		if (arity === 1 && !arg) return false;
		prunedTest = value !== "-print" && PRUNED_BY_GLOB.test(arg?.value ?? "");
		if (negated && !prunedTest) return false;
		// The glob tool never lists `.git`, so a search for it is not expressible unless it is pruned.
		if (!negated && prunedTest && arg?.value.includes(".git") && words[i + 1]?.value !== "-prune") return false;
		negated = false;
	}
	return true;
}

const FD: OptionSpec = {
	// Not `-S` (`--size`), `-t` (`--type`: glob has no type filter) or `-L` (follows symlinks).
	flags: "HIusga1",
	valued: { e: ANY, j: COUNT, c: ANY },
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
	if (!operands || operands.some(word => word.computed)) return false;
	const pattern = operands[0]?.value;
	if (pattern === undefined || pattern === "") return true;
	const globMode = options.some(word => /^(?:-[^-]*g|--glob$)/u.test(word.value));
	if (!globMode && !/^[A-Za-z0-9_-]+$/u.test(pattern)) return false;
	const caseSensitive = options.some(word => /^(?:-[^-]*s|--case-sensitive$)/u.test(word.value));
	return caseSensitive || /[A-Z]/u.test(pattern);
}

// ── write: echo, printf, cat ─────────────────────────────────────────────────

/** An unescaped `$` or backtick: the shell expands it inside an unquoted-delimiter heredoc. */
const HEREDOC_EXPANSION = /(?:^|[^\\])(?:\\\\)*[$`]/u;

/**
 * Escapes that make `printf` (in its format, or a `%b` argument) or `echo -e` emit raw bytes:
 * octal and `\x` escapes. The write tool writes UTF-8 text, so their output is not expressible.
 */
const BYTE_ESCAPE = /\\(?:[0-7]|x[0-9A-Fa-f])/u;

/** Paths whose writes reach a device or kernel interface, not a file the write tool creates. */
const SPECIAL_PATH = /^\/(?:dev|proc|sys)\//u;

/**
 * The write tool writes UTF-8 text the agent supplies to one regular file the agent names; to
 * append, the write rule's message points at `edit`. It cannot copy or concatenate files
 * (`cat a b > f`), write a command's output or anything else only the running shell knows
 * (`$(date)`, `$?`, `$OUT`, `${v:-…}`, `$((…))` over names, `printf '%(…)T'`, a heredoc body that
 * expands), emit raw bytes (`printf '\377'`), set a shell variable (`printf -v`), expand a glob,
 * write to a computed path, a FIFO or a device, or create a second file (`2>err.log`).
 */
function writeCanPerform(
	name: string,
	step: ParsedStep,
	availableTools: readonly string[],
	pathKind: ((path: string) => PathKind | undefined) | undefined,
): boolean {
	if (name !== "echo" && name !== "printf" && name !== "cat") return true;
	if (step.pipeline.length > 1) return false;
	const command = step.pipeline[0];
	const { stdout, opened } = redirectEffect(command, { kind: "agent" });
	// Stdout must be a file its own redirection opened, and no other file may be opened.
	if (stdout.kind !== "file" || stdout.viaDuplicate || opened.length !== 1 || opened[0] !== stdout.redirect)
		return false;
	const { op, target } = stdout.redirect;
	if (!target || target.computed || target.glob || SPECIAL_PATH.test(target.value)) return false;
	if ((pathKind?.(target.value) ?? "file") !== "file") return false;
	// `<>` writes over the file without truncating it, which the write tool cannot do.
	if (op === "<>" || (op === ">>" && !availableTools.includes("edit"))) return false;
	const args = command.words.slice(1);
	if (args.some(word => word.computed || word.glob)) return false;
	if (name === "printf") {
		const format = args.findIndex(word => word.value !== "--");
		if (format < 0 || args[format].value.startsWith("-")) return false;
		if (args[format].value.includes("%(") || BYTE_ESCAPE.test(args[format].value)) return false;
		if (args[format].value.includes("%b") && args.slice(format + 1).some(word => BYTE_ESCAPE.test(word.value)))
			return false;
	}
	if (name === "echo") {
		const escapes = args.some(word => /^-[neE]*e[neE]*$/u.test(word.value));
		if (escapes && args.some(word => BYTE_ESCAPE.test(word.value))) return false;
	}
	const bodies = heredocBodies(command, step.afterLine);
	if (bodies === undefined || bodies.some(({ body, expands }) => expands && HEREDOC_EXPANSION.test(body)))
		return false;
	if (name !== "cat") return true;
	// cat writes only what its heredoc or here-string holds; file operands or `<` make it a copy.
	if (!args.every(word => word.value.startsWith("-") && word.value !== "-")) return false;
	for (const redirect of command.redirects) {
		if (fdNumber(redirect.fd) !== undefined && fdNumber(redirect.fd) !== "0") continue;
		if (redirect.op === "<" || redirect.op === "<&") return false;
		if (redirect.op === "<<<" && (!redirect.target || redirect.target.computed)) return false;
	}
	return true;
}

// ── edit: sed -i, perl -i, awk -i inplace ────────────────────────────────────

/**
 * `sed -i` the edit tool can do: in place without a backup suffix, scripts that only substitute,
 * transliterate or delete (no `r`/`w`/`e`, no `s///w`/`e`, no `-n`, no script file), on named files.
 */
function sedEditIsExpressible(words: Word[]): boolean {
	const scripts: string[] = [];
	const operands: Word[] = [];
	let inPlace = false;
	let optionsEnded = false;
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		const text = word.value;
		if (word.computed) return false;
		if (optionsEnded || text === "-" || !text.startsWith("-")) {
			operands.push(word);
			continue;
		}
		if (text === "--") {
			optionsEnded = true;
			continue;
		}
		if (text.startsWith("--")) {
			const eq = text.indexOf("=");
			const long = text.slice(2, eq < 0 ? undefined : eq);
			if (long === "in-place") {
				if (eq >= 0 && text.length > eq + 1) return false;
				inPlace = true;
			} else if (long === "expression") {
				const script = eq >= 0 ? text.slice(eq + 1) : words[++i]?.value;
				if (script === undefined || words[i]?.computed) return false;
				scripts.push(script);
			} else if (!/^(?:regexp-extended|posix|unbuffered|separate)$/u.test(long)) return false;
			continue;
		}
		for (let j = 1; j < text.length; j++) {
			const letter = text[j];
			if (letter === "i") {
				// GNU sed reads the rest of the word as a backup suffix.
				if (j + 1 < text.length) return false;
				inPlace = true;
				break;
			}
			if (letter === "e") {
				const script = j + 1 < text.length ? text.slice(j + 1) : words[++i]?.value;
				if (script === undefined || words[i]?.computed) return false;
				scripts.push(script);
				break;
			}
			if (!"Ersu".includes(letter)) return false;
		}
	}
	if (scripts.length === 0) {
		const script = operands.shift();
		if (!script) return false;
		scripts.push(script.value);
	}
	return (
		inPlace && operands.length > 0 && operands.every(namesOneFile) && scripts.every(s => sedScriptIsSafe(s, "edit"))
	);
}

/**
 * Splits one perl `s///` or `tr///`/`y///` script into its operator, delimiter, pattern and
 * replacement in one pass; undefined for anything else (another statement, bracketing
 * delimiters, trailing code). Linear in the script's length.
 */
function perlSubstitution(
	script: string,
): { op: "s" | "tr"; delim: string; pattern: string; replacement: string; flags: string } | undefined {
	let i = 0;
	while (/\s/u.test(script[i] ?? "")) i++;
	let op: "s" | "tr";
	if (script[i] === "s") {
		op = "s";
		i++;
	} else if (script.startsWith("tr", i)) {
		op = "tr";
		i += 2;
	} else if (script[i] === "y") {
		op = "tr";
		i++;
	} else return undefined;
	const delim = script[i];
	if (delim === undefined || /[\w\s({[<]/u.test(delim)) return undefined;
	i++;
	const part = (): string | undefined => {
		const start = i;
		for (; i < script.length; i++) {
			if (script[i] === "\\") i++;
			else if (script[i] === delim) return script.slice(start, i++);
		}
		return undefined;
	};
	const pattern = part();
	const replacement = pattern === undefined ? undefined : part();
	if (pattern === undefined || replacement === undefined) return undefined;
	const flags = /^[a-z]*/u.exec(script.slice(i))?.[0] ?? "";
	if (!/^\s*;?\s*$/u.test(script.slice(i + flags.length))) return undefined;
	if (op === "s" ? /[^gimsxr]/u.test(flags) : /[^cdsr]/u.test(flags)) return undefined;
	return { op, delim, pattern, replacement, flags };
}

/** Regex code blocks (`(?{…})`, `(??{…})`, `(*{…})`), which run whatever the delimiter. */
const PERL_CODE_BLOCK = /\(\?\??\{|\(\*\{/u;
/**
 * Interpolation, which runs code through `${…}`/`@{…}` and reads variables: a `$` that ends the
 * pattern or precedes `)` or `|` is an anchor, and `$1`/`$&` in a replacement are captures.
 */
const PERL_PATTERN_INTERPOLATION = /@[\w{:$]|\$(?![)|]|$)/u;
const PERL_REPLACEMENT_INTERPOLATION = /@[\w{:$]|\$(?!\d|&)/u;

/** `perl -pi -e 's/…/…/' files` the edit tool can do: in place without a backup suffix, substitutions only. */
function perlEditIsExpressible(words: Word[]): boolean {
	const scripts: string[] = [];
	let print = false;
	let inPlace = false;
	let i = 0;
	for (; i < words.length; i++) {
		const word = words[i];
		const text = word.value;
		if (word.computed) return false;
		if (text === "--") {
			i++;
			break;
		}
		if (!text.startsWith("-") || text === "-") break;
		for (let j = 1; j < text.length; j++) {
			const letter = text[j];
			if (letter === "p") print = true;
			else if (letter === "i") {
				// perl reads the rest of the word as a backup extension (`-pi.bak`, even `-pie`).
				if (j + 1 < text.length) return false;
				inPlace = true;
			} else if (letter === "e" || letter === "E") {
				const script = j + 1 < text.length ? text.slice(j + 1) : words[++i]?.value;
				if (script === undefined || words[i]?.computed) return false;
				scripts.push(script);
				break;
			} else if (letter === "0" || letter === "l") {
				while (/[0-9a-fA-Fx]/u.test(text[j + 1] ?? "")) j++;
			} else if (letter !== "w") return false;
		}
	}
	const files = words.slice(i);
	if (!print || !inPlace || scripts.length === 0 || files.length === 0 || !files.every(namesOneFile)) return false;
	return scripts.every(script => {
		const sub = perlSubstitution(script);
		if (!sub) return false;
		if (sub.op === "tr") return true;
		if (PERL_CODE_BLOCK.test(sub.pattern) || PERL_CODE_BLOCK.test(sub.replacement)) return false;
		// With `'` as delimiter perl interpolates nothing; code blocks still run.
		return (
			sub.delim === "'" ||
			(!PERL_PATTERN_INTERPOLATION.test(sub.pattern) && !PERL_REPLACEMENT_INTERPOLATION.test(sub.replacement))
		);
	});
}

/**
 * The edit tool applies literal replacements to named files. A `sed -i` or `perl -pi` is within
 * its reach only when it substitutes, transliterates or deletes text in named files with no backup
 * copy; an `awk -i inplace` program runs code, which the edit tool does not.
 */
function editCanPerform(name: string, pipeline: SimpleCommand[]): boolean {
	// The edit tool changes the files it names and nothing else: no later stage, no opened file.
	if (pipeline.length > 1) return false;
	const command = pipeline[0];
	const words = command.words.slice(1);
	if (redirectEffect(command, { kind: "agent" }).opened.length > 0) return false;
	if (name === "sed") return sedEditIsExpressible(words);
	if (name === "perl") return perlEditIsExpressible(words);
	if (name === "awk" || name === "gawk") return false;
	return true;
}

/** The tools this module knows; a rule for any other tool keeps its own decision. */
const BUILT_IN_TOOLS: Record<string, true> = { read: true, grep: true, glob: true, write: true, edit: true };

/**
 * Whether every part of the step is literal: no command word, assignment or redirection target
 * the shell computes, and no heredoc or here-string (whose body the shell may expand, on any
 * descriptor) except where `allowStdinDocuments` lets write's `cat` take its text from stdin.
 */
function stepIsLiteral(pipeline: SimpleCommand[], allowStdinDocuments: boolean): boolean {
	return pipeline.every(
		stage =>
			!stage.words[0]?.computed &&
			!stage.assignments.some(word => word.computed) &&
			stage.redirects.every(({ fd, op, target }) => {
				if (!target) return false;
				if (op === "<<" || op === "<<-" || op === "<<<") {
					return allowStdinDocuments && (fdNumber(fd) ?? "0") === "0" && fd !== "&";
				}
				return !target.computed && !target.glob;
			}),
	);
}

/** What a path names on disk, for the checks that depend on it; undefined when it does not exist or cannot be read. */
export type PathKind = "file" | "directory" | "other";

/**
 * Whether the dedicated `tool` can perform the step `text` starts with. `true` for a tool or
 * command this module does not know: the rule's own match decides. `false` for a step of a
 * built-in tool's command that it cannot parse: nothing shows the tool can do it. `pathKind`,
 * when given, reports what an operand or target names, so a FIFO or device is never sent to
 * read or write.
 */
export function dedicatedToolCanPerformStep(
	tool: string,
	text: string,
	availableTools: readonly string[],
	pathKind?: (path: string) => PathKind | undefined,
): boolean {
	if (!own(BUILT_IN_TOOLS, tool)) return true;
	const step = parseLeadingPipeline(text);
	if (!step) return false;
	const { pipeline } = step;
	if (!stepIsLiteral(pipeline, tool === "write")) return false;
	const command = pipeline[0];
	const name = commandName(command);
	switch (tool) {
		case "read": {
			const spec = own(READ_SPECS, name);
			if (!spec) return true;
			if (!outputReachesAgent(pipeline) || !readCanPerform(spec, command)) return false;
			// The read tool reads regular files and lists directories; a FIFO or device it does not read.
			const paths = [
				...command.words.slice(1).filter(word => !word.value.startsWith("-")),
				...command.redirects.flatMap(r => (r.op === "<" && r.target ? [r.target] : [])),
			];
			return paths.every(word => (pathKind?.(word.value) ?? "file") !== "other");
		}
		case "grep": {
			const spec = own(GREP_SPECS, name);
			return !spec || (outputReachesAgent(pipeline) && grepCanPerform(spec, command));
		}
		case "glob":
			if (name === "locate") return false;
			if (name !== "find" && name !== "fd") return true;
			return outputReachesAgent(pipeline) && (name === "find" ? findCanPerform(command) : fdCanPerform(command));
		case "write":
			return writeCanPerform(name, step, availableTools, pathKind);
		default:
			return editCanPerform(name, pipeline);
	}
}
