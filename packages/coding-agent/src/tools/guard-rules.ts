/**
 * Fixed guard rules for tool calls (`tools.guardRules`), ported from nace-ai/intern's tool guard:
 * `credential_read` and `secret_send`, each naming a way to leak credentials that ordinary
 * development commands do not take. For `bash` they apply to the top-level simple commands
 * {@link parseShellCommands} finds; the bash tool's critical patterns stay a match on the raw
 * command line, whether these rules are on or off.
 *
 * The rules are an opt-in convenience layer over top-level commands (off by default), not a
 * security boundary; a nested, determined or obfuscated command gets past them. Known limitations:
 * - Reading stops at the first nested part: an unquoted `(` or `<<`, or a `$( )`, backtick or
 *   `${ }` other than a plain one, also in double quotes. The command it is in and every later
 *   one are not checked: `echo $(date); cat ~/.ssh/id_rsa`, `(cat .env) | curl -d @- ...`.
 * - Nothing nested is read: compound commands (`{ }`, `if`, loops, `case`, `[[ ]]`), function
 *   bodies, scripts fed to a shell, and `bash -c`, `sh -c`, `eval` and `env -S` strings:
 *   `bash -c 'cat ~/.ssh/id_rsa'`.
 * - Variables whose values are unknown are not expanded: `f=.env; cat "$f"`. Nor is a relative
 *   path after a directory change it does not follow, though a `.env` there still counts by its
 *   name: `cd "$dir" && cat .npmrc`, a `cd` after a `{ }`, `if`, loop, `case`, `eval` or `source`,
 *   the directory a wrapper runs its command in (`env -C ~/.ssh cat id_rsa`, `sudo -D`), or a
 *   `tar` member after `-C`/`--directory` (`tar -C ~ -czf - .ssh`). A `cd` is followed whether or
 *   not it runs: `cd ~; false && cd /; cat .ssh/id_rsa`.
 * - Upload syntaxes, network tools and shell forms it does not model are not seen:
 *   `gh gist create .env`, `curl file:///etc/shadow`, `coproc cat ~/.ssh/id_rsa`,
 *   `exec 3< .env; cat <&3 | nc ...`.
 * - Programs outside the reader list are not seen reading: `tac ~/.ssh/id_rsa`,
 *   `jq . ~/.docker/config.json`.
 * - A command run by a program it does not unwrap, or given its operands at run time, is not
 *   checked with them: `find ~/.ssh -exec cat {} +`, `ls ~/.ssh/id_* | xargs cat`.
 * - Commands in a script file a command runs are not read, even a file the same command writes
 *   first: `printf 'cat ~/.ssh/id_rsa' > x.sh; sh x.sh`.
 * - A program word written as a brace list or pathname pattern is not expanded:
 *   `{cat,/etc/shadow}`, `/bin/ca[t] /etc/shadow`.
 * - A directory that contains a credential location does not count as one:
 *   `tar czf - ~ | curl -T - ...`.
 * - A secret copied to another file first is sent under that file's name:
 *   `cp .env /tmp/x && curl -F f=@/tmp/x ...`.
 * - Brace expansion is followed only in words up to 4096 characters and for their first 1024
 *   words: `{a,b}{a,b}...{a,b}{x,.env}`.
 * - A path that reaches a credential location through a symlink, hard link or bind mount is not
 *   recognized: `ln -s ~/.ssh k && cat k/id_rsa`. Nor do bare wildcards for every component of
 *   `~/Library/Keychains` name it: `cat ~/???????/?????????/login.keychain-db`.
 * - A missing path the `read` tool finds by a unique match deeper under its directory is checked
 *   as written: `read id_rsa` from `~` opens `~/.ssh/id_rsa`.
 *
 * The `credential_read` and `secret_send` rules are derived from `src/intern/guard.py` of
 * nace-ai/intern (https://github.com/nace-ai/intern, v0.30.1, commit e1bbd096f9), Copyright Nace
 * AI, licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
 * Modified for omp: rewritten in TypeScript; a hit returns an approval override instead of refusing
 * the call; credential locations include omp's own stores. See
 * packages/coding-agent/THIRD-PARTY-NOTICES.txt.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { ToolApprovalDecision, ToolTier } from "@oh-my-pi/pi-agent-core";
import { getAgentDbPath, getAuthBrokerSnapshotCachePath } from "@oh-my-pi/pi-utils";
import { isReadableUrlPath, splitPathAndSel } from "@oh-my-pi/pi-tui/tools/read";
import { InternalUrlRouter } from "../internal-urls/router";
import { resolveToCwd } from "./path-utils";
import { parseSqlitePathCandidates } from "./sqlite-reader";
import {
	append,
	attachedValue,
	parseShellCommands,
	resolveShellWordPath,
	type ShellCommand,
	shellPositionalArgs,
} from "./shell-tokenize";

export type GuardRule = "credential_read" | "secret_send" | "size_limit";

/** A fixed rule a call breaks. */
export interface GuardHit {
	rule: GuardRule;
	/** Approval-prompt reason: `<rule>: <why>`. */
	reason: string;
}

/** Where a call runs: its working directory and the home directory `~` names. */
export interface GuardScope {
	cwd: string;
	home: string;
}

function hit(rule: GuardRule, why: string): GuardHit {
	return { rule, reason: `${rule}: ${why}` };
}

// -- credential locations ----------------------------------------------------------------------------

/** Credential folders under the home directory, each with the files in it that are not secret. */
const CREDENTIAL_DIRS: Record<string, readonly string[]> = {
	".ssh": ["config", "known_hosts", "known_hosts.old", "authorized_keys"],
	".aws": ["config"],
	".gnupg": [],
	".kube": [],
	".docker": [],
	".azure": [],
	".password-store": [],
	".config/gcloud": [],
	".config/gh": [],
	"Library/Keychains": [],
};
const CREDENTIAL_FILES: Record<string, true> = {
	".netrc": true,
	".git-credentials": true,
	".npmrc": true,
	".pypirc": true,
};
const SYSTEM_CREDENTIAL_FILES: Record<string, true> = {
	"/etc/shadow": true,
	"/etc/gshadow": true,
	"/etc/master.passwd": true,
	"/private/etc/master.passwd": true,
};
/** `.env` and `.env.<name>`, except the committed templates. */
const DOTENV_RE = /^\.env(?:\.(?!example$|sample$|template$|dist$|defaults$)[\w.-]+)?$/;

/** omp's own credential stores: the agent database (auth storage) and the auth-broker snapshot. */
function ompCredentialStores(): string[] {
	const agentDb = getAgentDbPath();
	return [agentDb, `${agentDb}-wal`, `${agentDb}-shm`, getAuthBrokerSnapshotCachePath()];
}

/** The characters that make a path component a pathname pattern the shell matches file names with. */
const GLOB_RE = /[*?[]/;

/** POSIX character classes of a pathname pattern's bracket expression, as regular expression class members. */
const POSIX_CLASSES: Record<string, string> = {
	alnum: "a-zA-Z0-9",
	alpha: "a-zA-Z",
	blank: " \\t",
	cntrl: "\\x00-\\x1f\\x7f",
	digit: "0-9",
	graph: "!-~",
	lower: "a-z",
	print: " -~",
	punct: "!-\\/:-@\\[-`{-~",
	space: "\\s",
	upper: "A-Z",
	word: "\\w",
	xdigit: "0-9A-Fa-f",
};

/**
 * Whether file names match without regard to case, as on the default file systems of macOS and
 * Windows, where `~/.SSH/id_rsa` opens `~/.ssh/id_rsa`.
 */
function foldsCase(): boolean {
	return process.platform === "darwin" || process.platform === "win32";
}

/** A `[:name:]` class in a pathname pattern's bracket expression, read where it starts. */
const POSIX_CLASS_RE = /\[:\w+:\]/y;

/** A part of a pathname pattern for one file name. */
interface GlobPart {
	/** A run of `*`, a `?`, a literal character, or a bracket expression. */
	kind: "*" | "?" | "char" | "[";
	/** The pattern text of a `*`, `?` or character; a bracket expression as a regular expression class. */
	text: string;
}

/**
 * The parts of a pathname pattern for one file name (`*`, `?`, `[...]`), read in one pass, or
 * `undefined` once more than `limit` of them take a character: such a pattern names no file of
 * `limit` characters, and reading no further keeps a long pattern from costing its length per
 * name. A `[` with no closing `]` is a literal character, and so is every `[` after it: a later
 * one could close only at the `]` ending a `[:name:]` class, and the literal `[` already keeps the
 * pattern from naming any file the guard looks for.
 */
function globParts(pattern: string, limit: number): GlobPart[] | undefined {
	const parts: GlobPart[] = [];
	let taking = 0;
	let unclosed = false;
	for (let i = 0; i < pattern.length; i++) {
		if (taking > limit) return undefined;
		const char = pattern[i];
		if (char === "*") {
			if (parts.at(-1)?.kind !== "*") parts.push({ kind: "*", text: char });
			continue;
		}
		taking++;
		if (char === "?") {
			parts.push({ kind: "?", text: char });
			continue;
		}
		if (char === "[" && !unclosed) {
			let end = i + 1;
			const negated = pattern[end] === "!" || pattern[end] === "^";
			if (negated) end++;
			const start = end;
			// A `]` right after the `[` (or `[!`) is a member.
			if (pattern[end] === "]") end++;
			while (end < pattern.length && pattern[end] !== "]") {
				POSIX_CLASS_RE.lastIndex = end;
				end = POSIX_CLASS_RE.test(pattern) ? POSIX_CLASS_RE.lastIndex : end + 1;
			}
			if (end < pattern.length) {
				const members = pattern.slice(start, end).replace(/\[:(\w+):\]|[\\\]^[]/g, (member, name?: string) => {
					if (name === undefined) return `\\${member}`;
					return Object.hasOwn(POSIX_CLASSES, name) ? POSIX_CLASSES[name] : "\\s\\S";
				});
				parts.push({ kind: "[", text: `[${negated ? "^" : ""}${members}]` });
				i = end;
				continue;
			}
			unclosed = true;
		}
		parts.push({ kind: "char", text: char });
	}
	return taking > limit ? undefined : parts;
}

/**
 * Whether a pathname pattern for one file name (`*`, `?`, `[...]`) matches `name`, ignoring case
 * when the file system does. A leading `.` is matched only by a `.`, as bash matches without
 * `dotglob`, so `*` names no dotfile. A pattern with a bracket expression that makes no valid class
 * (`[z-a]`) is taken to match any name it is not too long for. Every part but `*` takes one
 * character, so `*` only needs the last place it was tried from to go back to: the time is linear
 * in the pattern's length plus the square of the name's, whatever the pattern holds.
 */
function globMatches(pattern: string, name: string): boolean {
	if (!pattern.startsWith(".") && name.startsWith(".")) return false;
	const parts = globParts(pattern, name.length);
	if (parts === undefined) return false;
	const fold = foldsCase();
	// Per part, the test of the character it takes, `undefined` for `*`.
	const tests: (((char: string) => boolean) | undefined)[] = [];
	for (const { kind, text } of parts) {
		if (kind === "*") {
			tests.push(undefined);
		} else if (kind === "?") {
			tests.push(() => true);
		} else if (kind === "char") {
			const literal = fold ? text.toLowerCase() : text;
			tests.push(char => (fold ? char.toLowerCase() : char) === literal);
		} else {
			let members: RegExp;
			try {
				members = new RegExp(text, fold ? "i" : "");
			} catch {
				return true;
			}
			tests.push(char => members.test(char));
		}
	}
	let part = 0;
	let at = 0;
	// After the last `*` passed: the part that follows it, and where in `name` it was last tried.
	let afterStar = -1;
	let retry = 0;
	while (at < name.length) {
		const test = tests[part];
		if (part < tests.length && test === undefined) {
			afterStar = ++part;
			retry = at;
		} else if (test?.(name[at])) {
			part++;
			at++;
		} else if (afterStar >= 0) {
			part = afterStar;
			at = ++retry;
		} else {
			return false;
		}
	}
	while (part < tests.length && tests[part] === undefined) part++;
	return part === tests.length;
}

/** Whether a path component, or a pathname pattern for one (`.netr[c]`), names the file `name`. */
function namesFile(component: string, name: string): boolean {
	if (GLOB_RE.test(component)) return globMatches(component, name);
	return foldsCase() ? component.toLowerCase() === name.toLowerCase() : component === name;
}

/**
 * Whether a file name, or a pathname pattern for one, names a `.env` file that is not a committed
 * template. A pattern names one when what comes before its first wildcard can begin such a name
 * (`.env*`, `.e?v`, `.env.[lp]*`): the wildcard can go on as one. Only a literal `.` matches a
 * leading `.`, so a pattern that starts with a wildcard names none.
 */
function namesDotenv(file: string): boolean {
	const name = foldsCase() ? file.toLowerCase() : file;
	const wildcard = name.search(GLOB_RE);
	if (wildcard < 0) return DOTENV_RE.test(name);
	const prefix = name.slice(0, wildcard);
	return ".env.".startsWith(prefix) ? prefix.startsWith(".") : /^\.env\.[\w.-]*$/.test(prefix);
}

/** The names in an absolute path, root first. */
function pathNames(absPath: string): string[] {
	return path.resolve(absPath).split(path.sep).filter(Boolean);
}

/** A credential file's names, root first ({@link pathNames}), with how an approval names it. */
interface CredentialFileNames {
	names: readonly string[];
	shown: string;
}

/** The system credential files, each with its names read once, as {@link credentialLocation} compares them. */
const SYSTEM_CREDENTIAL_NAMES: readonly CredentialFileNames[] = Object.keys(SYSTEM_CREDENTIAL_FILES).map(file => ({
	names: pathNames(file),
	shown: file,
}));

/** The credential files of a home directory (`~/.netrc`), as {@link credentialLocation} compares them. */
const CREDENTIAL_FILE_NAMES: readonly string[] = Object.keys(CREDENTIAL_FILES);

/** A credential folder of a home directory, with its names and the files in it that are not secret. */
const CREDENTIAL_FOLDERS: readonly {
	folder: string;
	names: readonly string[];
	publicFiles: readonly string[];
}[] = Object.entries(CREDENTIAL_DIRS).map(([folder, publicFiles]) => ({
	folder,
	names: folder.split("/"),
	publicFiles,
}));

/** The longest word {@link expandBraces} expands, and the most words it makes of one; the rest is not checked. */
const MAX_BRACE_WORD_LENGTH = 4096;
const MAX_BRACE_WORDS = 1024;
/**
 * The most characters {@link expandBraces} makes while the guard checks one command line or one
 * file tool call, each string it makes counted with one for the space after it, the strings it
 * makes on the way to the words it returns included: the work of a list of many empty alternatives
 * is what that list makes, not the few characters it ends with. Every rule checks each word made,
 * so this bounds the guard's work on brace lists however many of them a call has; past it no more
 * words are made and the call fails closed ({@link SIZE_LIMIT_HIT}).
 */
const MAX_BRACE_TEXT = 1024 * 1024;
/** What is left of {@link MAX_BRACE_TEXT} for the call being checked, below 0 once passed; each entry point resets it. */
let braceTextLeft = MAX_BRACE_TEXT;
const SIZE_LIMIT_HIT = hit(
	"size_limit",
	`its brace lists make more than ${MAX_BRACE_TEXT / 1024 / 1024}M characters of expansions, past what the guard can check`,
);

/** A word read for brace expansion: literal text, and braces, each the list of its alternatives. */
type BracePart = string | BracePart[][];

/** A sequence brace's body: `1..5`, `a..e`, `0..10..2`. */
const BRACE_SEQUENCE_RE = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/;

/**
 * The words brace expansion makes of `word`: `a{b,c}` gives `ab` and `ac`, `{1..3}` and `{a..c}`
 * give sequences, and nested lists expand too; a brace with neither a top-level `,` nor a sequence,
 * or one after `$`, stays as written. Quotes are not known here: {@link shellBraces} leaves whole a
 * word whose braces the source quoted. A word longer than {@link MAX_BRACE_WORD_LENGTH} stays
 * whole, and at most {@link MAX_BRACE_WORDS} words are made. Once the words made for the command
 * line pass {@link MAX_BRACE_TEXT}, a word stays whole.
 */
function expandBraces(word: string): string[] {
	if (word.length > MAX_BRACE_WORD_LENGTH || !word.includes("{")) return [word];
	// Each `{` with the `}` that closes it and the commas directly inside it.
	const closes = new Map<number, number>();
	const commas = new Map<number, number[]>();
	const open: number[] = [];
	for (let i = 0; i < word.length; i++) {
		if (word[i] === "{") {
			open.push(i);
			commas.set(i, []);
		} else if (word[i] === "}" && open.length > 0) {
			closes.set(open.pop()!, i);
		} else if (word[i] === "," && open.length > 0) {
			commas.get(open.at(-1)!)!.push(i);
		}
	}
	// The alternatives of the brace from `start` to `end`, or `undefined` when it does not expand.
	function alternatives(start: number, end: number): BracePart[][] | undefined {
		const inside = commas.get(start)!;
		if (inside.length > 0) return [start, ...inside].map((at, k) => parts(at + 1, inside[k] ?? end));
		const sequence = BRACE_SEQUENCE_RE.exec(word.slice(start + 1, end));
		if (!sequence) return undefined;
		const numeric = /\d/.test(sequence[1]);
		if (numeric !== /\d/.test(sequence[2])) return undefined;
		const from = numeric ? Number(sequence[1]) : sequence[1].charCodeAt(0);
		const to = numeric ? Number(sequence[2]) : sequence[2].charCodeAt(0);
		const step = (from <= to ? 1 : -1) * (Math.abs(Number(sequence[3] ?? 1)) || 1);
		const items: BracePart[][] = [];
		for (let n = from; (step > 0 ? n <= to : n >= to) && items.length < MAX_BRACE_WORDS; n += step) {
			items.push([numeric ? String(n) : String.fromCharCode(n)]);
		}
		return items;
	}
	function parts(from: number, to: number): BracePart[] {
		const read: BracePart[] = [];
		let text = "";
		for (let i = from; i < to; i++) {
			const end = closes.get(i);
			const brace = end !== undefined && word[i - 1] !== "$" ? alternatives(i, end) : undefined;
			if (brace === undefined) {
				text += word[i];
				continue;
			}
			if (text) read.push(text);
			text = "";
			read.push(brace);
			i = end!;
		}
		if (text) read.push(text);
		return read;
	}
	if (braceTextLeft < 0) return [word];
	const words = braceWords(parts(0, word.length));
	if (words === undefined) {
		braceTextLeft = -1;
		return [word];
	}
	return words;
}

/**
 * The words the shell makes of a word of `command` by brace expansion ({@link expandBraces}); a
 * word whose every `{` the source quoted or escaped (`'{"a":1,"b":2}'`) stays whole, as the shell
 * expands no brace in it.
 */
function shellBraces(command: ShellCommand, word: string): string[] {
	return command.literalBraces.has(word) ? [word] : expandBraces(word);
}

/**
 * The words read `parts` stand for, at most {@link MAX_BRACE_WORDS}, or `undefined` once the
 * strings made for them, the ones for their parts included, pass the {@link braceTextLeft} budget:
 * a part of many empty alternatives (`{,}`) makes a thousand strings and charges each of them.
 */
function braceWords(parts: readonly BracePart[]): string[] | undefined {
	let words = [""];
	for (const part of parts) {
		const options: string[] = [];
		if (typeof part === "string") options.push(part);
		else {
			for (const alternative of part) {
				const made = braceWords(alternative);
				if (made === undefined) return undefined;
				for (const option of made) {
					if (options.length === MAX_BRACE_WORDS) break;
					options.push(option);
					braceTextLeft -= option.length + 1;
					if (braceTextLeft < 0) return undefined;
				}
			}
		}
		const next: string[] = [];
		for (const prefix of words) {
			for (const option of options) {
				next.push(prefix + option);
				braceTextLeft -= prefix.length + option.length + 1;
				if (braceTextLeft < 0) return undefined;
				if (next.length === MAX_BRACE_WORDS) break;
			}
			if (next.length === MAX_BRACE_WORDS) break;
		}
		words = next;
	}
	return words;
}

/**
 * The absolute paths a word of `command` names, one per word its braces expand to
 * ({@link shellBraces}), each resolved from `cwd` as {@link resolveShellWordPath} resolves it, a
 * leading `~` the source quoted kept as a name; those that cannot be resolved, relative ones from an
 * unknown `cwd` included, are left out.
 */
function wordPaths(command: ShellCommand, word: string, cwd: string | undefined, home: string): string[] {
	const literalTilde = command.literalTildes.has(word);
	const paths: string[] = [];
	for (const expanded of shellBraces(command, word)) {
		const target = resolveShellWordPath(literalTilde ? `./${expanded}` : expanded, cwd, home);
		if (target !== undefined) paths.push(target);
	}
	return paths;
}

/**
 * The credential names a guard evaluation compares paths with, read once for it: the names of the
 * home directory `~` names, and of every fixed credential file. Reading them per word makes a
 * command with hundreds of thousands of words take seconds.
 */
interface CredentialIndex {
	/** `~`, as {@link resolveShellWordPath} expands it. */
	home: string;
	/** The names of `home`, root first ({@link pathNames}). */
	homeNames: readonly string[];
	/** The system credential files and omp's own credential stores. */
	fixed: readonly CredentialFileNames[];
}

/** The credential names of a call's `home` and environment ({@link CredentialIndex}). */
function credentialIndex(home: string): CredentialIndex {
	return {
		home,
		homeNames: pathNames(home),
		fixed: [
			...SYSTEM_CREDENTIAL_NAMES,
			...ompCredentialStores().map(file => ({ names: pathNames(file), shown: `omp's credential store ${file}` })),
		],
	};
}

/**
 * The credential location a path's names are in, for display; `undefined` when they hold no
 * credentials. Public files in a credential folder (`~/.ssh/config`, `*.pub`) do not count. A
 * component that is a pathname pattern (`~/.ss?/id_*`, `~/.netr[c]`) counts when it can name the
 * location, and names are compared without regard to case where the file system does so
 * ({@link foldsCase}). Paths are compared as written: a symlink to a location is not followed.
 */
function credentialLocation(names: readonly string[], index: CredentialIndex): string | undefined {
	for (const { names: fileNames, shown } of index.fixed) {
		if (names.length === fileNames.length && fileNames.every((name, k) => namesFile(names[k], name))) return shown;
	}
	const { homeNames } = index;
	if (names.length <= homeNames.length || !homeNames.every((name, k) => namesFile(names[k], name))) return undefined;
	const rest = names.slice(homeNames.length);
	for (const file of CREDENTIAL_FILE_NAMES) {
		if (rest.length === 1 && namesFile(rest[0], file)) return `~/${file}`;
	}
	for (const { folder, names: folderNames, publicFiles } of CREDENTIAL_FOLDERS) {
		if (rest.length < folderNames.length || !folderNames.every((name, k) => namesFile(rest[k], name))) continue;
		// Bare wildcards for every component (`~/*/*/package.json`) name any folder, not this one.
		if (!folderNames.some((_, k) => /[^*?]/.test(rest[k]))) continue;
		const name = foldsCase() ? rest.at(-1)!.toLowerCase() : rest.at(-1)!;
		// A public file of this folder; a pattern can still name a secret of a later one (`~/.*/config`).
		if (rest.length > folderNames.length && (publicFiles.includes(name) || name.endsWith(".pub"))) continue;
		return `~/${folder}`;
	}
	return undefined;
}

/**
 * The secret a word of `command`, resolved from `cwd`, names when it is sent somewhere: a
 * credential file, a `.env`, or a process environment, also through braces and pathname patterns
 * (`.env*`, `~/.{netrc,x}`). From an unknown `cwd`, a relative `.env` still counts by its name.
 */
function sentSecret(
	command: ShellCommand,
	word: string,
	cwd: string | undefined,
	credentials: CredentialIndex,
): string | undefined {
	for (const target of wordPaths(command, word, cwd, credentials.home)) {
		const names = pathNames(target);
		if (namesDotenv(names.at(-1) ?? "")) return path.basename(target);
		if (names.length === 3 && namesFile(names[0], "proc") && namesFile(names[2], "environ")) {
			return "the process environment";
		}
		const found = credentialLocation(names, credentials);
		if (found) return found;
	}
	if (cwd === undefined) {
		for (const target of wordPaths(command, word, path.sep, credentials.home)) {
			if (namesDotenv(path.basename(target))) return path.basename(target);
		}
	}
	return undefined;
}

// -- command helpers ---------------------------------------------------------------------------------

function args(command: ShellCommand): string[] {
	return command.argv.slice(1);
}

/** Commands that put a file's content on their output or in another file. */
const READERS: Record<string, true> = {
	cat: true,
	less: true,
	more: true,
	head: true,
	tail: true,
	bat: true,
	base64: true,
	xxd: true,
	od: true,
	hexdump: true,
	strings: true,
	cp: true,
	scp: true,
	rsync: true,
	tar: true,
	zip: true,
	"7z": true,
	gzip: true,
	bzip2: true,
	xz: true,
	grep: true,
	rg: true,
	sed: true,
	awk: true,
	nl: true,
	sort: true,
	uniq: true,
	openssl: true,
	gpg: true,
	curl: true,
	wget: true,
	nc: true,
	ncat: true,
	mv: true,
};

/** Options of `scp` and `rsync` that take the next word as their value (`-i key`, `--rsh cmd`). */
const COPY_VALUE_OPTIONS: Record<string, readonly string[]> = {
	scp: ["-c", "-D", "-F", "-i", "-J", "-l", "-o", "-P", "-S", "-X"],
	rsync: [
		"-B",
		"-e",
		"-f",
		"-M",
		"-T",
		"-@",
		"--address",
		"--backup-dir",
		"--block-size",
		"--bwlimit",
		"--checksum-choice",
		"--checksum-seed",
		"--chmod",
		"--chown",
		"--compare-dest",
		"--compress-choice",
		"--compress-level",
		"--contimeout",
		"--copy-as",
		"--copy-dest",
		"--debug",
		"--early-input",
		"--exclude",
		"--exclude-from",
		"--files-from",
		"--filter",
		"--groupmap",
		"--iconv",
		"--include",
		"--include-from",
		"--info",
		"--link-dest",
		"--log-file",
		"--log-file-format",
		"--max-alloc",
		"--max-delete",
		"--max-size",
		"--min-size",
		"--modify-window",
		"--only-write-batch",
		"--out-format",
		"--outbuf",
		"--partial-dir",
		"--password-file",
		"--port",
		"--protocol",
		"--read-batch",
		"--remote-option",
		"--rsh",
		"--rsync-path",
		"--skip-compress",
		"--sockopts",
		"--stderr",
		"--stop-after",
		"--stop-at",
		"--suffix",
		"--temp-dir",
		"--timeout",
		"--usermap",
		"--write-batch",
	],
};
/** A remote `scp`/`rsync` operand: `host:path`, `user@host:path`, `host::module`, `scp://`, `rsync://`. */
const REMOTE_OPERAND_RE = /^[^/]*:/;

/** The operands of a `scp`/`rsync` command, sources first and the destination last; option values are not operands. */
function copyOperands(command: ShellCommand): string[] {
	const valued = COPY_VALUE_OPTIONS[command.argv[0]];
	const argv = args(command);
	const operands: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			append(
				operands,
				argv.slice(i + 1).flatMap(word => shellBraces(command, word)),
			);
			break;
		}
		if (arg.startsWith("--")) {
			if (!arg.includes("=") && valued.includes(arg)) i++;
		} else if (arg.startsWith("-") && arg.length > 1) {
			// In a bundle (`-rvi key`, `-ikey`), the first letter that takes a value takes the rest of
			// the word, or the next word when it ends the bundle.
			let k = 1;
			while (k < arg.length && !valued.includes(`-${arg[k]}`)) k++;
			if (k === arg.length - 1) i++;
		} else {
			append(operands, shellBraces(command, arg));
		}
	}
	return operands;
}

/** tar's one-letter options that take a value; in a bundle, the first of them takes the rest of the word. */
const TAR_VALUE_LETTERS = "bCfFgHIKLNTVX";
/**
 * tar's long options that take a separate value word (`--file x.tar`), besides `--directory`: true
 * when the value counts as read (the archive, a member list), false for an exclusion, whose paths
 * tar leaves out.
 */
const TAR_VALUE_OPTIONS: Record<string, boolean> = {
	"--file": true,
	"--files-from": true,
	"--exclude": false,
	"--exclude-from": false,
};
/** tar's letter for an exclusion list (`-X list`), whose paths tar leaves out. */
const TAR_EXCLUDE_LETTER = "X";
/** tar's one-letter operations whose members name entries of the archive, not files tar reads: extract and list. */
const TAR_ENTRY_LETTERS = "xt";
/**
 * tar's long operations whose members name entries of the archive, not files tar reads, each with
 * the shortest abbreviation GNU tar takes for it (`--ex` could also be `--exclude`).
 */
const TAR_ENTRY_OPTIONS: Record<string, string> = {
	"--extract": "--ext",
	"--get": "--ge",
	"--list": "--list",
	"--delete": "--dele",
};

/**
 * The files a `tar` command reads ({@link ReadWords}): its archive and member lists, and its
 * members, those after a `-C`/`--directory` in `moved`, as the guard does not follow the directory
 * tar changes to. A member's braces are expanded when it is checked, as the shell expands them
 * before tar sees the member (`{/etc/shadow,x}`). Option values stay as written, and exclusions are
 * left out. An extraction, listing or deletion (`x`, `t`, `--delete`) reads only the archive and the
 * member lists: its members name entries of the archive, not files.
 */
function tarReadWords(command: ShellCommand): ReadWords {
	const argv = args(command);
	const words: string[] = [];
	const members: string[] = [];
	const moved: string[] = [];
	let entries = false;
	let changed = false;
	let i = 0;
	// An old-style first word (`tar cfC x.tar ~ .ssh`): each letter that takes a value takes the next word.
	if (argv.length > 0 && !argv[0].startsWith("-")) {
		const letters = argv[i++];
		for (const letter of letters) {
			entries ||= TAR_ENTRY_LETTERS.includes(letter);
			if (!TAR_VALUE_LETTERS.includes(letter) || i >= argv.length) continue;
			const value = argv[i++];
			if (letter === "C") changed = true;
			else if (letter !== TAR_EXCLUDE_LETTER) words.push(value);
		}
	}
	let options = true;
	for (; i < argv.length; i++) {
		const arg = argv[i];
		if (options && arg === "--") {
			options = false;
		} else if (options && arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const flag = eq > 0 ? arg.slice(0, eq) : arg;
			// The shell expands no `~` in a value attached to its option (`--file=~/x`).
			const value = eq > 0 ? attachedValue(arg.slice(eq + 1)) : undefined;
			// GNU tar takes any unambiguous abbreviation: `--dir`, `--direc`.
			if (flag.length >= 5 && "--directory".startsWith(flag)) {
				if (value === undefined) i++;
				changed = true;
			} else if (Object.hasOwn(TAR_VALUE_OPTIONS, flag)) {
				const target = value ?? argv[++i];
				if (target !== undefined && TAR_VALUE_OPTIONS[flag]) words.push(target);
			} else {
				entries ||= Object.entries(TAR_ENTRY_OPTIONS).some(
					([full, shortest]) => flag.startsWith(shortest) && full.startsWith(flag),
				);
			}
		} else if (options && arg.startsWith("-") && arg.length > 1) {
			let k = 1;
			for (; k < arg.length && !TAR_VALUE_LETTERS.includes(arg[k]); k++) {
				entries ||= TAR_ENTRY_LETTERS.includes(arg[k]);
			}
			if (k === arg.length) continue;
			const value = k + 1 < arg.length ? attachedValue(arg.slice(k + 1)) : argv[++i];
			if (value === undefined) continue;
			if (arg[k] === "C") changed = true;
			else if (arg[k] !== TAR_EXCLUDE_LETTER) words.push(value);
		} else {
			(changed ? moved : members).push(arg);
		}
	}
	if (entries) return { words, moved: [] };
	return { words: [...words, ...members], moved };
}

/**
 * Readers whose first operand is a pattern or program, not a file, unless an option supplies one:
 * per such option, whether its value is the pattern itself or a file read for it. `valued` lists
 * the other options that take the next word as their value, only those that take one in every
 * common implementation, so that no file is mistaken for an option value. `switches` lists the
 * long options that take no value whose name begins that of one that does (`--binary`,
 * `--binary-files`). `suffixed` lists the one-letter options whose optional value is only the
 * rest of their word (`sed -i.bak`). `walks` says when a search given no file reads the directory
 * it runs in: `"always"` (`rg`, unless its input is piped or redirected, which it reads instead),
 * or after one of `flags` (`grep -r`) or one of `recurse` with the value `recurse`
 * (`grep -d recurse`).
 */
const PATTERN_READERS: Record<
	string,
	{
		supplies: Record<string, "pattern" | "file">;
		valued: readonly string[];
		switches?: readonly string[];
		suffixed?: readonly string[];
		walks?: "always" | { flags: readonly string[]; recurse: readonly string[] };
	}
> = {
	grep: {
		supplies: { "-e": "pattern", "--regexp": "pattern", "-f": "file", "--file": "file" },
		walks: { flags: ["-r", "-R", "--recursive", "--dereference-recursive"], recurse: ["-d", "--directories"] },
		switches: ["--binary"],
		valued: [
			"-A",
			"-B",
			"-C",
			"-D",
			"-d",
			"-m",
			"--after-context",
			"--before-context",
			"--binary-files",
			"--context",
			"--devices",
			"--directories",
			"--exclude",
			"--exclude-dir",
			"--exclude-from",
			"--group-separator",
			"--include",
			"--label",
			"--max-count",
		],
	},
	rg: {
		supplies: { "-e": "pattern", "--regexp": "pattern", "-f": "file", "--file": "file" },
		walks: "always",
		switches: ["--ignore"],
		valued: [
			"-A",
			"-B",
			"-C",
			"-d",
			"-E",
			"-g",
			"-j",
			"-M",
			"-m",
			"-r",
			"-T",
			"-t",
			"--after-context",
			"--before-context",
			"--color",
			"--colors",
			"--context",
			"--encoding",
			"--glob",
			"--iglob",
			"--ignore-file",
			"--max-columns",
			"--max-count",
			"--max-depth",
			"--max-filesize",
			"--pre",
			"--pre-glob",
			"--replace",
			"--sort",
			"--sortr",
			"--threads",
			"--type",
			"--type-add",
			"--type-not",
		],
	},
	sed: {
		supplies: { "-e": "pattern", "--expression": "pattern", "-f": "file", "--file": "file" },
		valued: [],
		suffixed: ["-i"],
	},
	awk: {
		supplies: { "-e": "pattern", "--source": "pattern", "-f": "file", "--file": "file" },
		valued: ["-F", "-v", "--assign", "--field-separator"],
	},
};

/**
 * The words a {@link PATTERN_READERS} command reads files from: its operands, without the first
 * when no option supplied the pattern, and a pattern file. A long option is the known one it names
 * in full, flags included, or else the one it alone abbreviates (`--reg=x`, `--fil x`, `--cont 2`,
 * `--rec`), as GNU getopt reads it: grep's `--binary` is a flag, not `--binary-files`. A search
 * with a pattern and no file operand that reads the directory it runs in ({@link PATTERN_READERS}
 * `walks`) reads `.`; one with no pattern (`rg --files`, `rg --version`) searches nothing.
 */
function patternReaderWords(command: ShellCommand): string[] {
	const { supplies, valued, switches = [], suffixed = [], walks } = PATTERN_READERS[command.argv[0]];
	const supplier = (option: string) => (Object.hasOwn(supplies, option) ? supplies[option] : undefined);
	const flags = walks === undefined || walks === "always" ? [] : walks.flags;
	const known = [...Object.keys(supplies), ...valued, ...switches, ...flags];
	const argv = args(command);
	const words: string[] = [];
	const operands: string[] = [];
	let supplied = false;
	let recursive = false;
	// The value of an option that takes one: a pattern file is read, a pattern is not.
	const take = (option: string, value: string | undefined) => {
		const kind = supplier(option);
		supplied ||= kind !== undefined;
		if (kind === "file" && value !== undefined) words.push(value);
		// GNU grep takes an abbreviated value (`-d rec`) once it names one choice alone.
		if (walks !== undefined && walks !== "always" && walks.recurse.includes(option) && value !== undefined) {
			recursive ||= value.length >= 3 && "recurse".startsWith(value);
		}
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			append(
				operands,
				argv.slice(i + 1).flatMap(word => shellBraces(command, word)),
			);
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const written = eq > 0 ? arg.slice(0, eq) : arg;
			const named = known.filter(option => option.startsWith(written));
			const name = known.includes(written) || named.length !== 1 ? written : named[0];
			if (supplier(name) !== undefined || valued.includes(name)) take(name, eq > 0 ? arg.slice(eq + 1) : argv[++i]);
			else recursive ||= flags.includes(name);
		} else if (arg.startsWith("-") && arg.length > 1) {
			// In a bundle (`-rne x`, `-A3`), the first letter that takes a value takes the rest of
			// the word, or the next word when it ends the bundle; a suffix option (`sed -i.bak`) takes
			// only the rest of the word.
			for (let k = 1; k < arg.length; k++) {
				const option = `-${arg[k]}`;
				if (suffixed.includes(option)) break;
				recursive ||= flags.includes(option);
				if (supplier(option) === undefined && !valued.includes(option)) continue;
				take(option, k + 1 < arg.length ? arg.slice(k + 1) : argv[++i]);
				break;
			}
		} else {
			append(operands, shellBraces(command, arg));
		}
	}
	const files = operands.slice(supplied ? 0 : 1);
	const walksCwd = walks === "always" ? !command.fedInput : recursive;
	if (files.length === 0 && (supplied || operands.length > 0) && walksCwd) files.push(".");
	return [...words, ...files];
}

/**
 * curl's one-letter options that take a value. In a bundle (`-sd @file`), the first of them takes
 * the rest of the word, or the next word when it ends the bundle.
 */
const CURL_VALUE_LETTERS = "AbCcDdEeFHKmoPQrTtUuwXxYyz";
/**
 * Long options of readers whose value is a key, certificate, netrc file or key folder the program
 * authenticates, verifies or keeps its keys with (`curl --key`, `wget --private-key`,
 * `gpg --homedir`), or a socket it connects to (`curl --unix-socket`): it neither prints nor
 * copies the value, as `scp -i` does not, so the value is not read.
 */
const KEY_VALUE_OPTIONS: Record<string, readonly string[]> = {
	curl: [
		"--abstract-unix-socket",
		"--cacert",
		"--capath",
		"--cert",
		"--crlfile",
		"--key",
		"--netrc-file",
		"--pinnedpubkey",
		"--proxy-cacert",
		"--proxy-capath",
		"--proxy-cert",
		"--proxy-crlfile",
		"--proxy-key",
		"--proxy-pinnedpubkey",
		"--pubkey",
		"--unix-socket",
	],
	wget: ["--ca-certificate", "--ca-directory", "--certificate", "--crl-file", "--pinnedpubkey", "--private-key"],
	gpg: ["--homedir"],
};
/**
 * Readers that also write files, whose options the guard reads in full: their one-letter options
 * that take a value (in a bundle, the first of them takes the rest of the word, or the next word
 * when it ends the bundle), the options whose value they write to (`writes`) or read (`reads`),
 * the other long options that take the next word as their value (`valued`), whether a last operand
 * without `-t` is the destination (a copy), and whether their operands are URLs, not files (a
 * download). Each takes a long option's value after an `=` too, curl since 8.16.
 */
const WRITING_READERS: Record<
	string,
	{
		letters: string;
		writes: readonly string[];
		reads?: readonly string[];
		valued?: readonly string[];
		destination?: true;
		urls?: true;
	}
> = {
	curl: {
		letters: CURL_VALUE_LETTERS,
		writes: [
			"-c",
			"-D",
			"-o",
			"--cookie-jar",
			"--dump-header",
			"--etag-save",
			"--libcurl",
			"--output",
			"--output-dir",
			"--stderr",
			"--trace",
			"--trace-ascii",
		],
		reads: ["-K", "--config"],
		urls: true,
	},
	wget: {
		letters: "aABDeiIlnoOPQRtTUwX",
		writes: [
			"-a",
			"-o",
			"-O",
			"-P",
			"--append-output",
			"--directory-prefix",
			"--output-document",
			"--output-file",
			"--save-cookies",
		],
		reads: ["-i", "--input-file"],
		urls: true,
	},
	cp: { letters: "St", writes: ["-t", "--target-directory"], valued: ["--suffix"], destination: true },
	mv: { letters: "St", writes: ["-t", "--target-directory"], valued: ["--suffix"], destination: true },
	sort: {
		letters: "kotST",
		writes: ["-o", "--output"],
		valued: ["--key", "--field-separator", "--buffer-size", "--temporary-directory"],
	},
};

/**
 * The words a {@link WRITING_READERS} command reads: the values of its `reads` options and its
 * operands (none for a download), without what it writes to and the values of its other options,
 * {@link KEY_VALUE_OPTIONS} included. A value after an `=` or in its option's word gets no tilde
 * expansion ({@link attachedValue}).
 */
function writingReaderWords(command: ShellCommand): string[] {
	const { letters, writes, reads = [], valued = [], destination, urls } = WRITING_READERS[command.argv[0]];
	const keys = Object.hasOwn(KEY_VALUE_OPTIONS, command.argv[0]) ? KEY_VALUE_OPTIONS[command.argv[0]] : [];
	const argv = args(command);
	const words: string[] = [];
	const operands: string[] = [];
	let targeted = false;
	// The value of an option that takes one: where the command writes, a file it reads, or neither.
	const take = (option: string, value: string | undefined) => {
		if (writes.includes(option)) targeted = true;
		else if (reads.includes(option) && value !== undefined) words.push(value);
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			if (!urls) {
				append(
					operands,
					argv.slice(i + 1).flatMap(word => shellBraces(command, word)),
				);
			}
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (eq > 0) take(arg.slice(0, eq), attachedValue(arg.slice(eq + 1)));
			else if ([writes, reads, valued, keys].some(options => options.includes(arg))) take(arg, argv[++i]);
		} else if (arg.startsWith("-") && arg.length > 1) {
			let k = 1;
			while (k < arg.length && !letters.includes(arg[k])) k++;
			if (k < arg.length) take(`-${arg[k]}`, k + 1 < arg.length ? attachedValue(arg.slice(k + 1)) : argv[++i]);
		} else if (!urls) {
			append(operands, shellBraces(command, arg));
		}
	}
	if (destination && !targeted) operands.pop();
	return [...words, ...operands];
}

/**
 * Options of plain readers whose value is a file they write, not read (`openssl genrsa -out
 * ~/.ssh/deploy.pem`, `gpg --output pub.asc --export`), as each reader spells them: openssl takes
 * its long options after one dash or two.
 */
const READER_OUTPUT_OPTIONS: Record<string, readonly string[]> = {
	openssl: ["-out", "--out", "-keyout", "--keyout"],
	gpg: ["-o", "--output"],
};

/** A number, maybe with a `+` or a unit (`5`, `+5`, `1K`): after an option, the option's value. */
const OPTION_NUMBER_RE = /^\+?\d+[A-Za-z]*$/;

/**
 * A plain reader's operands: its arguments without its options (`cat -n` names no file `-n`), and
 * without the values of its {@link KEY_VALUE_OPTIONS} (long options only) and
 * {@link READER_OUTPUT_OPTIONS}, given in the next word or after an `=`. Another option takes no
 * word, as the guard does not know which options take one, except a number right after it
 * ({@link OPTION_NUMBER_RE}: `head -n 5`, `tail -c +1K`), which is taken for its value.
 */
function readerArgs(command: ShellCommand): string[] {
	const name = command.argv[0];
	const argv = args(command);
	const keys = Object.hasOwn(KEY_VALUE_OPTIONS, name) ? KEY_VALUE_OPTIONS[name] : [];
	const outputs = Object.hasOwn(READER_OUTPUT_OPTIONS, name) ? READER_OUTPUT_OPTIONS[name] : [];
	const words: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			append(words, argv.slice(i + 1));
			break;
		}
		const eq = arg.indexOf("=");
		const option = eq > 0 ? arg.slice(0, eq) : arg;
		if ((arg.startsWith("--") && keys.includes(option)) || outputs.includes(option)) {
			if (eq < 0) i++;
		} else if (!arg.startsWith("-") && !(OPTION_NUMBER_RE.test(arg) && argv[i - 1]?.startsWith("-"))) {
			words.push(arg);
		}
	}
	return words;
}

/** A URL (`https://host/x`, `hkps://keys.example`), which names no local file. */
const URL_RE = /^[a-z][a-z\d+.-]*:\/\//i;

/** The files a reading command reads, as written ({@link readWords}). */
interface ReadWords {
	/** Read from where the command runs. */
	words: string[];
	/**
	 * Read from a directory the guard does not follow, a `tar`'s members after a `-C`
	 * ({@link tarReadWords}): checked as from an unknown directory, where only an absolute path
	 * resolves and a `.env` counts by its name ({@link sentSecret}).
	 */
	moved: string[];
}

/**
 * The words a reading command reads files from: a copy's local sources, a search's operands after
 * its pattern, the files a download reads (`curl -K`, `wget -i`) but not where it saves, any other
 * reader's operands; never `-` (standard input) or a URL. The value of an option that names a key
 * it authenticates with is not read ({@link KEY_VALUE_OPTIONS}).
 */
function readWords(command: ShellCommand): ReadWords {
	const name = command.argv[0];
	let words: string[];
	let moved: string[] = [];
	if (name === "tar") {
		({ words, moved } = tarReadWords(command));
	} else if (Object.hasOwn(COPY_VALUE_OPTIONS, name)) {
		words = copyOperands(command)
			.slice(0, -1)
			.filter(operand => !REMOTE_OPERAND_RE.test(operand));
	} else if (Object.hasOwn(PATTERN_READERS, name)) {
		words = patternReaderWords(command);
	} else if (Object.hasOwn(WRITING_READERS, name)) {
		words = writingReaderWords(command);
	} else {
		words = Object.hasOwn(READERS, name) ? readerArgs(command) : [];
	}
	return { words: words.filter(word => word !== "-" && !URL_RE.test(word)), moved };
}

// -- credential_read ---------------------------------------------------------------------------------

/** The options of `security find-generic-password`/`find-internet-password` that take a value. */
const KEYCHAIN_VALUE_LETTERS = "acCdDGjlpPrst";

/**
 * Whether a `security` command prints a keychain password: `find-generic-password` or
 * `find-internet-password` with `-w` (the password alone) or `-g` (with the item), also in a bundle
 * (`-ga`) up to a letter that takes a value. `add-*-password -w` gives the password to store.
 */
function printsKeychainPassword(argv: readonly string[]): boolean {
	if (!/^find-\w+-password$/.test(argv[1] ?? "")) return false;
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i];
		if (!/^-[A-Za-z]+$/.test(arg)) continue;
		for (let k = 1; k < arg.length; k++) {
			if (arg[k] === "w" || arg[k] === "g") return true;
			if (KEYCHAIN_VALUE_LETTERS.includes(arg[k])) {
				if (k === arg.length - 1) i++;
				break;
			}
		}
	}
	return false;
}

function credentialRead(command: ShellCommand, credentials: CredentialIndex): GuardHit | undefined {
	const name = command.argv[0];
	const first = command.argv[1] ?? "";
	if (name === "security" && (first === "dump-keychain" || first === "export")) {
		return hit("credential_read", "it exports the keychain");
	}
	if (name === "security" && printsKeychainPassword(command.argv)) {
		return hit("credential_read", "it prints a keychain password");
	}
	if (name === "gpg" && args(command).some(arg => arg.startsWith("--export-secret"))) {
		return hit("credential_read", "it exports private keys");
	}
	// Its arguments are read from where it runs, its `<` redirections from where the shell opens them.
	const { words, moved } = readWords(command);
	const sources = [
		{ words, cwd: command.cwd },
		{ words: moved, cwd: undefined },
		{ words: command.reads, cwd: command.shellCwd },
	];
	for (const { words, cwd } of sources) {
		for (const word of words) {
			for (const target of wordPaths(command, word, cwd, credentials.home)) {
				const found = credentialLocation(pathNames(target), credentials);
				if (found) return hit("credential_read", `it reads your credentials in ${found}`);
			}
		}
	}
	return undefined;
}

// -- secret_send -------------------------------------------------------------------------------------

const SENDERS: Record<string, true> = {
	curl: true,
	wget: true,
	http: true,
	https: true,
	xh: true,
	nc: true,
	ncat: true,
	netcat: true,
	socat: true,
	telnet: true,
	ftp: true,
	sftp: true,
	scp: true,
	rsync: true,
};
const CURL_DATA_OPTIONS: Record<string, true> = {
	"-d": true,
	"--data": true,
	"--data-binary": true,
	"--data-urlencode": true,
	"--data-ascii": true,
	"--json": true,
	"-F": true,
	"--form": true,
	"-T": true,
	"--upload-file": true,
};
/**
 * wget's options that send a file, as `--post-file=file` or `--post-file file`, each with the
 * shortest abbreviation wget takes for it (`--post-` could also be `--post-data`).
 */
const WGET_FILE_OPTIONS: Record<string, string> = { "--post-file": "--post-f", "--body-file": "--body-f" };

/**
 * The files a curl `-F` field reads after an `@` or `<` right after its `=`: a list split by `,` and
 * ended by `;` (where the field's options start), each name possibly double-quoted
 * (`f=@"a,b.txt",.env;type=text/plain`). A field with other text after its `=` is sent as written.
 */
function formFiles(value: string): string[] {
	const eq = value.indexOf("=");
	if (eq < 0 || (value[eq + 1] !== "@" && value[eq + 1] !== "<")) return [];
	const files: string[] = [];
	let i = eq + 2;
	for (;;) {
		let file = "";
		if (value[i] === '"') {
			for (i++; i < value.length && value[i] !== '"'; i++) {
				if (value[i] === "\\" && i + 1 < value.length) i++;
				file += value[i];
			}
		}
		for (; i < value.length && value[i] !== "," && value[i] !== ";"; i++) {
			if (value[i] !== '"') file += value[i];
		}
		files.push(file);
		if (value[i] !== ",") return files;
		i++;
	}
}

/** The local files a network command sends through its arguments. */
function sentFiles(command: ShellCommand): string[] {
	const name = command.argv[0];
	const argv = args(command);
	const files: string[] = [];
	if (name === "curl") {
		for (let i = 0; i < argv.length; i++) {
			const arg = argv[i];
			let option: string;
			let value: string | undefined;
			// The word the value is in, which tells whether the source quoted its braces.
			let source: string | undefined = arg;
			if (arg.startsWith("--")) {
				const eq = arg.indexOf("=");
				option = eq > 0 ? arg.slice(0, eq) : arg;
				if (!Object.hasOwn(CURL_DATA_OPTIONS, option)) continue;
				if (eq < 0) source = argv[++i];
				value = eq > 0 ? arg.slice(eq + 1) : source;
			} else if (arg.startsWith("-") && arg.length > 1) {
				let k = 1;
				while (k < arg.length && !CURL_VALUE_LETTERS.includes(arg[k])) k++;
				if (k === arg.length) continue;
				option = `-${arg[k]}`;
				if (k + 1 === arg.length) source = argv[++i];
				value = k + 1 < arg.length ? arg.slice(k + 1) : source;
				if (!Object.hasOwn(CURL_DATA_OPTIONS, option)) continue;
			} else {
				continue;
			}
			if (value === undefined || source === undefined) continue;
			if (option === "-T" || option === "--upload-file") {
				// curl globs the value itself, quoted or not: `-T "{a,b}"` uploads each file of the list,
				// and curl reads a set of one, `-T "{.env}"`, as its file.
				append(files, expandBraces(value.replace(/\{([^{},]*)\}/g, "$1")));
			} else if (option === "-F" || option === "--form") {
				// The shell brace-expands an unquoted field as it does a `-d @file` value (`f=@{a,.env}`).
				for (const field of command.literalBraces.has(source) ? [value] : expandBraces(value)) {
					append(files, formFiles(field));
				}
			} else if (option === "--data-urlencode") {
				// `name@file` or `@file`; after an `=`, the rest is the content.
				const at = value.indexOf("@");
				const eq = value.indexOf("=");
				if (at >= 0 && (eq < 0 || at < eq)) files.push(value.slice(at + 1));
			} else if (value.startsWith("@")) {
				files.push(value.slice(1).split(";")[0]);
			}
		}
	} else if (name === "wget") {
		for (let i = 0; i < argv.length; i++) {
			const eq = argv[i].indexOf("=");
			const option = eq > 0 ? argv[i].slice(0, eq) : argv[i];
			const sends = Object.entries(WGET_FILE_OPTIONS).some(
				([full, shortest]) => option.startsWith(shortest) && full.startsWith(option),
			);
			if (!sends) continue;
			const value = eq > 0 ? argv[i].slice(eq + 1) : argv[++i];
			if (value !== undefined) files.push(value);
		}
	} else if (name === "http" || name === "https" || name === "xh") {
		// A request item's separator is the first run of `:`, `=` and `@` in it; one that ends in `@`
		// reads a file: `field@file` (a form upload), `field=@file`, `field:=@file`, `@file`.
		for (const arg of argv) {
			if (arg.startsWith("-")) continue;
			const separator = /[:=@]+/.exec(arg);
			if (separator?.[0].endsWith("@")) files.push(arg.slice(separator.index + separator[0].length).split(";")[0]);
		}
	} else if (Object.hasOwn(COPY_VALUE_OPTIONS, name)) {
		// Only a copy to a remote destination sends anything; a local copy or a download does not.
		const operands = copyOperands(command);
		const destination = operands.at(-1);
		if (operands.length > 1 && destination !== undefined && REMOTE_OPERAND_RE.test(destination)) {
			append(
				files,
				operands.slice(0, -1).filter(operand => !REMOTE_OPERAND_RE.test(operand)),
			);
		}
	}
	return files;
}

/**
 * Whether a command prints the environment: `printenv` with no names, `env` with no command, and the
 * builtins that list exported variables when given no names: `export` (`-p`, `-n`),
 * `declare`/`typeset` (`-p`, `-x`), and a bare `set`.
 */
function dumpsEnvironment(command: ShellCommand): boolean {
	const [name, ...rest] = command.argv;
	if (name === "printenv" || name === "env") return shellPositionalArgs(command.argv).length === 0;
	if (name === "export") return rest.every(arg => /^-[pn]+$/.test(arg));
	if (name === "declare" || name === "typeset") return rest.every(arg => /^-[px]+$/.test(arg));
	return name === "set" && rest.length === 0;
}

/** The first secret one of `words` of `command` names, each resolved from `cwd` ({@link sentSecret}). */
function firstSecret(
	command: ShellCommand,
	words: readonly string[],
	cwd: string | undefined,
	credentials: CredentialIndex,
): string | undefined {
	for (const word of words) {
		const found = sentSecret(command, word, cwd, credentials);
		if (found) return found;
	}
	return undefined;
}

/**
 * The secret a command puts on its output: the environment, or a credential or `.env` file it
 * reads, through its arguments from where it runs or its `<` redirections from where the shell opens them.
 */
function secretOutput(command: ShellCommand, credentials: CredentialIndex): string | undefined {
	if (dumpsEnvironment(command)) return "the environment";
	const { words, moved } = command.argv[0] === "source" ? { words: args(command), moved: [] } : readWords(command);
	return (
		firstSecret(command, command.reads, command.shellCwd, credentials) ??
		firstSecret(command, words, command.cwd, credentials) ??
		firstSecret(command, moved, undefined, credentials)
	);
}

/**
 * A network command sending a secret: on its input from a `<` redirection, in a file it uploads, or
 * `upstream`, the secret an earlier stage of its pipeline puts on its output.
 */
function secretSend(
	command: ShellCommand,
	upstream: string | undefined,
	credentials: CredentialIndex,
): GuardHit | undefined {
	const found =
		firstSecret(command, command.reads, command.shellCwd, credentials) ??
		firstSecret(command, sentFiles(command), command.cwd, credentials) ??
		upstream;
	return found ? hit("secret_send", `it sends ${found} over the network (\`${command.argv[0]}\`)`) : undefined;
}

// -- entry points ------------------------------------------------------------------------------------

/**
 * The first fixed rule each pipeline of a shell command line breaks, `undefined` for one that
 * breaks none, one entry per pipeline {@link parseShellCommands} finds, in order: `secret_send`
 * across the pipeline first, then `credential_read`. Each pipeline is checked from the directory
 * the ones before it leave.
 */
export function findPipelineGuardHits(command: string, scope: GuardScope): (GuardHit | undefined)[] {
	braceTextLeft = MAX_BRACE_TEXT;
	const credentials = credentialIndex(scope.home);
	return parseShellCommands(command, scope).map(pipeline => {
		// The first secret a stage before the sender being checked puts out; each stage is read once.
		let upstream: string | undefined;
		let read = 0;
		for (const [index, sender] of pipeline.entries()) {
			if (!Object.hasOwn(SENDERS, sender.argv[0])) continue;
			for (; read < index && upstream === undefined; read++) upstream = secretOutput(pipeline[read], credentials);
			const found = secretSend(sender, upstream, credentials);
			if (found) return found;
		}
		for (const reader of pipeline) {
			const found = credentialRead(reader, credentials);
			if (found) return found;
		}
		return undefined;
	});
}

/**
 * The first fixed rule a shell command line breaks ({@link findPipelineGuardHits}), or
 * `undefined`. A command line whose brace lists expand past {@link MAX_BRACE_TEXT} and that breaks
 * no rule fails closed (`size_limit`).
 */
export function findShellGuardHit(command: string, scope: GuardScope): GuardHit | undefined {
	const found = findPipelineGuardHits(command, scope).find(pipelineHit => pipelineHit !== undefined);
	return found ?? (braceTextLeft < 0 ? SIZE_LIMIT_HIT : undefined);
}

/**
 * Applies `credential_read` to a file tool (`read`, `grep`): when any target path is in a
 * credential location, the call keeps `tier` but carries a safety override, like a critical bash
 * command. A path's brace lists are expanded first, as a search's glob matcher expands them
 * (`~/.{netrc,x}`), failing closed past {@link MAX_BRACE_TEXT}. A database path with a table or
 * query selector (`agent.db:table`, `agent.db?q=...`) targets the database file. Internal and web
 * URLs are not files and never match.
 */
export function fileToolApproval(tier: ToolTier, rawPaths: readonly string[], cwd: string): ToolApprovalDecision {
	const router = InternalUrlRouter.instance();
	const credentials = credentialIndex(os.homedir());
	braceTextLeft = MAX_BRACE_TEXT;
	for (const rawPath of rawPaths) {
		const filePaths = [
			splitPathAndSel(rawPath).path,
			...parseSqlitePathCandidates(rawPath).map(candidate => candidate.sqlitePath),
		];
		for (const filePath of filePaths.flatMap(written => expandBraces(written))) {
			if (filePath === "" || router.canHandle(filePath) || isReadableUrlPath(filePath)) continue;
			let found: string | undefined;
			try {
				found = credentialLocation(pathNames(resolveToCwd(filePath, cwd)), credentials);
			} catch {
				continue;
			}
			if (found)
				return {
					tier,
					override: true,
					reason: hit("credential_read", `it reads your credentials in ${found}`).reason,
				};
		}
	}
	return braceTextLeft < 0 ? { tier, override: true, reason: SIZE_LIMIT_HIT.reason } : tier;
}
