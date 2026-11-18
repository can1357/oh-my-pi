/**
 * Tool guard: after approval allows a call, the judge role screens the calls that can do harm.
 *
 * One judgment asks two questions over the session: a choice of what the call would do (`routine`, a
 * named risk, or `unclear`) and a yes/no on whether the user asked for it. The call is refused when
 * the named risks together reach `tools.guard.riskThreshold` and the asked probability stays below
 * `tools.guard.askedThreshold`. Any judge failure, timeout or malformed answer lets the call through;
 * a call aborted while it is judged never runs.
 *
 * Calls that cannot do harm never reach the judge: read-tier tools, writes inside the working
 * directory, shell commands made only of reading commands that write no file, and web search. The
 * design, wording and thresholds come from nace-ai/intern's System 1 guard (`guard.py`, Apache-2.0).
 */
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, AgentTool, ToolTier } from "@oh-my-pi/pi-agent-core";
import {
	type Answer,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	type JsonValue,
	judgeQuestions,
	type Questions,
	renderQuestion,
} from "@oh-my-pi/pi-ai";
import { logger, pathIsWithin, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type HostPressure, hostStrain, readHostPressure, summarizeHostPressure } from "../async/host-pressure";
import type { Settings } from "../config/settings";
import questionFile from "../prompts/judge/tool-guard.json" with { type: "json" };
import refusedTemplate from "../prompts/tools/tool-guard-refused.md" with { type: "text" };
import { operatorTitleText, textFromContent } from "../session/messages";
import { isMCPToolName } from "./builtin-names";
import {
	cfgToolGuardAllowances,
	cfgToolGuardAskedThreshold,
	cfgToolGuardEnabled,
	cfgToolGuardRiskThreshold,
} from "./settings";
import {
	extractFlatShellCommandSegments,
	isShellEnvironmentAssignment,
	lexShellCommand,
	tokenizeShellSegments,
} from "./shell-tokenize";

const QUESTIONS = judgeQuestions(questionFile);

type RiskLabel = keyof typeof questionFile.risk.criteria;

/** A static word list; looked up with {@link inTable} so inherited keys (`constructor`) never match. */
type WordTable = Readonly<Record<string, true>>;

/** The table of `words`, a space-separated list. */
function wordTable(words: string): WordTable {
	return Object.fromEntries(words.split(/\s+/).map(word => [word, true]));
}

function inTable(table: WordTable, word: string): boolean {
	return table[word] === true;
}

/** Labels that never block: everyday work, and a call the judge cannot read. */
const NON_RISKS = wordTable("routine unclear");
const RISK_LABELS = (Object.keys(QUESTIONS.risk.criteria) as RiskLabel[]).filter(label => !inTable(NON_RISKS, label));

/** Refusals in a row that stop the run: the model is not finding another way. */
const MAX_CONSECUTIVE_REFUSALS = 3;
/** Refusals in one run that stop it: more than working around one mistake. */
const MAX_TOTAL_REFUSALS = 20;
/** A judgment unanswered after this lets the call through. */
const JUDGE_TIMEOUT_MS = 15_000;
/** Judge failures or timeouts in a row that open the breaker: calls then go unjudged for the cooldown. */
const BREAKER_FAILURES = 3;
const BREAKER_COOLDOWN_MS = 5 * 60_000;
/** A call's arguments beyond this tell the judge nothing more about what it does. */
const CALL_CHARS = 6000;
/** Characters of each script shown, and how many scripts one call shows. */
const SCRIPT_CHARS = CALL_CHARS;
const SCRIPTS_SHOWN = 3;
/** The recent session shown, newest entries kept. */
const SESSION_CHARS = 12_000;
const SESSION_USER_CHARS = 1500;
const SESSION_ASSISTANT_CHARS = 800;
const SESSION_CALL_CHARS = 300;
const SESSION_RESULT_CHARS = 200;
/** The requests shown, newest kept; each one clipped. */
const REQUESTS_CHARS = 8000;
const REQUEST_CHARS = 2000;

/** Tools that need no judgement although they are not read-tier: a search sends only its query, and a
 * subagent's own calls pass the guard in its session. */
const UNJUDGED_TOOLS = wordTable("web_search task");

/** Commands that only read, print or compute. */
const READ_ONLY_COMMANDS = wordTable(
	"cat head tail ls pwd echo printf wc grep egrep fgrep which whereis type file stat du df cut tr nl diff cmp " +
		"basename dirname realpath readlink date whoami id uname hostname true false test [ column jq comm paste " +
		"fold rev seq md5sum sha1sum sha256sum shasum md5 sleep uniq tree pdfinfo",
);
/** `tree` options that write files: `-o FILE`, also inside a cluster (`-ao FILE`), and `-R`, which reruns tree with `-o 00Tree.html` in each directory. */
const TREE_WRITES = /^-[^-]*[oR]/;
/** `set` flags that change only how the shell stops on errors and traces, with `-o` naming one of {@link SET_NAMED_OPTIONS}. */
const SET_FLAGS = /^[-+][euxv]*o?$/;
const SET_NAMED_OPTIONS = wordTable("pipefail errexit nounset xtrace verbose");
/** Directory changes: the rest of the command runs somewhere the call does not show, so it is always judged. */
const DIRECTORY_CHANGES = wordTable("cd pushd popd");
const GIT_READS = wordTable(
	"status log diff show rev-parse ls-files blame describe shortlog grep ls-tree cat-file merge-base rev-list " +
		"show-ref whatchanged version help",
);
const GIT_BRANCH_LISTING = wordTable("-a -r -v -vv --all --remotes --list --show-current --merged --no-merged");
/** Git global options that take a value as the next word. */
const GIT_VALUE_OPTIONS = wordTable("-C -c --git-dir --work-tree --namespace");
const FIND_ACTIONS = wordTable("-exec -execdir -ok -okdir -delete -fprint -fprint0 -fprintf -fls");
/** Prefixes that run the rest of the line as the command; reads stay reads under the first group. */
const READ_WRAPPERS = wordTable("time nice timeout command");
const SCRIPT_WRAPPERS = wordTable("time nice timeout command sudo doas env nohup exec");
/** The one redirect target that writes nothing; every other file target is a write. */
const SAFE_REDIRECT_TARGETS = wordTable("/dev/null");

const SHELLS = wordTable("sh bash zsh dash ksh ash fish");
const INTERPRETER = /^(?:python[\d.]*|perl|ruby|node|php|pwsh)$/;
/** Project tools whose `run` runs the rest as a command in the project's environment. */
const RUNNERS = wordTable("uv poetry pipenv pdm hatch rye");
const SCRIPT_SUFFIX = /\.(?:py|sh|js|mjs|ts|rb|pl)$/;
/** Interpreter options that take a value before the script. */
const SCRIPT_VALUE_OPTIONS = wordTable("-o +o -O +O -W -X -I --require");
/** The system's own programs (`/usr/bin/env`), never shown as scripts. */
const SYSTEM_TREES = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/System", "/nix", "/opt/homebrew"];

/** A call the guard screens, as approval resolved it. */
export interface GuardedCall {
	toolName: string;
	/** The tool's description; its first line tells the judge what the tool is. */
	description?: string;
	tier: ToolTier;
	args: unknown;
	/** Absolute file paths or internal URLs the call writes or reads, from `approvalCacheTargets`. */
	targets?: readonly string[];
}

/** What the guard refused and why. */
export interface GuardVerdict {
	risk: RiskLabel;
	/** The risk's rubric head, e.g. "it deletes or overwrites data that may exist nowhere else". */
	reason: string;
	/** P(any named risk). */
	riskProbability: number;
	/** P(the user asked for it). */
	askedProbability: number;
	/** For `overloads_host`: the strain the host snapshot showed (`memory pressure`, `CPU saturation`, ...). */
	hostStrain?: string[];
}

export interface GuardThresholds {
	risk: number;
	asked: number;
}

/** The judge seam: answers typed questions; the session's judge role chain in production. */
export interface GuardJudge {
	judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>>;
}

/** What the guard reads from its session. */
export interface ToolGuardHost {
	readonly settings: Settings;
	cwd(): string;
	messages(): readonly AgentMessage[];
	judge(): GuardJudge;
	/** Stops the run after too many refusals; `reason` names them. */
	stop(reason: string): void;
	/**
	 * The machine's resource pressure, read only for calls that reach the judge; undefined when unknown.
	 * Defaults to {@link readHostPressure} for the working directory.
	 */
	hostPressure?(): Promise<HostPressure | undefined>;
}

function stringArg(args: unknown, key: string): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

/** `word` resolved against `base` (with `~/` as the home directory); undefined when it needs expansion. */
function resolveWord(word: string, base: string): string | undefined {
	if (/[$`*?{]/.test(word)) return undefined;
	if (word === "~" || word.startsWith("~/")) return path.join(os.homedir(), word.slice(1));
	if (word.startsWith("~")) return undefined;
	return path.resolve(base, word);
}

/** Leading assignments and read-only wrappers removed (`FOO=1 timeout 5 cat x` → `cat x`). */
function unwrapCommand(words: string[], wrappers: WordTable): string[] {
	let rest = words;
	for (;;) {
		while (rest.length > 0 && isShellEnvironmentAssignment(rest[0])) rest = rest.slice(1);
		const name = rest[0];
		if (name === undefined || !inTable(wrappers, name)) return rest;
		rest = rest.slice(1);
		while (rest.length > 0 && rest[0].startsWith("-")) {
			const option = rest[0];
			rest = rest.slice(1);
			if ((name === "nice" && option === "-n") || (name === "sudo" && (option === "-u" || option === "-g"))) {
				rest = rest.slice(1);
			}
		}
		if (name === "timeout" && rest.length > 0) rest = rest.slice(1);
		if (name === "env") while (rest.length > 0 && isShellEnvironmentAssignment(rest[0])) rest = rest.slice(1);
	}
}

/** Read-subcommand options that write a file or run a program: `--output=F`, `git grep -O<cmd>`, external diff and textconv drivers. */
const GIT_EXEC_OPTION = /^(?:--output|-O|--open-files-in-pager|--ext-diff|--textconv)/;

function readOnlyGit(args: string[]): boolean {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		const option = args[i];
		// Config set on the command line (`-c diff.external=x`) or another exec path can run anything.
		if (option.startsWith("-c") || option.startsWith("--config-env") || option.startsWith("--exec-path")) {
			return false;
		}
		if (inTable(GIT_VALUE_OPTIONS, option)) i++;
		i++;
	}
	const sub = args[i];
	const rest = args.slice(i + 1);
	const positional = rest.filter(arg => !arg.startsWith("-"));
	const flags = rest.filter(arg => arg.startsWith("-"));
	if (sub === undefined) return true;
	if (flags.some(flag => GIT_EXEC_OPTION.test(flag))) return false;
	if (inTable(GIT_READS, sub)) return true;
	if (sub === "branch") return positional.length === 0 && flags.every(flag => inTable(GIT_BRANCH_LISTING, flag));
	if (sub === "remote" || sub === "stash" || sub === "tag") {
		const action = positional[0];
		// A bare `git stash` (or `git stash -v`) is `git stash push`; bare `git remote` and `git tag` list.
		const listing = action === "show" || action === "list" || (action === undefined && sub !== "stash");
		return (
			(listing || action === "get-url") && flags.every(flag => flag === "-v" || flag === "-l" || flag === "--list")
		);
	}
	if (sub === "config") return rest.some(arg => arg.startsWith("--get") || arg === "--list" || arg === "-l");
	return sub === "reflog" && (positional[0] === undefined || positional[0] === "show");
}

/** Whether `set` only changes how the shell stops and traces (`set -euo pipefail`); `-a`, `-k` and positional `--` change what later commands see. */
function readOnlySet(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const flags = args[i];
		if (flags.length < 2 || !SET_FLAGS.test(flags)) return false;
		if (flags.endsWith("o") && i + 1 < args.length && !inTable(SET_NAMED_OPTIONS, args[++i])) return false;
	}
	return true;
}

/** `uniq` options whose value is the next word (`-f 1`, `-cw 3`, `--skip-chars 2`). */
const UNIQ_VALUE_OPTION = /^(?:-[a-zA-Z]*[fsw]|--(?:skip-fields|skip-chars|check-chars))$/;
/** `date` long options whose value may be the next word (`--date tomorrow`). */
const DATE_VALUE_OPTIONS = ["--date", "--file", "--reference", "--rfc-3339"];
/** `hostname` flags that only print a name or address; an operand, `-F FILE` and `-b` set the name. */
const HOSTNAME_DISPLAY =
	/^(?:-[aAdfhiIsvVy]+|--(?:alias|all-fqdns|all-ip-addresses|domain|fqdn|help|ip-address|long|nis|short|verbose|version|yp))$/;
/** `file -C`, also inside a cluster (`-zC`): compiles each magic file into a `.mgc` beside it. */
const FILE_COMPILE = /^-[^-]*C/;

/** Whether `date` only prints: no `-s`/`--set`, and every operand a `+FORMAT`, since a bare operand (`date 010112002020`) sets the clock. */
function readOnlyDate(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return args.slice(i + 1).every(operand => operand.startsWith("+"));
		if (arg.startsWith("--")) {
			// getopt accepts any unambiguous prefix of a long option (`--se` for `--set`).
			const name = arg.split("=", 1)[0];
			if ("--set".startsWith(name)) return false;
			if (name === arg && DATE_VALUE_OPTIONS.some(option => option.startsWith(name))) i++;
		} else if (arg.length > 1 && arg.startsWith("-")) {
			for (let j = 1; j < arg.length; j++) {
				const flag = arg[j];
				if (flag === "s") return false;
				// `-d`, `-f`, `-r` (and BSD `-v`) take the rest of the cluster or the next word; `-I` an attached format.
				if ("dfrv".includes(flag)) {
					if (j === arg.length - 1) i++;
					break;
				}
				if (flag === "I") break;
			}
		} else if (!arg.startsWith("+")) {
			return false;
		}
	}
	return true;
}

/**
 * Whether a reading command's arguments keep it reading: `tree -o`/`-R` write files, `printf -v` assigns a variable,
 * `uniq IN OUT` writes OUT, `file -C` compiles magic files, `date -s` and `hostname NAME` reconfigure the host.
 */
function readOnlyArguments(name: string, args: string[]): boolean {
	switch (name) {
		case "tree":
			return !args.some(arg => TREE_WRITES.test(arg));
		case "printf":
			return !args[0]?.startsWith("-v");
		case "uniq": {
			let operands = 0;
			for (let i = 0; i < args.length; i++) {
				const arg = args[i];
				if (arg === "--") {
					operands += args.length - i - 1;
					break;
				}
				if (UNIQ_VALUE_OPTION.test(arg)) i++;
				else if (arg === "-" || !arg.startsWith("-")) operands++;
			}
			return operands <= 1;
		}
		case "date":
			return readOnlyDate(args);
		case "hostname":
			return args.every(arg => HOSTNAME_DISPLAY.test(arg));
		case "file":
			// `--co` is the shortest prefix getopt takes for `--compile`.
			return !args.some(arg => FILE_COMPILE.test(arg) || (arg.length > 3 && "--compile".startsWith(arg)));
		default:
			return true;
	}
}

/** Whether `raw` holds a `>` outside quotes (`echo ok "x">f`): a redirection inside a word. */
function unquotedRedirect(raw: string): boolean {
	let quote: string | undefined;
	for (let i = 0; i < raw.length; i++) {
		const char = raw[i];
		if (char === "\\" && quote !== "'") i++;
		else if (quote !== undefined) {
			if (char === quote) quote = undefined;
		} else if (char === "'" || char === '"') quote = char;
		else if (char === ">") return true;
	}
	return false;
}

/** Whether one simple command only reads, prints or computes, writing no file. */
function readOnlySegment(text: string): boolean {
	const tokens = lexShellCommand(text);
	const words: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.kind !== "word") continue;
		// `<>` opens its file for reading and writing, creating it.
		const redirect = /^(\d*)(>>?|>\||<>)(.*)$/.exec(token.raw);
		if (redirect) {
			let target = redirect[3];
			if (target === "") {
				let next = i + 1;
				const separator = tokens[next];
				// The lexer splits `&` off as a separator: `>&1`, `>&-` copy or close a descriptor and write
				// nothing, while Bash's `>&file` writes the file.
				const duplicates = separator?.kind === "separator" && separator.raw.trimStart().startsWith("&");
				if (separator?.kind === "separator") next++;
				const word = tokens[next];
				if (word?.kind !== "word") return false;
				i = next;
				if (duplicates && /^(?:\d+|-)$/.test(word.value)) continue;
				target = word.value;
			}
			if (!inTable(SAFE_REDIRECT_TARGETS, target)) return false;
			continue;
		}
		// A `>` inside a word (`echo ok "x">f`, `cat <in>out`) is a redirection this scanner does not place.
		if (unquotedRedirect(token.raw) || inTable(DIRECTORY_CHANGES, token.value)) return false;
		const input = /^\d*<(.*)$/.exec(token.raw);
		if (input) {
			if (input[1] === "" && tokens[i + 1]?.kind === "separator") i += 2;
			continue;
		}
		words.push(token.value);
	}
	const command = unwrapCommand(words, READ_WRAPPERS);
	// An assignment (`PATH=/tmp/x git status`, `export PATH=...; git status`) changes which program a
	// name runs or what it reads, for the command or for the rest of the shell.
	const prefix = words.slice(0, words.length - command.length);
	if (prefix.some(isShellEnvironmentAssignment)) return false;
	// GNU time writes its report to a file with `-o FILE`, `-oFILE` or `--output=FILE`.
	if (prefix.includes("time") && prefix.some(word => /^-[a-zA-Z]*o|^--o/.test(word))) return false;
	const name = command[0];
	if (name === undefined) return words.length === 0 || command.length === 0;
	const args = command.slice(1);
	if (inTable(READ_ONLY_COMMANDS, name)) return readOnlyArguments(name, args);
	switch (name) {
		case "find":
			return !args.some(arg => inTable(FIND_ACTIONS, arg));
		case "rg":
			// `--pre` and `--hostname-bin` run a program of the caller's choosing.
			return !args.some(arg => arg.startsWith("--pre") || arg.startsWith("--hostname-bin"));
		case "sort":
			return !args.some(
				arg => /^-[a-zA-Z]*o/.test(arg) || arg.startsWith("--output") || arg.startsWith("--compress-program"),
			);
		case "set":
			return readOnlySet(args);
		case "git":
			return readOnlyGit(args);
		default:
			return false;
	}
}

/**
 * Whether a shell command is made only of commands that read, print or compute, redirecting only to
 * `/dev/null` or another descriptor. Syntax the scanner cannot follow (substitutions, heredocs, groups)
 * is not, nor is any directory change.
 */
export function isReadOnlyCommand(command: string): boolean {
	const segments = extractFlatShellCommandSegments(command);
	return segments.length > 0 && segments.every(segment => readOnlySegment(segment.text));
}

/** The file a simple command runs as code, as written; undefined for code in the call or a module. */
function scriptFile(words: string[]): string | undefined {
	const command = unwrapCommand(words, SCRIPT_WRAPPERS);
	const program = command[0];
	if (program === undefined) return undefined;
	const name = path.basename(program);
	const args = command.slice(1);
	// A sourced file (`source .env`) is often credentials; the judge reasons from the call text alone.
	if (name === "source" || name === ".") return undefined;
	if (inTable(RUNNERS, name) && args[0] === "run") {
		const rest = args.slice(1);
		while (rest.length > 0 && rest[0].startsWith("-")) rest.shift();
		if (rest.length === 0) return undefined;
		return SCRIPT_SUFFIX.test(rest[0]) ? rest[0] : scriptFile(rest);
	}
	const shell = inTable(SHELLS, name);
	if (!shell && !INTERPRETER.test(name)) return program.includes("/") ? program : undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-") return undefined;
		if (inTable(SCRIPT_VALUE_OPTIONS, arg)) {
			i++;
		} else if (!arg.startsWith("-") && !arg.startsWith("+")) {
			return arg;
		} else if (!arg.startsWith("--") && (shell ? arg.slice(1).includes("c") : /[cemrE]/.test(arg.slice(1)))) {
			return undefined; // code in the call (`-c`, `-e`) or a module (`-m`)
		}
	}
	return undefined;
}

/** Files a command writes by redirection or `tee`; a script it writes itself is shown in the call. */
function writtenWords(segment: string[]): string[] {
	const written: string[] = [];
	for (let i = 0; i < segment.length; i++) {
		const word = segment[i];
		const redirect = /^\d*>>?(.*)$/.exec(word);
		if (redirect) written.push(redirect[1] || (segment[i + 1] ?? ""));
	}
	if (segment[0] === "tee") written.push(...segment.slice(1).filter(arg => !arg.startsWith("-")));
	return written;
}

/** The files a shell command runs as code (`python x.py`, `bash x.sh`, `./x`, `uv run x.py`), at most three. Sourced files are never read: they are often credentials. */
export function scriptsRun(command: string, cwd: string): string[] {
	const segments = tokenizeShellSegments(command);
	const written = new Set<string>();
	const found: string[] = [];
	for (const segment of segments) {
		for (const word of writtenWords(segment)) {
			const target = resolveWord(word, cwd);
			if (target) written.add(target);
		}
		const script = scriptFile(segment);
		const file = script === undefined ? undefined : resolveWord(script, cwd);
		if (file === undefined || written.has(file) || found.includes(file)) continue;
		if (SYSTEM_TREES.some(tree => file === tree || file.startsWith(`${tree}/`))) continue;
		found.push(file);
	}
	return found.slice(0, SCRIPTS_SHOWN);
}

async function readScript(file: string): Promise<string> {
	let bytes: Uint8Array;
	try {
		bytes = await Bun.file(file)
			.slice(0, SCRIPT_CHARS * 4)
			.bytes();
	} catch {
		return "(no file there to read)";
	}
	if (bytes.includes(0)) return "(a compiled program)";
	const text = new TextDecoder().decode(bytes);
	return text.length > SCRIPT_CHARS ? `${text.slice(0, SCRIPT_CHARS)}\n[... the rest cut]` : text;
}

/** Whether a call can do harm the approval layer does not judge, so the judge should see it. */
export function needsJudgement(call: GuardedCall, cwd: string): boolean {
	if (call.tier === "read" || inTable(UNJUDGED_TOOLS, call.toolName)) return false;
	const writePath = call.toolName === "write" ? stringArg(call.args, "path") : undefined;
	// A write to a mounted device dispatches the device's own call, which the guard sees on its own.
	if (writePath?.startsWith("xd://")) return false;
	if (call.toolName === "bash") {
		const command = stringArg(call.args, "command");
		if (command === undefined) return true;
		return !isReadOnlyCommand(command);
	}
	if (call.tier === "write") {
		const targets = call.targets ?? [];
		// Internal URLs (`local://`, `xd://`) are the session's own artifacts or dispatch on their own.
		if (targets.length > 0) return targets.some(target => !target.includes("://") && !pathIsWithin(cwd, target));
		// Built-in write-tier tools without targets keep session state; an MCP tool can act anywhere.
		return isMCPToolName(call.toolName);
	}
	return true;
}

/** The refusal for `answers`, when the named risks reach `thresholds.risk` and P(asked) stays below `thresholds.asked`. */
export function guardVerdict(
	answers: { risk?: Answer; asked?: Answer },
	thresholds: GuardThresholds,
): GuardVerdict | undefined {
	const { risk, asked } = answers;
	if (risk?.type !== "choice" || asked?.type !== "noul") return undefined;
	const probabilities: Record<string, number> = risk.probabilities ?? { [risk.choice]: 1 };
	let riskProbability = 0;
	let top: RiskLabel | undefined;
	for (const label of RISK_LABELS) {
		const p = probabilities[label] ?? 0;
		if (!Number.isFinite(p)) return undefined;
		riskProbability += p;
		if (top === undefined || p > (probabilities[top] ?? 0)) top = label;
	}
	if (top === undefined || !Number.isFinite(asked.noul)) return undefined;
	if (riskProbability < thresholds.risk || asked.noul >= thresholds.asked) return undefined;
	const rubric = QUESTIONS.risk.criteria[top] ?? top;
	return {
		risk: top,
		reason: rubric.split(":")[0].trim(),
		riskProbability,
		askedProbability: asked.noul,
	};
}

function clip(text: string, chars: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > chars ? `${flat.slice(0, chars)}...` : flat;
}

function userRole(message: AgentMessage): message is Extract<AgentMessage, { role: "user" }> {
	return message.role === "user";
}

/**
 * What the session asked for, oldest first: the user's own messages; in a session with none (a
 * subagent), the assignment its parent sent. Harness-injected messages never count.
 */
export function guardRequests(messages: readonly AgentMessage[]): string[] {
	let texts = messages.flatMap(message => {
		if (userRole(message) && message.synthetic) return [];
		const text = operatorTitleText(message);
		return text ? [text] : [];
	});
	if (texts.length === 0) {
		texts = messages.flatMap(message => {
			if (!userRole(message) || message.synthetic) return [];
			const text = textFromContent(message.content);
			return text ? [text] : [];
		});
	}
	const kept: string[] = [];
	let chars = 0;
	for (let i = texts.length - 1; i >= 0; i--) {
		const text = clip(texts[i], REQUEST_CHARS);
		if (kept.length > 0 && chars + text.length > REQUESTS_CHARS) break;
		kept.push(text);
		chars += text.length;
	}
	return kept.reverse();
}

function sessionEntry(message: AgentMessage): string | undefined {
	switch (message.role) {
		case "user": {
			if (message.synthetic) return undefined;
			const text = textFromContent(message.content);
			if (!text) return undefined;
			return `${message.attribution === "user" ? "user" : "agent message"}: ${clip(text, SESSION_USER_CHARS)}`;
		}
		case "assistant": {
			const lines: string[] = [];
			const text = textFromContent(message.content);
			if (text) lines.push(`assistant: ${clip(text, SESSION_ASSISTANT_CHARS)}`);
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				lines.push(`call ${block.name} ${clip(JSON.stringify(block.arguments ?? {}), SESSION_CALL_CHARS)}`);
			}
			return lines.length > 0 ? lines.join("\n") : undefined;
		}
		case "toolResult": {
			const text = clip(textFromContent(message.content), SESSION_RESULT_CHARS);
			return `result ${message.toolName}${message.isError ? " (error)" : ""}: ${text || "(no text)"}`;
		}
		default:
			return undefined;
	}
}

/** The recent session, oldest first, cut to the newest entries that fit. */
export function guardSessionCut(messages: readonly AgentMessage[]): string {
	const entries: string[] = [];
	let chars = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const entry = sessionEntry(messages[i]);
		if (!entry) continue;
		if (chars + entry.length > SESSION_CHARS) break;
		entries.push(entry);
		chars += entry.length + 1;
	}
	return entries.reverse().join("\n");
}

function guardEnabled(settings: Settings): boolean {
	// A project or subagent layer may turn the guard on, never off.
	return cfgToolGuardEnabled.get(settings) || cfgToolGuardEnabled.get(settings.grantAuthority?.() ?? settings);
}

/**
 * One session's tool guard: screens each call approval allowed and counts what it refused. A run is
 * one request: the counts restart when a new one arrives.
 */
export class ToolGuard {
	readonly #host: ToolGuardHost;
	#consecutive = 0;
	#total = 0;
	/** Requests (non-synthetic user messages and user-invoked `/skill` prompts) when the counts last restarted; one more starts a new run. */
	#runKey: number | undefined;
	/** Judgments in a row that failed or timed out. */
	#judgeFailures = 0;
	/** While set and in the future, the judge is skipped and every call goes through. */
	#breakerOpenUntil: number | undefined;

	constructor(host: ToolGuardHost) {
		this.#host = host;
	}

	/** The refusal shown to the model in place of the call's result; undefined lets the call run. */
	async check(tool: AgentTool, args: unknown, tier: ToolTier, signal?: AbortSignal): Promise<string | undefined> {
		const settings = this.#host.settings;
		if (!guardEnabled(settings)) return undefined;
		const cwd = this.#host.cwd();
		let targets: readonly string[] | undefined;
		try {
			targets = tool.approvalCacheTargets?.(args);
		} catch {
			targets = undefined;
		}
		const call: GuardedCall = { toolName: tool.name, description: tool.description, tier, args, targets };
		let judged: boolean;
		try {
			judged = needsJudgement(call, cwd);
		} catch {
			judged = true; // a command the scanner cannot follow is judged
		}
		const messages = this.#host.messages();
		let runKey = 0;
		// A new request is a user message or a user-invoked `/skill` prompt (a custom message).
		for (const message of messages) {
			if (userRole(message) ? !message.synthetic : operatorTitleText(message) !== undefined) runKey++;
		}
		if (this.#runKey !== runKey) {
			this.#runKey = runKey;
			this.#consecutive = 0;
			this.#total = 0;
		}
		if (!judged) {
			if (tier !== "read") this.#consecutive = 0;
			return undefined;
		}
		const verdict = await this.#judge(call, messages, guardRequests(messages), cwd, signal);
		if (!verdict) {
			this.#consecutive = 0;
			return undefined;
		}
		this.#consecutive++;
		this.#total++;
		logger.warn("tool guard refused a call", {
			tool: tool.name,
			risk: verdict.risk,
			riskProbability: verdict.riskProbability,
			askedProbability: verdict.askedProbability,
		});
		const exhausted =
			this.#consecutive >= MAX_CONSECUTIVE_REFUSALS
				? `The tool guard refused ${this.#consecutive} tool calls in a row; the run stopped.`
				: this.#total >= MAX_TOTAL_REFUSALS
					? `The tool guard refused ${this.#total} tool calls in this run; the run stopped.`
					: undefined;
		if (exhausted) this.#host.stop(exhausted);
		return prompt.render(refusedTemplate, {
			risk: verdict.risk,
			reason: verdict.reason,
			riskProbability: verdict.riskProbability.toFixed(2),
			askedProbability: verdict.askedProbability.toFixed(2),
			overloadsHost: verdict.risk === "overloads_host",
			hostStrain: verdict.hostStrain?.join(", "),
		});
	}

	async #judge(
		call: GuardedCall,
		messages: readonly AgentMessage[],
		requests: string[],
		cwd: string,
		signal: AbortSignal | undefined,
	): Promise<GuardVerdict | undefined> {
		if (this.#breakerOpenUntil !== undefined && Date.now() < this.#breakerOpenUntil) return undefined;
		try {
			const timeout = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
			const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const authority = this.#host.settings.grantAuthority?.() ?? this.#host.settings;
			const allowances = cfgToolGuardAllowances.get(authority)?.trim();
			const command = call.toolName === "bash" ? stringArg(call.args, "command") : undefined;
			const runIn = stringArg(call.args, "cwd");
			const scripts = command === undefined ? [] : scriptsRun(command, runIn ? path.resolve(cwd, runIn) : cwd);
			const shown: JsonValue[] = [];
			for (const file of scripts) shown.push({ path: file, content: await readScript(file) });
			const state: Record<string, JsonValue> = {
				session: guardSessionCut(messages) || "(empty)",
				...(allowances ? { allowances } : {}),
				requests: requests.length > 0 ? requests : ["(none)"],
				cwd,
				home: os.homedir(),
				call: {
					tool: call.toolName,
					description: clip(call.description?.split("\n", 1)[0] ?? "", 300),
					tier: call.tier,
					arguments: clip(JSON.stringify(call.args ?? {}), CALL_CHARS),
				},
				...(shown.length > 0 ? { scripts: shown } : {}),
			};
			const pressure = await untilAborted(
				deadline,
				this.#host.hostPressure ? this.#host.hostPressure() : readHostPressure(cwd),
			).catch(() => undefined);
			if (pressure) state.host = summarizeHostPressure(pressure);
			// A judge that ignores its signal still cannot hold the call past the deadline or an abort.
			const { answers } = await untilAborted(deadline, () =>
				this.#host.judge().judge(
					{
						state,
						questions: {
							risk: QUESTIONS.risk,
							asked: renderQuestion(QUESTIONS.asked, { allowances: Boolean(allowances) }),
						},
					},
					{ signal: deadline },
				),
			);
			const verdict = guardVerdict(answers, {
				risk: cfgToolGuardRiskThreshold.get(authority),
				asked: cfgToolGuardAskedThreshold.get(authority),
			});
			if (verdict?.risk === "overloads_host" && pressure) verdict.hostStrain = hostStrain(pressure);
			this.#judgeFailures = 0;
			if (this.#breakerOpenUntil !== undefined) {
				this.#breakerOpenUntil = undefined;
				logger.info("tool guard: judge answering again, judging resumed");
			}
			return verdict;
		} catch (error) {
			// A call the user aborted says nothing about the judge, and must not run.
			if (signal?.aborted) throw error;
			logger.debug("tool guard: judgment failed, call allowed", {
				tool: call.toolName,
				error: error instanceof Error ? error.message : String(error),
			});
			this.#recordJudgeFailure();
			return undefined;
		}
	}

	#recordJudgeFailure(): void {
		this.#judgeFailures++;
		if (this.#judgeFailures < BREAKER_FAILURES) return;
		// After the cooldown the judge is tried again; three more failures open the breaker again.
		this.#breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
		this.#judgeFailures = 0;
		logger.warn("tool guard: judge failing, calls go unjudged for a while", {
			failures: BREAKER_FAILURES,
			cooldownMs: BREAKER_COOLDOWN_MS,
		});
	}
}
