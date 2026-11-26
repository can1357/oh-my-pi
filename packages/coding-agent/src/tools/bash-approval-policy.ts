import type { ApprovalAndClause, ApprovalSimpleCommand, BashApprovalAnalysis } from "@oh-my-pi/pi-natives";
import { isPosixShell } from "@oh-my-pi/pi-utils/procmgr";
import { isShellEnvironmentAssignment } from "./shell-tokenize";

// Builtins that can mutate shell state (cwd, env, functions, options, traps,
// BASH_CMDS, etc.) when invoked as a simple command. Parser-level keywords
// (if/for/while/case/[[/!) are already classified as compound commands by the AST.
const SHELL_STATEFUL_COMMANDS = new Set([
	":",
	".",
	"[",
	"test",
	"-",
	"alias",
	"autoload",
	"bg",
	"bindkey",
	"break",
	"builtin",
	"bye",
	"cd",
	"chdir",
	"command",
	"continue",
	"declare",
	"dirs",
	"disable",
	"disown",
	"emulate",
	"enable",
	"eval",
	"exec",
	"exit",
	"export",
	"fc",
	"fg",
	"float",
	"functions",
	"getopts",
	"hash",
	"history",
	"integer",
	"jobs",
	"let",
	"limit",
	"local",
	"logout",
	"mapfile",
	"popd",
	"print",
	"printf",
	"pushd",
	"read",
	"readarray",
	"readonly",
	"rehash",
	"repeat",
	"return",
	"sched",
	"set",
	"setopt",
	"shift",
	"shopt",
	"source",
	"suspend",
	"time",
	"times",
	"trap",
	"typeset",
	"ulimit",
	"umask",
	"unalias",
	"unfunction",
	"unhash",
	"unlimit",
	"unset",
	"unsetopt",
	"vared",
	"wait",
	"zle",
	"zmodload",
	"zparseopts",
	"zstyle",
]);

const POSIX_SHELLS = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"ash",
	"ksh",
	"ksh93",
	"mksh",
	"pdksh",
	"csh",
	"tcsh",
	"fish",
	"rbash",
	"osh",
	"ysh",
	"nu",
]);

const SHELL_INTERPRETER_COMMANDS = new Set([...POSIX_SHELLS, "busybox", "env", "nocorrect", "noglob", "sudo"]);

/** Raw shell control characters rejected for non-POSIX single-command `allow` fallback. */
export const NON_POSIX_CONTROL_RE = /[\n\r;&|<>`$()]/u;
const ZSH_SHELL_RE = /(?:^|[\\/])zsh(?:\.exe)?$/i;
const PYTHON_BIN_RE = /^python\d*(?:\.\d+)*$/u;
const GENERIC_REINTERPRET_FLAG_RE = /^(?:-[^-]*[ce]|--(?:command|eval)(?:=|$))/u;
const PWSH_EXEC_FLAGS = ["command", "commandwithargs", "cmd", "cwa", "encodedcommand", "enc", "ec"];
const CMD_EXEC_ARG_RE = /^\/[ckr]/i;
const GO_TOOLEXEC_SUBCOMMANDS = new Set(["build", "run", "install", "test", "vet"]);
const COMMAND_SPEC_ALIASES: Record<string, string> = {
	nodejs: "node",
	luajit: "lua",
	osascript: "lua",
	ripgrep: "rg",
	gsort: "sort",
	gtar: "tar",
};

interface LauncherSpec {
	valueOpts?: readonly string[];
	rejectLong?: readonly string[];
	rejectShort?: string;
	skipAssignments?: boolean;
	skipPositionals?: number;
	allowStandaloneDash?: boolean;
}

const LAUNCHERS: Record<string, LauncherSpec> = {
	"-": {},
	env: {
		valueOpts: ["-a", "--argv0", "-u", "--unset", "-C", "--chdir", "-P", "--env0-from"],
		rejectLong: ["--split-string"],
		rejectShort: "S",
		skipAssignments: true,
		allowStandaloneDash: true,
	},
	sudo: {
		valueOpts: [
			"-u",
			"-g",
			"-C",
			"-D",
			"-h",
			"-p",
			"-R",
			"-r",
			"-T",
			"-t",
			"-U",
			"--user",
			"--group",
			"--close-from",
			"--chdir",
			"--host",
			"--prompt",
			"--chroot",
			"--role",
			"--command-timeout",
			"--type",
			"--other-user",
		],
		rejectLong: ["--shell", "--login"],
		rejectShort: "si",
		skipAssignments: true,
	},
	doas: { valueOpts: ["-u", "-C"], skipAssignments: true },
	timeout: { valueOpts: ["-s", "--signal", "-k", "--kill-after"], skipPositionals: 1 },
	gtimeout: { valueOpts: ["-s", "--signal", "-k", "--kill-after"], skipPositionals: 1 },
	nice: { valueOpts: ["-n", "--adjustment"] },
	time: { valueOpts: ["-o", "--output", "-f", "--format"] },
	stdbuf: { valueOpts: ["-i", "-o", "-e", "--input", "--output", "--error"] },
	exec: { valueOpts: ["-a"] },
	nohup: {},
	command: {},
	builtin: {},
	noglob: {},
	nocorrect: {},
	busybox: {},
};

interface ExecFlagSpec {
	valueOpts?: readonly string[];
	execLong?: readonly string[];
	execShort?: string;
	stopAtPositional: boolean;
	allowPlusOptions?: boolean;
}

const EXEC_FLAG_SPECS: Record<string, ExecFlagSpec> = {
	python: { valueOpts: ["-W", "-X", "-m", "-Q"], execShort: "c", stopAtPositional: true },
	node: {
		valueOpts: ["-C", "--conditions", "--input-type", "--env-file"],
		execLong: ["--eval", "--print", "--require", "--import", "--loader", "--experimental-loader", "--preload"],
		execShort: "epr",
		stopAtPositional: true,
	},
	bun: {
		valueOpts: ["-C", "--conditions", "--env-file", "--cwd", "--config"],
		execLong: ["--eval", "--print", "--require", "--import", "--loader", "--experimental-loader", "--preload"],
		execShort: "epr",
		stopAtPositional: true,
	},
	ruby: { valueOpts: ["-r", "-I", "-C", "-E"], execLong: ["--eval"], execShort: "e", stopAtPositional: true },
	perl: { valueOpts: ["-I", "-M", "-m"], execShort: "eE", stopAtPositional: true },
	php: { valueOpts: ["-d", "-c", "-z"], execShort: "rRBE", stopAtPositional: true },
	lua: { valueOpts: ["-l"], execShort: "e", stopAtPositional: true },
	rg: {
		valueOpts: ["-e", "-f", "-g", "-t", "-T", "--regexp", "--file", "--glob", "--iglob", "--type", "--type-not"],
		execLong: ["--pre"],
		stopAtPositional: false,
	},
	sort: { execLong: ["--compress-program"], stopAtPositional: false },
	jq: { stopAtPositional: true },
	tar: {
		valueOpts: ["-f", "-C"],
		execLong: [
			"--to-command",
			"--checkpoint-action",
			"--use-compress-program",
			"--rsh-command",
			"--info-script",
			"--new-volume-script",
		],
		execShort: "IF",
		stopAtPositional: false,
	},
};

const POSIX_SHELL_SPEC: ExecFlagSpec = {
	valueOpts: ["-o", "+o", "-O", "+O", "--rcfile", "--init-file"],
	execLong: ["--command"],
	execShort: "c",
	stopAtPositional: true,
	allowPlusOptions: true,
};

const DENO_VALUE_OPTS = new Set([
	"-c",
	"--config",
	"--import-map",
	"--lock",
	"--ext",
	"-L",
	"--log-level",
	"--env-file",
]);
const FIND_EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const GIT_GLOBAL_VALUE_OPTS = new Set([
	"-C",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--super-prefix",
	"--list-cmds",
]);
const GIT_PACK_SUBCOMMANDS = new Set([
	"clone",
	"fetch",
	"pull",
	"ls-remote",
	"push",
	"archive",
	"remote",
	"send-pack",
	"fetch-pack",
	"receive-pack",
	"upload-pack",
]);

const GIT_SUBCOMMAND_SPECS: Record<string, ExecFlagSpec> = {
	clone: { execLong: ["--config"], execShort: "cu", stopAtPositional: false },
	"ls-remote": { execShort: "u", stopAtPositional: false },
	rebase: { execLong: ["--exec"], execShort: "x", stopAtPositional: false },
	push: { execLong: ["--exec"], stopAtPositional: false },
	"send-pack": { execLong: ["--exec"], stopAtPositional: false },
	archive: { execLong: ["--exec"], stopAtPositional: false },
	difftool: { execLong: ["--extcmd", "--tool"], execShort: "xt", stopAtPositional: false },
	mergetool: { execLong: ["--extcmd", "--tool"], execShort: "xt", stopAtPositional: false },
	grep: { valueOpts: ["-e", "-f"], execLong: ["--open-files-in-pager"], execShort: "O", stopAtPositional: false },
	"filter-branch": {
		execLong: [
			"--env-filter",
			"--tree-filter",
			"--index-filter",
			"--parent-filter",
			"--msg-filter",
			"--commit-filter",
			"--tag-name-filter",
			"--subdirectory-filter",
			"--setup",
		],
		stopAtPositional: false,
	},
	"send-email": { execLong: ["--sendmail-cmd", "--to-cmd", "--cc-cmd"], stopAtPositional: false },
};

/** Maps a configured shell path to the native parser dialect, or `null` for non-POSIX shells. */
export function bashApprovalDialect(shell: string | undefined): "bash" | "zsh" | null {
	if (!shell || !isPosixShell(shell)) return null;
	return ZSH_SHELL_RE.test(shell) ? "zsh" : "bash";
}

function commandBasename(executable: string): string {
	const base = executable.slice(Math.max(executable.lastIndexOf("/"), executable.lastIndexOf("\\")) + 1);
	return base.replace(/\.exe$/i, "");
}

function canGlobExpandToOption(arg: string): boolean {
	const first = arg[0];
	return first === "-" || first === "*" || first === "?" || first === "[";
}

function matchesLongFlag(arg: string, flags: readonly string[] | undefined, allowPrefix = false): boolean {
	if (!flags) return false;
	const eq = arg.indexOf("=");
	const name = eq >= 0 ? arg.slice(0, eq) : arg;
	for (const flag of flags) {
		if (name === flag) return true;
		if (allowPrefix && name.startsWith("--") && name.length >= 4 && flag.startsWith(name)) return true;
	}
	return false;
}

/**
 * Walks a single-prefix short-option cluster left to right (getopt semantics):
 * - returns `"reject"` if any option flag before a value-taking flag is in `rejectShort`
 * - returns `"consume-next"` if a value-taking short flag ends the cluster (so `argv[i + 1]` is its value)
 * - returns `"ok"` otherwise (including when a value-taking flag consumed the rest of `arg` as its attached value)
 */
function scanShortCluster(
	arg: string,
	valueOpts: readonly string[] | undefined,
	rejectShort: string | undefined,
	allowPlus: boolean,
): "reject" | "consume-next" | "ok" {
	const prefix = arg[0];
	if ((prefix !== "-" && !(allowPlus && prefix === "+")) || arg.length < 2 || arg[1] === "-") {
		return "ok";
	}
	for (let k = 1; k < arg.length; k++) {
		const ch = arg[k]!;
		if (prefix === "-" && rejectShort?.includes(ch)) return "reject";
		if (valueOpts?.includes(`${prefix}${ch}`)) {
			return k === arg.length - 1 ? "consume-next" : "ok";
		}
	}
	return "ok";
}

function scanOptionFlags(
	argv: readonly string[],
	startIndex: number,
	spec: ExecFlagSpec,
	globIndices?: ReadonlySet<number>,
	allowLongPrefix = false,
): boolean {
	for (let i = startIndex; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") break;
		if (globIndices?.has(i) && canGlobExpandToOption(arg)) return true;
		const isOpt = arg.startsWith("-") || (spec.allowPlusOptions && arg.startsWith("+"));
		if (spec.stopAtPositional && (!isOpt || arg === "-" || arg === "+")) {
			// Under `nullglob`, an unmatched positional glob disappears and exposes later flags.
			if (globIndices?.has(i)) continue;
			break;
		}
		if (!isOpt || arg === "-" || arg === "+") continue;
		if (matchesLongFlag(arg, spec.execLong, allowLongPrefix)) return true;
		if (arg.startsWith("--")) {
			if (spec.valueOpts?.includes(arg)) i++;
			continue;
		}
		const result = scanShortCluster(arg, spec.valueOpts, spec.execShort, !!spec.allowPlusOptions);
		if (result === "reject") return true;
		if (result === "consume-next") i++;
	}
	return false;
}

function unwrapLauncherIndex(argv: readonly string[], globIndices?: ReadonlySet<number>): number | "reject" {
	let offset = 0;
	for (let depth = 0; depth < 8 && offset < argv.length; depth++) {
		if (globIndices?.has(offset)) return "reject";
		const name = commandBasename(argv[offset]!).toLowerCase();
		const spec = Object.hasOwn(LAUNCHERS, name) ? LAUNCHERS[name] : undefined;
		if (!spec) return offset;
		let i = offset + 1;
		while (i < argv.length) {
			const arg = argv[i]!;
			if (arg === "--") {
				i++;
				break;
			}
			if (arg === "-" && spec.allowStandaloneDash) {
				i++;
				continue;
			}
			if (!arg.startsWith("-") || arg === "-") break;
			if (globIndices?.has(i) && canGlobExpandToOption(arg)) return "reject";
			if (matchesLongFlag(arg, spec.rejectLong)) return "reject";
			if (arg.startsWith("--")) {
				i += spec.valueOpts?.includes(arg) ? 2 : 1;
				continue;
			}
			const result = scanShortCluster(arg, spec.valueOpts, spec.rejectShort, false);
			if (result === "reject") return "reject";
			i += result === "consume-next" ? 2 : 1;
		}
		if (spec.skipAssignments) {
			while (i < argv.length && (isShellEnvironmentAssignment(argv[i]!) || argv[i]!.includes("="))) {
				if (argv[i]!.startsWith("=")) break;
				i++;
			}
		}
		if (spec.skipPositionals) {
			if (i + spec.skipPositionals > argv.length) return "reject";
			i += spec.skipPositionals;
		}
		offset = i;
	}
	if (offset < argv.length && Object.hasOwn(LAUNCHERS, commandBasename(argv[offset]!).toLowerCase())) {
		return "reject";
	}
	return offset;
}

function hasGitReinterpretableArg(
	argv: readonly string[],
	startOffset: number,
	globIndices?: ReadonlySet<number>,
): boolean {
	let subcommandIdx = -1;
	for (let i = startOffset + 1; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") return false;
		if (globIndices?.has(i) && canGlobExpandToOption(arg)) return true;
		if (!arg.startsWith("-") || arg === "-") {
			subcommandIdx = i;
			break;
		}
		if (GIT_GLOBAL_VALUE_OPTS.has(arg)) {
			i++;
			continue;
		}
		if (
			arg.startsWith("-C") ||
			matchesLongFlag(arg, ["--git-dir", "--work-tree", "--namespace", "--super-prefix", "--list-cmds"])
		) {
			continue;
		}
		if (matchesLongFlag(arg, ["--config-env", "--exec-path", "--upload-pack", "--receive-pack"])) {
			return true;
		}
		if (scanShortCluster(arg, ["-C"], "c", false) === "reject") return true;
	}
	if (subcommandIdx < 0) return false;
	if (globIndices?.has(subcommandIdx)) return true;
	const subcommand = argv[subcommandIdx]!;
	if (
		GIT_PACK_SUBCOMMANDS.has(subcommand) &&
		scanOptionFlags(
			argv,
			subcommandIdx + 1,
			{ execLong: ["--upload-pack", "--receive-pack"], stopAtPositional: false },
			globIndices,
			true,
		)
	) {
		return true;
	}
	const subSpec = Object.hasOwn(GIT_SUBCOMMAND_SPECS, subcommand) ? GIT_SUBCOMMAND_SPECS[subcommand] : undefined;
	if (subSpec && scanOptionFlags(argv, subcommandIdx + 1, subSpec, globIndices, true)) return true;
	if (subcommand === "submodule" || subcommand === "bisect") {
		const target = subcommand === "submodule" ? "foreach" : "run";
		for (let i = subcommandIdx + 1; i < argv.length; i++) {
			const arg = argv[i]!;
			if (arg === "--") break;
			if (globIndices?.has(i)) return true;
			if (!arg.startsWith("-")) return arg === target;
		}
	}
	return false;
}

/** Returns `true` when `argv` passes code-execution or argument-reinterpretation flags to a launcher or command. */
export function hasReinterpretableExecutionArg(argv: readonly string[], globWordIndices?: readonly number[]): boolean {
	const globSet = globWordIndices && globWordIndices.length > 0 ? new Set(globWordIndices) : undefined;
	const offset = unwrapLauncherIndex(argv, globSet);
	if (offset === "reject") return true;
	if (offset >= argv.length) return false;
	if (globSet?.has(offset)) return true;

	const name = commandBasename(argv[offset]!).toLowerCase();
	if (name === "eval" || name === "xargs") return true;
	if (POSIX_SHELLS.has(name)) return scanOptionFlags(argv, offset + 1, POSIX_SHELL_SPEC, globSet);
	if (name === "pwsh" || name === "powershell") {
		return hasPwshReinterpretableArg(argv, offset, name === "powershell");
	}
	if (name === "cmd") {
		return argv.slice(offset + 1).some(arg => CMD_EXEC_ARG_RE.test(arg));
	}
	if (name === "git") return hasGitReinterpretableArg(argv, offset, globSet);
	if (name === "go") {
		let subIdx = offset + 1;
		while (subIdx < argv.length) {
			const arg = argv[subIdx]!;
			if (arg === "-C" || arg === "--C") {
				subIdx += 2;
				continue;
			}
			if (arg.startsWith("-C=") || arg.startsWith("--C=")) {
				subIdx++;
				continue;
			}
			break;
		}
		if (subIdx >= argv.length) return false;
		if (globSet?.has(subIdx)) return true;
		const sub = argv[subIdx]!;
		if (!GO_TOOLEXEC_SUBCOMMANDS.has(sub)) return false;
		const execLong = ["-toolexec", "--toolexec"];
		if (sub === "test" || sub === "run") execLong.push("-exec", "--exec");
		if (sub === "vet") execLong.push("-vettool", "--vettool");
		return scanOptionFlags(argv, subIdx + 1, { execLong, stopAtPositional: false }, globSet);
	}
	if (name === "find" || name === "gfind") {
		for (let i = offset + 1; i < argv.length; i++) {
			const arg = argv[i]!;
			if (FIND_EXEC_FLAGS.has(arg) || (globSet?.has(i) && canGlobExpandToOption(arg))) return true;
		}
		return false;
	}
	if (name === "deno") {
		let i = offset + 1;
		while (i < argv.length) {
			const arg = argv[i]!;
			if (arg === "--") {
				i++;
				break;
			}
			if (globSet?.has(i) && canGlobExpandToOption(arg)) return true;
			if (!arg.startsWith("-") || arg === "-") break;
			i += DENO_VALUE_OPTS.has(arg) ? 2 : 1;
		}
		return i < argv.length && (globSet?.has(i) || argv[i] === "eval");
	}
	if (name === "tar" || name === "gtar") {
		const firstArg = argv[offset + 1];
		if (firstArg && !firstArg.startsWith("-") && /[IF]/u.test(firstArg)) return true;
	}

	const specKey = PYTHON_BIN_RE.test(name)
		? "python"
		: Object.hasOwn(COMMAND_SPEC_ALIASES, name)
			? COMMAND_SPEC_ALIASES[name]!
			: name;
	const spec = Object.hasOwn(EXEC_FLAG_SPECS, specKey) ? EXEC_FLAG_SPECS[specKey] : undefined;
	if (spec) return scanOptionFlags(argv, offset + 1, spec, globSet);
	// Fail-closed floor for unlisted wrappers (e.g. `docker exec c sh -c`, `uv run bash -c`, `npx -c`, `su -c`).
	for (let i = offset + 1; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") break;
		const innerName = commandBasename(arg).toLowerCase();
		if (POSIX_SHELLS.has(innerName) && scanOptionFlags(argv, i + 1, POSIX_SHELL_SPEC, globSet)) {
			return true;
		}
	}
	let hasGenericFlag = false;
	let hasShellMeta = false;
	for (let i = offset + 1; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") break;
		if (GENERIC_REINTERPRET_FLAG_RE.test(arg)) hasGenericFlag = true;
		if (NON_POSIX_CONTROL_RE.test(arg)) hasShellMeta = true;
		if (hasGenericFlag && hasShellMeta) return true;
	}
	return false;
}

function hasPwshReinterpretableArg(
	argv: readonly string[],
	offset: number,
	barePositionalRunsCommand: boolean,
): boolean {
	for (let i = offset + 1; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg.startsWith("-")) {
			const flagName = arg.slice(1).split(/[:=]/u, 1)[0]!.toLowerCase();
			if (flagName.length > 0 && PWSH_EXEC_FLAGS.some(f => f.startsWith(flagName))) return true;
			if (flagName.length > 0 && "file".startsWith(flagName)) {
				// Remaining args after -File <script> are script parameters, not host options.
				return false;
			}
			continue;
		}
		if (barePositionalRunsCommand) return true;
	}
	return false;
}

/** Returns `true` when an `&&` clause is a strictly literal, non-stateful simple command eligible for per-clause `allow`. */
export function isCompoundLiteralClauseEligible(
	clause: ApprovalAndClause,
): clause is ApprovalAndClause & { simple: ApprovalSimpleCommand } {
	const simple = clause.simple;
	if (!simple || !simple.strictlyLiteral) return false;
	if (simple.argv.some(isShellEnvironmentAssignment)) return false;
	const commandName = commandBasename(simple.argv[0]!);
	if (SHELL_STATEFUL_COMMANDS.has(commandName) || SHELL_INTERPRETER_COMMANDS.has(commandName)) {
		return false;
	}
	return !hasReinterpretableExecutionArg(simple.argv, simple.globWordIndices);
}

/** Returns `true` when a non-literal `&&` clause can mutate shell state for subsequent clauses. */
export function clauseMutatesShellState(clause: ApprovalAndClause, literalEligible: boolean): boolean {
	if (literalEligible) return false;
	if (clause.syntacticallyStateful || clause.stageCommands.length === 0) return true;
	return clause.stageCommands.some(argv => {
		const exe = argv[0];
		if (!exe || isShellEnvironmentAssignment(exe)) return true;
		const commandName = commandBasename(exe);
		return (
			SHELL_STATEFUL_COMMANDS.has(commandName) ||
			SHELL_INTERPRETER_COMMANDS.has(commandName) ||
			hasReinterpretableExecutionArg(argv)
		);
	});
}

/** Extracts all `&&` simple commands when every clause is literal and eligible for compound `allow` evaluation. */
export function extractLiteralAndChainFromAnalysis(
	analysis: BashApprovalAnalysis | null,
	allowCompoundCommands: boolean,
): ApprovalSimpleCommand[] | null {
	if (
		!allowCompoundCommands ||
		!analysis ||
		!analysis.valid ||
		analysis.hasControlChars ||
		analysis.hasComment ||
		!analysis.andChain
	) {
		return null;
	}
	const clauses: ApprovalSimpleCommand[] = [];
	for (const clause of analysis.andChain) {
		if (!isCompoundLiteralClauseEligible(clause)) return null;
		clauses.push(clause.simple);
	}
	return clauses;
}
