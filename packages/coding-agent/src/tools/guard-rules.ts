/**
 * Fixed guard rules for tool calls (`tools.guardRules`), ported from nace-ai/intern's tool guard:
 * `credential_read` and `secret_send`, each naming a way to leak credentials that ordinary
 * development commands do not take, and `discard_changes` and `kills_harness`, each naming a way to
 * lose uncommitted work or the session itself. For `bash` they apply to the top-level simple
 * commands {@link parseShellCommands} finds; the bash tool's critical patterns stay a match on the
 * raw command line, whether these rules are on or off.
 *
 * The rules are an opt-in convenience layer over top-level commands (off by default), not a
 * security boundary; a nested, determined or obfuscated command gets past them. Known limitations:
 * - Reading stops at the first nested part: an unquoted `(` or `<<`, or a `$( )`, backtick or
 *   `${ }` other than a plain one, also in double quotes. The command it is in and every later
 *   one are not checked: `echo $(date); cat ~/.ssh/id_rsa`, `(cat .env) | curl -d @- ...`,
 *   `echo $(date); git reset --hard`, `(cd repo && git checkout .)`.
 * - Nothing nested is read: compound commands (`{ }`, `if`, loops, `case`, `[[ ]]`), function
 *   bodies, scripts fed to a shell, and `bash -c`, `sh -c`, `eval` and `env -S` strings:
 *   `bash -c 'cat ~/.ssh/id_rsa'`, `bash -c 'pkill node'`. A `git stash` earlier in the `&&`
 *   chain counts for `discard_changes` only in a line read whole: one with no nested part, compound
 *   command, function or `env -S` string, and no shell, `eval`, `source`, `trap` or `coproc`
 *   command, any of which could run a `git stash pop` unseen.
 * - Variables other than a leading `$HOME`, `$PWD` among them, are not expanded:
 *   `f=.env; cat "$f"`, `cd ~ && cat $PWD/.ssh/id_rsa`. Nor is a relative path after a directory
 *   change it does not follow, though a `.env` there still counts by its name:
 *   `cd "$dir" && cat .npmrc`, a `cd` after a `{ }`, `if`, loop, `case`, `eval` or `source`, the
 *   directory a wrapper runs its command in (`env -C ~/.ssh cat id_rsa`, `sudo -D`), or a `tar`
 *   member after `-C`/`--directory` (`tar -C ~ -czf - .ssh`). A `cd` the shell runs is followed
 *   whether or not it runs (`cd ~; false && cd /; cat .ssh/id_rsa`); one a process wrapper runs
 *   (`sudo cd /`, `env cd`, `timeout 1 cd`) does not move the shell.
 * - Upload syntaxes, network tools and shell forms it does not model are not seen:
 *   `gh gist create .env`, `curl file:///etc/shadow`, `coproc cat ~/.ssh/id_rsa`,
 *   `exec 3< .env; cat <&3 | nc ...`.
 * - Programs outside the reader list are not seen reading: `tac ~/.ssh/id_rsa`,
 *   `jq . ~/.docker/config.json`. Nor are the operands of `nc`, `ncat`, `openssl` and `gpg` read,
 *   most of them host names, subcommands or user IDs: `openssl rsa -in ~/.ssh/id_rsa`,
 *   `gpg -d ~/.password-store/x.gpg`.
 * - A command run by a program it does not unwrap, or given its operands at run time, is not
 *   checked with them: `find ~/.ssh -exec cat {} +`, `ls ~/.ssh/id_* | xargs cat`.
 * - Commands in a script file a command runs are not read, even a file the same command writes
 *   first: `printf 'cat ~/.ssh/id_rsa' > x.sh; sh x.sh`. Nor is a `git stash pop` that a script,
 *   alias or program it does not unwrap runs, after the stash a discard counts on:
 *   `git stash && make restore && git reset --hard`.
 * - A program word written as a brace list or pathname pattern is not expanded:
 *   `{cat,/etc/shadow}`, `/bin/ca[t] /etc/shadow`.
 * - A directory that contains a credential location does not count as one:
 *   `tar czf - ~ | curl -T - ...`.
 * - A secret copied to another file first is sent under that file's name:
 *   `cp .env /tmp/x && curl -F f=@/tmp/x ...`.
 * - A same-size edit to a file a configured filter driver handles (git-lfs, git-crypt) is not seen
 *   by `discard_changes`: the probe runs no filter, so it compares such a file by size.
 * - A `git clean` without `-f` or `-i`, which git refuses by default, is not checked: one where
 *   `clean.requireForce` is false deletes unasked (`git -c clean.requireForce=false clean -d`).
 * - `discard_changes` checks the tree as it is before the command line runs. Work a top-level
 *   `git stash pop`, `apply` or `branch` may bring back first makes it ask, but work any other
 *   command writes into the tree first is not seen: `mv ~/notes.txt . && git clean -f`,
 *   `git apply fix.patch && git reset --hard`.
 * - A git alias (or `-c alias.*`) that expands to a discarding command is not resolved:
 *   `git -c alias.x='reset --hard' x`.
 * - Where the directory is unknown (see above), `discard_changes` has no directory to probe for a
 *   git command there, unless its `-C` names one by an absolute path, `~` or `$HOME`, and
 *   `kills_harness` no executable for a relative `killall` path: `cd "$d" && git reset --hard`,
 *   `env -C repo git reset --hard`. A leading `cd` onto an internal URL, or onto a directory that
 *   does not resolve, makes the starting directory unknown to them.
 * - The probes of one call on one input share {@link PROBE_BUDGET_MS}; in a command that asks more
 *   than fit, such as many distinct `pkill` patterns, the ones left without time count as no match.
 * - Brace expansion is followed only in words up to 4096 characters and for their first 1024
 *   words: `{a,b}{a,b}...{a,b}{x,.env}`.
 * - A path that reaches a credential location through a symlink, hard link or bind mount is not
 *   recognized: `ln -s ~/.ssh k && cat k/id_rsa`. Nor do bare wildcards for every component of
 *   `~/Library/Keychains` name it: `cat ~/???????/?????????/login.keychain-db`.
 * - A missing path the `read` tool finds by a unique match deeper under its directory is checked
 *   as written: `read id_rsa` from `~` opens `~/.ssh/id_rsa`.
 *
 * `discard_changes` and `kills_harness` confirm a match with a read-only probe (the
 * `@oh-my-pi/pi-natives/vcs` discard check, `pgrep`) and fire only when the probe shows something
 * would be lost. A probe that fails, times out, or cannot run counts as no match.
 *
 * The `credential_read`, `secret_send`, `discard_changes`, and `kills_harness` rules are derived
 * from `src/intern/guard.py` of nace-ai/intern (https://github.com/nace-ai/intern, v0.30.1, commit
 * e1bbd096f9), Copyright Nace AI, licensed under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0). Modified for omp: rewritten in TypeScript; a hit
 * returns an approval override instead of refusing the call; credential locations include omp's own
 * stores; the git probe runs through the native VCS helper without repository-configured programs;
 * a `git stash` earlier in the same `&&` chain counts as keeping the work. See
 * packages/coding-agent/THIRD-PARTY-NOTICES.txt.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Process, type VcsDiscardCheck } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { ToolApprovalDecision, ToolCallContext, ToolTier } from "@oh-my-pi/pi-agent-core";
import { getAuthBrokerTokenFilePath } from "@oh-my-pi/pi-ai/auth-broker/discover";
import { getAgentDbPath, getAuthBrokerSnapshotCachePath, getConfigRootDir } from "@oh-my-pi/pi-utils";
import { InternalUrlRouter } from "../internal-urls/router";
import { toolApprovalScopeToken } from "./approval-scope";
import { resolveToCwd } from "./path-utils";
import { isReadableUrlPath, splitPathAndSel } from "./details/read";
import { parseSqlitePathCandidates } from "./sqlite-reader";
import {
	append,
	attachedValue,
	parseShellCommands,
	resolveCommandWordPath,
	resolveShellWordPath,
	type ShellCommand,
	type ShellLine,
	shellPositionalArgs,
	type SucceededLink,
} from "./shell-tokenize";

export type GuardRule = "credential_read" | "secret_send" | "discard_changes" | "kills_harness" | "size_limit";

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
	/**
	 * Set when `cwd` only stands in for a directory the guard cannot place, such as the target of a
	 * leading bash `cd` that is an internal URL or does not resolve: the probing rules then start from
	 * an unknown directory ({@link pipelineProbes}), so that none probes a directory guessed from `cwd`.
	 */
	cwdStandIn?: boolean;
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

/**
 * omp's own credential stores: the agent database (auth storage), both the active one and the
 * default one under the config root when another agent directory is active, the auth-broker
 * snapshot, and the auth-broker bearer token.
 */
function ompCredentialStores(): string[] {
	const agentDbs = new Set([getAgentDbPath(), path.join(getConfigRootDir(), "agent", "agent.db")]);
	const stores = [...agentDbs].flatMap(db => [db, `${db}-wal`, `${db}-shm`]);
	stores.push(getAuthBrokerSnapshotCachePath(), getAuthBrokerTokenFilePath());
	return stores;
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
	curl: true,
	wget: true,
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
/** tar's letter that extracts members to standard output. */
const TAR_STDOUT_LETTER = "O";
/** tar's long option that extracts members to standard output, with the shortest abbreviation GNU tar takes for it. */
const TAR_STDOUT_OPTION = { long: "--to-stdout", shortest: "--to-s" };

/**
 * The files a `tar` command reads ({@link ReadWords}): its archive and member lists, and its
 * members, those after a `-C`/`--directory` in `moved`, as the guard does not follow the directory
 * tar changes to. A member's braces are expanded when it is checked, as the shell expands them
 * before tar sees the member (`{/etc/shadow,x}`). Option values stay as written, and exclusions are
 * left out. An extraction, listing or deletion (`x`, `t`, `--delete`) reads only the archive and the
 * member lists: its members name entries of the archive, not files. What it reads reaches its
 * output when it writes the archive there (`-f -`, `-f /dev/stdout`, or no `-f`) or extracts to it (`-O`).
 */
function tarReadWords(command: ShellCommand): ReadWords {
	const argv = args(command);
	const words: string[] = [];
	const members: string[] = [];
	const moved: string[] = [];
	let entries = false;
	let changed = false;
	// The archive (`-f`), `undefined` for tar's default, and whether `-O` sends extracted members to stdout.
	let archive: string | undefined;
	let toStdout = false;
	let i = 0;
	// An old-style first word (`tar cfC x.tar ~ .ssh`): each letter that takes a value takes the next word.
	if (argv.length > 0 && !argv[0].startsWith("-")) {
		const letters = argv[i++];
		for (const letter of letters) {
			entries ||= TAR_ENTRY_LETTERS.includes(letter);
			toStdout ||= letter === TAR_STDOUT_LETTER;
			if (!TAR_VALUE_LETTERS.includes(letter) || i >= argv.length) continue;
			const value = argv[i++];
			if (letter === "f") archive = value;
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
				if (flag === "--file") archive = target;
			} else if (flag.length >= TAR_STDOUT_OPTION.shortest.length && TAR_STDOUT_OPTION.long.startsWith(flag)) {
				toStdout = true;
			} else {
				entries ||= Object.entries(TAR_ENTRY_OPTIONS).some(
					([full, shortest]) => flag.startsWith(shortest) && full.startsWith(flag),
				);
			}
		} else if (options && arg.startsWith("-") && arg.length > 1) {
			let k = 1;
			for (; k < arg.length && !TAR_VALUE_LETTERS.includes(arg[k]); k++) {
				entries ||= TAR_ENTRY_LETTERS.includes(arg[k]);
				toStdout ||= arg[k] === TAR_STDOUT_LETTER;
			}
			if (k === arg.length) continue;
			const value = k + 1 < arg.length ? attachedValue(arg.slice(k + 1)) : argv[++i];
			if (value === undefined) continue;
			if (arg[k] === "f") archive = value;
			if (arg[k] === "C") changed = true;
			else if (arg[k] !== TAR_EXCLUDE_LETTER) words.push(value);
		} else {
			(changed ? moved : members).push(arg);
		}
	}
	// What it reads reaches its output when it writes the archive there (`-f -`, or no `-f`) or extracts to it.
	const stdout = toStdout || archive === undefined || Object.hasOwn(STDOUT_FILES, archive);
	if (entries) return { words, moved: [], stdout };
	return { words: [...words, ...members], moved, stdout };
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
 * Long options of readers whose value is a key, certificate or netrc file the program
 * authenticates or verifies with (`curl --key`, `wget --private-key`), or a socket it connects to
 * (`curl --unix-socket`): it neither prints nor copies the value, as `scp -i` does not, so the
 * value is not read.
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
 * {@link KEY_VALUE_OPTIONS} included; and what it writes to (`outputs`), its destination or the
 * values of its `writes` options. A value after an `=` or in its option's word gets no tilde
 * expansion ({@link attachedValue}).
 */
function writingReaderWords(command: ShellCommand): { words: string[]; outputs: string[] } {
	const { letters, writes, reads = [], valued = [], destination, urls } = WRITING_READERS[command.argv[0]];
	const keys = Object.hasOwn(KEY_VALUE_OPTIONS, command.argv[0]) ? KEY_VALUE_OPTIONS[command.argv[0]] : [];
	const argv = args(command);
	const words: string[] = [];
	const operands: string[] = [];
	const outputs: string[] = [];
	let targeted = false;
	// The value of an option that takes one: where the command writes, a file it reads, or neither.
	const take = (option: string, value: string | undefined) => {
		if (writes.includes(option)) {
			targeted = true;
			if (value !== undefined) outputs.push(value);
		} else if (reads.includes(option) && value !== undefined) {
			words.push(value);
		}
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
	if (destination && !targeted) {
		const last = operands.pop();
		if (last !== undefined) outputs.push(last);
	}
	return { words: [...words, ...operands], outputs };
}

/** A number, maybe with a `+` or a unit (`5`, `+5`, `1K`): after an option, the option's value. */
const OPTION_NUMBER_RE = /^\+?\d+[A-Za-z]*$/;

/**
 * A plain reader's operands: its arguments without its options (`cat -n` names no file `-n`). An
 * option takes no word, as the guard does not know which options take one, except a number right
 * after it ({@link OPTION_NUMBER_RE}: `head -n 5`, `tail -c +1K`), which is taken for its value.
 */
function readerArgs(command: ShellCommand): string[] {
	const argv = args(command);
	const words: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			append(words, argv.slice(i + 1));
			break;
		}
		if (!arg.startsWith("-") && !(OPTION_NUMBER_RE.test(arg) && argv[i - 1]?.startsWith("-"))) words.push(arg);
	}
	return words;
}

/** A URL (`https://host/x`, `hkps://keys.example`), which names no local file. */
const URL_RE = /^[a-z][a-z\d+.-]*:\/\//i;

/** The names a command opens its standard input by, as a file it reads (`curl -d @/dev/stdin`). */
const STDIN_FILES: Record<string, true> = { "-": true, "/dev/stdin": true, "/dev/fd/0": true, "/proc/self/fd/0": true };
/** The names a command opens its standard output by, as a file it writes (`tar -cf - .env`, `cp .env /dev/stdout`). */
const STDOUT_FILES: Record<string, true> = {
	"-": true,
	"/dev/stdout": true,
	"/dev/fd/1": true,
	"/proc/self/fd/1": true,
};

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
	/** Whether what it reads reaches its standard output, rather than only a file it writes (`cp .env /tmp/x`). */
	stdout: boolean;
}

/** Compressors, which write a file next to each they read unless told to write to stdout. */
const COMPRESSORS: Record<string, true> = { gzip: true, bzip2: true, xz: true };

/**
 * Whether a {@link READERS} command that is neither a copy, a search nor a {@link WRITING_READERS}
 * entry puts what it reads on its output: a compressor only with `-c`/`--stdout` (`gzip -c .env`),
 * `zip` only into the archive `-` (its first word that is no option), `7z` only with `-so`. The
 * others print what they read.
 */
function readerPrints(command: ShellCommand): boolean {
	const name = command.argv[0];
	const argv = args(command);
	const end = argv.indexOf("--");
	const options = (end < 0 ? argv : argv.slice(0, end)).filter(arg => arg.startsWith("-") && arg.length > 1);
	if (Object.hasOwn(COMPRESSORS, name)) {
		return options.some(arg => arg === "--stdout" || arg === "--to-stdout" || /^-[^-]*c/.test(arg));
	}
	if (name === "zip") return argv.find(arg => arg === "-" || !arg.startsWith("-")) === "-";
	if (name === "7z") return options.includes("-so");
	return true;
}

/** The one-letter options of `sed` that take a value; in a bundle, the first of them takes the rest of the word. */
const SED_VALUE_LETTERS = "efl";

/** Whether a `sed` edits its files in place (`-i`, `-i.bak`, `-ni`, `--in-place`), so it prints none of them. */
function editsInPlace(command: ShellCommand): boolean {
	for (const arg of args(command)) {
		if (arg === "--") return false;
		if (arg.startsWith("--")) {
			const flag = arg.split("=")[0];
			if (flag.length >= 3 && "--in-place".startsWith(flag)) return true;
			continue;
		}
		if (!arg.startsWith("-")) continue;
		for (let k = 1; k < arg.length && !SED_VALUE_LETTERS.includes(arg[k]); k++) {
			if (arg[k] === "i") return true;
		}
	}
	return false;
}

/**
 * The words a reading command reads files from: a copy's local sources, a search's operands after
 * its pattern, the files a download reads (`curl -K`, `wget -i`) but not where it saves, any other
 * reader's operands; never `-` (standard input) or a URL. The value of an option that names a key
 * it authenticates with is not read ({@link KEY_VALUE_OPTIONS}). What a copy, a download, a
 * `sed -i` or a `sort -o` reads does not reach its output, nor does what `cp` or `mv` reads unless
 * it copies to the output (`cp .env /dev/stdout`) ({@link readerPrints} for the others).
 */
function readWords(command: ShellCommand): ReadWords {
	const name = command.argv[0];
	let words: string[];
	let moved: string[] = [];
	let stdout: boolean;
	if (name === "tar") {
		({ words, moved, stdout } = tarReadWords(command));
	} else if (Object.hasOwn(COPY_VALUE_OPTIONS, name)) {
		words = copyOperands(command)
			.slice(0, -1)
			.filter(operand => !REMOTE_OPERAND_RE.test(operand));
		stdout = false;
	} else if (Object.hasOwn(PATTERN_READERS, name)) {
		words = patternReaderWords(command);
		stdout = name !== "sed" || !editsInPlace(command);
	} else if (Object.hasOwn(WRITING_READERS, name)) {
		let outputs: string[];
		({ words, outputs } = writingReaderWords(command));
		stdout = !WRITING_READERS[name].urls && outputs.every(output => Object.hasOwn(STDOUT_FILES, output));
	} else {
		words = Object.hasOwn(READERS, name) ? readerArgs(command) : [];
		stdout = readerPrints(command);
	}
	return { words: words.filter(word => word !== "-" && !URL_RE.test(word)), moved, stdout };
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
 * reads, through its arguments from where it runs or its `<` redirections from where the shell
 * opens them, when what it reads reaches its output ({@link ReadWords.stdout}): `cp .env /tmp/x`
 * puts out none.
 */
function secretOutput(command: ShellCommand, credentials: CredentialIndex): string | undefined {
	if (dumpsEnvironment(command)) return "the environment";
	const { words, moved, stdout } =
		command.argv[0] === "source" ? { words: args(command), moved: [], stdout: true } : readWords(command);
	if (!stdout) return undefined;
	return (
		firstSecret(command, command.reads, command.shellCwd, credentials) ??
		firstSecret(command, words, command.cwd, credentials) ??
		firstSecret(command, moved, undefined, credentials)
	);
}

/** Whether `file` names standard input ({@link STDIN_FILES}). */
function namesStdin(file: string): boolean {
	return Object.hasOwn(STDIN_FILES, file);
}

/**
 * Whether a network command sends what it reads on its standard input: `nc`, `socat`, `telnet`,
 * `ftp` and `sftp` always; `http`/`xh` unless told not to (`--ignore-stdin`, `-I`); `curl` only
 * through standard input named as a file it sends or reads (`-d @-`, `-T -`, `-T .`,
 * `-F f=@/dev/stdin`, `-K -`, `--variable name@-`), `wget` likewise (`--post-file=-`, `-i -`), and
 * `rsync` when a list option reads it (`--files-from=-`); `scp` never.
 */
function readsStdin(command: ShellCommand): boolean {
	const name = command.argv[0];
	const argv = args(command);
	switch (name) {
		case "scp":
			return false;
		case "http":
		case "https":
		case "xh":
			return !argv.some(arg => arg === "--ignore-stdin" || arg === "-I");
		case "curl":
			return (
				sentFiles(command).some(file => namesStdin(file) || file === ".") ||
				writingReaderWords(command).words.some(namesStdin) ||
				argv.some(arg => arg.endsWith("@-"))
			);
		case "wget":
			return sentFiles(command).some(namesStdin) || writingReaderWords(command).words.some(namesStdin);
		case "rsync":
			return argv.some(arg => namesStdin(arg) || namesStdin(arg.slice(arg.indexOf("=") + 1)));
		default:
			return true;
	}
}

/**
 * A network command sending a secret: on its input from a `<` redirection, in a file it uploads, or
 * `upstream`, the secret an earlier stage of its pipeline puts on its output, when it reads the
 * pipe ({@link ShellCommand.pipedInput}, {@link readsStdin}).
 */
function secretSend(
	command: ShellCommand,
	upstream: () => string | undefined,
	credentials: CredentialIndex,
): GuardHit | undefined {
	const found =
		firstSecret(command, command.reads, command.shellCwd, credentials) ??
		firstSecret(command, sentFiles(command), command.cwd, credentials) ??
		(command.pipedInput && readsStdin(command) ? upstream() : undefined);
	return found ? hit("secret_send", `it sends ${found} over the network (\`${command.argv[0]}\`)`) : undefined;
}

// -- probes ------------------------------------------------------------------------------------------

/**
 * How long the probes of one bash call may take together, across its approval paths and the rows
 * of its prompt. Each probe gets what is left as its timeout; a probe that finds nothing left does
 * not run and counts as no match, as one that times out does.
 */
const PROBE_BUDGET_MS = 3_000;

type ProbeAnswer = string | boolean | undefined;

/**
 * The probes of the checks one tool call makes on one input: its approval paths (the ACP permission
 * gate, the extension wrapper before and after `tool_call` hooks) and the rows of its prompt (the
 * segments of a compound command, each one pipeline of the whole chain's parse). Together their
 * probes take at most {@link PROBE_BUDGET_MS}, each probe is asked once among them, and a pipeline
 * checked again gets what its first check found. A `tool_call` hook that rewrites the input gives
 * the rewritten one its own budget, so probes of the input it replaced cannot use up the time of the
 * one that runs. Never shared across calls: an earlier call of the same batch may change the tree
 * before a later call's gate.
 */
export class GuardProbeBudget {
	#left = PROBE_BUDGET_MS;
	readonly #answers = new Map<string, ProbeAnswer>();
	/** What the probing rules found in each pipeline checked: by scope and command line, then by pipeline. */
	readonly results = new Map<string, Map<number, GuardHit | undefined>>();

	/**
	 * The answer to the probe `key`: a kept one, else `run`'s, which gets the probe time left as its
	 * timeout and uses up what it takes. With none left it does not run and answers `undefined`. A
	 * probe that throws answers `undefined`.
	 */
	ask(key: string, run: (timeoutMs: number) => ProbeAnswer): ProbeAnswer {
		if (this.#answers.has(key)) return this.#answers.get(key);
		if (this.#left <= 0) return undefined;
		const start = performance.now();
		let answer: ProbeAnswer;
		try {
			answer = run(Math.ceil(this.#left));
		} catch {
			answer = undefined;
		}
		this.#left -= performance.now() - start;
		this.#answers.set(key, answer);
		return answer;
	}
}

/** Each tool call's probe budgets, by its loop context, then by input ({@link callProbeBudget}). */
const toolCallBudgets = new WeakMap<ToolCallContext, Map<string, GuardProbeBudget>>();
/**
 * Each tool call's probe budgets, by the approval scope ({@link toolApprovalScopeToken}) the
 * extension wrapper approves that call in and shows its prompt from, then by input.
 */
const scopeBudgets = new WeakMap<object, Map<string, GuardProbeBudget>>();

/**
 * Marks the current approval scope as one tool call's own: the extension wrapper binds it (through
 * the tool's `bindApprovalTargets`) before its final gate and prompt. Only such a scope keys a probe
 * budget; a scope the call merely runs inside, such as that of the `task` call that started a
 * subagent, is shared with other calls.
 */
export function bindGuardProbeScope(): void {
	const scope = toolApprovalScopeToken();
	if (scope && !scopeBudgets.has(scope)) scopeBudgets.set(scope, new Map());
}

/** Whether the current approval scope is a tool call's own ({@link bindGuardProbeScope}). */
export function inGuardProbeScope(): boolean {
	const scope = toolApprovalScopeToken();
	return scope !== undefined && scopeBudgets.has(scope);
}

/**
 * The probe budget of the tool call being approved on `input` (the checked input, as the caller
 * keys it), shared by its approval paths and the rows of its prompt: found by its loop context
 * `toolCall`, or by the call's own approval scope ({@link bindGuardProbeScope}), which the prompt
 * rows have without a context. A new one when neither knows one for `input`.
 */
export function callProbeBudget(input: string, toolCall?: ToolCallContext): GuardProbeBudget {
	const token = toolApprovalScopeToken();
	const scoped = token ? scopeBudgets.get(token) : undefined;
	let called = toolCall ? toolCallBudgets.get(toolCall) : undefined;
	if (toolCall && !called) {
		called = new Map();
		toolCallBudgets.set(toolCall, called);
	}
	const budget = called?.get(input) ?? scoped?.get(input) ?? new GuardProbeBudget();
	called?.set(input, budget);
	scoped?.set(input, budget);
	return budget;
}

// -- discard_changes ---------------------------------------------------------------------------------

const GIT_VALUE_OPTIONS: Record<string, true> = {
	"-C": true,
	"-c": true,
	"--namespace": true,
	"--config-env": true,
	"--attr-source": true,
};
/** Pathspecs of the whole directory: `./*` is the shell's expansion of every entry in it, as `*` is. */
const MASS_PATHSPECS: Record<string, true> = {
	".": true,
	":/": true,
	"*": true,
	"./*": true,
	":(top)": true,
	"./": true,
};
/**
 * git's own options that print something and exit before any subcommand runs (`--exec-path` only
 * bare; `--exec-path=<dir>` sets the directory). `--list-cmds=<kind>` exits too.
 */
const GIT_EXITING_OPTIONS: Record<string, true> = {
	"-h": true,
	"--help": true,
	"-v": true,
	"--version": true,
	"--html-path": true,
	"--man-path": true,
	"--info-path": true,
	"--exec-path": true,
};

/**
 * Where a git command works: the directory it runs in after its `-C`s, and the repository and work
 * tree it names with `--git-dir` and `--work-tree` (or `GIT_DIR=` and `GIT_WORK_TREE=` it runs
 * with), resolved against that directory as git does.
 */
interface GitTarget {
	where: string;
	gitDir?: string;
	workTree?: string;
}

/** A git command's subcommand and its arguments. */
interface GitInvocation {
	sub: string;
	rest: string[];
	/** Where it works; none when a directory it names is a word the guard cannot resolve. */
	target?: GitTarget;
	/** One of git's own options ({@link GIT_EXITING_OPTIONS}) makes git exit before the subcommand runs. */
	exits: boolean;
}

function gitInvocation(command: ShellCommand, home: string): GitInvocation {
	const argv = args(command);
	let where = command.cwd;
	let exits = false;
	const named: { gitDir?: string; workTree?: string } = {};
	for (const assignment of command.assignments) {
		const eq = assignment.indexOf("=");
		const name = assignment.slice(0, eq);
		if (name === "GIT_DIR") named.gitDir = assignment.slice(eq + 1);
		else if (name === "GIT_WORK_TREE") named.workTree = assignment.slice(eq + 1);
	}
	let i = 0;
	while (i < argv.length && argv[i].startsWith("-")) {
		const arg = argv[i];
		if (Object.hasOwn(GIT_EXITING_OPTIONS, arg) || arg.startsWith("--list-cmds=")) exits = true;
		const eq = arg.indexOf("=");
		const option = eq > 0 ? arg.slice(0, eq) : arg;
		if (option === "--git-dir" || option === "--work-tree") {
			const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
			if (option === "--git-dir") named.gitDir = value;
			else named.workTree = value;
			i++;
		} else if (Object.hasOwn(GIT_VALUE_OPTIONS, arg)) {
			// Each `-C` is relative to the directory the one before it left; an absolute one needs none.
			if (arg === "-C" && i + 1 < argv.length) {
				where = resolveCommandWordPath(command, argv[i + 1], where, home);
			}
			i += 2;
		} else {
			i++;
		}
	}
	const sub = i < argv.length ? argv[i] : "";
	const rest = argv.slice(i + 1);
	if (where === undefined) return { sub, rest, exits };
	const target: GitTarget = { where };
	for (const key of ["gitDir", "workTree"] as const) {
		const word = named[key];
		if (word === undefined) continue;
		const resolved = resolveCommandWordPath(command, word, where, home);
		if (resolved === undefined) return { sub, rest, exits };
		target[key] = resolved;
	}
	return { sub, rest, target, exits };
}

/** Whether `arg` is the long option `name` or an abbreviation git expands to it (`--har` for `--hard`). */
function isLongOption(arg: string, name: string): boolean {
	const flag = arg.split("=", 1)[0];
	return flag.length > 2 && name.startsWith(flag);
}

/**
 * Whether a git subcommand's options, before a `--`, end with `--recurse-submodules` (or an
 * abbreviation of it) rather than `--no-recurse-submodules`.
 */
function recursesSubmodules(rest: readonly string[]): boolean {
	let recurses = false;
	for (const arg of rest) {
		if (arg === "--") break;
		if (!arg.startsWith("--")) continue;
		if (isLongOption(arg, "--recurse-submodules")) recurses = true;
		else if (isLongOption(arg, "--no-recurse-submodules")) recurses = false;
	}
	return recurses;
}

/** A word the shell expands before git sees it: one with a variable, or a leading `~`. */
const SHELL_EXPANDED_RE = /\$|^~/;
/** A brace group with no brace inside, matched in time linear in the word. */
const BRACE_GROUP_RE = /\{[^{}]*\}/g;
/**
 * Whether `word` holds a brace expansion, which can make one word several (`{build,dist}`,
 * `out{1..3}`). One the source quoted counts too, which only widens the check.
 */
function hasBraceExpansion(word: string): boolean {
	for (const [group] of word.matchAll(BRACE_GROUP_RE)) {
		if (group.includes(",") || group.includes("..")) return true;
	}
	return false;
}

/**
 * `words`, pathspecs a git command names, as git sees them: a word the shell expands is resolved
 * like a path (`~/repo`, `$HOME/repo`). Empty (git's default scope, which covers them all) when one
 * cannot be: another variable (`"$PWD"` among them), a brace expansion.
 */
function resolvePathspecs(words: readonly string[], command: ShellCommand, scope: GuardScope): string[] {
	const resolved = words.map(word => {
		if (hasBraceExpansion(word)) return undefined;
		if (!SHELL_EXPANDED_RE.test(word)) return word;
		return resolveCommandWordPath(command, word, command.cwd, scope.home);
	});
	return resolved.every((word): word is string => word !== undefined) ? resolved : [];
}

/**
 * The `git clean` a command runs, as a dry-run discard check, or `undefined` for a dry run, and for
 * one without `-f` or `-i`, which git refuses unless `clean.requireForce` is false (not read here).
 * `-q` and `-i` do not change what is deleted; a second `-f` adds untracked nested repositories.
 * Pathspecs are resolved by {@link resolvePathspecs}; without any, the whole directory is
 * previewed. An exclude the shell expands is dropped, which only widens the preview.
 */
function cleanCheck(rest: readonly string[], command: ShellCommand, scope: GuardScope): VcsDiscardCheck | undefined {
	let force = 0;
	let interactive = false;
	let directories = false;
	let includeIgnored = false;
	let ignoredOnly = false;
	const excludes: string[] = [];
	const pathspecs: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--") {
			pathspecs.push(...rest.slice(i + 1));
			break;
		}
		if (arg.startsWith("--") && arg.length > 2) {
			if (isLongOption(arg, "--dry-run")) return undefined;
			if (isLongOption(arg, "--force")) {
				force++;
			} else if (isLongOption(arg, "--interactive")) {
				interactive = true;
			} else if (isLongOption(arg, "--exclude")) {
				const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : rest[++i];
				if (value !== undefined) excludes.push(value);
			}
		} else if (arg.startsWith("-") && arg.length > 1) {
			for (let k = 1; k < arg.length; k++) {
				const letter = arg[k];
				if (letter === "n") return undefined;
				if (letter === "f") force++;
				else if (letter === "i") interactive = true;
				else if (letter === "d") directories = true;
				else if (letter === "x") includeIgnored = true;
				else if (letter === "X") ignoredOnly = true;
				else if (letter === "e") {
					// `-e` takes the rest of the bundle, or the next word.
					const value = k + 1 < arg.length ? arg.slice(k + 1) : rest[++i];
					if (value !== undefined) excludes.push(value);
					break;
				}
			}
		} else {
			pathspecs.push(arg);
		}
	}
	if (force === 0 && !interactive) return undefined;

	return {
		clean: true,
		directories,
		includeIgnored,
		ignoredOnly,
		nestedRepositories: force > 1,
		excludes: excludes.filter(word => !SHELL_EXPANDED_RE.test(word) && !hasBraceExpansion(word)),
		pathspecs: resolvePathspecs(pathspecs, command, scope),
	};
}

/**
 * Options of the discarding git subcommands that take the next word as their value: long ones
 * unless `=` gives it, short ones at the end of their bundle.
 */
const NEXT_WORD_OPTIONS: Record<string, { long: readonly string[]; short: string }> = {
	checkout: { long: ["--orphan", "--conflict", "--pathspec-from-file"], short: "bB" },
	switch: { long: ["--create", "--force-create", "--orphan", "--conflict"], short: "cC" },
	restore: { long: ["--source", "--conflict", "--pathspec-from-file"], short: "s" },
	clean: { long: ["--exclude"], short: "e" },
};
/**
 * Short options of the discarding git subcommands that take a value: the rest of their bundle,
 * when there is one, is that value (`-bfix` names a branch, it does not force).
 */
const SHORT_VALUE_LETTERS: Record<string, string> = { checkout: "bBt", switch: "cCt", restore: "s", clean: "e" };

/**
 * The operands of a git `sub`command (`checkout`, `switch`, `restore`, `reset`, `clean`), without
 * its options and their values: `named` before a `--`, `paths` after it, the tree-ish `git restore`
 * names with `--source` or `-s`, and whether an option asks for the usage (`-h`, `--help`,
 * `--help-all`), which a pathspec after `--` or an option's value (`git checkout -- --help`,
 * `git clean -e --help`) does not.
 */
function gitOperands(
	sub: string,
	rest: readonly string[],
): { named: string[]; paths: string[] | undefined; source: string | undefined; help: boolean } {
	const options = Object.hasOwn(NEXT_WORD_OPTIONS, sub) ? NEXT_WORD_OPTIONS[sub] : { long: [], short: "" };
	const stuck = Object.hasOwn(SHORT_VALUE_LETTERS, sub) ? SHORT_VALUE_LETTERS[sub] : "";
	const restore = sub === "restore";
	const named: string[] = [];
	let source: string | undefined;
	let help = false;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--") return { named, paths: rest.slice(i + 1), source, help };
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			help ||= arg === "--help" || arg === "--help-all";
			// `--force` is an option of its own, not short for `git switch --force-create`.
			const next = arg !== "--force" && options.long.some(name => isLongOption(arg, name));
			const value = eq > 0 ? arg.slice(eq + 1) : next ? rest[++i] : undefined;
			if (restore && isLongOption(arg, "--source")) source = value;
		} else if (arg.startsWith("-") && arg !== "-") {
			for (let k = 1; k < arg.length; k++) {
				const letter = arg[k];
				help ||= letter === "h";
				if (!stuck.includes(letter)) continue;
				const value =
					k + 1 < arg.length ? arg.slice(k + 1) : options.short.includes(letter) ? rest[++i] : undefined;
				if (restore && letter === "s") source = value;
				break;
			}
		} else {
			named.push(arg);
		}
	}
	return { named, paths: undefined, source, help };
}

/** The short option letters `rest` gives a git subcommand, without the values stuck to them. */
function shortOptionLetters(sub: string, rest: readonly string[]): string {
	const valueLetters = Object.hasOwn(SHORT_VALUE_LETTERS, sub) ? SHORT_VALUE_LETTERS[sub] : "";
	let letters = "";
	for (const arg of rest) {
		if (arg === "--") break;
		if (!/^-[A-Za-z]/.test(arg)) continue;
		for (const letter of arg.slice(1)) {
			letters += letter;
			if (valueLetters.includes(letter)) break;
		}
	}
	return letters;
}

/**
 * The discard check for a git command, with the rule's reason, or `undefined` when it discards
 * nothing. A command that checks files out of another commit names it as the check's `source`: it
 * also overwrites the untracked files that commit tracks.
 */
function discardProbe(
	command: ShellCommand,
	scope: GuardScope,
	sub: string,
	rest: readonly string[],
): { check: VcsDiscardCheck; what: string } | undefined {
	const has = (name: string) => rest.some(arg => arg.startsWith("--") && isLongOption(arg, name));
	const short = shortOptionLetters(sub, rest);
	const { named, paths, source, help } = gitOperands(sub, rest);
	// `-h` and `--help` print the usage and run nothing.
	if (help) return undefined;
	const tracked = (check: VcsDiscardCheck) => ({
		check,
		what: `\`git ${sub}\` would discard uncommitted changes; commit or otherwise save them first`,
	});
	// `--merge` reverts only staged changes (refusing while a path has both, or an untracked file is
	// in the way); `--hard` loses every change, and to another commit, untracked files it tracks.
	if (sub === "reset" && has("--hard")) return tracked({ source: named[0] });
	if (sub === "reset" && has("--merge")) return tracked({ merge: true });
	// The commit a checkout's or a switch's first operand names: `-` is the branch checked out before.
	const commit = named[0] === "-" ? "@{-1}" : named[0];
	if (sub === "checkout" || sub === "restore") {
		const checkout = sub === "checkout";
		// `git checkout [<commit>] [--] <paths>`: before a `--`, the first operand names a commit
		// unless it is a whole-tree pathspec. `git restore` names its commit with `--source`.
		const fromCommit =
			checkout && named.length > 0 && (paths !== undefined || !Object.hasOwn(MASS_PATHSPECS, named[0]));
		const pathspecs = paths ?? (fromCommit ? named.slice(1) : named);
		if (pathspecs.some(arg => Object.hasOwn(MASS_PATHSPECS, arg))) {
			// Restoring from the index keeps the staged changes there; restoring from a commit, or
			// `restore --staged --worktree`, overwrites the index too.
			const staged = !checkout && (has("--staged") || short.includes("S"));
			if (staged && !has("--worktree") && !short.includes("W")) return undefined;
			return tracked({
				worktreeOnly: checkout ? !fromCommit : !staged,
				pathspecs: resolvePathspecs(pathspecs, command, scope),
				source: checkout ? (fromCommit ? commit : undefined) : source,
			});
		}
	}
	if (
		(sub === "checkout" || sub === "switch") &&
		(has("--force") || has("--discard-changes") || short.includes("f"))
	) {
		return tracked({ source: commit });
	}
	if (sub === "clean") {
		const check = cleanCheck(rest, command, scope);
		return (
			check && {
				check,
				what: "`git clean` would delete untracked files that exist nowhere else; delete specific files instead",
			}
		);
	}
	return undefined;
}

/**
 * What a `git stash` saves besides every change to tracked files: untracked files (`-u`), and
 * ignored ones too (`-a`).
 */
interface Stashed {
	untracked: boolean;
	ignored: boolean;
}

/**
 * What `git stash` with these arguments saves, or `undefined` when it saves nothing or only part of
 * the tracked changes: some paths, some hunks (`-p`), or the index alone (`--staged`), or when it
 * only prints its usage (`-h`, `--help`). Of `-u`, `-a`, `--no-include-untracked` and `--no-all`,
 * the last one counts.
 */
function stashSaves(rest: readonly string[]): Stashed | undefined {
	const save = rest[0] === "save";
	const options = rest[0] === "push" || save ? rest.slice(1) : rest;
	// `list`, `show`, `apply`, `pop`, `drop`, ... save nothing.
	if (options === rest && rest.length > 0 && !rest[0].startsWith("-")) return undefined;
	const saved: Stashed = { untracked: false, ignored: false };
	const include = (untracked: boolean, ignored: boolean) => {
		saved.untracked = untracked;
		saved.ignored = ignored;
	};
	for (let i = 0; i < options.length; i++) {
		const arg = options[i];
		if (arg === "--") {
			// `push -- <paths>` stashes only those paths; `save -- <message>` everything.
			if (!save && i + 1 < options.length) return undefined;
			break;
		}
		if (arg.startsWith("--") && arg.length > 2) {
			if (arg === "--help" || arg === "--help-all") return undefined;
			if (isLongOption(arg, "--message")) {
				if (!arg.includes("=")) i++;
			} else if (["--patch", "--staged", "--pathspec-from-file"].some(name => isLongOption(arg, name))) {
				return undefined;
			} else if (isLongOption(arg, "--all")) {
				include(true, true);
			} else if (isLongOption(arg, "--include-untracked")) {
				include(true, false);
			} else if (isLongOption(arg, "--no-all") || isLongOption(arg, "--no-include-untracked")) {
				include(false, false);
			}
		} else if (arg.startsWith("-") && arg.length > 1) {
			for (let k = 1; k < arg.length; k++) {
				const letter = arg[k];
				if (letter === "p" || letter === "S" || letter === "h") return undefined;
				if (letter === "a") include(true, true);
				else if (letter === "u") include(true, false);
				else if (letter === "m") {
					// `-m` takes the rest of the bundle, or the next word.
					if (k === arg.length - 1) i++;
					break;
				}
			}
		} else if (!save) {
			// A pathspec: only those paths are stashed.
			return undefined;
		}
	}
	return saved;
}

/** `git stash` subcommands that take saved work back out of the stash: into the tree, or away. */
const STASH_RELEASES: Record<string, true> = { pop: true, drop: true, clear: true, branch: true };
/**
 * `git stash` subcommands that bring saved work back into the tree, where a discard after them
 * can destroy it once the stash no longer holds it (after `pop` or `branch`, or an `apply` and a
 * `drop`).
 */
const STASH_RESTORES: Record<string, true> = { pop: true, apply: true, branch: true };

/**
 * The arguments after `stash` and the target of a `git stash` that git runs, or `undefined` for any
 * other command and for one git exits before (`git --version stash`).
 */
function gitStash(command: ShellCommand, home: string): { rest: string[]; target?: GitTarget } | undefined {
	if (command.argv[0] !== "git") return undefined;
	const { sub, rest, target, exits } = gitInvocation(command, home);
	return sub === "stash" && !exits ? { rest, target } : undefined;
}

/** Whether `command` takes saved work back out of the stash (`git stash pop`, `drop`, `clear`, `branch`). */
function releasesStash(command: ShellCommand, home: string): boolean {
	const rest = gitStash(command, home)?.rest;
	return rest !== undefined && rest.length > 0 && Object.hasOwn(STASH_RELEASES, rest[0]);
}

/** A top-level `git stash pop`, `apply` or `branch` of a command line ({@link STASH_RESTORES}). */
interface StashRestore {
	/** Its stash subcommand. */
	sub: string;
	/** The index of its pipeline in the command line. */
	pipeline: number;
	/** Where it works; none when a directory it names is a word the guard cannot resolve. */
	target: GitTarget | undefined;
	/** Its repository ({@link gitRepository}), `""` for none, once a discard has asked. */
	repository?: string;
}

/** A `git stash` that has succeeded in a `&&` chain. */
interface StashLink {
	/** The chain link whose command it is. */
	link: SucceededLink;
	/** It takes saved work back out (`pop`, `drop`, `clear`, `branch`), so no earlier stash holds anything. */
	release: boolean;
	/** The repository and work tree it saves ({@link gitRepository}), when it saves every change to tracked files there. */
	repository: string | undefined;
	/** What it saves besides the tracked changes, when it saves every one of them. */
	saved: Stashed | undefined;
}

/**
 * The repository and work tree a git command at `target` works on, as one key, or `undefined` when
 * it finds none. A `git stash` saves the whole work tree, whichever of its directories it runs in.
 */
function gitRepository(target: GitTarget | undefined): string | undefined {
	if (!target) return undefined;
	// With a repository named and no work tree, git takes the directory it runs in as the work tree.
	if (target.gitDir !== undefined) return `${target.gitDir}\0${target.workTree ?? target.where}`;
	try {
		const info = vcs.gitInfo(target.where);
		return info ? `${info.gitDir}\0${target.workTree ?? info.repoRoot}` : undefined;
	} catch {
		return undefined;
	}
}

/** The `git stash` that is `link`'s command, or `undefined` when the command is none ({@link gitStash}). */
function stashAt(link: SucceededLink, scope: GuardScope): StashLink | undefined {
	const stash = gitStash(link.command, scope.home);
	if (!stash) return undefined;
	const { rest, target } = stash;
	const release = rest.length > 0 && Object.hasOwn(STASH_RELEASES, rest[0]);
	const saved = release ? undefined : stashSaves(rest);
	return { link, release, repository: saved && gitRepository(target), saved };
}

/** The latest `git stash` at or before each chain link looked at, `null` for none. */
const latestStashes = new WeakMap<SucceededLink, StashLink | null>();

/**
 * The latest `git stash` at or before `link` in its `&&` chain. Every link is looked at once, for
 * whichever command asks first, so a chain costs one step per link however many commands ask.
 */
function latestStash(link: SucceededLink | undefined, scope: GuardScope): StashLink | undefined {
	const pending: SucceededLink[] = [];
	let found: StashLink | undefined;
	for (; link; link = link.before) {
		const known = latestStashes.get(link);
		if (known !== undefined) {
			found = known ?? undefined;
			break;
		}
		found = stashAt(link, scope);
		if (found) {
			latestStashes.set(link, found);
			break;
		}
		pending.push(link);
	}
	for (const visited of pending) latestStashes.set(visited, found ?? null);
	return found;
}

/** How many links of the chain at or before each link looked at release the stash ({@link releasesStash}). */
const chainReleases = new WeakMap<SucceededLink, number>();

/**
 * How many links of `link`'s `&&` chain, at or before it, take saved work back out of the stash.
 * Every link is looked at once, as in {@link latestStash}.
 */
function releasesThrough(link: SucceededLink | undefined, scope: GuardScope): number {
	const pending: SucceededLink[] = [];
	let count = 0;
	for (; link; link = link.before) {
		const known = chainReleases.get(link);
		if (known !== undefined) {
			count = known;
			break;
		}
		pending.push(link);
	}
	for (let i = pending.length - 1; i >= 0; i--) {
		if (releasesStash(pending[i].command, scope.home)) count++;
		chainReleases.set(pending[i], count);
	}
	return count;
}

/**
 * The most `git stash` commands {@link stashedBefore} looks back through. One further back is not
 * counted: the command is checked as if it had not run, so the rule can fire on work it saved, but
 * never misses work.
 */
const STASH_LOOKBACK = 64;

/**
 * What the `git stash` commands that have succeeded by the time `command` runs (earlier in its `&&`
 * chain) saved in the repository and work tree `target` works on and still hold, or `undefined` for
 * none. `releases` counts the top-level commands of the command line that take saved work back out
 * of the stash (`pop`, `drop`, `clear`, `branch`, in any pipeline stage) and may run before
 * `command` finishes: all but those in the later pipelines that wait for its pipeline, the rest of
 * its and-or list and, unless `&` runs that list in the background, the rest of the line
 * ({@link lineStashes}). A stash holds its work only when every one of them is a link of its
 * chain before it, known to have run first; any other may run between it and `command`. When the
 * line can run one the guard does not see (`"unseen"`: a part it does not read, such as the first
 * nested part where reading stops, or a shell or `eval`, wherever it is), no stash counts.
 * Only stashes are visited, at most {@link STASH_LOOKBACK} of them.
 */
function stashedBefore(
	command: ShellCommand,
	target: GitTarget,
	scope: GuardScope,
	releases: StashReleases,
): Stashed | undefined {
	if (releases === "unseen") return undefined;
	let stashed: Stashed | undefined;
	let stash = latestStash(command.succeeded, scope);
	// Looked up at the first stash that saved something.
	let repository: string | undefined | null = null;
	for (let seen = 0; stash && !stash.release && seen < STASH_LOOKBACK; seen++) {
		// The releases before this stash are before every older one too: none of those holds more.
		if (releases > 0 && releasesThrough(stash.link.before, scope) < releases) break;
		const { saved } = stash;
		if (saved && stash.repository !== undefined) {
			if (repository === null) repository = gitRepository(target);
			if (stash.repository === repository) {
				stashed = {
					untracked: saved.untracked || (stashed?.untracked ?? false),
					ignored: saved.ignored || (stashed?.ignored ?? false),
				};
				// An `-a` stash saved all there is.
				if (stashed.ignored) break;
			}
		}
		stash = latestStash(stash.link.before, scope);
	}
	return stashed;
}

/**
 * `releases`: as for {@link stashedBefore}. `restores`: the top-level `git stash pop`, `apply` and
 * `branch` commands of the command line that may run before `command` finishes, as for the
 * releases. The probe sees the tree as it is before the line runs, without the work one of them
 * brings back, so one in the same repository, or in a directory the guard cannot place, makes the
 * command a hit, unless a stash that saved what the command discards has run after it.
 */
function discardChanges(
	command: ShellCommand,
	scope: GuardScope,
	probes: GuardProbeBudget,
	releases: StashReleases,
	restores: readonly StashRestore[],
): GuardHit | undefined {
	if (command.argv[0] !== "git") return undefined;
	const { sub, rest, target, exits } = gitInvocation(command, scope.home);
	const probe = discardProbe(command, scope, sub, rest);
	if (!probe || !target || exits) return undefined;
	// The probe reads the repository's own index; one `GIT_INDEX_FILE` names instead can hold
	// staged files the default index lacks, which the command would delete.
	if (command.assignments.some(assignment => assignment.startsWith("GIT_INDEX_FILE="))) {
		return hit(
			"discard_changes",
			`\`git ${sub}\` runs with another index (\`GIT_INDEX_FILE\`), whose changes the guard cannot check`,
		);
	}
	// The probe leaves submodules out, but with `--recurse-submodules` the command also resets
	// their work trees, whose changes it would discard.
	if (sub !== "clean" && recursesSubmodules(rest)) {
		return hit(
			"discard_changes",
			`\`git ${sub} --recurse-submodules\` also discards changes in submodules, which the guard cannot check`,
		);
	}
	let check: VcsDiscardCheck = { ...probe.check, gitDir: target.gitDir, workTree: target.workTree };
	// A stash just before keeps what it saved; only what it left behind can be lost. It keeps no
	// nested repository, only a pointer to its commit, so a `git clean -ff` is checked in full. A
	// `pop` or `branch` that may run before the command is a release, so the stash counts only
	// after it, and saves what it brought back; an `apply` leaves that work in the stash too.
	const stashed = check.nestedRepositories ? undefined : stashedBefore(command, target, scope, releases);
	if (stashed) {
		// `-a` saved every file there is.
		if (stashed.ignored) return undefined;
		if (check.clean) {
			if (stashed.untracked) {
				if (!check.includeIgnored && !check.ignoredOnly) return undefined;
				check = { ...check, untrackedStashed: true };
			}
		} else {
			// Without `-u`, the untracked files a checkout of another commit overwrites are left.
			if (check.source === undefined || stashed.untracked) return undefined;
			check = { ...check, trackedStashed: true };
		}
	}
	if (restores.length > 0) {
		const repository = gitRepository(target);
		const restore =
			repository !== undefined &&
			restores.find(restoring => {
				if (!restoring.target) return true;
				restoring.repository ??= gitRepository(restoring.target) ?? "";
				return restoring.repository === repository;
			});
		if (restore) {
			return hit(
				"discard_changes",
				`\`git ${sub}\` may discard the work \`git stash ${restore.sub}\` brings back first; commit it or leave it in the stash`,
			);
		}
	}
	const { where } = target;
	const answer = probes.ask(`git\0${where}\0${JSON.stringify(check)}`, timeoutMs =>
		vcs.discardsWorkSync(where, check, timeoutMs),
	);
	return answer === true ? hit("discard_changes", probe.what) : undefined;
}

// -- kills_harness -----------------------------------------------------------------------------------

/**
 * This process and its ancestors below init. The process itself always counts, PID 1 included: omp
 * is PID 1 when it is a container's entrypoint.
 */
function harnessLineage(): number[] {
	const pids = [process.pid];
	let pid = Process.fromPid(process.pid)?.ppid ?? null;
	while (pid !== null && pid > 1 && !pids.includes(pid) && pids.length < 32) {
		pids.push(pid);
		pid = Process.fromPid(pid)?.ppid ?? null;
	}
	return pids;
}

/** Signal names `kill -l` lists, without their `SIG` prefix. */
const SIGNAL_NAMES: ReadonlySet<string> = new Set(Object.keys(os.constants.signals).map(name => name.slice(3)));
/** Linux keeps a process's name in 15 characters; psmisc `killall` matches a longer name whole. */
const COMM_LENGTH = 15;
/** psmisc `killall` short options that take a value: the rest of their bundle, or the next word. */
const KILLALL_VALUE_LETTERS = "uoynZs";
/** psmisc `killall` long options that take a value: after `=`, or the next word. */
const KILLALL_VALUE_OPTIONS = ["--user", "--older-than", "--younger-than", "--ns", "--context"];

/**
 * One question that lists what a `pkill`/`killall` would signal: a `pgrep` with the same
 * selection, or for a `killall` name that is a path, the processes running that executable.
 */
interface KillProbe {
	/** The cache key. */
	key: string;
	/** The PIDs it lists, one per line, or `undefined` when it fails or takes longer than `timeoutMs`. */
	run(timeoutMs: number): string | undefined;
}

/** A probe running `pgrep` with `argv`. */
function pgrepProbe(argv: string[]): KillProbe {
	const run = (timeoutMs: number) => {
		const result = Bun.spawnSync(argv, {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			timeout: timeoutMs,
		});
		return result.success ? result.stdout.toString() : undefined;
	};
	return { key: argv.join("\0"), run };
}

/**
 * The signal an option word of `pkill` or `killall` gives, without its dash, or `undefined` for an
 * option that is no signal: a number (`-9`, `-0`), or a signal name in either case, with or without
 * `SIG` (`-KILL`, `-kill`, `-SIGTERM`). `EXIT` is no signal `kill -l` lists, but `pkill` takes it.
 */
function signalOption(word: string): string | undefined {
	const value = word.slice(1);
	if (!word.startsWith("-") || value.length === 0) return undefined;
	if (/^\d+$/.test(value)) return value;
	const name = value.toUpperCase().replace(/^SIG/, "");
	return SIGNAL_NAMES.has(name) || name === "EXIT" ? value : undefined;
}

/** procps `pkill` short options that take a value: the rest of their bundle, or the next word. */
const PKILL_VALUE_LETTERS = "gGPstuUFrOq";
/**
 * procps `pkill` long options `pgrep` lacks or answers differently, each with the shortest
 * abbreviation getopt takes for it (`--co`, as `--c` could also be `--cgroup`).
 */
const PKILL_DROPPED_OPTIONS = [
	{ long: "--count", shortest: "--co" },
	{ long: "--echo", shortest: "--ec" },
] as const;
/** procps `pkill`'s `--queue`, which takes a value and which `pgrep` lacks. */
const PKILL_QUEUE_OPTION = { long: "--queue", shortest: "--q" };

/**
 * The selection a `pkill` gives `pgrep`: its options without the ones `pgrep` lacks or answers
 * differently. `-c` and `--count` (a count, not PIDs), `-e` and `--echo`, and `-H` go; `-q` and
 * `--queue` go with the value they take, a long one also when abbreviated (`--cou`, `--qu 5`).
 * Every other option selects what `pkill` does, and one that takes a value keeps it whole, stuck
 * on (`-ucoolify`, `--parent=1`) or the next word.
 */
function pgrepSelection(kept: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < kept.length; i++) {
		const arg = kept[i];
		if (arg === "--") {
			out.push(...kept.slice(i));
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const flag = eq < 0 ? arg : arg.slice(0, eq);
			const names = (option: { long: string; shortest: string }) =>
				flag.length >= option.shortest.length && option.long.startsWith(flag);
			if (names(PKILL_QUEUE_OPTION)) {
				if (eq < 0) i++;
			} else if (!PKILL_DROPPED_OPTIONS.some(names)) {
				out.push(arg);
			}
		} else if (arg.startsWith("-") && arg.length > 1) {
			let letters = "";
			for (let k = 1; k < arg.length; k++) {
				const letter = arg[k];
				if (PKILL_VALUE_LETTERS.includes(letter)) {
					const stuck = arg.slice(k + 1);
					const value = stuck === "" ? kept[++i] : undefined;
					if (letter !== "q") letters += letter + stuck;
					if (letters.length > 0) out.push(`-${letters}`);
					if (letter !== "q" && value !== undefined) out.push(value);
					letters = "";
					break;
				}
				if (!"cHe".includes(letter)) letters += letter;
			}
			if (letters.length > 0) out.push(`-${letters}`);
		} else out.push(arg);
	}
	return out;
}

/**
 * The probes that list what a `pkill`/`killall` would signal. A zero signal sends nothing, so it
 * needs none. `pkill` takes `pgrep`'s selection options, without the ones `pgrep` lacks or answers
 * differently (see {@link pgrepSelection}). psmisc `killall` selects processes by exact name (`-r` a
 * regular expression, `-I` ignoring case), by the executable a name that contains a `/` resolves to,
 * and by owner (`-u`, every process of that user when it names none). A name of 15 or more characters
 * is probed by its first 15, the name the kernel keeps for the process. On the BSDs both spare their
 * ancestors, so omp, unless given `-a`; BSD `killall` has no path names, and its `pgrep` gets `-a`:
 * the probe is a child of omp, so without it omp is never listed.
 */
function killMatchProbes(command: ShellCommand, scope: GuardScope): KillProbe[] {
	const name = command.argv[0];
	const kept: string[] = [];
	let signal: string | undefined;
	const argv = args(command);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const option = signalOption(arg);
		if (name === "pkill" ? arg === "--signal" : arg === "-s" || arg === "--signal") signal = argv[++i];
		else if (arg.startsWith("--signal=")) signal = arg.slice("--signal=".length);
		else if (name === "killall" && /^-s./.test(arg)) signal = arg.slice(2);
		else if (option !== undefined) signal = option;
		else kept.push(arg);
	}
	if (signal !== undefined && (/^0+$/.test(signal) || /^(SIG)?EXIT$/i.test(signal))) return [];
	if (name === "pkill") {
		// `pgrep` refuses a selection with no criterion in it, as `pkill` does.
		const selection = pgrepSelection(kept);
		return selection.length > 0 ? [pgrepProbe(["pgrep", ...selection])] : [];
	}
	const names: string[] = [];
	let user: string | undefined;
	let ignoreCase = false;
	let regexp = false;
	for (let i = 0; i < kept.length; i++) {
		const arg = kept[i];
		if (arg === "--") {
			names.push(...kept.slice(i + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const valueOption = KILLALL_VALUE_OPTIONS.find(option => isLongOption(arg, option));
			const value = eq > 0 ? arg.slice(eq + 1) : valueOption ? kept[++i] : undefined;
			if (valueOption === "--user") user = value;
			else if (isLongOption(arg, "--ignore-case")) ignoreCase = true;
			else if (isLongOption(arg, "--regexp")) regexp = true;
		} else if (arg.startsWith("-") && arg.length > 1) {
			for (let k = 1; k < arg.length; k++) {
				const letter = arg[k];
				if (letter === "I") ignoreCase = true;
				else if (letter === "r") regexp = true;
				else if (KILLALL_VALUE_LETTERS.includes(letter)) {
					const value = k + 1 < arg.length ? arg.slice(k + 1) : kept[++i];
					if (letter === "u") user = value;
					break;
				}
			}
		} else {
			names.push(arg);
		}
	}
	const bsd = process.platform === "darwin" || process.platform === "freebsd";
	const select = [...(bsd ? ["-a"] : []), ...(user === undefined ? [] : ["-u", user])];
	if (names.length === 0) return user === undefined ? [] : [pgrepProbe(["pgrep", ...select])];
	const match = [...(ignoreCase ? ["-i"] : []), ...(regexp ? [] : ["-x"])];
	return names.flatMap(processName => {
		if (bsd || regexp || !processName.includes("/")) {
			const probe =
				!bsd && !regexp && processName.length >= COMM_LENGTH ? processName.slice(0, COMM_LENGTH) : processName;
			return pgrepProbe(["pgrep", ...select, ...match, "--", probe]);
		}
		const executable = resolveCommandWordPath(command, processName, command.cwd, scope.home);
		if (executable === undefined) return [];
		const run = () =>
			Process.fromPath(fs.realpathSync(executable))
				.map(found => found.pid)
				.join("\n");
		return [{ key: `executable\0${executable}`, run }];
	});
}

/**
 * The embedded shell runs `pkill` as its own builtin, which refuses to signal this process or its
 * ancestors, so that builtin cannot reach omp. The rule still asks: a PTY or client-terminal backend
 * runs the system `pkill`, and so does a `pkill` behind a wrapper such as `sudo` or `xargs`.
 */
function killsHarness(command: ShellCommand, scope: GuardScope, budget: GuardProbeBudget): GuardHit | undefined {
	const name = command.argv[0];
	if (name !== "pkill" && name !== "killall") return undefined;
	const probes = killMatchProbes(command, scope);
	if (probes.length === 0) return undefined;
	const lineage = harnessLineage();
	for (const probe of probes) {
		const output = budget.ask(probe.key, probe.run);
		if (typeof output !== "string") continue;
		const matched = output
			.split("\n")
			.map(line => Number.parseInt(line.trim(), 10))
			.filter(pid => lineage.includes(pid));
		if (matched.length > 0) {
			return hit(
				"kills_harness",
				`\`${name}\` would also kill the omp process running this session or a parent of it (PID ${matched.join(", ")}); stop only what you started, by PID or with a pattern that matches nothing else`,
			);
		}
	}
	return undefined;
}

// -- entry points ------------------------------------------------------------------------------------

/**
 * The commands that take saved work back out of the stash (`git stash pop`, `drop`, `clear`,
 * `branch`; see {@link stashedBefore}) that may run before a command finishes: how many top-level
 * ones, or `"unseen"` when part of its command line can run one the guard does not see
 * ({@link lineStashes}).
 */
type StashReleases = number | "unseen";

/** Options for {@link findShellGuardHit} and {@link findPipelineGuardHits}. */
export interface ShellGuardOptions {
	/**
	 * Whether `discard_changes` and `kills_harness` may run their probes. Without probes those
	 * rules never fire; callers turn them off when the answer cannot change the decision.
	 */
	probe?: boolean;
	/**
	 * The probe budget of the tool call this check is for ({@link callProbeBudget}): its probes
	 * share the call's time and answers, and a pipeline checked again for the call gets what its
	 * first check found. Without one the check has its own {@link PROBE_BUDGET_MS}.
	 */
	budget?: GuardProbeBudget;
}

/**
 * Programs that run shell code the guard does not read: a shell (its `-c` string, its script, or
 * the script it is fed), `eval`, `source` and `.`, `trap`'s action, and `coproc`'s command.
 */
const SHELL_CODE_RUNNERS: Record<string, true> = {
	".": true,
	ash: true,
	bash: true,
	busybox: true,
	coproc: true,
	csh: true,
	dash: true,
	eval: true,
	fish: true,
	ksh: true,
	mksh: true,
	sh: true,
	source: true,
	tcsh: true,
	trap: true,
	yash: true,
	zsh: true,
};

/** The `git stash` commands of a command line that bear on its discards ({@link lineStashes}). */
interface LineStashes {
	/**
	 * For each pipeline, by index, how many of the commands that take saved work back out of the
	 * stash ({@link releasesStash}) may run before it finishes, or `"unseen"` when one can run where
	 * the guard does not look ({@link stashedBefore}).
	 */
	releases: readonly number[] | "unseen";
	/** Its top-level stash restores ({@link STASH_RESTORES}), in order. */
	restores: readonly StashRestore[];
}

/**
 * The stash commands of `line`. Releases count, for each pipeline, those in it or before it and
 * those in the later pipelines that do not wait for it ({@link ShellLine.overlapFrom}), all of
 * which may run before it finishes; or `"unseen"` when one can run where the guard does not look:
 * the line has a part it does not read ({@link ShellLine.nested}), the first nested part where
 * reading stops among them, or a command that runs shell code ({@link SHELL_CODE_RUNNERS}). The
 * restores are listed from the top-level commands it reads either way.
 */
function lineStashes(line: ShellLine, home: string): LineStashes {
	const { pipelines, overlapFrom } = line;
	const restores: StashRestore[] = [];
	let unseen = line.nested;
	// The releases in the pipelines before each index.
	const before = [0];
	for (const [index, pipeline] of pipelines.entries()) {
		let count = before[before.length - 1];
		for (const command of pipeline) {
			if (Object.hasOwn(SHELL_CODE_RUNNERS, command.argv[0])) unseen = true;
			const stash = gitStash(command, home);
			if (!stash || stash.rest.length === 0) continue;
			const sub = stash.rest[0];
			if (Object.hasOwn(STASH_RELEASES, sub)) count++;
			if (Object.hasOwn(STASH_RESTORES, sub)) restores.push({ sub, pipeline: index, target: stash.target });
		}
		before.push(count);
	}
	const total = before[pipelines.length];
	// All but those from the next pipeline up to the first that may start before it finishes.
	const releases = unseen
		? "unseen"
		: pipelines.map((_, index) => total - before[overlapFrom[index] ?? pipelines.length] + before[index + 1]);
	return { releases, restores };
}

/**
 * The first fixed rule each of `pipelines` breaks, `undefined` for one that breaks none:
 * `secret_send` across the pipeline first, then `credential_read`. Resets the brace budget
 * ({@link braceTextLeft}) for the command line they come from.
 */
function fixedPipelineHits(pipelines: readonly ShellCommand[][], home: string): (GuardHit | undefined)[] {
	braceTextLeft = MAX_BRACE_TEXT;
	const credentials = credentialIndex(home);
	return pipelines.map(pipeline => {
		// The first secret a stage before the sender being checked puts out; each stage is read once.
		let upstream: string | undefined;
		let read = 0;
		for (const [index, sender] of pipeline.entries()) {
			if (!Object.hasOwn(SENDERS, sender.argv[0])) continue;
			const earlier = () => {
				for (; read < index && upstream === undefined; read++) upstream = secretOutput(pipeline[read], credentials);
				return upstream;
			};
			const found = secretSend(sender, earlier, credentials);
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
 * What the probing rules `discard_changes` and `kills_harness` find in each pipeline of `line`,
 * the parse of `command` from `scope`, asked by the pipeline's index: the first simple command in
 * it that breaks one. A pipeline is probed once for the call: what it found is kept in the call's
 * budget ({@link GuardProbeBudget.results}). From a stand-in directory ({@link GuardScope.cwdStandIn})
 * the line is read again from an unknown one, so that no probe runs in a directory derived from it.
 */
function pipelineProbes(
	command: string,
	line: ShellLine,
	scope: GuardScope,
	options: ShellGuardOptions,
): (index: number) => GuardHit | undefined {
	const budget = options.budget ?? new GuardProbeBudget();
	const key = `${scope.cwd}\0${scope.cwdStandIn === true}\0${scope.home}\0${command}`;
	let kept = budget.results.get(key);
	if (!kept) {
		kept = new Map();
		budget.results.set(key, kept);
	}
	const results = kept;
	let probed: { line: ShellLine; stashes: LineStashes } | undefined;
	return index => {
		if (results.has(index)) return results.get(index);
		if (!probed) {
			const read = scope.cwdStandIn ? parseShellCommands(command, { cwd: undefined, home: scope.home }) : line;
			probed = { line: read, stashes: lineStashes(read, scope.home) };
		}
		const { line: read, stashes } = probed;
		const releases = stashes.releases === "unseen" ? "unseen" : stashes.releases[index];
		// The restores that may run before this pipeline finishes, as for the releases.
		const bound = read.overlapFrom[index] ?? read.pipelines.length;
		const restores = stashes.restores.filter(({ pipeline }) => pipeline <= index || pipeline >= bound);
		let found: GuardHit | undefined;
		for (const simple of read.pipelines[index]) {
			found = discardChanges(simple, scope, budget, releases, restores) ?? killsHarness(simple, scope, budget);
			if (found) break;
		}
		results.set(index, found);
		return found;
	};
}

/**
 * The rule each pipeline of a shell command line breaks, `undefined` for one that breaks none, one
 * entry per pipeline {@link parseShellCommands} finds, in order: its first fixed rule
 * ({@link fixedPipelineHits}), else its first probing rule ({@link pipelineProbes}). Each pipeline
 * is checked from the directory the ones before it leave, after the commands known to have
 * succeeded before it. A line whose brace lists expand past {@link MAX_BRACE_TEXT} is not probed:
 * it fails closed as a whole ({@link findShellGuardHit}).
 */
export function findPipelineGuardHits(
	command: string,
	scope: GuardScope,
	options: ShellGuardOptions = {},
): (GuardHit | undefined)[] {
	const line = parseShellCommands(command, scope);
	const hits = fixedPipelineHits(line.pipelines, scope.home);
	if (braceTextLeft < 0 || options.probe === false) return hits;
	const probe = pipelineProbes(command, line, scope, options);
	return hits.map((found, index) => found ?? probe(index));
}

/**
 * The first rule a shell command line breaks, or `undefined`: a fixed rule of any pipeline
 * ({@link fixedPipelineHits}) first, then `size_limit` for a line whose brace lists expand past
 * {@link MAX_BRACE_TEXT}, then the probing rules ({@link pipelineProbes}), which run only after
 * every other rule has passed and stop at the first pipeline that breaks one.
 */
export function findShellGuardHit(
	command: string,
	scope: GuardScope,
	options: ShellGuardOptions = {},
): GuardHit | undefined {
	const line = parseShellCommands(command, scope);
	const found = fixedPipelineHits(line.pipelines, scope.home).find(pipelineHit => pipelineHit !== undefined);
	if (found) return found;
	if (braceTextLeft < 0) return SIZE_LIMIT_HIT;
	if (options.probe === false) return undefined;
	const probe = pipelineProbes(command, line, scope, options);
	for (let index = 0; index < line.pipelines.length; index++) {
		const probed = probe(index);
		if (probed) return probed;
	}
	return undefined;
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
