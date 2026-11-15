/**
 * Fixed safety rules for tool calls (`tools.guardRules`): the critical shell patterns, matched
 * through shell nesting, plus rules ported from nace-ai/intern's tool guard. Each rule names an
 * action that destroys work or leaks credentials and does not fire on ordinary development
 * commands. Rules run over every simple command {@link parseShellScript} finds, nested
 * `bash -c`/`eval` strings and substitutions included.
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
	resolveShellWordPath,
	SHELL_SCRIPT_MAX_DEPTH,
	type ShellCommand,
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

/** The secret a shell word names when it is sent somewhere: a credential file, a `.env`, or a process environment. */
function sentSecret(word: string, cwd: string, home: string): string | undefined {
	const target = resolveShellWordPath(word, cwd, home);
	if (target === undefined) return undefined;
	if (DOTENV_RE.test(path.basename(target))) return path.basename(target);
	if (PROC_ENVIRON_RE.test(target)) return "the process environment";
	return credentialLocation(target, home);
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
	tee: true,
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

/** The words a reading command reads files from: a copy's local sources, any other reader's arguments. */
function readWords(command: ShellCommand): string[] {
	const name = command.argv[0];
	if (Object.hasOwn(COPY_VALUE_OPTIONS, name)) {
		return copyOperands(command)
			.slice(0, -1)
			.filter(operand => !REMOTE_OPERAND_RE.test(operand));
	}
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
	const words = [...readWords(command), ...command.reads];
	for (const word of words) {
		const target = resolveShellWordPath(word, command.cwd, scope.home);
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

/** The local files a network command sends. */
function sentFiles(command: ShellCommand): string[] {
	const name = command.argv[0];
	const argv = args(command);
	const files = [...command.reads];
	if (name === "curl") {
		for (let i = 0; i < argv.length; i++) {
			const arg = argv[i];
			let value: string | undefined;
			const eq = arg.indexOf("=");
			if (Object.hasOwn(CURL_DATA_OPTIONS, arg)) value = argv[i + 1];
			else if (arg.startsWith("--") && eq > 0 && Object.hasOwn(CURL_DATA_OPTIONS, arg.slice(0, eq))) {
				value = arg.slice(eq + 1);
			} else if ((arg.startsWith("-d") || arg.startsWith("-F") || arg.startsWith("-T")) && arg.length > 2) {
				value = arg.slice(2);
			}
			if (value === undefined) continue;
			if (arg.startsWith("-T") || arg.startsWith("--upload-file")) {
				files.push(value);
				continue;
			}
			const at = value.search(/[@<]/);
			if (at >= 0) files.push(value.slice(at + 1).split(";")[0]);
		}
	} else if (name === "wget") {
		for (const arg of argv) {
			if (arg.startsWith("--post-file=") || arg.startsWith("--body-file="))
				files.push(arg.slice(arg.indexOf("=") + 1));
		}
	} else if (name === "http" || name === "https" || name === "xh") {
		for (const arg of argv) {
			if (arg.includes("=@") || arg.startsWith("@")) files.push(arg.slice(arg.indexOf("@") + 1));
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
	const words = [...(name === "source" ? args(command) : readWords(command)), ...command.reads];
	for (const word of words) {
		const found = sentSecret(word, command.cwd, scope.home);
		if (found) return found;
	}
	return undefined;
}

/** A network command sending a secret: in a file it uploads, an upstream stage's output, or a substitution's. */
function secretSend(command: ShellCommand, scope: GuardScope): GuardHit | undefined {
	if (!Object.hasOwn(SENDERS, command.argv[0])) return undefined;
	let found: string | undefined;
	for (const file of sentFiles(command)) {
		found = sentSecret(file, command.cwd, scope.home);
		if (found) break;
	}
	for (const upstream of found ? [] : command.upstream) {
		found = secretOutput(upstream, scope);
		if (found) break;
	}
	for (const inner of found ? [] : command.subs) {
		found = secretOutput(inner, scope);
		if (found) break;
	}
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
 * A probe that throws answers `undefined`.
 */
function cachedProbe(key: string, run: () => string | boolean | undefined): string | boolean | undefined {
	const cached = probeCache.get(key);
	if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) return cached.answer;
	let answer: string | boolean | undefined;
	try {
		answer = run();
	} catch {
		answer = undefined;
	}
	const now = Date.now();
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
	"--git-dir": true,
	"--work-tree": true,
	"--namespace": true,
	"--exec-path": true,
	"--config-env": true,
};
const MASS_PATHSPECS: Record<string, true> = { ".": true, ":/": true, "*": true, ":(top)": true, "./": true };

/** A git command's subcommand, its arguments, and the `-C` directory. */
function gitInvocation(command: ShellCommand): { sub: string; rest: string[]; directory?: string } {
	const argv = args(command);
	let directory: string | undefined;
	let i = 0;
	while (i < argv.length && argv[i].startsWith("-")) {
		if (Object.hasOwn(GIT_VALUE_OPTIONS, argv[i])) {
			if (argv[i] === "-C" && i + 1 < argv.length) directory = argv[i + 1];
			i += 2;
		} else {
			i++;
		}
	}
	return i < argv.length ? { sub: argv[i], rest: argv.slice(i + 1), directory } : { sub: "", rest: [], directory };
}

/** Whether `arg` is the long option `name` or an abbreviation git expands to it (`--har` for `--hard`). */
function isLongOption(arg: string, name: string): boolean {
	const flag = arg.split("=", 1)[0];
	return flag.length > 2 && name.startsWith(flag);
}

/** A word the shell expands before git sees it: a variable, a substitution (its key), a leading `~`. */
const SHELL_EXPANDED_RE = /[$\0]|^~/;
/** An expansion up front that makes a word an absolute path: `~`, `$HOME`, `$PWD`. */
const ABSOLUTE_EXPANSION_RE = /^(?:~(?:\/|$)|\$\{?(?:HOME|PWD)\b)/;

/**
 * The `git clean` a command runs, as a dry-run discard check, or `undefined` for a dry run. Without
 * `-f`, git refuses to clean (by default), so checking it anyway only prompts for a call that fails.
 * `-q` and `-i` do not change what is deleted; a second `-f` adds untracked nested repositories. A
 * pathspec the shell expands is resolved like a path (`"$PWD"`, `~/repo`); when one cannot be
 * (another variable, a substitution), the whole directory is previewed. An exclude the shell
 * expands is dropped, which only widens the preview.
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
	const resolved = pathspecs.map(word => {
		if (!SHELL_EXPANDED_RE.test(word)) return word;
		return ABSOLUTE_EXPANSION_RE.test(word) ? resolveShellWordPath(word, command.cwd, scope.home) : undefined;
	});
	return {
		clean: true,
		directories,
		includeIgnored,
		ignoredOnly,
		nestedRepositories: force > 1,
		excludes: excludes.filter(word => !SHELL_EXPANDED_RE.test(word)),
		pathspecs: resolved.every((word): word is string => word !== undefined) ? resolved : [],
	};
}

/** The discard check for a git command, with the rule's reason, or `undefined` when it discards nothing. */
function discardProbe(
	command: ShellCommand,
	scope: GuardScope,
	sub: string,
	rest: readonly string[],
): { check: VcsDiscardCheck; what: string } | undefined {
	const has = (name: string) => rest.some(arg => arg.startsWith("--") && isLongOption(arg, name));
	const short = rest
		.filter(arg => /^-[A-Za-z]+$/.test(arg))
		.map(arg => arg.slice(1))
		.join("");
	const massPath = rest.some(arg => !arg.startsWith("-") && Object.hasOwn(MASS_PATHSPECS, arg));
	const tracked = {
		check: {},
		what: `\`git ${sub}\` would discard uncommitted changes; keep them recoverable first, e.g. \`git stash && git ${sub} ...\``,
	};
	if (sub === "reset" && (has("--hard") || has("--merge"))) return tracked;
	if (
		(sub === "checkout" || sub === "switch") &&
		(has("--force") || has("--discard-changes") || short.includes("f") || massPath)
	) {
		return tracked;
	}
	if (sub === "restore" && massPath) {
		const stagedOnly = (has("--staged") || short.includes("S")) && !(has("--worktree") || short.includes("W"));
		return stagedOnly ? undefined : tracked;
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
 * What the `git stash` commands that have succeeded by the time `command` runs (earlier in its
 * `&&` chain) saved in the directory `where` and still hold, or `undefined` for none. A later
 * `pop`, `drop`, `clear` or `branch`, in whatever directory, gives that up.
 */
function stashedBefore(command: ShellCommand, where: string, scope: GuardScope): Stashed | undefined {
	let stashed: Stashed | undefined;
	for (const earlier of command.succeeded) {
		if (earlier.argv[0] !== "git") continue;
		const { sub, rest, directory } = gitInvocation(earlier);
		if (sub !== "stash") continue;
		if (rest.length > 0 && Object.hasOwn(STASH_RELEASES, rest[0])) {
			stashed = undefined;
			continue;
		}
		const dir = directory === undefined ? earlier.cwd : resolveShellWordPath(directory, earlier.cwd, scope.home);
		const saved = dir === where ? stashSaves(rest) : undefined;
		if (saved) {
			stashed = {
				untracked: saved.untracked || (stashed?.untracked ?? false),
				ignored: saved.ignored || (stashed?.ignored ?? false),
			};
		}
	}
	return stashed;
}

function discardChanges(command: ShellCommand, scope: GuardScope): GuardHit | undefined {
	if (command.argv[0] !== "git") return undefined;
	const { sub, rest, directory } = gitInvocation(command);
	const probe = discardProbe(command, scope, sub, rest);
	if (!probe) return undefined;
	const where = directory === undefined ? command.cwd : resolveShellWordPath(directory, command.cwd, scope.home);
	if (where === undefined) return undefined;
	let check = probe.check;
	// A stash just before keeps what it saved; only what it left behind can be lost. It keeps no
	// nested repository, only a pointer to its commit, so a `git clean -ff` is checked in full.
	const stashed = check.nestedRepositories ? undefined : stashedBefore(command, where, scope);
	if (stashed) {
		if (!check.clean || stashed.ignored) return undefined;
		if (stashed.untracked) {
			if (!check.includeIgnored && !check.ignoredOnly) return undefined;
			check = { ...check, includeIgnored: false, ignoredOnly: true };
		}
	}
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

/** A signal given as an option (`-9`, `-KILL`); single capitals such as `-P` are matching options. */
const SIGNAL_OPTION_RE = /^-(?:\d+|[A-Z][A-Z0-9+-]+)$/;
const KILLALL_VALUE_OPTIONS: Record<string, true> = {
	"-u": true,
	"--user": true,
	"-o": true,
	"--older-than": true,
	"-y": true,
	"--younger-than": true,
	"-n": true,
	"--ns": true,
	"-Z": true,
};

/** The `pgrep` argument lists that match what a `pkill`/`killall` would signal. */
function killMatchProbes(command: ShellCommand): string[][] {
	const name = command.argv[0];
	const signalValues = name === "pkill" ? ["--signal"] : ["-s", "--signal"];
	const kept: string[] = [];
	const argv = args(command);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (signalValues.includes(arg)) i++;
		else if (!(arg.startsWith("--signal=") || SIGNAL_OPTION_RE.test(arg) || arg === "-e" || arg === "--echo")) {
			kept.push(arg);
		}
	}
	if (name === "pkill") return kept.some(arg => !arg.startsWith("-")) ? [["pgrep", ...kept]] : [];
	const names: string[] = [];
	for (let i = 0; i < kept.length; i++) {
		if (Object.hasOwn(KILLALL_VALUE_OPTIONS, kept[i])) i++;
		else if (!kept[i].startsWith("-")) names.push(kept[i]);
	}
	const match = [
		...(kept.includes("-I") || kept.includes("--ignore-case") ? ["-i"] : []),
		...(kept.includes("-r") || kept.includes("--regexp") ? [] : ["-x"]),
	];
	return names.map(processName => ["pgrep", ...match, "--", processName]);
}

function killsHarness(command: ShellCommand): GuardHit | undefined {
	const name = command.argv[0];
	if (name !== "pkill" && name !== "killall") return undefined;
	const probes = killMatchProbes(command);
	if (probes.length === 0) return undefined;
	const lineage = harnessLineage();
	for (const probe of probes) {
		if (probe.some(arg => arg.includes("\0"))) continue;
		const output = cachedProbe(probe.join("\0"), () => {
			const result = Bun.spawnSync(probe, {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
				timeout: PROBE_TIMEOUT_MS,
			});
			return result.success ? result.stdout.toString() : undefined;
		});
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
 * command it runs. A command nested deeper than the parser follows fails closed
 * (`nesting_limit`). Probing rules run only after every cheap rule has passed.
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
	// stays quoted, as it is in the raw line.
	const canonical = pipelines
		.flat()
		.map(c =>
			[
				...c.wrappers,
				...c.argv.map((word, index) =>
					/^[\w@%+=:,./-]+$/.test(word) && (index === 0 || !c.quoted[index])
						? word
						: `'${word.replaceAll("'", "'\\''")}'`,
				),
			].join(" "),
		);
	const texts = [command, ...scripts, ...canonical];
	if (CRITICAL_BASH_PATTERNS.some(pattern => texts.some(text => pattern.test(text)))) {
		return { rule: "critical_pattern", reason: CRITICAL_PATTERN_REASON };
	}
	if (truncated) {
		return hit(
			"nesting_limit",
			`it nests \`bash -c\`, \`eval\`, heredoc scripts, or substitutions more than ${SHELL_SCRIPT_MAX_DEPTH} levels deep, past what the guard can check`,
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
			const found = discardChanges(simple, scope) ?? killsHarness(simple);
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
