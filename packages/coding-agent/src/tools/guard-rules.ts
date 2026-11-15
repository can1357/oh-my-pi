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

/** An expansion up front that makes a word an absolute path: `~`, `$HOME`, `$PWD`. */
const ABSOLUTE_EXPANSION_RE = /^(?:~(?:\/|$)|\$\{?(?:HOME|PWD)\b)/;
/** tar's one-letter options that take a value; in a bundle, the first of them takes the rest of the word. */
const TAR_VALUE_LETTERS = "bCfFgHIKLNTVX";
/** tar's long options that take a separate value word (`--file x.tar`), besides `--directory`. */
const TAR_VALUE_OPTIONS: Record<string, true> = {
	"--file": true,
	"--files-from": true,
	"--exclude": true,
	"--exclude-from": true,
};

/**
 * The words a `tar` command reads, with every member after a `-C`/`--directory` resolved against
 * that directory, as tar does; each `-C` is relative to the one before it. Option values stay as
 * written. A member after a directory the guard cannot resolve is left out unless it is absolute.
 */
function tarReadWords(command: ShellCommand, home: string): string[] {
	const argv = args(command);
	const words: string[] = [];
	let dir: string | undefined = command.cwd;
	const changeDir = (word: string) => {
		dir = dir === undefined ? undefined : resolveShellWordPath(word, dir, home);
	};
	let i = 0;
	// An old-style first word (`tar cfC x.tar ~ .ssh`): each letter that takes a value takes the next word.
	if (argv.length > 0 && !argv[0].startsWith("-")) {
		const letters = argv[i++];
		for (const letter of letters) {
			if (!TAR_VALUE_LETTERS.includes(letter) || i >= argv.length) continue;
			const value = argv[i++];
			if (letter === "C") changeDir(value);
			else words.push(value);
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
				if (target !== undefined) words.push(target);
			}
		} else if (options && arg.startsWith("-") && arg.length > 1) {
			let k = 1;
			while (k < arg.length && !TAR_VALUE_LETTERS.includes(arg[k])) k++;
			if (k === arg.length) continue;
			const value = k + 1 < arg.length ? arg.slice(k + 1) : argv[++i];
			if (value === undefined) continue;
			if (arg[k] === "C") changeDir(value);
			else words.push(value);
		} else {
			const member: string | undefined =
				dir !== undefined
					? resolveShellWordPath(arg, dir, home)
					: path.isAbsolute(arg) || ABSOLUTE_EXPANSION_RE.test(arg)
						? arg
						: undefined;
			if (member !== undefined) words.push(member);
		}
	}
	return words;
}

/** The words a reading command reads files from: a copy's local sources, any other reader's arguments. */
function readWords(command: ShellCommand, home: string): string[] {
	const name = command.argv[0];
	if (name === "tar") return tarReadWords(command, home);
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
	const words = [...readWords(command, scope.home), ...command.reads];
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
/**
 * curl's one-letter options that take a value. In a bundle (`-sd @file`), the first of them takes
 * the rest of the word, or the next word when it ends the bundle.
 */
const CURL_VALUE_LETTERS = "AbCcDdEeFHKmoPQrTtUuwXxYyz";
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
		const found = sentSecret(word, command.cwd, scope.home);
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
		found = sentSecret(file, command.cwd, scope.home);
		if (found) break;
	}
	found ??= firstSecretOutput(command.upstream, scope) ?? firstSecretOutput(command.subs, scope);
	return found ? hit("secret_send", `it sends ${found} over the network (\`${command.argv[0]}\`)`) : undefined;
}

// -- entry points ------------------------------------------------------------------------------------

/**
 * The first fixed rule a shell command breaks, or `undefined`. Critical patterns are matched
 * against the command and every nested script it runs; the other rules against every simple
 * command it runs. A command nested deeper than the parser follows fails closed
 * (`nesting_limit`).
 */
export function findShellGuardHit(command: string, scope: GuardScope): GuardHit | undefined {
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
