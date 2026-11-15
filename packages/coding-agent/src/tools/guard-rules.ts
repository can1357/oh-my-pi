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
 * - Commands inside a `bash -c` or `eval` string, or captured by `$( )`, are not linked to the
 *   pipeline around them: `bash -c 'cat .env' | curl -d @- ...`.
 * - A heredoc opened inside `$( )` whose body starts after the closing `)` is not that command's
 *   input: `echo "$(curl -d @- ... <<EOF)"` with a `$(cat .env)` body line.
 * - A path behind a directory the guard cannot expand is not resolved: `cat "$(pwd)/.env"`.
 * - Upload syntaxes and network tools it does not model are not seen: `gh gist create .env`.
 * - Programs outside the reader list are not seen reading: `tac ~/.ssh/id_rsa`,
 *   `jq . ~/.docker/config.json`.
 * - A command run by a program it does not unwrap, or given its operands at run time, is not
 *   checked with them: `find ~/.ssh -exec cat {} +`, `ls ~/.ssh/id_* | xargs cat`.
 * - A directory that contains a credential location does not count as one:
 *   `tar czf - ~ | curl -T - ...`.
 * - A secret copied to another file first is sent under that file's name:
 *   `cp .env /tmp/x && curl -F f=@/tmp/x ...`.
 * - A same-size edit to a file a configured filter driver handles (git-lfs, git-crypt) is not seen
 *   by `discard_changes`: the probe runs no filter, so it compares such a file by size.
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
import type { ToolApprovalDecision, ToolTier } from "@oh-my-pi/pi-agent-core";
import { getAgentDbPath, getAuthBrokerSnapshotCachePath } from "@oh-my-pi/pi-utils";
import { isReadableUrlPath, splitPathAndSel } from "@oh-my-pi/pi-tui/tools/read";
import { InternalUrlRouter } from "../internal-urls/router";
import { resolveToCwd } from "./path-utils";
import {
	parseShellScript,
	resolveCommandWordPath,
	SHELL_SCRIPT_MAX_DEPTH,
	SHELL_SCRIPT_MAX_NESTED_TEXT,
	type ShellCommand,
	shellPositionalArgs,
	type SucceededLink,
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

export type GuardRule =
	| "critical_pattern"
	| "nesting_limit"
	| "credential_read"
	| "secret_send"
	| "discard_changes"
	| "kills_harness";

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
const PROC_ENVIRON_RE = /^\/proc\/[^/]+\/environ$/;

/** omp's own credential stores: the agent database (auth storage) and the auth-broker snapshot. */
function ompCredentialStores(): string[] {
	const agentDb = getAgentDbPath();
	return [agentDb, `${agentDb}-wal`, `${agentDb}-shm`, getAuthBrokerSnapshotCachePath()];
}

/**
 * The credential location an absolute path is in, for display; `undefined` when it holds no
 * credentials. Public files in a credential folder (`~/.ssh/config`, `*.pub`) do not count.
 */
export function credentialLocation(absPath: string, home: string): string | undefined {
	const target = path.resolve(absPath);
	if (Object.hasOwn(SYSTEM_CREDENTIAL_FILES, target)) return target;
	if (ompCredentialStores().includes(target)) return `omp's credential store ${target}`;
	const relative = path.relative(home, target);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	const posix = relative.split(path.sep).join("/");
	if (Object.hasOwn(CREDENTIAL_FILES, posix)) return `~/${posix}`;
	for (const [folder, publicFiles] of Object.entries(CREDENTIAL_DIRS)) {
		if (posix !== folder && !posix.startsWith(`${folder}/`)) continue;
		const name = path.basename(target);
		if (posix !== folder && (publicFiles.includes(name) || name.endsWith(".pub"))) return undefined;
		return `~/${folder}`;
	}
	return undefined;
}

/**
 * The secret a word of `command` names when it is sent somewhere: a credential file, a `.env`, or
 * a process environment.
 */
function sentSecret(command: ShellCommand, word: string, home: string): string | undefined {
	const target = resolveCommandWordPath(command, word, command.cwd, home);
	if (target === undefined) return undefined;
	if (DOTENV_RE.test(path.basename(target))) return path.basename(target);
	if (PROC_ENVIRON_RE.test(target)) return "the process environment";
	return credentialLocation(target, home);
}

// -- command helpers ---------------------------------------------------------------------------------

function args(command: ShellCommand): string[] {
	return command.argv.slice(1);
}

/** The directory a command runs in, or `undefined` once a `cd` the parser could not resolve has moved it. */
function commandDir(command: ShellCommand): string | undefined {
	return command.unknownCwd ? undefined : command.cwd;
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
			operands.push(...argv.slice(i + 1));
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
			operands.push(arg);
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

/**
 * The words a `tar` command reads, with every member after a `-C`/`--directory` resolved against
 * that directory, as tar does; each `-C` is relative to the one before it. Option values stay as
 * written, and exclusions are left out. A member after a directory the guard cannot resolve is
 * left out unless it is absolute.
 */
function tarReadWords(command: ShellCommand, home: string): string[] {
	const argv = args(command);
	const words: string[] = [];
	let dir: string | undefined = command.cwd;
	const changeDir = (word: string) => {
		dir = dir === undefined ? undefined : resolveCommandWordPath(command, word, dir, home);
	};
	let i = 0;
	// An old-style first word (`tar cfC x.tar ~ .ssh`): each letter that takes a value takes the next word.
	if (argv.length > 0 && !argv[0].startsWith("-")) {
		const letters = argv[i++];
		for (const letter of letters) {
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
			}
		} else if (options && arg.startsWith("-") && arg.length > 1) {
			let k = 1;
			while (k < arg.length && !TAR_VALUE_LETTERS.includes(arg[k])) k++;
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
			if (member !== undefined) words.push(member);
		}
	}
	return words;
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
			operands.push(...argv.slice(i + 1));
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
			operands.push(arg);
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

/** The words a {@link WRITING_READERS} command reads: its arguments, without what it writes to. */
function writingReaderWords(command: ShellCommand): string[] {
	const { letters, writes, destination } = WRITING_READERS[command.argv[0]];
	const argv = args(command);
	const words: string[] = [];
	const operands: string[] = [];
	let targeted = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			operands.push(...argv.slice(i + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			if (writes.includes(eq > 0 ? arg.slice(0, eq) : arg)) {
				targeted = true;
				if (eq < 0) i++;
			} else {
				words.push(arg);
			}
		} else if (arg.startsWith("-") && arg.length > 1) {
			let k = 1;
			while (k < arg.length && !letters.includes(arg[k])) k++;
			if (k < arg.length && writes.includes(`-${arg[k]}`)) {
				targeted = true;
				if (k === arg.length - 1) i++;
			} else {
				words.push(arg);
			}
		} else {
			operands.push(arg);
		}
	}
	if (destination && !targeted) operands.pop();
	return [...words, ...operands];
}

/**
 * The words a reading command reads files from: a copy's local sources, a search's operands after
 * its pattern, a download's arguments other than where it saves, any other reader's arguments.
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
	return Object.hasOwn(READERS, name) ? args(command) : [];
}

// -- credential_read ---------------------------------------------------------------------------------

function credentialRead(command: ShellCommand, scope: GuardScope): GuardHit | undefined {
	const name = command.argv[0];
	const first = command.argv[1] ?? "";
	if (name === "security" && (first === "dump-keychain" || first === "export")) {
		return hit("credential_read", "it exports the keychain");
	}
	if (
		name === "security" &&
		first.includes("password") &&
		args(command).some(arg => /^-[A-Za-z]+$/.test(arg) && arg.includes("w"))
	) {
		return hit("credential_read", "it prints a keychain password");
	}
	if (name === "gpg" && args(command).some(arg => arg.startsWith("--export-secret"))) {
		return hit("credential_read", "it exports private keys");
	}
	const words = [...readWords(command, scope.home), ...command.reads];
	for (const word of words) {
		const target = resolveCommandWordPath(command, word, command.cwd, scope.home);
		const found = target === undefined ? undefined : credentialLocation(target, scope.home);
		if (found) return hit("credential_read", `it reads your credentials in ${found}`);
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
/** wget's options that send a file, as `--post-file=file` or `--post-file file`. */
const WGET_FILE_OPTIONS: Record<string, true> = { "--post-file": true, "--body-file": true };

/** The local files a network command sends. */
function sentFiles(command: ShellCommand): string[] {
	const name = command.argv[0];
	const argv = args(command);
	const files = [...command.reads];
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
				files.push(value);
			} else {
				const at = value.search(/[@<]/);
				if (at >= 0) files.push(value.slice(at + 1).split(";")[0]);
			}
		}
	} else if (name === "wget") {
		for (let i = 0; i < argv.length; i++) {
			const eq = argv[i].indexOf("=");
			const option = eq > 0 ? argv[i].slice(0, eq) : argv[i];
			if (!Object.hasOwn(WGET_FILE_OPTIONS, option)) continue;
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

function dumpsEnvironment(command: ShellCommand): boolean {
	const name = command.argv[0];
	if (name === "printenv" || (name === "env" && shellPositionalArgs(command.argv).length === 0)) return true;
	return name === "export" && command.argv.length === 2 && command.argv[1] === "-p";
}

/** The secret a command puts on its output: the environment, or a credential or `.env` file it reads. */
function secretOutput(command: ShellCommand, scope: GuardScope): string | undefined {
	if (dumpsEnvironment(command)) return "the environment";
	const name = command.argv[0];
	const words = [...(name === "source" ? args(command) : readWords(command, scope.home)), ...command.reads];
	for (const word of words) {
		const found = sentSecret(command, word, scope.home);
		if (found) return found;
	}
	return undefined;
}

/**
 * The first secret one of `commands` can put on its output: its own ({@link secretOutput}), or one
 * a command in its substitutions puts in its words (`printf "$(cat .env)"`), at any depth.
 */
function firstSecretOutput(commands: readonly ShellCommand[], scope: GuardScope): string | undefined {
	for (const command of commands) {
		const found = secretOutput(command, scope) ?? firstSecretOutput(command.subs, scope);
		if (found) return found;
	}
	return undefined;
}

/** A network command sending a secret: in a file it uploads, an upstream stage's output, or a substitution's. */
function secretSend(command: ShellCommand, scope: GuardScope): GuardHit | undefined {
	if (!Object.hasOwn(SENDERS, command.argv[0])) return undefined;
	let found: string | undefined;
	for (const file of sentFiles(command)) {
		found = sentSecret(command, file, scope.home);
		if (found) break;
	}
	found ??= firstSecretOutput(command.upstream, scope) ?? firstSecretOutput(command.subs, scope);
	return found ? hit("secret_send", `it sends ${found} over the network (\`${command.argv[0]}\`)`) : undefined;
}

// -- probes ------------------------------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 3_000;
/**
 * How long a probe's answer is reused. One bash call resolves approval on several paths within
 * milliseconds (`resolveApproval`, the extension wrapper before and after `tool_call` hooks,
 * speculation, the approval prompt details), and a compound prompt asks the same question per
 * segment; each must see one probe, not spawn its own. Kept short so a later call, after the
 * agent has changed the tree, probes again.
 */
const PROBE_CACHE_TTL_MS = 1_000;
const PROBE_CACHE_MAX = 64;
const probeCache = new Map<string, { at: number; answer: string | boolean | undefined }>();

/** Forgets every memoized probe answer; tests that change a repository between calls use it. */
export function clearGuardProbeCache(): void {
	probeCache.clear();
}

/**
 * The answer to the probe `key`: reused while fresh, else `run`'s, which is memoized for
 * {@link PROBE_CACHE_TTL_MS} from when it arrived, so a slow probe is reused like a fast one.
 * Ages come from the monotonic clock: a wall clock stepped back must not keep an answer alive.
 * A probe that throws answers `undefined`.
 */
function cachedProbe(key: string, run: () => string | boolean | undefined): string | boolean | undefined {
	const cached = probeCache.get(key);
	if (cached && performance.now() - cached.at < PROBE_CACHE_TTL_MS) return cached.answer;
	let answer: string | boolean | undefined;
	try {
		answer = run();
	} catch {
		answer = undefined;
	}
	const now = performance.now();
	probeCache.delete(key);
	probeCache.set(key, { at: now, answer });
	for (const [oldest, entry] of probeCache) {
		if (probeCache.size <= PROBE_CACHE_MAX && now - entry.at < PROBE_CACHE_TTL_MS) break;
		probeCache.delete(oldest);
	}
	return answer;
}

// -- discard_changes ---------------------------------------------------------------------------------

const GIT_VALUE_OPTIONS: Record<string, true> = {
	"-C": true,
	"-c": true,
	"--namespace": true,
	"--exec-path": true,
	"--config-env": true,
};
const MASS_PATHSPECS: Record<string, true> = { ".": true, ":/": true, "*": true, ":(top)": true, "./": true };

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

/**
 * A git command's subcommand, its arguments, and where it works; no `target` when a directory it
 * names is a word the guard cannot resolve.
 */
function gitInvocation(command: ShellCommand, home: string): { sub: string; rest: string[]; target?: GitTarget } {
	const argv = args(command);
	let where: string | undefined = commandDir(command);
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
	if (where === undefined) return { sub, rest };
	const target: GitTarget = { where };
	for (const key of ["gitDir", "workTree"] as const) {
		const word = named[key];
		if (word === undefined) continue;
		const resolved = resolveCommandWordPath(command, word, where, home);
		if (resolved === undefined) return { sub, rest };
		target[key] = resolved;
	}
	return { sub, rest, target };
}

/** Whether `arg` is the long option `name` or an abbreviation git expands to it (`--har` for `--hard`). */
function isLongOption(arg: string, name: string): boolean {
	const flag = arg.split("=", 1)[0];
	return flag.length > 2 && name.startsWith(flag);
}

/** A word the shell expands before git sees it: a variable, a substitution (its key), a leading `~`. */
const SHELL_EXPANDED_RE = /[$\0]|^~/;
/**
 * A brace expansion, which can make one word several (`{build,dist}`, `out{1..3}`). A word records
 * only that some part of it was quoted, not which, so a quoted one counts too.
 */
const BRACE_EXPANSION_RE = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;

/**
 * `words`, pathspecs a git command names, as git sees them: a word the shell expands is resolved
 * like a path (`"$PWD"`, `~/repo`). Empty (git's default scope, which covers them all) when one
 * cannot be: another variable, a substitution, a brace expansion.
 */
function resolvePathspecs(words: readonly string[], command: ShellCommand, scope: GuardScope): string[] {
	const resolved = words.map(word => {
		if (BRACE_EXPANSION_RE.test(word)) return undefined;
		if (!SHELL_EXPANDED_RE.test(word)) return word;
		return ABSOLUTE_EXPANSION_RE.test(word)
			? resolveCommandWordPath(command, word, commandDir(command), scope.home)
			: undefined;
	});
	return resolved.every((word): word is string => word !== undefined) ? resolved : [];
}

/**
 * The `git clean` a command runs, as a dry-run discard check, or `undefined` for a dry run. Without
 * `-f`, git refuses to clean (by default), so checking it anyway only prompts for a call that fails.
 * `-q` and `-i` do not change what is deleted; a second `-f` adds untracked nested repositories.
 * Pathspecs are resolved by {@link resolvePathspecs}; without any, the whole directory is
 * previewed. An exclude the shell expands is dropped, which only widens the preview.
 */
function cleanCheck(rest: readonly string[], command: ShellCommand, scope: GuardScope): VcsDiscardCheck | undefined {
	let force = 0;
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
			} else if (isLongOption(arg, "--exclude")) {
				const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : rest[++i];
				if (value !== undefined) excludes.push(value);
			}
		} else if (arg.startsWith("-") && arg.length > 1) {
			for (let k = 1; k < arg.length; k++) {
				const letter = arg[k];
				if (letter === "n") return undefined;
				if (letter === "f") force++;
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

	return {
		clean: true,
		directories,
		includeIgnored,
		ignoredOnly,
		nestedRepositories: force > 1,
		excludes: excludes.filter(word => !SHELL_EXPANDED_RE.test(word) && !BRACE_EXPANSION_RE.test(word)),
		pathspecs: resolvePathspecs(pathspecs, command, scope),
	};
}

/**
 * The operands of a `git checkout` or `git restore`, without their options and the values
 * `valueOptions` take as the next word: `named` before a `--`, `paths` after it.
 */
function gitOperands(
	rest: readonly string[],
	valueOptions: Record<string, true>,
): { named: string[]; paths: string[] | undefined } {
	const named: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--") return { named, paths: rest.slice(i + 1) };
		if (Object.hasOwn(valueOptions, arg)) i++;
		else if (!arg.startsWith("-") || arg === "-") named.push(arg);
	}
	return { named, paths: undefined };
}

const CHECKOUT_VALUE_OPTIONS: Record<string, true> = { "-b": true, "-B": true, "--orphan": true };
const RESTORE_VALUE_OPTIONS: Record<string, true> = { "-s": true, "--source": true };
/**
 * Short options of the discarding git subcommands that take a value: the rest of their bundle,
 * when there is one, is that value (`-bfix` names a branch, it does not force).
 */
const SHORT_VALUE_LETTERS: Record<string, string> = { checkout: "bBt", switch: "cCt", restore: "s", clean: "e" };

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

/** The discard check for a git command, with the rule's reason, or `undefined` when it discards nothing. */
function discardProbe(
	command: ShellCommand,
	scope: GuardScope,
	sub: string,
	rest: readonly string[],
): { check: VcsDiscardCheck; what: string } | undefined {
	const has = (name: string) => rest.some(arg => arg.startsWith("--") && isLongOption(arg, name));
	const short = shortOptionLetters(sub, rest);
	// `-h` and `--help` print the usage and run nothing.
	if (short.includes("h") || rest.some(arg => arg === "--help" || arg === "--help-all")) return undefined;
	const tracked = (check: VcsDiscardCheck) => ({
		check,
		what: `\`git ${sub}\` would discard uncommitted changes; commit or otherwise save them first`,
	});
	// `--merge` reverts only staged changes (refusing while a path has both); `--hard` loses every change.
	if (sub === "reset" && has("--hard")) return tracked({});
	if (sub === "reset" && has("--merge")) return tracked({ merge: true });
	if (sub === "checkout" || sub === "restore") {
		const checkout = sub === "checkout";
		const { named, paths } = gitOperands(rest, checkout ? CHECKOUT_VALUE_OPTIONS : RESTORE_VALUE_OPTIONS);
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
			});
		}
	}
	if (
		(sub === "checkout" || sub === "switch") &&
		(has("--force") || has("--discard-changes") || short.includes("f"))
	) {
		return tracked({});
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
 * the tracked changes: some paths, some hunks (`-p`), or the index alone (`--staged`).
 */
function stashSaves(rest: readonly string[]): Stashed | undefined {
	const save = rest[0] === "save";
	const options = rest[0] === "push" || save ? rest.slice(1) : rest;
	// `list`, `show`, `apply`, `pop`, `drop`, ... save nothing.
	if (options === rest && rest.length > 0 && !rest[0].startsWith("-")) return undefined;
	const saved: Stashed = { untracked: false, ignored: false };
	for (let i = 0; i < options.length; i++) {
		const arg = options[i];
		if (arg === "--") {
			// `push -- <paths>` stashes only those paths; `save -- <message>` everything.
			if (!save && i + 1 < options.length) return undefined;
			break;
		}
		if (arg.startsWith("--") && arg.length > 2) {
			if (isLongOption(arg, "--message")) {
				if (!arg.includes("=")) i++;
			} else if (["--patch", "--staged", "--pathspec-from-file"].some(name => isLongOption(arg, name))) {
				return undefined;
			} else if (isLongOption(arg, "--all")) {
				saved.untracked = saved.ignored = true;
			} else if (isLongOption(arg, "--include-untracked")) {
				saved.untracked = true;
			}
		} else if (arg.startsWith("-") && arg.length > 1) {
			for (let k = 1; k < arg.length; k++) {
				const letter = arg[k];
				if (letter === "p" || letter === "S") return undefined;
				if (letter === "a") saved.untracked = saved.ignored = true;
				else if (letter === "u") saved.untracked = true;
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
 * What `git stash` saved for `target` once the chain link's command `earlier` has run: its own stash
 * adds what it saved, and a later `pop`, `drop`, `clear` or `branch`, wherever it runs, gives it all up.
 */
function stashStep(
	earlier: ShellCommand,
	stashed: Stashed | undefined,
	target: GitTarget,
	scope: GuardScope,
): Stashed | undefined {
	if (earlier.argv[0] !== "git") return stashed;
	const stash = gitInvocation(earlier, scope.home);
	if (stash.sub !== "stash") return stashed;
	if (stash.rest.length > 0 && Object.hasOwn(STASH_RELEASES, stash.rest[0])) return undefined;
	const same =
		stash.target?.where === target.where &&
		stash.target.gitDir === target.gitDir &&
		stash.target.workTree === target.workTree;
	const saved = same ? stashSaves(stash.rest) : undefined;
	if (!saved) return stashed;
	return {
		untracked: saved.untracked || (stashed?.untracked ?? false),
		ignored: saved.ignored || (stashed?.ignored ?? false),
	};
}

/** What each link of a `&&` chain left stashed, per target: a link is worked out once per target. */
const stashMemo = new WeakMap<SucceededLink, Map<string, Stashed | null>>();

/**
 * What the `git stash` commands that have succeeded by the time `command` runs (earlier in its `&&`
 * chain) saved where `target` points and still hold, or `undefined` for none. Each link of the chain
 * builds on the one before it, so a long chain costs one step per command, not a walk per command.
 */
function stashedBefore(command: ShellCommand, target: GitTarget, scope: GuardScope): Stashed | undefined {
	const key = JSON.stringify([target.where, target.gitDir ?? null, target.workTree ?? null]);
	const pending: SucceededLink[] = [];
	let stashed: Stashed | undefined;
	for (let link = command.succeeded; link; link = link.before) {
		const known = stashMemo.get(link)?.get(key);
		if (known !== undefined) {
			stashed = known ?? undefined;
			break;
		}
		pending.push(link);
	}
	for (let i = pending.length - 1; i >= 0; i--) {
		stashed = stashStep(pending[i].command, stashed, target, scope);
		const memo = stashMemo.get(pending[i]) ?? new Map<string, Stashed | null>();
		memo.set(key, stashed ?? null);
		stashMemo.set(pending[i], memo);
	}
	return stashed;
}

function discardChanges(command: ShellCommand, scope: GuardScope): GuardHit | undefined {
	if (command.argv[0] !== "git") return undefined;
	const { sub, rest, target } = gitInvocation(command, scope.home);
	const probe = discardProbe(command, scope, sub, rest);
	if (!probe || !target) return undefined;
	let check: VcsDiscardCheck = { ...probe.check, gitDir: target.gitDir, workTree: target.workTree };
	// A stash just before keeps what it saved; only what it left behind can be lost. It keeps no
	// nested repository, only a pointer to its commit, so a `git clean -ff` is checked in full.
	const stashed = check.nestedRepositories ? undefined : stashedBefore(command, target, scope);
	if (stashed) {
		if (!check.clean || stashed.ignored) return undefined;
		if (stashed.untracked) {
			if (!check.includeIgnored && !check.ignoredOnly) return undefined;
			check = { ...check, untrackedStashed: true };
		}
	}
	const { where } = target;
	const answer = cachedProbe(`git\0${where}\0${JSON.stringify(check)}`, () => vcs.discardsWorkSync(where, check));
	return answer === true ? hit("discard_changes", probe.what) : undefined;
}

// -- kills_harness -----------------------------------------------------------------------------------

/** This process and its ancestors below init. */
function harnessLineage(): number[] {
	const pids: number[] = [];
	let pid: number | null = process.pid;
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
	/** The PIDs it lists, one per line, or `undefined` when it fails. */
	run(): string | undefined;
}

/** A probe running `pgrep` with `argv`; none for an argument holding a substitution the guard did not run. */
function pgrepProbe(argv: string[]): KillProbe[] {
	if (argv.some(arg => arg.includes("\0"))) return [];
	const run = () => {
		const result = Bun.spawnSync(argv, {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			timeout: PROBE_TIMEOUT_MS,
		});
		return result.success ? result.stdout.toString() : undefined;
	};
	return [{ key: argv.join("\0"), run }];
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

/**
 * The selection a `pkill` gives `pgrep`: its options without the ones `pgrep` lacks or answers
 * differently. `-c` and `--count` (a count, not PIDs), `-e` and `--echo`, and `-H` go; `-q` and
 * `--queue` go with the value they take. Every other option selects what `pkill` does.
 */
function pgrepSelection(kept: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < kept.length; i++) {
		const arg = kept[i];
		if (arg === "--") {
			out.push(...kept.slice(i));
			break;
		}
		if (arg === "--queue") i++;
		else if (arg.startsWith("--")) {
			if (arg !== "--count" && arg !== "--echo" && !arg.startsWith("--queue=")) out.push(arg);
		} else if (arg.startsWith("-") && arg.length > 1) {
			let letters = "";
			for (let k = 1; k < arg.length; k++) {
				const letter = arg[k];
				// `-q` takes the rest of its bundle, or the next word, as its value.
				if (letter === "q") {
					if (k === arg.length - 1) i++;
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
		const selection = pgrepSelection(kept);
		return selection.some(arg => !arg.startsWith("-")) ? pgrepProbe(["pgrep", ...selection]) : [];
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
	if (names.length === 0) return user === undefined ? [] : pgrepProbe(["pgrep", ...select]);
	const match = [...(ignoreCase ? ["-i"] : []), ...(regexp ? [] : ["-x"])];
	return names.flatMap(processName => {
		if (bsd || regexp || !processName.includes("/")) {
			const probe =
				!bsd && !regexp && processName.length >= COMM_LENGTH ? processName.slice(0, COMM_LENGTH) : processName;
			return pgrepProbe(["pgrep", ...select, ...match, "--", probe]);
		}
		const executable = resolveCommandWordPath(command, processName, commandDir(command), scope.home);
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
 * runs the system `pkill`, and so does a `pkill` behind a wrapper such as `sudo` or `xargs`, or in a
 * nested `bash -c`.
 */
function killsHarness(command: ShellCommand, scope: GuardScope): GuardHit | undefined {
	const name = command.argv[0];
	if (name !== "pkill" && name !== "killall") return undefined;
	const probes = killMatchProbes(command, scope);
	if (probes.length === 0) return undefined;
	const lineage = harnessLineage();
	for (const probe of probes) {
		const output = cachedProbe(probe.key, probe.run);
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

/** Options for {@link findShellGuardHit}. */
export interface ShellGuardOptions {
	/**
	 * Whether `discard_changes` and `kills_harness` may run their probes. Without probes those
	 * rules never fire; callers turn them off when the answer cannot change the decision.
	 */
	probe?: boolean;
}

/**
 * The first fixed rule a shell command breaks, or `undefined`. Critical patterns are matched
 * against the command and every nested script it runs; the other rules against every simple
 * command it runs. A command nested deeper than the parser follows, or with more nested script
 * text than it reads, fails closed (`nesting_limit`). Probing rules run only after every cheap rule
 * has passed.
 */
export function findShellGuardHit(
	command: string,
	scope: GuardScope,
	options: ShellGuardOptions = {},
): GuardHit | undefined {
	if (command.trim() === "") return undefined;
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
			`it nests \`bash -c\`, \`eval\`, heredoc scripts, or substitutions more than ${SHELL_SCRIPT_MAX_DEPTH} levels deep or in more than ${SHELL_SCRIPT_MAX_NESTED_TEXT / 1024}K characters of nested script, past what the guard can check`,
		);
	}
	for (const pipeline of pipelines) {
		const found =
			pipeline.map(c => secretSend(c, scope)).find(Boolean) ??
			pipeline.map(c => credentialRead(c, scope)).find(Boolean);
		if (found) return found;
	}
	if (options.probe === false) return undefined;
	for (const pipeline of pipelines) {
		for (const simple of pipeline) {
			const found = discardChanges(simple, scope) ?? killsHarness(simple, scope);
			if (found) return found;
		}
	}
	return undefined;
}

/**
 * Applies `credential_read` to a file tool (`read`, `grep`): when any target path is in a
 * credential location, the call keeps `tier` but carries a safety override, like a critical bash
 * command. Internal and web URLs are not files and never match.
 */
export function fileToolApproval(tier: ToolTier, rawPaths: readonly string[], cwd: string): ToolApprovalDecision {
	const router = InternalUrlRouter.instance();
	const home = os.homedir();
	for (const rawPath of rawPaths) {
		const filePath = splitPathAndSel(rawPath).path;
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
	return tier;
}
