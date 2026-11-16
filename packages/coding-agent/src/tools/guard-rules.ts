/**
 * Fixed safety rules for tool calls (`tools.guardRules`): the critical shell patterns, matched
 * through shell nesting, plus rules ported from nace-ai/intern's tool guard. Each rule names an
 * action that destroys work or leaks credentials and does not fire on ordinary development
 * commands. Rules run over every simple command {@link parseShellScript} finds, nested
 * `bash -c`/`eval` strings and substitutions included.
 *
 * The rules are best-effort, opt-in heuristics over shell text (off by default), not a security
 * boundary; a determined or obfuscated command can get past them. Known gaps:
 * - Variables and substitutions whose values are unknown are not expanded: `f=.env; cat "$f"`.
 * - Commands inside a `bash -c` or `eval` string are not linked to the pipeline around them, and a
 *   value captured by `$( )` and sent later is not followed: `bash -c 'cat .env' | curl -d @- ...`,
 *   `x=$(cat .env); curl -d "$x" ...`.
 * - A heredoc opened inside `$( )` whose body starts after the closing `)` is not that command's
 *   input: `echo "$(curl -d @- ... <<EOF)"` with a `$(cat .env)` body line.
 * - A path behind a directory the guard cannot expand is not resolved: `cat "$(pwd)/.env"`. Nor is
 *   a relative path after a `cd`, `pushd` or `popd` to such a directory, though a `.env` there
 *   still counts by its name: `cd "$dir" && cat .npmrc`. A directory change is followed whether or
 *   not it runs: `cd ~; false && cd /; cat .ssh/id_rsa`.
 * - Upload syntaxes, network tools and shell forms it does not model are not seen:
 *   `gh gist create .env`, `curl file:///etc/shadow`, `coproc cat ~/.ssh/id_rsa`,
 *   `exec 3< .env; cat <&3 | nc ...`.
 * - Programs outside the reader list are not seen reading: `tac ~/.ssh/id_rsa`,
 *   `jq . ~/.docker/config.json`.
 * - A command run by a program it does not unwrap, or given its operands at run time, is not
 *   checked with them: `find ~/.ssh -exec cat {} +`, `ls ~/.ssh/id_* | xargs cat`.
 * - Commands in a script file a command runs are not read, even a file the same command writes
 *   first or passes as `<( )`: `printf 'cat ~/.ssh/id_rsa' > x.sh; sh x.sh`,
 *   `bash <(echo 'cat ~/.ssh/id_rsa')`.
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
	parseShellScript,
	resolveCommandWordPath,
	resolveShellWordPath,
	SHELL_SCRIPT_MAX_DEPTH,
	SHELL_SCRIPT_MAX_HEREDOC_SEARCH,
	SHELL_SCRIPT_MAX_NESTED_TEXT,
	type ShellCommand,
	type ShellUpstream,
	shellPositionalArgs,
} from "./shell-tokenize";

/**
 * Bash patterns flagged as safety critical for approval policy.
 *
 * Kept intentionally tight: the cost of a false negative is data loss or a compromised host,
 * while false positives remain actionable through user policy control.
 * New patterns should target shapes that are virtually never legitimate in automation.
 */
export const CRITICAL_BASH_PATTERNS = [
	// Recursive destruction.
	// Options may sit on either side of the recursive/force flag, so only that flag is pinned and
	// any other options are skipped: `rm -rf /`, `rm -rf -- /`, `rm --recursive --force /`,
	// `rm -rf -v /`, `rm -v -rf /`. An absolute target is still required.
	/\brm\s+(?:-\S+\s+)*(?:-[a-z]*[rRfF][a-z]*|--recursive|--force)\s+(?:-\S+\s+)*\//i,
	// `--no-preserve-root` defeats coreutils' own refusal to recurse on `/`, so it is critical
	// wherever it appears, including forms this list would otherwise reach only via the target.
	/\brm\s+(?:-\S+\s+)*--no-preserve-root\b/i,
	/\bsudo\s+rm\b/i, // any `sudo rm`.
	/\bchmod\s+-R\s+[0-7]+\s+\//i, // `chmod -R 777 /`.
	/\bchmod\s+-R\s+[ugoa+\-=rwxXst,]+\s+\//, // `chmod -R u+x /`, `chmod -R u+rwx,o+w /etc` (symbolic mode, root target).
	/\bchown\s+-R\s+\S+\s+\//i, // `chown -R user /`.

	// Fork bomb (a few common spacings).
	/:\(\)\s*\{\s*:\s*\|\s*:/i,

	// Disk / filesystem destruction.
	/>\s*\/dev\/sd[a-z]/i, // write to disk device.
	/\bmkfs(\.|\b)/i, // format filesystem.
	// dd to a device. Write-only pseudo-device sinks (`of=/dev/null`, `/dev/stdout`, `/dev/fd/1`, …) are
	// excluded: they cannot destroy data, and `dd … of=/dev/null` is the standard read-throughput idiom.
	/\bdd\s+if=.+of=\/dev\/(?!(?:null|zero|stdout|stderr|tty|fd\/\d+)(?:[\s;&|)<>]|$))/i,
	/\bshred\s+\/dev\//i,
	/\bcryptsetup\b/i,

	// System-config destruction.
	/>\s*\/etc\/(?:passwd|shadow|sudoers)\b/i,
	/\btee\s+(?:-a\s+)?\/etc\/(?:passwd|shadow|sudoers)\b/i, // `tee /etc/passwd`, `tee -a /etc/sudoers`.

	// Remote-fetch-then-execute (curl/wget piped to a shell or process-subbed).
	/\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:bash|sh|zsh|fish)\b/i,
	// Process-sub variants: `bash <(curl …)`, `source <(curl …)`, `. <(curl …)`. `.` and `source` are
	// anchored to a command boundary so `find . -name` and similar don't false-positive.
	/(?:^|[\s;&|(])(?:bash|sh|zsh|source|\.)\s+<\(\s*(?:curl|wget|fetch)\b/i,
	// `eval "$(curl …)"` / `eval $(curl …)` / `eval \`curl …\``.
	/\beval\s+["'`]?\$\(\s*(?:curl|wget|fetch)\b|\beval\s+`\s*(?:curl|wget|fetch)\b/i,

	// Process/host control.
	/\bkill\s+-9\s+1\b/, // kill PID 1.
	// Process/host control: must sit at command position so `npm run reboot-tests`
	// or `echo 'shutdown the queue'` don't false-positive.
	/(?:^|[\s;&|(])(?:shutdown|poweroff|reboot|halt)(?:\s|$|[;|&])/i,
	/(?:^|[\s;&|(])init\s+0\b/i,

	// Network-shell exfil.
	/\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i, // `nc -e` / `nc -c`.
] as const;

/** Reason the bash tool reports for a {@link CRITICAL_BASH_PATTERNS} match. */
export const CRITICAL_PATTERN_REASON = "Critical pattern detected";

export type GuardRule = "critical_pattern" | "nesting_limit" | "credential_read" | "secret_send";

/** A fixed rule a call breaks. */
export interface GuardHit {
	rule: GuardRule;
	/** Approval-prompt reason: {@link CRITICAL_PATTERN_REASON} for a critical pattern, else `<rule>: <why>`. */
	reason: string;
}

/** Where a call runs: its working directory and the home directory `~` names. */
export interface GuardScope {
	cwd: string;
	home: string;
}

function hit(rule: Exclude<GuardRule, "critical_pattern">, why: string): GuardHit {
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

/** The longest word {@link expandBraces} expands, and the most words it makes of one; the rest is not checked. */
const MAX_BRACE_WORD_LENGTH = 4096;
const MAX_BRACE_WORDS = 1024;
/**
 * The most characters {@link expandBraces} makes while the guard checks one command line, each word
 * counted with one for the space after it. Every rule checks each word made, so this bounds the
 * guard's work on brace lists however many of them a command has; past it no more words are made
 * and the command fails closed (`nesting_limit`).
 */
const MAX_BRACE_TEXT = 256 * 1024;
/** What is left of {@link MAX_BRACE_TEXT} for the command line being checked, below 0 once passed; {@link findShellGuardHit} resets it. */
let braceTextLeft = MAX_BRACE_TEXT;

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
	const words = braceWords(parts(0, word.length), braceTextLeft);
	if (words === undefined) {
		braceTextLeft = -1;
		return [word];
	}
	for (const made of words) braceTextLeft -= made.length + 1;
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
 * The words read `parts` stand for, at most {@link MAX_BRACE_WORDS}, or `undefined` once they, or
 * the alternatives of one brace, come to more than `maxText` characters.
 */
function braceWords(parts: readonly BracePart[], maxText: number): string[] | undefined {
	let words = [""];
	for (const part of parts) {
		const options: string[] = [];
		if (typeof part === "string") options.push(part);
		else {
			let optionsText = 0;
			for (const alternative of part) {
				const made = braceWords(alternative, maxText);
				if (made === undefined) return undefined;
				for (const option of made) {
					if (options.length === MAX_BRACE_WORDS) break;
					options.push(option);
					optionsText += option.length + 1;
					if (optionsText > maxText) return undefined;
				}
			}
		}
		const next: string[] = [];
		let text = 0;
		for (const prefix of words) {
			for (const option of options) {
				next.push(prefix + option);
				text += prefix.length + option.length + 1;
				if (text > maxText) return undefined;
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
 * ({@link shellBraces}), each resolved from `cwd` as {@link resolveCommandWordPath} resolves it;
 * those that cannot be resolved, relative ones from an unknown `cwd` included, are left out.
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
 * The credential location an absolute path is in, for display; `undefined` when it holds no
 * credentials. Public files in a credential folder (`~/.ssh/config`, `*.pub`) do not count. A
 * component that is a pathname pattern (`~/.ss?/id_*`, `~/.netr[c]`) counts when it can name the
 * location, and names are compared without regard to case where the file system does so
 * ({@link foldsCase}). Paths are compared as written: a symlink to a location is not followed.
 */
export function credentialLocation(absPath: string, home: string): string | undefined {
	const names = pathNames(absPath);
	const fixed = [
		...Object.keys(SYSTEM_CREDENTIAL_FILES).map(file => ({ file, shown: file })),
		...ompCredentialStores().map(file => ({ file, shown: `omp's credential store ${file}` })),
	];
	for (const { file, shown } of fixed) {
		const fileNames = pathNames(file);
		if (names.length === fileNames.length && fileNames.every((name, k) => namesFile(names[k], name))) return shown;
	}
	const homeNames = pathNames(home);
	if (names.length <= homeNames.length || !homeNames.every((name, k) => namesFile(names[k], name))) return undefined;
	const rest = names.slice(homeNames.length);
	for (const file of Object.keys(CREDENTIAL_FILES)) {
		if (rest.length === 1 && namesFile(rest[0], file)) return `~/${file}`;
	}
	for (const [folder, publicFiles] of Object.entries(CREDENTIAL_DIRS)) {
		const folderNames = folder.split("/");
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
function sentSecret(command: ShellCommand, word: string, cwd: string | undefined, home: string): string | undefined {
	for (const target of wordPaths(command, word, cwd, home)) {
		const names = pathNames(target);
		if (namesDotenv(names.at(-1) ?? "")) return path.basename(target);
		if (names.length === 3 && namesFile(names[0], "proc") && namesFile(names[2], "environ")) {
			return "the process environment";
		}
		const found = credentialLocation(target, home);
		if (found) return found;
	}
	if (cwd === undefined) {
		for (const target of wordPaths(command, word, path.sep, home)) {
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
			operands.push(...argv.slice(i + 1).flatMap(word => shellBraces(command, word)));
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
			operands.push(...shellBraces(command, arg));
		}
	}
	return operands;
}

/** An expansion up front that makes a word an absolute path: `~`, `$HOME`, `$PWD`. */
const ABSOLUTE_EXPANSION_RE = /^(?:~(?:\/|$)|\$\{?(?:HOME|PWD)\b)/;
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
 * The words a `tar` command reads, with every member after a `-C`/`--directory` resolved against
 * that directory, as tar does; each `-C` is relative to the one before it. Option values stay as
 * written, and exclusions are left out. A member after a directory the guard cannot resolve is
 * left out unless it is absolute. An extraction, listing or deletion (`x`, `t`, `--delete`) reads
 * only the archive and the member lists: its members name entries of the archive, not files.
 */
function tarReadWords(command: ShellCommand, home: string): string[] {
	const argv = args(command);
	const words: string[] = [];
	const members: string[] = [];
	let entries = false;
	let dir: string | undefined = command.cwd;
	const changeDir = (word: string) => {
		dir = dir === undefined ? undefined : resolveCommandWordPath(command, word, dir, home);
	};
	let i = 0;
	// An old-style first word (`tar cfC x.tar ~ .ssh`): each letter that takes a value takes the next word.
	if (argv.length > 0 && !argv[0].startsWith("-")) {
		const letters = argv[i++];
		for (const letter of letters) {
			entries ||= TAR_ENTRY_LETTERS.includes(letter);
			if (!TAR_VALUE_LETTERS.includes(letter) || i >= argv.length) continue;
			const value = argv[i++];
			if (letter === "C") changeDir(value);
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
			const value = eq > 0 ? arg.slice(eq + 1) : undefined;
			// GNU tar takes any unambiguous abbreviation: `--dir`, `--direc`.
			if (flag.length >= 5 && "--directory".startsWith(flag)) {
				const target = value ?? argv[++i];
				if (target !== undefined) changeDir(target);
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
			const value = k + 1 < arg.length ? arg.slice(k + 1) : argv[++i];
			if (value === undefined) continue;
			if (arg[k] === "C") changeDir(value);
			else if (arg[k] !== TAR_EXCLUDE_LETTER) words.push(value);
		} else {
			const member: string | undefined =
				dir !== undefined
					? resolveCommandWordPath(command, arg, dir, home)
					: path.isAbsolute(arg) || ABSOLUTE_EXPANSION_RE.test(arg)
						? arg
						: undefined;
			if (member !== undefined) members.push(member);
		}
	}
	return entries ? words : [...words, ...members];
}

/**
 * Readers whose first operand is a pattern or program, not a file, unless an option supplies one:
 * per such option, whether its value is the pattern itself or a file read for it. `valued` lists
 * the other options that take the next word as their value, only those that take one in every
 * common implementation, so that no file is mistaken for an option value. `suffixed` lists the
 * one-letter options whose optional value is only the rest of their word (`sed -i.bak`).
 */
const PATTERN_READERS: Record<
	string,
	{ supplies: Record<string, "pattern" | "file">; valued: readonly string[]; suffixed?: readonly string[] }
> = {
	grep: {
		supplies: { "-e": "pattern", "--regexp": "pattern", "-f": "file", "--file": "file" },
		valued: [
			"-A",
			"-B",
			"-D",
			"-d",
			"-m",
			"--after-context",
			"--before-context",
			"--binary-files",
			"--devices",
			"--directories",
			"--exclude",
			"--exclude-dir",
			"--exclude-from",
			"--include",
			"--label",
			"--max-count",
		],
	},
	rg: {
		supplies: { "-e": "pattern", "--regexp": "pattern", "-f": "file", "--file": "file" },
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
 * when no option supplied the pattern, and a pattern file. A long option that abbreviates one
 * that supplies the pattern (`--reg=x`, `--fil x`) counts as that option.
 */
function patternReaderWords(command: ShellCommand): string[] {
	const { supplies, valued, suffixed = [] } = PATTERN_READERS[command.argv[0]];
	const supplier = (option: string) => (Object.hasOwn(supplies, option) ? supplies[option] : undefined);
	const argv = args(command);
	const words: string[] = [];
	const operands: string[] = [];
	let supplied = false;
	// The value of an option that takes one: a pattern file is read, a pattern is not.
	const take = (option: string, value: string | undefined) => {
		const kind = supplier(option);
		supplied ||= kind !== undefined;
		if (kind === "file" && value !== undefined) words.push(value);
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			operands.push(...argv.slice(i + 1).flatMap(word => shellBraces(command, word)));
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			let name = eq > 0 ? arg.slice(0, eq) : arg;
			if (supplier(name) === undefined && !valued.includes(name) && name.length > 2) {
				const expanded = Object.keys(supplies).filter(option => option.startsWith(name));
				if (expanded.length === 1) name = expanded[0];
			}
			if (supplier(name) !== undefined || valued.includes(name)) take(name, eq > 0 ? arg.slice(eq + 1) : argv[++i]);
		} else if (arg.startsWith("-") && arg.length > 1) {
			// In a bundle (`-rne x`, `-A3`), the first letter that takes a value takes the rest of
			// the word, or the next word when it ends the bundle; a suffix option (`sed -i.bak`) takes
			// only the rest of the word.
			for (let k = 1; k < arg.length; k++) {
				const option = `-${arg[k]}`;
				if (suffixed.includes(option)) break;
				if (supplier(option) === undefined && !valued.includes(option)) continue;
				take(option, k + 1 < arg.length ? arg.slice(k + 1) : argv[++i]);
				break;
			}
		} else {
			operands.push(...shellBraces(command, arg));
		}
	}
	return [...words, ...operands.slice(supplied ? 0 : 1)];
}

/**
 * curl's one-letter options that take a value. In a bundle (`-sd @file`), the first of them takes
 * the rest of the word, or the next word when it ends the bundle.
 */
const CURL_VALUE_LETTERS = "AbCcDdEeFHKmoPQrTtUuwXxYyz";
/**
 * Options of readers whose value is a key, certificate, netrc file or key folder the program
 * authenticates, verifies or keeps its keys with (`curl --key`, `wget --private-key`,
 * `gpg --homedir`), or a socket it connects to (`curl --unix-socket`): it neither prints nor
 * copies the value, as `scp -i` does not, so the value is not read. A one-letter option
 * (`curl -E`) counts only for {@link WRITING_READERS}, whose option bundles are read letter by
 * letter.
 */
const KEY_VALUE_OPTIONS: Record<string, readonly string[]> = {
	curl: [
		"-E",
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
 * Readers that also write files: their one-letter options that take a value (in a bundle, the
 * first of them takes the rest of the word, or the next word when it ends the bundle), the options
 * whose value they write to rather than read, and, for a copy, whether a last operand without
 * `-t` is the destination.
 */
const WRITING_READERS: Record<string, { letters: string; writes: readonly string[]; destination?: true }> = {
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
	},
	cp: { letters: "St", writes: ["-t", "--target-directory"], destination: true },
	mv: { letters: "St", writes: ["-t", "--target-directory"], destination: true },
};

/**
 * The words a {@link WRITING_READERS} command reads: its arguments, without what it writes to and
 * the values of its {@link KEY_VALUE_OPTIONS}.
 */
function writingReaderWords(command: ShellCommand): string[] {
	const { letters, writes, destination } = WRITING_READERS[command.argv[0]];
	const keys = Object.hasOwn(KEY_VALUE_OPTIONS, command.argv[0]) ? KEY_VALUE_OPTIONS[command.argv[0]] : [];
	const argv = args(command);
	const words: string[] = [];
	const operands: string[] = [];
	let targeted = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			operands.push(...argv.slice(i + 1).flatMap(word => shellBraces(command, word)));
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const option = eq > 0 ? arg.slice(0, eq) : arg;
			if (writes.includes(option)) {
				targeted = true;
				if (eq < 0) i++;
			} else if (keys.includes(option)) {
				if (eq < 0) i++;
			} else {
				words.push(arg);
			}
		} else if (arg.startsWith("-") && arg.length > 1) {
			let k = 1;
			while (k < arg.length && !letters.includes(arg[k])) k++;
			const option = `-${arg[k]}`;
			if (k < arg.length && writes.includes(option)) {
				targeted = true;
				if (k === arg.length - 1) i++;
			} else if (k < arg.length && keys.includes(option)) {
				if (k === arg.length - 1) i++;
			} else {
				words.push(arg);
			}
		} else {
			operands.push(...shellBraces(command, arg));
		}
	}
	if (destination && !targeted) operands.pop();
	return [...words, ...operands];
}

/** A plain reader's arguments, without its {@link KEY_VALUE_OPTIONS} (long options only) and their values. */
function readerArgs(command: ShellCommand): string[] {
	const argv = args(command);
	if (!Object.hasOwn(KEY_VALUE_OPTIONS, command.argv[0])) return argv;
	const keys = KEY_VALUE_OPTIONS[command.argv[0]];
	const words: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			words.push(...argv.slice(i + 1));
			break;
		}
		const eq = arg.indexOf("=");
		if (arg.startsWith("--") && keys.includes(eq > 0 ? arg.slice(0, eq) : arg)) {
			if (eq < 0) i++;
			continue;
		}
		words.push(arg);
	}
	return words;
}

/**
 * The words a reading command reads files from: a copy's local sources, a search's operands after
 * its pattern, a download's arguments other than where it saves, any other reader's arguments; the
 * value of an option that names a key it authenticates with is not read ({@link KEY_VALUE_OPTIONS}).
 */
function readWords(command: ShellCommand, home: string): string[] {
	const name = command.argv[0];
	if (name === "tar") return tarReadWords(command, home);
	if (Object.hasOwn(COPY_VALUE_OPTIONS, name)) {
		return copyOperands(command)
			.slice(0, -1)
			.filter(operand => !REMOTE_OPERAND_RE.test(operand));
	}
	if (Object.hasOwn(PATTERN_READERS, name)) return patternReaderWords(command);
	if (Object.hasOwn(WRITING_READERS, name)) return writingReaderWords(command);
	return Object.hasOwn(READERS, name) ? readerArgs(command) : [];
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

function credentialRead(command: ShellCommand, scope: GuardScope): GuardHit | undefined {
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
	const sources = [
		{ words: readWords(command, scope.home), cwd: command.cwd },
		{ words: command.reads, cwd: command.shellCwd },
	];
	for (const { words, cwd } of sources) {
		for (const word of words) {
			for (const target of wordPaths(command, word, cwd, scope.home)) {
				const found = credentialLocation(target, scope.home);
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
			if (arg.startsWith("--")) {
				const eq = arg.indexOf("=");
				option = eq > 0 ? arg.slice(0, eq) : arg;
				if (!Object.hasOwn(CURL_DATA_OPTIONS, option)) continue;
				value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
			} else if (arg.startsWith("-") && arg.length > 1) {
				let k = 1;
				while (k < arg.length && !CURL_VALUE_LETTERS.includes(arg[k])) k++;
				if (k === arg.length) continue;
				option = `-${arg[k]}`;
				value = k + 1 < arg.length ? arg.slice(k + 1) : argv[++i];
				if (!Object.hasOwn(CURL_DATA_OPTIONS, option)) continue;
			} else {
				continue;
			}
			if (value === undefined) continue;
			if (option === "-T" || option === "--upload-file") {
				// curl globs the value itself, quoted or not: `-T "{a,b}"` uploads each file of the list,
				// and curl reads a set of one, `-T "{.env}"`, as its file.
				files.push(...expandBraces(value.replace(/\{([^{},]*)\}/g, "$1")));
			} else if (option === "-F" || option === "--form") {
				files.push(...formFiles(value));
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
			files.push(...operands.slice(0, -1).filter(operand => !REMOTE_OPERAND_RE.test(operand)));
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
	home: string,
): string | undefined {
	for (const word of words) {
		const found = sentSecret(command, word, cwd, home);
		if (found) return found;
	}
	return undefined;
}

/**
 * The secret a command puts on its output: the environment, or a credential or `.env` file it
 * reads, through its arguments from where it runs or its `<` redirections from where the shell opens them.
 */
function secretOutput(command: ShellCommand, scope: GuardScope): string | undefined {
	if (dumpsEnvironment(command)) return "the environment";
	const words = command.argv[0] === "source" ? args(command) : readWords(command, scope.home);
	return (
		firstSecret(command, command.reads, command.shellCwd, scope.home) ??
		firstSecret(command, words, command.cwd, scope.home)
	);
}

/**
 * The secrets commands put on their output, each command and upstream stage worked out once per
 * {@link findShellGuardHit}, so a long pipeline of senders costs no more than its length.
 */
class SecretOutputs {
	readonly #commands = new Map<ShellCommand, string | undefined>();
	/** Per command list of an upstream stage, the index of the first command from each index on that puts a secret out. */
	readonly #next = new Map<readonly ShellCommand[], Int32Array>();
	readonly #upstream = new Map<ShellUpstream, string | undefined>();

	constructor(readonly scope: GuardScope) {}

	/**
	 * The secret `command` can put on its output: its own ({@link secretOutput}), or one a command
	 * in its substitutions puts in its words (`printf "$(cat .env)"`), at any depth.
	 */
	of(command: ShellCommand): string | undefined {
		if (this.#commands.has(command)) return this.#commands.get(command);
		const found = secretOutput(command, this.scope) ?? this.first(command.subs);
		this.#commands.set(command, found);
		return found;
	}

	/** The first secret one of `commands` can put on its output. */
	first(commands: readonly ShellCommand[]): string | undefined {
		for (const command of commands) {
			const found = this.of(command);
			if (found) return found;
		}
		return undefined;
	}

	/** The first secret a command upstream can put on its output, the earliest stage first. */
	upstream(upstream: ShellUpstream | undefined): string | undefined {
		const stages: ShellUpstream[] = [];
		let known = upstream;
		for (; known && !this.#upstream.has(known); known = known.before) stages.push(known);
		let found = known === undefined ? undefined : this.#upstream.get(known);
		for (const stage of stages.reverse()) {
			found ??= this.#stage(stage);
			this.#upstream.set(stage, found);
		}
		return found;
	}

	/** The first secret a command of the stage itself can put on its output. */
	#stage({ commands, from, to }: ShellUpstream): string | undefined {
		let next = this.#next.get(commands);
		if (!next) {
			next = new Int32Array(commands.length + 1);
			next[commands.length] = commands.length;
			for (let i = commands.length - 1; i >= 0; i--) next[i] = this.of(commands[i]) ? i : next[i + 1];
			this.#next.set(commands, next);
		}
		return next[from] < to ? this.of(commands[next[from]]) : undefined;
	}
}

/**
 * A network command sending a secret: on its input from a `<` redirection, in a file it uploads, from
 * an upstream stage's output, or from a substitution's.
 */
function secretSend(command: ShellCommand, outputs: SecretOutputs): GuardHit | undefined {
	if (!Object.hasOwn(SENDERS, command.argv[0])) return undefined;
	const { home } = outputs.scope;
	const found =
		firstSecret(command, command.reads, command.shellCwd, home) ??
		firstSecret(command, sentFiles(command), command.cwd, home) ??
		outputs.upstream(command.upstream) ??
		outputs.first(command.subs);
	return found ? hit("secret_send", `it sends ${found} over the network (\`${command.argv[0]}\`)`) : undefined;
}

// -- entry points ------------------------------------------------------------------------------------

/**
 * The first fixed rule a shell command breaks, or `undefined`. Critical patterns are matched
 * against the command and every nested script it runs; the other rules against every simple
 * command it runs. A command nested deeper than the parser follows, with more nested script text
 * than it reads, with more text to search for heredoc delimiters that never come, or with brace
 * lists that expand past {@link MAX_BRACE_TEXT} and break no rule before that, fails closed
 * (`nesting_limit`).
 */
export function findShellGuardHit(command: string, scope: GuardScope): GuardHit | undefined {
	if (command.trim() === "") return undefined;
	braceTextLeft = MAX_BRACE_TEXT;
	const { pipelines, scripts, truncated } = parseShellScript(command, scope);
	// The raw line, each nested script, and each simple command in canonical quoting: the program
	// and plain unquoted words bare, everything else single-quoted. `bash -c "eval '\"rm\" -rf /'"`
	// matches like `rm -rf /`, while an argument quoted in the source (`git commit -m "reboot"`)
	// stays quoted, as it is in the raw line. A program named by an absolute path (`/sbin/reboot`)
	// is its basename; one named by a relative path (`./scripts/shutdown`) stays as written.
	const canonical = pipelines.flat().map(c =>
		[
			...c.wrappers,
			...c.argv.map((arg, index) => {
				const word = index === 0 && !c.program.startsWith("/") ? c.program : arg;
				return /^[\w@%+=:,./-]+$/.test(word) && (index === 0 || !c.quoted[index])
					? word
					: `'${word.replaceAll("'", "'\\''")}'`;
			}),
		].join(" "),
	);
	const texts = [command, ...scripts, ...canonical];
	if (CRITICAL_BASH_PATTERNS.some(pattern => texts.some(text => pattern.test(text)))) {
		return { rule: "critical_pattern", reason: CRITICAL_PATTERN_REASON };
	}
	if (truncated) {
		return hit(
			"nesting_limit",
			`it nests \`bash -c\`, \`eval\`, heredoc scripts, or substitutions more than ${SHELL_SCRIPT_MAX_DEPTH} levels deep or in more than ${SHELL_SCRIPT_MAX_NESTED_TEXT / 1024}K characters of nested script, or has heredocs that never close past ${SHELL_SCRIPT_MAX_HEREDOC_SEARCH / 1024}K characters of searching, past what the guard can check`,
		);
	}
	const outputs = new SecretOutputs(scope);
	for (const pipeline of pipelines) {
		const found =
			pipeline.map(c => secretSend(c, outputs)).find(Boolean) ??
			pipeline.map(c => credentialRead(c, scope)).find(Boolean);
		if (found) return found;
	}
	if (braceTextLeft < 0) {
		return hit(
			"nesting_limit",
			`its brace lists expand to more than ${MAX_BRACE_TEXT / 1024}K characters, past what the guard can check`,
		);
	}
	return undefined;
}

/**
 * Applies `credential_read` to a file tool (`read`, `grep`): when any target path is in a
 * credential location, the call keeps `tier` but carries a safety override, like a critical bash
 * command. A database path with a table or query selector (`agent.db:table`, `agent.db?q=...`)
 * targets the database file. Internal and web URLs are not files and never match.
 */
export function fileToolApproval(tier: ToolTier, rawPaths: readonly string[], cwd: string): ToolApprovalDecision {
	const router = InternalUrlRouter.instance();
	const home = os.homedir();
	for (const rawPath of rawPaths) {
		const filePaths = [
			splitPathAndSel(rawPath).path,
			...parseSqlitePathCandidates(rawPath).map(candidate => candidate.sqlitePath),
		];
		for (const filePath of filePaths) {
			if (filePath === "" || router.canHandle(filePath) || isReadableUrlPath(filePath)) continue;
			let found: string | undefined;
			try {
				found = credentialLocation(resolveToCwd(filePath, cwd), home);
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
	return tier;
}
