import {
	type BashToolDetails,
	formatBackgroundNotice,
	formatWallTimeNotice,
	formatExitCodeNotice,
	WALL_TIME_NOTICE_MIN_MS,
} from "@oh-my-pi/pi-tui/tools/bash";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
	ToolTier,
} from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { PipeStreams, shellBuiltins } from "@oh-my-pi/pi-natives";
import { $which, isEnoent, logger, prompt, spillUrl } from "@oh-my-pi/pi-utils";
import { $env } from "@oh-my-pi/pi-utils/env";
import { isPosixShell } from "@oh-my-pi/pi-utils/procmgr";
import {
	compileNotifyPattern,
	type NotifyPattern,
	OutputNotifier,
	raceJobSettlement,
	resolveAutoBackgroundWaitMs,
} from "../async";
import { type BoardEntry, registerOnBoard } from "../daemon/client";
import { applyDirenvPreflight, type BashResult, executeBash } from "../exec/bash-executor";
import { shellMounts, shellProcessCommand } from "../exec/shell-process";
import { InternalUrlRouter } from "../internal-urls";
import { sessionResolveContext } from "../internal-urls/context";
import {
	InternalUrlFilesystem,
	type InternalUrlFilesystemOptions,
	type UrlWriteReport,
	UrlFsError,
} from "../internal-urls/url-filesystem";
import { PipeTextSources, TextTap } from "../job-widgets";
import bashDescription from "../prompts/tools/bash.md" with { type: "text" };
import type {
	ClientBridgeTerminalExitStatus,
	ClientBridgeTerminalHandle,
	ClientBridgeTerminalOutput,
} from "../session/client-bridge";
import { DEFAULT_MAX_BYTES, enforceInlineByteCap } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { TerminalGraphicsDecoder } from "../utils/terminal-graphics";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { type BashInteractiveResult, runInteractiveBashPty } from "./bash-interactive";
import type { ShellTrace } from "@oh-my-pi/pi-wire";
import { applyPatchShellInput } from "./bash-apply-patch";
import { hostCommandUrls, urlBacking } from "./bash-host-urls";
import { checkBashInterception } from "./bash-interceptor";
import { rewriteGitWorktreeAdd } from "./bash-worktree-rewrite";
import { canUseInteractiveBashPty } from "./bash-pty-selection";
import { resolveEvalBackends } from "./eval-backends";
import { invalidateGithubCacheForBashCommand, invalidateGithubCacheForBashResult } from "./gh-cache-invalidation";
import { serviceLogs, startService, type ServiceReady } from "../launch/services";
import { isFindEnabled } from "./jfind";
import { formatArtifactErrorNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { formatOutputNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { outputMeta, resolveInlineByteCapBudget } from "./output-meta";
import { resolveShellDirectory, resolveToCwd } from "./path-utils";
import {
	extractAndChainSegments,
	extractLeadingCdTarget,
	extractLiteralAndChainSegments,
	isShellEnvironmentAssignment,
	type LiteralShellCommandSegment,
	tokenizeShellSegments,
	withoutLeadingEnvironmentAssignments,
} from "./shell-tokenize";
import { findPipelineGuardHits, findShellGuardHit, type GuardHit, type GuardScope } from "./guard-rules";
import { ToolAbortError } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout, TOOL_TIMEOUTS } from "./tool-timeouts";

import {
	cfgAstEditEnabled,
	cfgAstGrepEnabled,
	cfgAsyncEnabled,
	cfgGlobEnabled,
	cfgGrepEnabled,
	cfgLaunchEnabled,
	cfgToolsGuardRules,
	cfgToolsMaxTimeout,
} from "./settings";
import {
	type BashApprovalPatternRule,
	type BashPatternApproval,
	cfgBashAllowedEnvVars,
	cfgBashAllowCompoundCommands,
	cfgBashAutoBackgroundEnabled,
	cfgBashAutoBackgroundThresholdMs,
	cfgBashDirenv,
	cfgBashDirenvLoadTimeoutMs,
	cfgBashGitGuard,
	cfgBashInterceptorEnabled,
	cfgBashInterceptorPatterns,
	cfgBashPatterns,
} from "../exec/settings";
import { cfgDisplayShellVisualization } from "../modes/settings";
import { cfgSkillful } from "../session/settings";
import { cfgWorktreeClone, ovnfsCommand } from "../task/settings";
import { sessionShellSpeech } from "../tts/shell-speech";
import { nativeShapingOff, shapeToolText, shapingExperiment } from "../spotlight";
import { SPOTLIGHT_FULL_OUTPUT_MAX_BYTES } from "../spotlight/types";
import type { SpotlightDetails } from "@oh-my-pi/pi-tui/chat/spotlight";

const BASH_APPROVAL_SHELL_CONTROL_CHARS: Record<string, true> = {
	"\n": true,
	"\r": true,
	";": true,
	"&": true,
	"|": true,
	"<": true,
	">": true,
	"`": true,
	$: true,
	"(": true,
	")": true,
};
const BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE = /(?:^|[ \t])(?:-[^-]*[ce]|--(?:command|eval))(?:[= \t]|$)/u;

function hasBashApprovalShellControl(command: string): boolean {
	let quote: "'" | '"' | undefined;
	let hasReinterpretableShellControl = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") {
				quote = undefined;
			} else if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) {
				hasReinterpretableShellControl = true;
			}
			continue;
		}
		if (ch === "\\") {
			const escaped = command[i + 1];
			if (escaped && Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, escaped)) {
				hasReinterpretableShellControl = true;
			}
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
				continue;
			}
			// Expansion is active inside double quotes even in the original line.
			if (ch === "`" || ch === "$") return true;
			// Other control characters are literal here but become executable if a
			// `-c`/`-e` option reinterprets the argument through another shell.
			if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) hasReinterpretableShellControl = true;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) return true;
	}
	// Options such as `git -c alias.x='!...'` and `sh -c "..."` reinterpret
	// otherwise literal quoted or escaped arguments as executable code.
	return hasReinterpretableShellControl && BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE.test(command);
}

const BASH_PATTERN_APPROVAL_VALUES = new Set(["allow", "deny", "prompt"]);

/**
 * Shape a shell command line for an ACP-conformant `terminal/create` request.
 *
 * ACP's `command` field is documented as the executable and `args` as its
 * argv tail (see https://agentclientprotocol.com/protocol/v1/terminals), so a
 * spec-conformant client `spawn(command, args)`s them directly — no implicit
 * shell. A raw `bash` tool line ("git status && echo x | head") therefore has
 * to be wrapped in an explicit shell invocation, otherwise the client tries
 * to spawn the whole line as argv[0] and fails with `ENOENT` for anything
 * containing a space, pipe, `&&`, redirect, or `$(...)`.
 *
 * The wrap reuses the same shell binary + args the local `bash-executor` would
 * pick via `settings.getShellConfig()` — Git Bash / `bash.exe` on Windows
 * (`cmd.exe /c` as the last-resort fallback when no bash exists on the host),
 * `$SHELL` (bash/zsh) with the `sh` fallback on POSIX — so the ACP path
 * preserves `bash` tool semantics (`$VAR`, `$(...)`, `source`, POSIX quoting,
 * `-l`) wherever a POSIX shell is available. The agent host's shell path is
 * used as a proxy for the client's, matching the near-universal ACP
 * deployment shape of an editor spawning omp as a co-hosted subprocess.
 */
export function wrapShellLineForClientTerminal(
	line: string,
	shellConfig: { shell: string; args: string[]; prefix?: string | undefined },
): { command: string; args: string[] } {
	const finalLine = shellConfig.prefix ? `${shellConfig.prefix} ${line}` : line;
	return { command: shellConfig.shell, args: [...shellConfig.args, finalLine] };
}

/**
 * Bash patterns flagged as safety critical for approval policy.
 *
 * Kept intentionally tight — the cost of a false negative is data loss or a compromised host,
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
	// wherever it appears — including forms this list would otherwise reach only via the target.
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
	// Process-sub variants — `bash <(curl …)`, `source <(curl …)`, `. <(curl …)`. `.` and `source` are
	// anchored to a command boundary so `find . -name` and similar don't false-positive.
	/(?:^|[\s;&|(])(?:bash|sh|zsh|source|\.)\s+<\(\s*(?:curl|wget|fetch)\b/i,
	// `eval "$(curl …)"` / `eval $(curl …)` / `eval \`curl …\``.
	/\beval\s+["'`]?\$\(\s*(?:curl|wget|fetch)\b|\beval\s+`\s*(?:curl|wget|fetch)\b/i,

	// Process/host control.
	/\bkill\s+-9\s+1\b/, // kill PID 1.
	// Process/host control — must sit at command position so `npm run reboot-tests`
	// or `echo 'shutdown the queue'` don't false-positive.
	/(?:^|[\s;&|(])(?:shutdown|poweroff|reboot|halt)(?:\s|$|[;|&])/i,
	/(?:^|[\s;&|(])init\s+0\b/i,

	// Network-shell exfil.
	/\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i, // `nc -e` / `nc -c`.
] as const;

function normalizeBashApprovalPattern(value: string): string {
	return value.trim().replace(/\s+/gu, " ");
}

function bashApprovalPatternToRegExp(pattern: string): RegExp {
	const escaped = normalizeBashApprovalPattern(pattern)
		.split("*")
		.map(part => part.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "u");
}

function normalizeBashPatternApproval(value: unknown): BashPatternApproval | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return BASH_PATTERN_APPROVAL_VALUES.has(normalized) ? (normalized as BashPatternApproval) : undefined;
}

function normalizeBashAllowedEnvList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map(entry => entry.trim())
		.filter(entry => entry.length > 0);
}

function getBashApprovalPatternRules(value: unknown): BashApprovalPatternRule[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(item => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
			const record = item as Record<string, unknown>;
			if (typeof record.match !== "string") return undefined;
			const match = normalizeBashApprovalPattern(record.match);
			const approval = normalizeBashPatternApproval(record.approval);
			const env = normalizeBashAllowedEnvList(record.env);
			if (match.length === 0 || !approval) return undefined;
			return env.length > 0 ? { match, approval, env } : { match, approval };
		})
		.filter((rule): rule is BashApprovalPatternRule => !!rule);
}

function commandMatchesBashApprovalPattern(command: string, pattern: string): boolean {
	const normalizedCommand = normalizeBashApprovalPattern(command);
	if (normalizedCommand.length === 0) return false;
	return bashApprovalPatternToRegExp(pattern).test(normalizedCommand);
}

// Names match exactly: a wildcard such as `CARGO_*` would also admit
// execution-redirecting variables (`CARGO_BUILD_RUSTC_WRAPPER`, `*_RUNNER`).
function stripAllowedLeadingEnvAssignments(command: string, allowedEnvNames: readonly string[]): string | undefined {
	if (allowedEnvNames.length === 0) return undefined;
	return withoutLeadingEnvironmentAssignments(command, varName => allowedEnvNames.includes(varName)) ?? undefined;
}

// `deny`/`prompt` rules are matched per segment so a dangerous command buried in
// a compound line (`cd x && rm -rf /`, `sleep 1 & rm -rf /`) is still caught,
// including when prefixed by leading `NAME=value` environment assignments.
// Reuse the shared shell tokenizer so segmentation stays in one place and honors
// every command boundary (`;`, `&&`, `||`, `|`, `&`, subshells, newlines).
function bashCommandSegments(command: string): string[] {
	const candidates: string[] = [];
	for (const words of tokenizeShellSegments(command)) {
		if (words.length === 0) continue;
		candidates.push(words.join(" "));
		let firstCmdIndex = 0;
		while (firstCmdIndex < words.length && isShellEnvironmentAssignment(words[firstCmdIndex])) {
			firstCmdIndex++;
		}
		if (firstCmdIndex > 0 && firstCmdIndex < words.length) {
			candidates.push(words.slice(firstCmdIndex).join(" "));
		}
	}
	return candidates;
}

// `deny`/`prompt` matching: the rule fires when its glob matches the whole
// command or any single segment of a compound command.
function commandSegmentMatchesBashApprovalPattern(command: string, pattern: string): boolean {
	const regex = bashApprovalPatternToRegExp(pattern);
	const normalizedCommand = normalizeBashApprovalPattern(command);
	if (normalizedCommand.length === 0) return false;
	if (regex.test(normalizedCommand)) return true;
	return bashCommandSegments(command).some(segment => regex.test(segment));
}

// A rule "applies" to a command under approval-specific semantics: `allow` must
// vouch for the ENTIRE command and never rides a compound line (shell control
// syntax could smuggle an unsafe segment past a narrow allow), while `deny` and
// `prompt` fire on any matching segment so they mean what they appear to.
function bashApprovalRuleMatches(
	command: string,
	rule: BashApprovalPatternRule,
	allowedEnvVars: readonly string[],
): boolean {
	if (rule.approval === "allow") {
		if (hasBashApprovalShellControl(command)) return false;
		if (commandMatchesBashApprovalPattern(command, rule.match)) return true;
		const effectiveEnv = rule.env ? [...rule.env, ...allowedEnvVars] : allowedEnvVars;
		const stripped = stripAllowedLeadingEnvAssignments(command, effectiveEnv);
		return stripped !== undefined && commandMatchesBashApprovalPattern(stripped, rule.match);
	}
	return commandSegmentMatchesBashApprovalPattern(command, rule.match);
}

function findNonCompoundBashRestrictionRule(
	command: string,
	rules: readonly BashApprovalPatternRule[],
): BashApprovalPatternRule | undefined {
	const segments = bashCommandSegments(command);
	let promptRule: BashApprovalPatternRule | undefined;
	for (const rule of rules) {
		if (
			rule.approval !== "allow" &&
			commandMatchesBashApprovalPattern(command, rule.match) &&
			!segments.some(segment => commandMatchesBashApprovalPattern(segment, rule.match))
		) {
			if (rule.approval === "deny") return rule;
			promptRule ??= rule;
		}
	}
	for (const segment of segments) {
		const segmentRule = rules.find(
			rule => rule.approval !== "allow" && commandMatchesBashApprovalPattern(segment, rule.match),
		);
		if (segmentRule?.approval === "deny") return segmentRule;
		if (segmentRule?.approval === "prompt") promptRule ??= segmentRule;
	}
	return promptRule;
}

function findBashApprovalPatternRule(
	command: string,
	rules: readonly BashApprovalPatternRule[],
	allowedEnvVars: readonly string[],
): BashApprovalPatternRule | undefined {
	if (hasBashApprovalShellControl(command)) {
		return findNonCompoundBashRestrictionRule(command, rules);
	}
	return rules.find(rule => bashApprovalRuleMatches(command, rule, allowedEnvVars));
}

type BashPatternDecision =
	| { kind: "deny"; rule: BashApprovalPatternRule }
	| { kind: "prompt"; rule: BashApprovalPatternRule }
	| { kind: "allow" }
	| { kind: "unmatched" };

/** One `bash.patterns` view: its rules plus the env names its `allow` rules may strip. */
interface BashPatternPolicy {
	rules: BashApprovalPatternRule[];
	allowedEnvVars: string[];
}

function resolveBashPatternDecision(
	command: string,
	compoundSegments: readonly LiteralShellCommandSegment[] | null,
	patternRules: readonly BashApprovalPatternRule[],
	allowedEnvVars: readonly string[],
): BashPatternDecision {
	if (compoundSegments) {
		let promptRule: BashApprovalPatternRule | undefined;
		for (const rule of patternRules) {
			if (
				rule.approval !== "allow" &&
				commandMatchesBashApprovalPattern(command, rule.match) &&
				!compoundSegments.some(segment => commandSegmentMatchesBashApprovalPattern(segment.text, rule.match))
			) {
				if (rule.approval === "deny") return { kind: "deny", rule };
				promptRule ??= rule;
			}
		}
		let hasUnmatchedSegment = false;
		for (const segment of compoundSegments) {
			const segmentRule = findBashApprovalPatternRule(segment.text, patternRules, allowedEnvVars);
			if (segmentRule?.approval === "deny") return { kind: "deny", rule: segmentRule };
			if (segmentRule?.approval === "prompt") promptRule ??= segmentRule;
			if (!segmentRule) hasUnmatchedSegment = true;
		}
		if (promptRule) return { kind: "prompt", rule: promptRule };
		return hasUnmatchedSegment ? { kind: "unmatched" } : { kind: "allow" };
	}
	const patternRule = findBashApprovalPatternRule(command, patternRules, allowedEnvVars);
	if (patternRule?.approval === "deny") return { kind: "deny", rule: patternRule };
	if (patternRule?.approval === "prompt") return { kind: "prompt", rule: patternRule };
	if (patternRule?.approval === "allow") return { kind: "allow" };
	return { kind: "unmatched" };
}

async function saveBashOriginalArtifact(session: ToolSession, originalText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.();
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, originalText);
		return alloc.id;
	} catch {
		return undefined;
	}
}

const BASH_TIMEOUT_DESCRIPTION = `timeout in seconds; 0 disables the command deadline; nonzero values are clamped to ${TOOL_TIMEOUTS.bash.min}-${TOOL_TIMEOUTS.bash.max}`;

// Blank stays valid: some tool-call layers spell an unset field as "".
const SERVICE_NAME = type(/^(?:\s*|[A-Za-z0-9][A-Za-z0-9._-]{0,47})$/).describe(
	"starts a long-lived supervised service under this name; omit for finite commands, async jobs included. 1-48 of [A-Za-z0-9._-]",
);

const SERVICE_READY = type({
	"log?": type("string").describe("regex an output line matches once the service is ready"),
	"port?": type("number").describe("TCP port the service accepts connections on once ready"),
	"host?": type("string").describe("host for the port probe; default localhost (127.0.0.1 and ::1)"),
	"timeout?": type("number").describe("seconds to wait for readiness; default 30"),
}).describe("service readiness; needs log or port");

const bashSchemaBase = type({
	command: type("string"),
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": "string",
	"pty?": "boolean",
});

const bashSchemaWithAsync = type({
	command: "string",
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": "string",
	"pty?": "boolean",
	"async?": "boolean",
	"notify?": "string",
});

const bashSchemaWithService = type({
	command: "string",
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": "string",
	"pty?": "boolean",
	"notify?": "string",
	"name?": SERVICE_NAME,
	"ready?": SERVICE_READY,
});

const bashSchemaWithAsyncAndService = type({
	command: "string",
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": "string",
	"pty?": "boolean",
	"async?": "boolean",
	"notify?": "string",
	"name?": SERVICE_NAME,
	"ready?": SERVICE_READY,
});

// Without an interactive UI a finite command's `pty` can only fall back, so those sessions are not
// offered it; services keep it, since the daemon gives them a terminal of their own.
const bashSchemaBaseNoPty = bashSchemaBase.omit("pty");
const bashSchemaWithAsyncNoPty = bashSchemaWithAsync.omit("pty");

type BashToolSchema =
	| typeof bashSchemaBase
	| typeof bashSchemaWithAsync
	| typeof bashSchemaWithService
	| typeof bashSchemaWithAsyncAndService
	| typeof bashSchemaBaseNoPty
	| typeof bashSchemaWithAsyncNoPty;

export interface BashToolInput {
	command: string;
	timeout?: number;
	cwd?: string;
	name?: string;
	ready?: ServiceReady;
	async?: boolean;
	/**
	 * Regex; each output line it matches is reported while the command runs. Without `name` the command
	 * runs as a background job, as `async` does; with `name` the service reports.
	 */
	notify?: string;
	pty?: boolean;
}

const PTY_BOARD_COMMAND_MAX = 60;

/** A pty command as one board-label line of at most {@link PTY_BOARD_COMMAND_MAX} chars. */
function ptyBoardCommand(command: string): string {
	const line = command.replace(/\s+/gu, " ").trim();
	return line.length > PTY_BOARD_COMMAND_MAX ? `${line.slice(0, PTY_BOARD_COMMAND_MAX - 1)}…` : line;
}

/**
 * Treats a blank string as an unset field.
 *
 * Some tool-call layers materialize every optional argument, spelling "not set"
 * as `""`; a whitespace-only service name is no more a name than a missing one.
 */
function blankToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Drops placeholder readiness fields, and the whole spec when it names no
 * condition (`log` or `port`): `host` and `timeout` only configure one. An
 * empty `log` pattern would otherwise match the first byte of output, an empty
 * `host` would break the TCP probe, and a zero `port` (how tool-call layers
 * materialize an unset number; no listener has it) would fail port validation,
 * so placeholder values must not reach {@link startService}.
 */
function normalizeReady(ready: ServiceReady | undefined): ServiceReady | undefined {
	if (!ready) return undefined;
	const log = blankToUndefined(ready.log);
	const port = Number.isFinite(ready.port) && ready.port !== 0 ? ready.port : undefined;
	if (log === undefined && port === undefined) return undefined;
	const host = blankToUndefined(ready.host);
	const timeout = Number.isFinite(ready.timeout) ? ready.timeout : undefined;
	return { log, host, port, timeout };
}

export interface BashToolOptions {}

type ManagedBashJobCompletion =
	| {
			kind: "completed";
			result: AgentToolResult<BashToolDetails>;
	  }
	| {
			kind: "failed";
			error: unknown;
	  };

interface ManagedBashJobHandle {
	jobId: string;
	completion: Promise<ManagedBashJobCompletion>;
	getLatestText: () => string;
	getLatestTrace: () => ShellTrace | undefined;
	/** Notices for this call's results, including the ones the run adds (URL writes). */
	notices: readonly string[];
	/** Hand the call's card to the job: later frames carry `details.async` and the last one settles it. */
	background: () => void;
	/** Text the run wrote to `out://` while the call was in the foreground, oldest first. */
	replies: readonly string[];
}

interface BashProgressDetails extends BashToolDetails {
	images?: ImageContent[];
	/** A running job's output so far (`proc://` shows it). */
	output?: string;
}

/** Pid probe of a background job with no command in flight. */
const NO_PIDS = (): readonly number[] => [];

/**
 * Shown when a call ran in a fork of the session's busy shell (it overlapped a parallel or backgrounded call)
 * and what it set could not be carried back into the session's shell.
 */
const FORK_STATE_LOST_NOTICE = "Ran in a copy of the busy session shell; changes here won't persist.";
/** Shown when such a call left background jobs running: they stay in the copy. */
const FORK_JOBS_NOTICE =
	"Background jobs started here run in a copy of the busy session shell; later calls' jobs, wait and %N won't see them.";

function normalizeResultOutput(result: BashResult | BashInteractiveResult): string {
	return result.output || "";
}

/**
 * Incrementally decodes cumulative client-terminal snapshots. Normal snapshots
 * append only the unseen suffix; a host-side rolling/truncated window retires
 * the old decoder and starts from the replacement snapshot without losing
 * images already completed before the rollover.
 */
class TerminalSnapshotDecoder {
	#decoder = new TerminalGraphicsDecoder();
	#raw = "";
	#clean = "";
	#retiredImages: Array<Promise<ImageContent[]>> = [];

	push(snapshot: string): string {
		if (!snapshot.startsWith(this.#raw)) {
			this.#decoder.finish();
			this.#retiredImages.push(this.#decoder.images());
			this.#decoder = new TerminalGraphicsDecoder();
			this.#raw = "";
			this.#clean = "";
		}
		const suffix = snapshot.slice(this.#raw.length);
		this.#raw = snapshot;
		this.#clean += this.#decoder.push(suffix);
		return this.#clean;
	}

	async finish(snapshot: string): Promise<{ text: string; images: ImageContent[] }> {
		const text = this.push(snapshot) + this.#decoder.finish();
		const batches = await Promise.all([...this.#retiredImages, this.#decoder.images()]);
		return { text, images: batches.flat() };
	}
}

function formatTimeoutClampNotice(
	requestedTimeoutSec: number,
	effectiveTimeoutSec: number,
	maxTimeout: number,
): string | undefined {
	if (requestedTimeoutSec === effectiveTimeoutSec) return undefined;
	const cappedByGlobal = maxTimeout > 0 && effectiveTimeoutSec === maxTimeout && maxTimeout < TOOL_TIMEOUTS.bash.max;
	const limit = cappedByGlobal
		? `global tools.maxTimeout ceiling ${maxTimeout}s`
		: `allowed range ${TOOL_TIMEOUTS.bash.min}-${TOOL_TIMEOUTS.bash.max}s`;
	return `Timeout clamped to ${effectiveTimeoutSec}s (requested ${requestedTimeoutSec}s; ${limit}).`;
}

/**
 * Records handler answers to a command's URL writes (`> proc://<id>/kill`, `> xd://<tool>`) as
 * result notices: the shell itself shows only an errno for a refused write.
 */
function noticeUrlWrites(notices: string[]): (report: UrlWriteReport) => void {
	return ({ url, text, failed }) => {
		if (failed) notices.push(`Write to ${url} failed: ${text}`);
		else if (text) notices.push(`${url}: ${text}`);
	};
}

/** Explicit tool `cwd` keeps the workspace-root alias; a hoisted shell `cd` does not. */
function resolveCommandCwd(cwd: string | undefined, sessionCwd: string, hoistedShellCwd: boolean): string {
	if (!cwd) return sessionCwd;
	return hoistedShellCwd ? resolveShellDirectory(cwd, sessionCwd) : resolveToCwd(cwd, sessionCwd);
}

/**
 * Bash tool implementation.
 *
 * Executes bash commands with optional timeout and working directory.
 */
export class BashTool implements AgentTool<BashToolSchema, BashToolDetails> {
	readonly name = "bash";
	/** Bash reads `skill://` paths through its shell filesystem, including as a working directory. */
	readonly readsSkillUris = true;
	/**
	 * The interceptor message for a call, checking the raw command and the one after a leading
	 * `cd … &&` so the wrapper hides neither shell-navigation rules nor the dedicated-tool command.
	 */
	#interception(
		rawCommand: string,
		command: string,
		name: string | undefined,
		toolNames: string[],
	): string | undefined {
		if (!cfgBashInterceptorEnabled.get(this.session.settings)) return undefined;
		const rules = cfgBashInterceptorPatterns.get(this.session.settings).filter(rule => !name || rule.tool !== "bash");
		for (const commandToCheck of rawCommand === command ? [command] : [rawCommand, command]) {
			const interception = checkBashInterception(commandToCheck, toolNames, rules, rawCommand);
			if (interception.block) return interception.message ?? "Command blocked";
		}
		return undefined;
	}

	readonly approval = (args: unknown, ctx?: AgentToolContext): ToolApprovalDecision => {
		const input = (args ?? {}) as Partial<BashToolInput>;
		const rawCommand = input.command;
		const command = typeof rawCommand === "string" ? rawCommand : "";
		// An intercepted call is refused outright; asking first would only approve a doomed call.
		const cwdCommand = input.cwd ? command : (extractLeadingCdTarget(command)?.rest ?? command);
		const name = typeof input.name === "string" ? blankToUndefined(input.name) : undefined;
		const interception = this.#interception(command, cwdCommand, name, ctx?.toolNames ?? []);
		if (interception) {
			return { tier: "exec", override: true, policy: "deny", reason: interception.replace(/^Blocked:\s*/u, "") };
		}
		const { session: policy, authority } = this.#patternPolicies();
		const shell = cfgBashAllowCompoundCommands.get(this.session.settings)
			? this.session.settings.getShellConfig().shell
			: undefined;
		const compoundSegments = shell && isPosixShell(shell) ? extractLiteralAndChainSegments(command) : null;
		const decision = resolveBashPatternDecision(command, compoundSegments, policy.rules, policy.allowedEnvVars);
		// Project layers may tighten the operator's `bash.patterns`, never loosen
		// them: an operator deny or prompt still applies under a project allow.
		const authorityDecision =
			authority === policy
				? decision
				: resolveBashPatternDecision(command, compoundSegments, authority.rules, authority.allowedEnvVars);
		const denied =
			authorityDecision.kind === "deny" ? authorityDecision : decision.kind === "deny" ? decision : undefined;
		if (denied) {
			return {
				tier: "exec",
				override: true,
				policy: "deny",
				reason: `Blocked by bash pattern: ${denied.rule.match}`,
			};
		}
		const prompted =
			authorityDecision.kind === "prompt" ? authorityDecision : decision.kind === "prompt" ? decision : undefined;
		if (prompted) {
			return {
				tier: "exec",
				override: true,
				policy: "prompt",
				reason: `Prompt required by bash pattern: ${prompted.rule.match}`,
			};
		}
		const criticalCommand = command !== "" && CRITICAL_BASH_PATTERNS.some(pattern => pattern.test(command));
		if (!compoundSegments && criticalCommand) {
			return { tier: "exec", override: true, reason: "Critical pattern detected" };
		}
		if (compoundSegments) {
			for (const segment of compoundSegments) {
				const literalCommand = segment.argv.join(" ");
				if (criticalCommand || CRITICAL_BASH_PATTERNS.some(pattern => pattern.test(literalCommand))) {
					return { tier: "exec", override: true, reason: "Critical pattern detected" };
				}
			}
		}
		const guardHit = this.#guardHit(command, input.cwd);
		if (guardHit) return { tier: "exec", override: true, reason: guardHit.reason };
		if (decision.kind === "allow") return { tier: "write", policy: "allow" };
		return "exec";
	};
	/**
	 * The fixed guard rule (`tools.guardRules`) `command` breaks over its top-level commands, or
	 * `undefined`, as always with the setting off. The critical patterns are not among the rules:
	 * they match the raw command line either way.
	 */
	#guardHit(command: string, cwd: unknown): GuardHit | undefined {
		return cfgToolsGuardRules.get(this.session.settings)
			? findShellGuardHit(command, this.#guardScope(cwd))
			: undefined;
	}
	/**
	 * Where the fixed guard rules see a call run: its `cwd` argument (resolved like execution
	 * resolves it) or the session cwd. A `cwd` execution cannot resolve (`@local://notes`) is left
	 * for execution to report, and the rules see the session cwd.
	 */
	#guardScope(cwd: unknown): GuardScope {
		const sessionCwd = this.session.cwd ?? process.cwd();
		let commandCwd = sessionCwd;
		if (typeof cwd === "string" && cwd !== "" && !InternalUrlRouter.instance().canHandle(cwd)) {
			try {
				commandCwd = resolveToCwd(cwd, sessionCwd);
			} catch {
				commandCwd = sessionCwd;
			}
		}
		return { cwd: commandCwd, home: os.homedir() };
	}
	/**
	 * `bash.patterns` rules and env allowlist for the session (`session`) and for the operator layers
	 * alone (`authority`, from `Settings.grantAuthority()`); `authority` is `session` when they agree.
	 * Shared by {@link approval} and the compound approval rows so both judge segments alike.
	 */
	#patternPolicies(): { session: BashPatternPolicy; authority: BashPatternPolicy } {
		const settings = this.session.settings;
		const rawPatterns = cfgBashPatterns.get(settings);
		const rawAllowedEnvVars = cfgBashAllowedEnvVars.get(settings);
		const session: BashPatternPolicy = {
			rules: getBashApprovalPatternRules(rawPatterns),
			allowedEnvVars: normalizeBashAllowedEnvList(rawAllowedEnvVars),
		};
		const authoritySettings = settings.grantAuthority?.();
		if (!authoritySettings) return { session, authority: session };
		const rawAuthorityPatterns = cfgBashPatterns.get(authoritySettings);
		const rawAuthorityAllowedEnvVars = cfgBashAllowedEnvVars.get(authoritySettings);
		if (rawAuthorityPatterns === rawPatterns && rawAuthorityAllowedEnvVars === rawAllowedEnvVars) {
			return { session, authority: session };
		}
		return {
			session,
			authority: {
				rules: getBashApprovalPatternRules(rawAuthorityPatterns),
				allowedEnvVars: normalizeBashAllowedEnvList(rawAuthorityAllowedEnvVars),
			},
		};
	}

	#formatCompoundApprovalDetails(command: string, cwd: unknown): string[] | null {
		const shell = cfgBashAllowCompoundCommands.get(this.session.settings)
			? this.session.settings.getShellConfig().shell
			: undefined;
		if (!shell || !isPosixShell(shell)) return null;
		const segments = extractAndChainSegments(command);
		if (!segments) return null;
		const { session: policy, authority } = this.#patternPolicies();
		// Whole-chain restrictions apply to the complete chain rather than individual segments.
		for (const rules of authority === policy ? [policy.rules] : [authority.rules, policy.rules]) {
			for (const rule of rules) {
				if (
					rule.approval !== "allow" &&
					commandMatchesBashApprovalPattern(command, rule.match) &&
					!segments.some(segment => commandSegmentMatchesBashApprovalPattern(segment.text, rule.match))
				) {
					return null;
				}
			}
		}
		const segmentCritical = segments.map(segment => {
			const literalCommand = segment.literal?.argv.join(" ");
			return CRITICAL_BASH_PATTERNS.some(
				pattern => pattern.test(segment.text) || (literalCommand !== undefined && pattern.test(literalCommand)),
			);
		});
		const wholeChainOnlyCritical =
			command !== "" &&
			CRITICAL_BASH_PATTERNS.some(pattern => pattern.test(command)) &&
			!segmentCritical.some(Boolean);
		if (wholeChainOnlyCritical) return null;
		// Each segment is one pipeline of the guard's parse of the whole chain, checked from the directory
		// the segments before it leave. A hit no segment can carry (`size_limit`), or a parse with more
		// pipelines than segments, leaves the chain to the plain command row.
		const segmentGuards = cfgToolsGuardRules.get(this.session.settings)
			? findPipelineGuardHits(command, this.#guardScope(cwd))
			: [];
		if (segmentGuards.length > segments.length || (!segmentGuards.some(Boolean) && this.#guardHit(command, cwd))) {
			return null;
		}

		let chainUntainted = true;
		const rows: string[] = [];
		for (let i = 0; i < segments.length; i++) {
			const segment = segments[i]!;
			const isCritical = segmentCritical[i]!;
			const guardRule = segmentGuards[i]?.rule;
			const segmentRule = findBashApprovalPatternRule(segment.text, policy.rules, policy.allowedEnvVars);
			const authorityRule =
				authority === policy
					? segmentRule
					: findBashApprovalPatternRule(segment.text, authority.rules, authority.allowedEnvVars);
			const promptRule =
				authorityRule?.approval === "prompt"
					? authorityRule
					: segmentRule?.approval === "prompt"
						? segmentRule
						: undefined;
			const covered =
				chainUntainted &&
				segment.literal !== null &&
				!isCritical &&
				!guardRule &&
				!promptRule &&
				authorityRule?.approval !== "deny" &&
				segmentRule?.approval === "allow";
			if (segment.mutatesShellState) chainUntainted = false;
			if (covered && segmentRule) {
				rows.push(`  ✓ ${truncateForPrompt(segment.text)} (allowed: ${segmentRule.match})`);
			} else {
				const reason = promptRule
					? `prompt: ${promptRule.match}`
					: isCritical
						? "critical pattern"
						: (guardRule ?? "requires approval");
				rows.push(`  ? ${truncateForPrompt(segment.text)} (${reason})`);
			}
		}
		return ["Command:", ...rows];
	}

	readonly formatApprovalDetails = (args: unknown): string[] => {
		const input = args as Partial<BashToolInput>;
		const rawCommand = input.command;
		const command = typeof rawCommand === "string" ? rawCommand : "(missing)";
		if (typeof rawCommand === "string") {
			const compound = this.#formatCompoundApprovalDetails(command, input.cwd);
			if (compound) return compound;
		}
		return [`Command: ${truncateForPrompt(command)}`];
	};
	readonly label = "Bash";
	readonly loadMode = "essential";
	get description(): string {
		const evalBackends = resolveEvalBackends(this.session);
		const isToolActive = (name: string, fallback: boolean): boolean => this.session.isToolActive?.(name) ?? fallback;
		return prompt.render(bashDescription, {
			asyncEnabled: cfgAsyncEnabled.get(this.session.settings),
			// The deadline an omitted `timeout` resolves to, after the `tools.maxTimeout` cap.
			defaultTimeoutSec: clampTimeout("bash", undefined, cfgToolsMaxTimeout.get(this.session.settings)),
			autoBackgroundEnabled: cfgBashAutoBackgroundEnabled.get(this.session.settings),
			autoBackgroundSeconds: cfgBashAutoBackgroundThresholdMs.get(this.session.settings) / 1000,
			hasAstGrep: isToolActive("ast_grep", cfgAstGrepEnabled.get(this.session.settings)),
			hasAstEdit: isToolActive("ast_edit", cfgAstEditEnabled.get(this.session.settings)),
			hasGrep: isToolActive("grep", cfgGrepEnabled.get(this.session.settings)),
			hasGlob: isToolActive("glob", cfgGlobEnabled.get(this.session.settings)),
			hasFind: this.session.isToolActive?.("find") ?? isFindEnabled(this.session),
			hasRead: isToolActive("read", true),
			// Frozen at the last prompt rebuild (managed sessions). SDK consumers
			// building a bare ToolSession lack the rebuild lifecycle, so fall back
			// to the derived form (skillful && skills) instead of dropping the hint.
			hasSkills:
				(this.session.skillHintVisible ??
					(cfgSkillful.get(this.session.settings) && (this.session.skills?.length ?? 0) > 0)) === true,
			hasLaunch: this.#launchEnabled,
			hasPty: this.#ptyAvailable || this.#launchEnabled,
			hasEval: isToolActive("eval", evalBackends.python || evalBackends.js),
			// The embedded shell's session env is the shell config env (see bash-executor).
			builtins: shellBuiltins(this.session.settings.getShellConfig().env),
			isWindows: process.platform === "win32",
		});
	}
	/** Schema variant for the live `async.enabled` and `launch.enabled` settings and PTY availability. */
	get parameters(): BashToolSchema {
		const asyncEnabled = cfgAsyncEnabled.get(this.session.settings);
		if (this.#launchEnabled) return asyncEnabled ? bashSchemaWithAsyncAndService : bashSchemaWithService;
		if (this.#ptyAvailable) return asyncEnabled ? bashSchemaWithAsync : bashSchemaBase;
		return asyncEnabled ? bashSchemaWithAsyncNoPty : bashSchemaBaseNoPty;
	}

	/** Whether `pty: true` can get a terminal: only an interactive UI hosts one. */
	get #ptyAvailable(): boolean {
		return this.session.hasUI && $env.PI_NO_PTY !== "1";
	}
	// Non-pty calls run alongside each other (the executor isolates overlapping
	// runs on the same shell session); pty takes over the terminal UI and must
	// run alone.
	readonly concurrency = (args: Partial<BashToolInput>): "shared" | "exclusive" =>
		args.pty === true ? "exclusive" : "shared";
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	/**
	 * URL filesystem for one embedded-shell run: this session's context, cancelled by the run's own
	 * signal. Without `onReply`/`onWrite` the run's writes to `out://` and other handler-written URLs
	 * are refused.
	 */
	#urlFilesystem(
		signal: AbortSignal | undefined,
		options: Omit<InternalUrlFilesystemOptions, "context">,
	): InternalUrlFilesystem {
		return new InternalUrlFilesystem({ ...options, context: sessionResolveContext(this.session, { signal }) });
	}

	/**
	 * Session identity for a command, read when its tool call starts, so
	 * `/fork`, `/new`, and `/resume` take effect on the next call while a call
	 * already under way keeps the session it began in. `PI_TOOL_CALL_ID` is the
	 * id this call runs under: the agent's call in the transcript, or the eval
	 * tool bridge's own id for a call made from an eval cell. Always
	 * set every key: an empty value replaces a stale one inherited from a parent
	 * omp process, since an env overlay cannot unset.
	 */
	#sessionEnv(toolCallId: string): Record<string, string> {
		return {
			PI_SESSION_ID: this.session.sessionManager?.getSessionId?.() ?? this.session.getSessionId?.() ?? "",
			PI_SESSION_FILE: this.session.getSessionFile() ?? "",
			PI_TOOL_CALL_ID: toolCallId,
		};
	}

	/**
	 * Where the session's persistent shell stands, read from a copy of it, for a shell process
	 * (a service, a pty command) to start from: `env` holds what it exports (PATH included), as a
	 * child of that shell would see in the host directory `cwd` (its direnv environment
	 * included), and `script` defines its functions and aliases. Shell bookkeeping variables
	 * stay with the process's own shell.
	 */
	async #sessionSeed(
		sessionId: string | undefined,
		cwd: string,
		signal: AbortSignal | undefined,
	): Promise<{ env: Record<string, string>; script: string }> {
		const dumpPath = path.join(os.tmpdir(), `omp-shell-env-${crypto.randomUUID()}`);
		const scriptPath = `${dumpPath}.sh`;
		const quote = (file: string): string => `'${file.replaceAll("'", `'\\''`)}'`;
		try {
			const sessionKey = sessionId ?? "";
			const dump = `env -0 > ${quote(dumpPath)} && { shopt -p expand_aliases; declare -f; alias -p; } > ${quote(scriptPath)} 2>/dev/null`;
			const result = await executeBash(dump, {
				cwd,
				// The same shell options as the session's calls, so the copy is of that session's shell.
				sessionKey: `${sessionKey}:async:service-env:${crypto.randomUUID()}`,
				seedSessionKey: sessionKey,
				minimize: !nativeShapingOff(this.session),
				gitGuard: cfgBashGitGuard.get(this.session.settings),
				ovnfs: ovnfsCommand(this.session.settings),
				timeout: 10_000,
				signal,
			});
			if (result.exitCode !== 0) throw new Error(result.output || `env exited ${result.exitCode}`);
			const [dumped, script] = await Promise.all([Bun.file(dumpPath).text(), Bun.file(scriptPath).text()]);
			const env: Record<string, string> = {};
			for (const entry of dumped.split("\0")) {
				const eq = entry.indexOf("=");
				if (eq <= 0) continue;
				const key = entry.slice(0, eq);
				if (key === "PWD" || key === "OLDPWD" || key === "SHLVL" || key === "_") continue;
				env[key] = entry.slice(eq + 1);
			}
			return { env, script };
		} catch (error) {
			logger.warn("Could not read the session shell's state for a shell process", {
				error: error instanceof Error ? error.message : String(error),
			});
			return { env: {}, script: "" };
		} finally {
			await Promise.all([fs.promises.rm(dumpPath, { force: true }), fs.promises.rm(scriptPath, { force: true })]);
		}
	}

	/**
	 * Run `command` as a shell process on a pseudo-terminal the user drives: the session's shell
	 * (its exports, functions and aliases, and the host files `mounts` puts behind its URL paths)
	 * leading a terminal of its own, so its programs own that terminal.
	 */
	async #runOnTerminal(
		ui: Pick<NonNullable<AgentToolContext["ui"]>, "custom">,
		run: {
			command: string;
			/** Host directory the process starts in. */
			hostCwd: string;
			/** URL directory its shell enters first. */
			urlCwd: string | undefined;
			sessionId: string | undefined;
			sessionEnv: Record<string, string>;
			timeoutMs: number | undefined;
			signal: AbortSignal | undefined;
			/** `urlmap` commands for the session's URL paths ({@link shellMounts}). */
			mounts: string;
			artifactPath: string | undefined;
			artifactId: string | undefined;
		},
	): Promise<BashInteractiveResult> {
		const seed = await this.#sessionSeed(run.sessionId, run.hostCwd, run.signal);
		const script = run.mounts + seed.script;
		const source = script ? path.join(os.tmpdir(), `omp-shell-seed-${crypto.randomUUID()}.sh`) : undefined;
		// Set from the pty's start callback; a holder keeps the type from narrowing to `undefined`.
		const board: { entry?: BoardEntry } = {};
		try {
			if (source !== undefined) await fs.promises.writeFile(source, script, { mode: 0o600 });
			return await runInteractiveBashPty(ui, {
				command: run.command,
				...shellProcessCommand({ command: run.command, source, cwd: run.urlCwd }),
				cwd: run.hostCwd,
				env: { ...seed.env, ...run.sessionEnv },
				timeoutMs: run.timeoutMs,
				signal: run.signal,
				artifactPath: run.artifactPath,
				artifactId: run.artifactId,
				onStart: pid => {
					board.entry = registerOnBoard({
						kind: "external",
						scope: { kind: "session", id: run.sessionId || `process-${process.pid}` },
						key: `pty:${pid}`,
						label: `pty: ${ptyBoardCommand(run.command)}`,
						pid,
					});
				},
			});
		} finally {
			// Resolves only after the pty program exited.
			board.entry?.dispose();
			if (source !== undefined) await fs.promises.rm(source, { force: true });
		}
	}

	/** Service launch mode: live `launch.enabled` while `bash` itself is an active tool. */
	get #launchEnabled(): boolean {
		return cfgLaunchEnabled.get(this.session.settings) === true && (this.session.isToolActive?.("bash") ?? true);
	}

	#formatResultOutput(result: BashResult | BashInteractiveResult): string {
		const outputText = normalizeResultOutput(result);
		// A failed exit gets its own notice; a clean one says so, or an empty diff reads like a broken command.
		if (!outputText) return result.exitCode === 0 ? "(no output, exit code 0)" : "(no output)";
		return outputText;
	}

	/**
	 * Throw for outcomes that are *not* a completed command: user aborts and a
	 * missing exit status. Timeouts are handled separately by
	 * #buildCompletedResult, which returns a non-throwing error result with
	 * details.timedOut=true so the renderer can show a warning border. The
	 * foreground and bridge callers plus the async job manager rely on these
	 * throwing so cancellations surface as aborts and jobs are recorded as
	 * failed. A definite non-zero exit is a completed command that failed;
	 * #buildCompletedResult surfaces it as an error *result* (carrying
	 * execution details) rather than a throw.
	 */
	#throwIfUnfinished(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number | undefined,
		outputText: string,
	): void {
		const captureNotice = result.artifactError ? `\n\n[${formatArtifactErrorNotice(result.artifactError)}]` : "";
		if (result.cancelled) {
			// Local executor output already carries a leading `[Command cancelled]`
			// notice from the sink; PTY/bridge output does not, so annotate only
			// the latter.
			const out = normalizeResultOutput(result);
			const annotated = out.startsWith("[Command cancelled]") ? out : out ? `${out}\n\n[Command aborted]` : out;
			throw new ToolError(`${annotated || "Command aborted"}${captureNotice}`);
		}
		if (result.timedOut === true) {
			const out = normalizeResultOutput(result);
			const message =
				timeoutSec === undefined ? "Command timed out" : `Command timed out after ${timeoutSec} seconds`;
			throw new ToolError(`${out ? `${out}\n\n[${message}]` : message}${captureNotice}`);
		}
		if (result.exitCode === undefined) {
			throw new ToolError(`${outputText}\n\nCommand failed: missing exit status${captureNotice}`);
		}
	}

	async #buildCompletedResult(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number | undefined,
		options: {
			command: string;
			cwd: string;
			requestedTimeoutSec?: number;
			notices?: readonly string[];
			wallTimeMs?: number;
			/** Text the run wrote to `out://`. */
			replies?: readonly string[];
			/** The call the result answers; shapes the output under the session's Spotlight experiment. */
			toolCallId?: string;
		},
	): Promise<AgentToolResult<BashToolDetails>> {
		const exitCode = result.exitCode;
		const failedExit = exitCode !== undefined && exitCode !== 0;

		const shaped =
			options.toolCallId === undefined
				? undefined
				: await this.#shapeOutput(result, options.toolCallId, options.command);
		const outputLines = [shaped?.text ?? this.#formatResultOutput(result)];
		const notices: string[] = [];
		const wallTimeMs = options.wallTimeMs;
		const wallTimeNoticeEmitted = wallTimeMs !== undefined && wallTimeMs >= WALL_TIME_NOTICE_MIN_MS;
		if (wallTimeNoticeEmitted) {
			notices.push(formatWallTimeNotice(wallTimeMs));
		}
		if (options.notices) {
			for (const notice of options.notices) {
				if (notice) notices.push(notice);
			}
		}
		const fork = "fork" in result ? result.fork : undefined;
		if (fork && !fork.carried) notices.push(FORK_STATE_LOST_NOTICE);
		if (fork?.jobs) notices.push(FORK_JOBS_NOTICE);
		if (notices.length > 0) outputLines.push("", ...notices);
		// Shaped output already leads with its exit status.
		if (failedExit && !shaped?.text?.startsWith("[exit code ")) outputLines.push("", formatExitCodeNotice(exitCode));
		const outputText = outputLines.join("\n");

		// Timeouts are not failures — the command ran its course. Return an error
		// result (isError=true for the model) but flag timedOut so the renderer
		// uses a warning border instead of error red. Both interactive and
		// non-interactive results carry an explicit `timedOut` field from the
		// executor/PTY layer.
		const isTimeout = result.timedOut === true;

		const details: BashToolDetails = { wallTimeNoticeEmitted };
		if (timeoutSec === undefined) {
			details.timeoutDisabled = true;
		} else {
			details.timeoutSeconds = timeoutSec;
		}
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		if (wallTimeMs !== undefined) {
			details.wallTimeMs = wallTimeMs;
		}
		if (failedExit) {
			details.exitCode = exitCode;
		}
		if (options.replies?.length) details.replies = [...options.replies];
		if (shaped?.spotlight) details.spotlight = shaped.spotlight;
		// Native history is bounded; retain it whole so persisted calls remain replayable.
		const trace = "trace" in result ? result.trace : undefined;
		if (trace) details.trace = trace;

		// Final-defense inline cap config, shared by the timeout and normal
		// completion paths. The sink already bounds inline bodies to the spill
		// threshold, so with the notice slack this only fires on paths that
		// bypass the sink (client-bridge terminals, minimizer misses). When the
		// sink spilled, its artifact already holds the full raw stream — reuse
		// that id instead of saving a second (already-truncated) copy, so the
		// `[raw output: local://N.log]` footer and the truncation notice agree.
		const inlineCap = {
			maxBytes: resolveInlineByteCapBudget(this.session.settings),
			saveArtifact: result.artifactError
				? undefined
				: (full: string) => result.artifactId ?? saveBashOriginalArtifact(this.session, full),
		};

		if (isTimeout) {
			details.timedOut = true;
			const message =
				timeoutSec === undefined ? "Command timed out" : `Command timed out after ${timeoutSec} seconds`;
			// executeBash has already emitted this leading sink notice. PTY output has not, and output shaped from the
			// artifact never carries it, so provide the LLM-facing annotation exactly once in the text sent.
			const lead = outputLines[0];
			if (lead !== `[${message}]` && !lead.startsWith(`[${message}]\n`)) {
				outputLines.push("", `[${message}]`);
			}
			const timeoutOutputText = await enforceInlineByteCap(outputLines.join("\n"), inlineCap);
			const timeoutBuilder = toolResult(details).content([
				{ type: "text", text: timeoutOutputText },
				...(result.images ?? []),
			]);
			if (!shaped?.whole) timeoutBuilder.truncationFromSummary(result, { direction: "tail" });
			return timeoutBuilder.error().done();
		}

		// Non-timeout cancellations and missing exit status still propagate as thrown errors.
		this.#throwIfUnfinished(result, timeoutSec, outputText);
		await invalidateGithubCacheForBashResult(options.command, options.cwd, result);

		// No-op for already-bounded output; see `inlineCap` above.
		const cappedOutputText = await enforceInlineByteCap(outputText, inlineCap);

		const resultBuilder = toolResult(details)
			.content([{ type: "text", text: cappedOutputText }, ...(result.images ?? [])])
			.minimized("minimized" in result ? result.minimized : undefined);
		// Output shaped from the whole spilled artifact no longer matches the sink's line ranges.
		if (!shaped?.whole) resultBuilder.truncationFromSummary(result, { direction: "tail" });
		if (failedExit) resultBuilder.error();
		return resultBuilder.done();
	}

	/**
	 * The command's output under the session's Spotlight shaping, or undefined when the session does not shape: `text`
	 * when shaping changed it, and the trace for the result's details. A spilled output, or one whose long lines the sink
	 * cut to its column cap, is shaped whole from its artifact (`whole`), up to {@link SPOTLIGHT_FULL_OUTPUT_MAX_BYTES}:
	 * shaping a capped line would only cut the preview further, past anything the cap dropped. Its savings still count
	 * against the capped text `plain` shows, truncation notice included, and a cut longer than that is not applied,
	 * except a short one when the column cap cut `plain` (`plainWidthCut`): the cap's preview leaves the rest to a read
	 * of the artifact. A result shaping does not cut (kept, held out, capped) stays as the sink built it, as under `plain`.
	 */
	async #shapeOutput(
		result: BashResult | BashInteractiveResult,
		toolCallId: string,
		command: string,
	): Promise<{ text?: string; whole: boolean; spotlight?: SpotlightDetails } | undefined> {
		const experiment = shapingExperiment(this.session);
		if (!experiment?.shapesTool("bash")) return undefined;
		const built = this.#formatResultOutput(result);
		let text = built;
		let whole = false;
		const widthCut = (result.columnTruncatedLines ?? 0) > 0;
		if (
			(result.truncated || widthCut) &&
			result.artifactId &&
			!result.artifactElidedBytes &&
			!result.artifactError &&
			result.totalBytes <= SPOTLIGHT_FULL_OUTPUT_MAX_BYTES
		) {
			const full = await experiment.readArtifact(result.artifactId);
			if (full !== null) {
				text = full;
				whole = true;
			}
		}
		const shaped = await shapeToolText(this.session, toolCallId, {
			tool: "bash",
			text,
			plain: built + formatOutputNotice(outputMeta().truncationFromSummary(result, { direction: "tail" }).get()),
			plainWidthCut: whole && widthCut,
			artifact: whole && result.artifactId ? spillUrl(result.artifactId) : undefined,
			command,
			exitCode: result.exitCode,
			source: command,
		});
		// Kept, held-out or capped text: the result stays as the sink built it (and keeps its truncation notice).
		return shaped.text === text
			? { whole: false, spotlight: shaped.spotlight }
			: { text: shaped.text, whole, spotlight: shaped.spotlight };
	}

	#buildBackgroundStartResult(
		jobId: string,
		previewText: string,
		timeoutSec: number | undefined,
		options: {
			requestedTimeoutSec?: number;
			notices?: readonly string[];
			replies?: readonly string[];
			trace?: ShellTrace;
		} = {},
	): AgentToolResult<BashToolDetails> {
		const details: BashToolDetails = {
			async: { state: "running", jobId, type: "bash" },
		};
		if (options.trace) details.trace = options.trace;
		if (options.replies?.length) details.replies = [...options.replies];
		if (timeoutSec === undefined) {
			details.timeoutDisabled = true;
		} else {
			details.timeoutSeconds = timeoutSec;
		}
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		const lines: string[] = [];
		const trimmedPreview = previewText.trimEnd();
		if (trimmedPreview.length > 0) {
			lines.push(trimmedPreview, "");
		}
		if (options.notices?.length) {
			lines.push(...options.notices, "");
		}
		lines.push(formatBackgroundNotice(jobId, timeoutSec));
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details,
		};
	}

	#extractTextResult(result: AgentToolResult<BashToolDetails>): string {
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		return text + formatOutputNotice(result.details?.meta);
	}

	#startManagedBashJob(options: {
		command: string;
		commandCwd: string;
		timeoutMs: number | undefined;
		timeoutSec: number | undefined;
		requestedTimeoutSec?: number;
		notices?: readonly string[];
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>;
		/** A foreground wait races the job: updates stream to the caller and the row stays hidden until promoted. */
		foreground: boolean;
		/** Approval tier bounding the job's URL filesystem. */
		approvalTier: ToolTier;
		/** Session the call started in; its shell, even if the session changes before the job runs. */
		sessionId: string | undefined;
		/** That session's identity for the command (see {@link BashTool.#sessionEnv}). */
		sessionEnv: Record<string, string>;
		/** The model's `i` intent on the call, for the job's widget author. */
		intent?: string;
		/** The call that started the job. */
		toolCallId: string;
		/** Output lines to report while the job runs; see {@link BashToolInput.notify}. */
		notify?: NotifyPattern;
	}): ManagedBashJobHandle {
		const manager = this.session.asyncJobManager;
		if (!manager) {
			throw new ToolError("Background job manager unavailable for this session.");
		}

		const label = options.command.length > 120 ? `${options.command.slice(0, 117)}...` : options.command;
		// Holds the run's Shell only while it runs: a retained reference would
		// keep a finished `:async:` Shell (and its background children) alive.
		let pids: () => readonly number[] = NO_PIDS;
		// Outlives the run with the job row, so a finished pipeline stays readable.
		const streams = new PipeStreams();
		// The job's widget reads the command's own output and every pipe it opens.
		const outputTap = new TextTap("out", "the command's own stdout+stderr");
		const pipeSources = new PipeTextSources(streams);
		let latestText = "";
		let latestProgressDetails: BashProgressDetails | undefined;
		let backgrounded = !options.foreground;
		const completion = Promise.withResolvers<ManagedBashJobCompletion>();
		const notices = [...(options.notices ?? [])];
		const replies: string[] = [];
		// The run's live trace; cleared once the result carries the final bounded snapshot.
		let liveTrace: ShellTrace | undefined;
		// While the call waits on the run, every frame of its card carries the replies so far and the
		// transcript draws the new ones. A backgrounded job's frames carry none: the call's result already did.
		// Every frame of a live run carries its latest trace.
		const withReplies = (details: BashProgressDetails): BashProgressDetails => {
			const withTrace = liveTrace && details.trace === undefined ? { ...details, trace: liveTrace } : details;
			return !backgrounded && replies.length > 0 ? { ...withTrace, replies: [...replies] } : withTrace;
		};
		// Replies reach the user only while the call waits on the run: once it returns, nothing draws them.
		const onReply = (text: string): void => {
			if (backgrounded) {
				throw new ToolError("out:// replies reach the user only while the command runs in the foreground.");
			}
			replies.push(text);
			options.onUpdate?.({
				content: [{ type: "text", text: latestText }],
				details: withReplies(latestProgressDetails ?? {}),
			});
		};

		const jobId = manager.register(
			"bash",
			label,
			async ({ jobId, signal: runSignal, reportProgress }) => {
				// Records the job's progress and shows it on the call's card: plain output
				// while the call still waits on it, the job frame (`details.async`) once
				// backgrounded, so the card keeps filling and settles with the job.
				const report = async (text: string, details: BashProgressDetails): Promise<void> => {
					latestText = text;
					const reported = reportProgress(text, { ...details });
					// `output` feeds job listings; the card already shows `text`.
					const { output: _output, ...frame } = details;
					options.onUpdate?.({
						content: [{ type: "text", text }],
						details: withReplies(backgrounded ? frame : (latestProgressDetails ?? {})),
					});
					await reported;
				};
				// `#execute` refused the call when this session has no notify channel.
				const notifier =
					options.notify && this.session.openAsyncNotify
						? new OutputNotifier(
								options.notify,
								outputTap,
								this.session.openAsyncNotify({
									id: jobId,
									type: "bash",
									command: options.command,
									pattern: options.notify.source,
									running: () => manager.getJob(jobId)?.status === "running",
								}),
							)
						: undefined;
				// A cancelled job reports nothing more, even while its command is still shutting down.
				if (notifier) runSignal.addEventListener("abort", () => notifier.stop(), { once: true });
				const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.()) ?? {};
				const wallTimeStart = performance.now();
				try {
					const result = await executeBash(options.command, {
						cwd: options.commandCwd,
						env: options.sessionEnv,
						minimize: !nativeShapingOff(this.session),
						// A call that starts in the foreground runs in the session's
						// persistent shell, like the direct path, so its variables,
						// functions, and options reach the next call even after it is
						// backgrounded. A job that starts in the background gets its own
						// copy of the session's shell, so it sees what earlier calls set
						// but never holds the session's shell nor changes it.
						sessionKey: options.foreground ? options.sessionId : `${options.sessionId ?? ""}:async:${jobId}`,
						seedSessionKey: options.foreground ? undefined : (options.sessionId ?? ""),
						isSessionCurrent: () => (this.session.getSessionId?.() ?? undefined) === options.sessionId,
						timeout: options.timeoutMs ?? 0,
						signal: runSignal,
						gitGuard: cfgBashGitGuard.get(this.session.settings),
						ovnfs: ovnfsCommand(this.session.settings),
						// Bound to the job's own signal: the job outlives the call that started it.
						filesystem: this.#urlFilesystem(runSignal, {
							tier: options.approvalTier,
							onReply,
							onWrite: noticeUrlWrites(notices),
							toolCallId: options.toolCallId,
						}).shellFilesystem(),
						speech: sessionShellSpeech(this.session),
						artifactPath,
						artifactId,
						onChunk: chunk => {
							outputTap.append(chunk);
							notifier?.poll();
						},
						onPreview: text => {
							void report(text, { output: text, async: { state: "running", jobId, type: "bash" } });
						},
						onTrace: cfgDisplayShellVisualization.get(this.session.settings)
							? trace => {
									liveTrace = trace;
									void report(latestText, {
										output: latestText,
										async: { state: "running", jobId, type: "bash" },
									});
								}
							: undefined,
						onMinimizedSave: originalText => saveBashOriginalArtifact(this.session, originalText),
						streams,
						onStart: probe => {
							pids = probe;
						},
					}).finally(() => {
						pids = NO_PIDS;
						liveTrace = undefined;
						outputTap.close();
						// The result that follows carries the job's last output, matches included.
						notifier?.stop();
					});
					if (result.artifactError) latestProgressDetails = { meta: { artifactError: result.artifactError } };
					const wallTimeMs = performance.now() - wallTimeStart;
					const finalResult = await this.#buildCompletedResult(result, options.timeoutSec, {
						command: options.command,
						cwd: options.commandCwd,
						requestedTimeoutSec: options.requestedTimeoutSec,
						notices,
						wallTimeMs,
						replies: backgrounded ? undefined : replies,
						toolCallId: options.toolCallId,
					});
					const finalText = this.#extractTextResult(finalResult);
					latestText = finalText;
					const images = finalResult.content.filter((block): block is ImageContent => block.type === "image");
					latestProgressDetails = {
						...finalResult.details,
						...(images.length > 0 ? { images } : {}),
					};
					// Hand the detailed result to the foreground auto-background
					// waiter (which renders it, footer included) before deciding
					// the job's terminal state.
					completion.resolve({ kind: "completed", result: finalResult });
					if (finalResult.isError === true) {
						// A non-zero exit is a completed command that failed. Re-enter
						// the failure path so the job manager records it as failed and
						// delivers the error text, matching prior throw-based behavior.
						throw new ToolError(finalText);
					}
					await report(finalText, {
						...latestProgressDetails,
						async: { state: "completed", jobId, type: "bash" },
					});
					return finalText;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					completion.resolve({ kind: "failed", error });
					// Only a cancel aborts the job's own signal (deadlines end in a timed-out result).
					await report(message, {
						...latestProgressDetails,
						async: { state: runSignal.aborted ? "cancelled" : "failed", jobId, type: "bash" },
					});
					throw error;
				}
			},
			{
				ownerId: this.session.getAgentId?.() ?? undefined,
				foreground: options.foreground,
				process: { command: options.command, cwd: options.commandCwd, pids: () => pids(), streams },
				intent: options.intent,
				widgetInputs: {
					sources: () => [outputTap, ...pipeSources.list()],
					brief: () => ({
						kind: "bash",
						command: options.command,
						timeoutSec: options.timeoutSec,
						intent: options.intent,
					}),
				},
			},
		);

		return {
			jobId,
			completion: completion.promise,
			getLatestText: () => latestText,
			getLatestTrace: () => liveTrace ?? latestProgressDetails?.trace,
			notices,
			background: () => {
				backgrounded = true;
			},
			replies,
		};
	}

	async execute(
		toolCallId: string,
		input: BashToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		// The directory the command actually ran in, set once resolved. A hoisted
		// `cd <dir>; …` runs only the remainder, so renderers drawing the executed
		// script read the directory from here instead of re-parsing the command.
		const ran: { cwd?: string; cdSeparator?: ";" } = {};
		const stamp = (details: BashToolDetails | undefined): BashToolDetails | undefined =>
			ran.cwd === undefined
				? details
				: { ...details, cwd: ran.cwd, ...(ran.cdSeparator ? { cdSeparator: ran.cdSeparator } : {}) };
		const result = await this.#execute(
			toolCallId,
			input,
			ran,
			signal,
			onUpdate && (update => onUpdate({ ...update, details: stamp(update.details) })),
			ctx,
		);
		return { ...result, details: stamp(result.details) };
	}

	async #execute(
		toolCallId: string,
		{
			command: rawCommand,
			timeout: rawTimeout,
			cwd,
			name: rawName,
			ready: rawReady,
			async: rawAsync,
			notify: rawNotify,
			pty,
		}: BashToolInput,
		ran: { cwd?: string; cdSeparator?: ";" },
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		let command = rawCommand;
		// The session this call belongs to, captured before any await: a session
		// change while the call waits must not move it into the new session's
		// shell, nor hand it the new session's identity.
		const sessionId = this.session.getSessionId?.() ?? undefined;
		const sessionEnv = this.#sessionEnv(toolCallId);

		// Extract a leading `cd <path> && ...` / `cd <path>; ...` into cwd when the
		// model ignores the cwd parameter. The scanner captures only a single path
		// token and defers to the shell for anything else (redirects, extra args,
		// shell expansion), so it never absorbs shell syntax like
		// `cd /tmp 2>/dev/null && ...` into the structured cwd. `&&` always hoists:
		// a missing directory fails early, as the shell would short-circuit. `;`
		// runs the rest even when `cd` fails, so it hoists only onto an existing host
		// directory; anything else (URL targets included) stays with the shell.
		// The target is a shell path: `/` is the filesystem root, not the workspace
		// alias an explicit tool `cwd` keeps.
		let hoistedShellCwd = false;
		if (!cwd) {
			const cd = extractLeadingCdTarget(command);
			const virtualTarget = cd !== null && InternalUrlRouter.instance().canHandle(cd.path);
			const semicolonDirectory =
				cd?.separator === ";" &&
				!virtualTarget &&
				(await fs.promises.stat(resolveShellDirectory(cd.path, this.session.cwd)).catch(() => null))?.isDirectory();
			if (cd && (cd.separator === "&&" || semicolonDirectory === true)) {
				hoistedShellCwd = !virtualTarget;
				cwd = cd.path;
				command = cd.rest;
				if (cd.separator === ";") ran.cdSeparator = ";";
			}
		}
		// Mode selection runs on normalized fields: a caller that materializes
		// every optional argument with empty or placeholder values still asked
		// for a plain command. Only `async: true` or a `notify` regex is an async
		// request, a blank `name` is no service name, and service-only fields
		// with nothing in them are not a service request.
		const name = blankToUndefined(rawName);
		const ready = normalizeReady(rawReady);
		const notifySource = blankToUndefined(rawNotify);
		// `notify` reports output while the command runs: a service does that as it is, and anything
		// else starts in the background as `async` does.
		const asyncRequested = rawAsync === true || (notifySource !== undefined && name === undefined);
		const pendingNotices: string[] = [];
		if (name !== undefined) {
			if (!this.#launchEnabled) throw new ToolError("Service launch is disabled in this session.");
			// Without a readiness condition nothing marks this as a service but `name`, while
			// async/timeout ask for a finite command: refuse rather than guess.
			if (ready === undefined && (rawAsync === true || rawTimeout !== undefined)) {
				throw new ToolError(
					"`name` starts a long-lived service, which takes no async or timeout. Omit `name` for a finite command (async jobs included), or drop async/timeout to start a service.",
				);
			}
			if (rawTimeout !== undefined)
				pendingNotices.push("Ignored timeout: service-only; readiness follows ready.timeout.");
			if (rawAsync === true)
				pendingNotices.push("Ignored async: service-only; a service start is asynchronous already.");
			// Host and timeout configure a readiness condition without naming one.
			if (
				ready === undefined &&
				(blankToUndefined(rawReady?.host) !== undefined || Number.isFinite(rawReady?.timeout))
			)
				pendingNotices.push("Ignored ready: it needs log or port; the service started without a readiness wait.");
		} else if (ready !== undefined) {
			pendingNotices.push("Ignored ready: service-only, and no service name was given.");
		}
		if (name === undefined && asyncRequested && !cfgAsyncEnabled.get(this.session.settings)) {
			throw new ToolError("Async bash execution is disabled. Enable async.enabled to use async mode.");
		}
		if (
			notifySource !== undefined &&
			!(name === undefined ? this.session.openAsyncNotify : this.session.queueServiceNotify)
		) {
			throw new ToolError("notify is unavailable in this session.");
		}
		// Compiled before anything runs: a bad regex fails the call instead of a job that never reports.
		// A service's regex is checked by `startService`.
		const notify = name === undefined && notifySource !== undefined ? compileNotifyPattern(notifySource) : undefined;
		// Tells the model which output reaches it before the command ends.
		const notifyNotice =
			notifySource === undefined
				? undefined
				: `Output lines matching /${notifySource}/ arrive as follow-ups while it runs.`;

		const interception = this.#interception(rawCommand, command, name, ctx?.toolNames ?? []);
		if (interception) throw new ToolError(interception);
		// Models trained on Codex call the apply_patch tool as a shell command; omp ships no such
		// program, so a patch given that way goes to the tool (through its own approval).
		const shellPatch = applyPatchShellInput(command);
		if (shellPatch !== undefined && !$which("apply_patch")) {
			const applyPatch = this.session.getToolForEvalBridge?.("apply_patch");
			if (applyPatch?.customWireName === "apply_patch") {
				if (shellPatch === null) {
					throw new ToolError("apply_patch is a tool, not a shell command: call it with the patch text.");
				}
				const patched = await applyPatch.execute(toolCallId, { input: shellPatch }, signal, undefined, ctx);
				return { content: patched.content, isError: patched.isError, details: {} };
			}
		}

		if (cfgWorktreeClone.get(this.session.settings)) {
			const rewritten = rewriteGitWorktreeAdd(command, resolveCliEntryCmd());
			if (rewritten !== command) {
				pendingNotices.push(
					"Ran `git worktree add` as `omp worktree add`: a copy-on-write clone of the checkout without .git, other worktrees, or untracked .env files. Set worktree.clone=false for plain git.",
				);
				command = rewritten;
			}
		}

		// Best-effort cache invalidation: drop github-cache rows for any issue/PR
		// number touched by a mutating `gh` subcommand inside this bash call so
		// subsequent issue:// / pr:// reads pick up the post-mutation state
		// instead of the cached pre-mutation snapshot.
		invalidateGithubCacheForBashCommand(command);

		// URL paths resolve through the embedded shell's filesystem, within the
		// tier this command was approved at. A URL cwd stays a URL: only that
		// filesystem can enter it, so a service's or pty command's shell process
		// starts on the host and enters it, and the client terminal never runs there.
		const approval = this.approval({ command: rawCommand });
		const approvalTier = typeof approval === "string" ? approval : approval.tier;
		const router = InternalUrlRouter.instance();
		const virtualCwd = cwd && router.canHandle(cwd) ? router.normalize(cwd) : undefined;
		const commandCwd = virtualCwd ?? resolveCommandCwd(cwd, this.session.cwd, hoistedShellCwd);
		if (cwd) ran.cwd = commandCwd;
		// Where a process for this command starts: a URL directory has none of its own.
		const hostCwd = virtualCwd === undefined ? commandCwd : this.session.cwd;
		if (virtualCwd !== undefined) {
			const cwdStat = await this.#urlFilesystem(signal, { tier: approvalTier })
				.stat(virtualCwd)
				.catch((err: unknown) => {
					if (err instanceof UrlFsError && err.code === "ENOENT") {
						throw new ToolError(`Working directory does not exist: ${virtualCwd}`);
					}
					throw new ToolError(
						`Working directory ${virtualCwd} is unavailable: ${err instanceof Error ? err.message : String(err)}`,
					);
				});
			if (cwdStat.type !== "directory") {
				throw new ToolError(`Working directory is not a directory: ${virtualCwd}`);
			}
		} else {
			let cwdStat: fs.Stats;
			try {
				cwdStat = await fs.promises.stat(commandCwd);
			} catch (err) {
				if (isEnoent(err)) {
					throw new ToolError(`Working directory does not exist: ${commandCwd}`);
				}
				throw err;
			}
			if (!cwdStat.isDirectory()) {
				throw new ToolError(`Working directory is not a directory: ${commandCwd}`);
			}
		}

		if (name !== undefined) {
			// The service is the session's shell as a process of its own: it starts from this
			// shell's exports, functions and aliases, with the host files behind its URL paths.
			const seed = await this.#sessionSeed(sessionId, hostCwd, signal);
			// Only a readiness wait can outlast a steer; without `ready` the start
			// returns once the process spawns.
			const service = await startService(
				this.session,
				{
					name,
					command,
					cwd: commandCwd,
					pty: pty ?? true,
					ready,
					notify: notifySource,
					env: { ...seed.env, ...sessionEnv },
					seed: (await shellMounts(sessionResolveContext(this.session), approvalTier)) + seed.script,
				},
				signal,
				ready === undefined ? undefined : ctx?.toolCall?.steeringSignal,
			);
			const daemon = service.daemon;
			const pid = daemon.pids[0];
			const notifyLine = service.notifyArmed ? notifyNotice : undefined;
			if (service.readyInterrupted) {
				// A queued message arrived mid-wait: return so it injects promptly.
				// The daemon keeps starting the service, inspectable via proc://.
				return {
					content: [
						{
							type: "text",
							text: `${name}: starting${pid === undefined ? "" : ` pid=${pid}`}\nReadiness wait interrupted early to handle an incoming message; the service is still starting and keeps running. Read proc://${name} for status.${notifyLine ? `\n${notifyLine}` : ""}`,
						},
					],
					details: { service: { name, state: daemon.state, ready: false, timedOut: false, pid } },
				};
			}
			const lines = [
				`${daemon.key}: ${daemon.state}${pid === undefined ? "" : ` pid=${pid}`}${daemon.readyAt === undefined ? "" : " ready"}`,
			];
			if (service.readyTimedOut)
				lines.push(
					`NOT ready — readiness timed out after ${ready?.timeout ?? 30}s; process state: ${daemon.state}.`,
				);
			if (daemon.exitReason) lines.push(`Reason: ${daemon.exitReason}`);
			lines.push(...pendingNotices);
			if (notifyLine) lines.push(notifyLine);
			const log = await serviceLogs(this.session, name, signal);
			if (log) lines.push(log);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					service: {
						name,
						state: daemon.state,
						ready: daemon.readyAt !== undefined || daemon.state === "running",
						timedOut: service.readyTimedOut,
						pid,
					},
				},
			};
		}

		// A timeout of 0 is an explicit long-running-command contract: the user
		// must still cancel the call or job, but OMP does not impose a deadline.
		const requestedTimeoutSec = rawTimeout ?? 300;
		const timeoutDisabled = requestedTimeoutSec === 0;
		const maxTimeout = cfgToolsMaxTimeout.get(this.session.settings);
		const timeoutSec = timeoutDisabled ? undefined : clampTimeout("bash", requestedTimeoutSec, maxTimeout);
		const timeoutMs = timeoutSec === undefined ? undefined : timeoutSec * 1000;
		if (timeoutSec !== undefined) {
			const timeoutClampNotice = formatTimeoutClampNotice(requestedTimeoutSec, timeoutSec, maxTimeout);
			if (timeoutClampNotice) pendingNotices.push(timeoutClampNotice);
		}

		if (asyncRequested) {
			if (!this.session.asyncJobManager) {
				throw new ToolError("Async job manager unavailable for this session.");
			}
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,
				onUpdate,
				foreground: false,
				approvalTier,
				sessionId,
				sessionEnv,
				intent: this.session.getToolCallIntent?.(toolCallId),
				toolCallId,
				notify,
			});
			return this.#buildBackgroundStartResult(job.jobId, "", timeoutSec, {
				requestedTimeoutSec,
				notices: notifyNotice ? [...pendingNotices, notifyNotice] : pendingNotices,
				trace: job.getLatestTrace(),
			});
		}

		// The client-bridge terminal provides a live terminal card in the editor;
		// when available it wins over auto-backgrounding (both are opt-in, and
		// auto-background would otherwise silently disable the terminal route).
		const clientBridge = this.session.getClientBridge?.();
		const bridgeTerminalAvailable = Boolean(
			clientBridge?.capabilities.terminal && clientBridge.createTerminal && !pty && virtualCwd === undefined,
		);

		const autoBgManager = this.session.asyncJobManager;
		// At the running-job cap, fall through to direct foreground execution
		// instead of failing every bash call until a slot frees up.
		if (
			cfgBashAutoBackgroundEnabled.get(this.session.settings) &&
			!pty &&
			!bridgeTerminalAvailable &&
			autoBgManager &&
			!autoBgManager.atCapacity
		) {
			const autoBackgroundWaitMs = resolveAutoBackgroundWaitMs(
				Math.floor(cfgBashAutoBackgroundThresholdMs.get(this.session.settings)),
				timeoutMs,
			);
			const startBackgrounded = autoBackgroundWaitMs === 0;
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,
				onUpdate,
				foreground: !startBackgrounded,
				approvalTier,
				sessionId,
				sessionEnv,
				intent: this.session.getToolCallIntent?.(toolCallId),
				toolCallId,
			});
			if (startBackgrounded) {
				return this.#buildBackgroundStartResult(job.jobId, "", timeoutSec, {
					requestedTimeoutSec,
					notices: pendingNotices,
					trace: job.getLatestTrace(),
				});
			}
			// The job was registered as foreground-backed: hidden from listings and
			// delivery-suppressed until backgroundJob() promotes it, so a command
			// finishing within the wait never surfaces as a background job.
			const waitResult = await raceJobSettlement(
				job.completion,
				autoBackgroundWaitMs,
				signal,
				ctx?.toolCall?.steeringSignal,
			);
			if (waitResult.kind === "completed") {
				autoBgManager.releaseForegroundJob(job.jobId);
				return waitResult.result;
			}
			if (waitResult.kind === "failed") {
				autoBgManager.releaseForegroundJob(job.jobId);
				throw waitResult.error;
			}
			if (waitResult.kind === "aborted") {
				autoBgManager.cancel(job.jobId);
				autoBgManager.releaseForegroundJob(job.jobId);
				throw new ToolAbortError(job.getLatestText() || "Command aborted");
			}
			job.background();
			autoBgManager.backgroundJob(job.jobId);
			// "steer": a queued user/peer message arrived mid-wait — background
			// the command (it keeps running) so the message injects promptly.
			// `job.notices` also carries the notices the run added so far.
			const notices =
				waitResult.kind === "steer"
					? [...job.notices, "Backgrounded early to handle an incoming message; the command keeps running."]
					: job.notices;
			return this.#buildBackgroundStartResult(job.jobId, job.getLatestText(), timeoutSec, {
				requestedTimeoutSec,
				notices,
				replies: job.replies,
				trace: job.getLatestTrace(),
			});
		}

		// Fold direnv/devenv env into (command, env) ONCE for the one backend
		// that runs outside the engine: the ACP client terminal. The
		// `executeBash` branch below is intentionally excluded: it runs its own
		// preflight internally, so routing the pre-applied command there too
		// would double-apply the unset prefix. No
		// `commandPrefix` here: ACP applies the shell prefix via
		// `wrapShellLineForClientTerminal`.
		// `callerTimeoutMs` clamps the direnv load to a positive command timeout
		// (the backend's own timeout is installed only after this await), matching
		// the executeBash branch so a cold `.envrc` can't outlast a short call.
		const backendPreflight = bridgeTerminalAvailable
			? await applyDirenvPreflight(
					// The client's shell knows no internal URL.
					await hostCommandUrls(
						command,
						urlBacking(this.#urlFilesystem(signal, { tier: approvalTier })),
						this.session.settings.getShellConfig().shell,
					),
					commandCwd,
					{
						callerEnv: sessionEnv,
						signal,
						timeoutMs: cfgBashDirenvLoadTimeoutMs.get(this.session.settings),
						callerTimeoutMs: timeoutMs,
						direnvSetting: cfgBashDirenv.get(this.session.settings),
					},
				)
			: undefined;

		// Route through the client terminal when the client advertises the terminal capability.
		// Skip when pty=true (PTY needs the local terminal UI) or the cwd is a URL
		// (only the embedded shell's filesystem can enter it).
		if (clientBridge?.capabilities.terminal && clientBridge.createTerminal && !pty && virtualCwd === undefined) {
			// Invariant (ACP terminal bridge): createTerminal has no signal in its
			// contract; allocation cannot be cancelled retroactively. Guard before
			// allocation. Shared timeout helper / pure AbortSignal fusion rejected:
			// we need explicit kill-before-read ordering and distinct abort vs
			// timeout result shapes. Per-route race retained for testability.
			if (signal?.aborted) {
				throw new ToolAbortError("Command aborted");
			}

			const bridgeWallTimeStart = performance.now();
			const bridgeGraphics = new TerminalSnapshotDecoder();
			const killGraceMs = 1000;
			const outputSnapshotGraceMs = 2000;
			// Cancellable timeout: a bare Bun.sleep(timeoutMs) would leave a live,
			// ref'd timer for the full command timeout after fast completions —
			// accumulating timers and delaying process shutdown in SDK/headless use.
			// `timeoutMs` is optional (#4642): without one, no timer is armed and
			// the promise simply never resolves.
			const { promise: timeoutPromise, resolve: resolveTimeout } = Promise.withResolvers<{
				kind: "timeout";
			}>();
			const timeoutTimer = timeoutMs ? setTimeout(() => resolveTimeout({ kind: "timeout" }), timeoutMs) : undefined;
			const { promise: abortedP, resolve: resolveAborted } = Promise.withResolvers<void>();
			let handle: ClientBridgeTerminalHandle | undefined;
			let killStarted = false;
			const fireKill = (): Promise<void> => {
				if (killStarted) return Promise.resolve();
				const currentHandle = handle;
				if (!currentHandle) return Promise.resolve();
				killStarted = true;
				return currentHandle.kill().catch((error: unknown) => {
					logger.warn("ACP terminal kill failed", { terminalId: currentHandle.terminalId, error });
				});
			};
			const cleanupLateCreate = (createP: Promise<ClientBridgeTerminalHandle>): void => {
				void createP
					.then(async lateHandle => {
						try {
							await lateHandle.kill();
						} catch (error) {
							logger.warn("ACP terminal kill failed", { terminalId: lateHandle.terminalId, error });
						}
						try {
							await lateHandle.release();
						} catch (error) {
							logger.warn("ACP terminal release failed", { terminalId: lateHandle.terminalId, error });
						}
					})
					.catch((error: unknown) => {
						logger.warn("ACP terminal create failed after cancellation", { error });
					});
			};
			const onAbortSignal = () => {
				resolveAborted();
				void fireKill();
			};
			signal?.addEventListener("abort", onAbortSignal, { once: true });

			try {
				// direnv-transformed command (carries any `unset -v` prefix) + direnv
				// env; falls back to the raw command when direnv is off/absent.
				const bridgeCommand = backendPreflight?.command ?? command;
				const bridgeEnv = backendPreflight?.env;
				const shellSpawn = wrapShellLineForClientTerminal(bridgeCommand, this.session.settings.getShellConfig());
				const createP = clientBridge.createTerminal({
					command: shellSpawn.command,
					args: shellSpawn.args,
					cwd: commandCwd,
					env: bridgeEnv
						? Object.entries(bridgeEnv).map(([name, value]) => ({ name, value: value as string }))
						: undefined,
					outputByteLimit: DEFAULT_MAX_BYTES,
				});
				const createRaced = await Promise.race([
					createP.then(createdHandle => ({ kind: "created" as const, handle: createdHandle })),
					timeoutPromise,
					abortedP.then(() => ({ kind: "aborted" as const })),
				]);
				if (createRaced.kind === "aborted" || signal?.aborted) {
					cleanupLateCreate(createP);
					throw new ToolAbortError("Command aborted");
				}
				if (createRaced.kind === "timeout") {
					cleanupLateCreate(createP);
					const timedOutResult: BashInteractiveResult = {
						output: "",
						exitCode: undefined,
						cancelled: false,
						timedOut: true,
						truncated: false,
						totalLines: 0,
						totalBytes: 0,
						outputLines: 0,
						outputBytes: 0,
					};
					return this.#buildCompletedResult(timedOutResult, timeoutSec, {
						command,
						cwd: commandCwd,
						requestedTimeoutSec,
						notices: pendingNotices,
						wallTimeMs: performance.now() - bridgeWallTimeStart,
						toolCallId,
					});
				}

				handle = createRaced.handle;

				// Emit partial update so the editor can embed the live terminal card.
				onUpdate?.({ content: [], details: { terminalId: handle.terminalId } });

				// Exit, timeout, and abort are each subscribed once and latch the first
				// outcome. Every wait below races only a fresh per-iteration promise, so
				// a long command does not pile reactions onto promises that stay pending.
				type BridgeOutcome =
					| { kind: "exit"; status: ClientBridgeTerminalExitStatus }
					| { kind: "timeout" }
					| { kind: "aborted" }
					| { kind: "failed"; error: unknown };
				// Held on an object: TypeScript would narrow a closure-assigned `let` to `undefined`.
				const bridge: { outcome?: BridgeOutcome; wake?: () => void } = {};
				const settle = (next: BridgeOutcome): void => {
					bridge.outcome ??= next;
					bridge.wake?.();
				};
				void handle.waitForExit().then(
					status => settle({ kind: "exit", status }),
					(error: unknown) => settle({ kind: "failed", error }),
				);
				void timeoutPromise.then(settle);
				void abortedP.then(() => settle({ kind: "aborted" }));
				let exitStatus!: ClientBridgeTerminalExitStatus;
				let lastPolledOutput: ClientBridgeTerminalOutput = { output: "", truncated: false };

				// Poll until the process exits, times out, or the caller aborts.
				for (;;) {
					if (!bridge.outcome) {
						// The sleep settles within one tick even when an outcome wakes us first.
						const tick = Promise.withResolvers<void>();
						bridge.wake = tick.resolve;
						void Bun.sleep(250).then(tick.resolve);
						await tick.promise;
					}
					const outcome = bridge.outcome;

					if (outcome?.kind === "failed") throw outcome.error;

					if (outcome?.kind === "aborted" || signal?.aborted) {
						await Promise.race([fireKill(), Bun.sleep(killGraceMs)]);
						throw new ToolAbortError("Command aborted");
					}

					if (outcome?.kind === "timeout") {
						// Kill before reading final output so a slow `terminal/output`
						// RPC cannot let a timed-out command keep running past the
						// enforced timeout. The handle stays valid post-kill so the
						// buffered output is still readable.
						await Promise.race([fireKill(), Bun.sleep(killGraceMs)]);
						let current = lastPolledOutput;
						try {
							current = await Promise.race([
								handle.currentOutput(),
								Bun.sleep(outputSnapshotGraceMs).then(() => lastPolledOutput),
							]);
						} catch (error) {
							logger.warn("ACP terminal final output read failed", {
								terminalId: handle.terminalId,
								error,
							});
						}
						const decoded = await bridgeGraphics.finish(current.output);
						const timedOutResult: BashInteractiveResult = {
							output: decoded.text,
							exitCode: undefined,
							cancelled: false,
							timedOut: true,
							truncated: current.truncated,
							totalLines: decoded.text.length > 0 ? decoded.text.split("\n").length : 0,
							totalBytes: decoded.text.length,
							outputLines: decoded.text.length > 0 ? decoded.text.split("\n").length : 0,
							outputBytes: decoded.text.length,
							...(decoded.images.length > 0 ? { images: decoded.images } : {}),
						};
						return this.#buildCompletedResult(timedOutResult, timeoutSec, {
							command,
							cwd: commandCwd,
							requestedTimeoutSec,
							notices: pendingNotices,
							wallTimeMs: performance.now() - bridgeWallTimeStart,
							toolCallId,
						});
					}

					if (outcome?.kind === "exit") {
						exitStatus = outcome.status;
						break;
					}

					// Poll tick: push current output so agent-loop transcript stays consistent.
					// Race the read against the outcomes so a stuck `terminal/output` RPC does
					// not delay cancellation or let the command outlive its deadline.
					const interrupted = Promise.withResolvers<undefined>();
					bridge.wake = () => interrupted.resolve(undefined);
					const pollOutput = await Promise.race([handle.currentOutput(), interrupted.promise]);
					if (pollOutput === undefined) {
						// An outcome landed during the poll-tick read; let the next loop
						// iteration exit via the matching branch.
						continue;
					}
					lastPolledOutput = pollOutput;
					onUpdate?.({
						content: [{ type: "text", text: bridgeGraphics.push(pollOutput.output) }],
						details: { terminalId: handle.terminalId },
					});
				}

				// Fetch final output; the terminal is released in the outer finally.
				let finalOutput = lastPolledOutput;
				try {
					finalOutput = await Promise.race([
						handle.currentOutput(),
						Bun.sleep(outputSnapshotGraceMs).then(() => lastPolledOutput),
					]);
				} catch (error) {
					logger.warn("ACP terminal final output read failed", {
						terminalId: handle.terminalId,
						error,
					});
				}

				// Map exit status: null exitCode with a signal → treat as signal kill (137).
				const rawExitCode = exitStatus.exitCode;
				const exitCode: number | undefined =
					rawExitCode != null ? rawExitCode : exitStatus.signal ? 137 : undefined;

				const decoded = await bridgeGraphics.finish(finalOutput.output);
				const outputText = decoded.text;
				const outputByteLen = outputText.length;
				const outputLineCount = outputText.length > 0 ? outputText.split("\n").length : 0;

				const bridgeResult: BashResult = {
					output: outputText,
					exitCode,
					cancelled: false,
					truncated: finalOutput.truncated,
					totalLines: outputLineCount,
					totalBytes: outputByteLen,
					outputLines: outputLineCount,
					outputBytes: outputByteLen,
					...(decoded.images.length > 0 ? { images: decoded.images } : {}),
				};

				const bridgeNotices: string[] = [];
				if (finalOutput.truncated) bridgeNotices.push("(output truncated)");
				for (const notice of pendingNotices) bridgeNotices.push(notice);

				return this.#buildCompletedResult(bridgeResult, timeoutSec, {
					command,
					cwd: commandCwd,
					requestedTimeoutSec,
					notices: bridgeNotices,
					wallTimeMs: performance.now() - bridgeWallTimeStart,
					toolCallId,
				});
			} finally {
				clearTimeout(timeoutTimer);
				signal?.removeEventListener("abort", onAbortSignal);
				if (handle) {
					const releaseHandle = handle;
					// Bound release like kill/output: a hung `terminal/release` RPC must not
					// keep the tool pending after the result is already decided.
					await Promise.race([
						releaseHandle.release().catch((error: unknown) => {
							logger.warn("ACP terminal release failed", { terminalId: releaseHandle.terminalId, error });
						}),
						Bun.sleep(killGraceMs),
					]);
				}
			}
		}

		// Allocate artifact for truncated output storage
		const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.()) ?? {};

		const interactiveUi = canUseInteractiveBashPty(pty === true, ctx) ? ctx?.ui : undefined;
		if (pty && !interactiveUi) {
			pendingNotices.push("pty requested but unavailable in this environment; ran without a terminal");
		}
		const wallTimeStart = performance.now();
		// Each frame of the card repeats the latest preview with the replies so far; the transcript draws the new ones.
		const replies: string[] = [];
		let preview = "";
		let trace: ShellTrace | undefined;
		const emitFrame = onUpdate
			? () =>
					onUpdate({
						content: [{ type: "text", text: preview }],
						details: {
							...(replies.length > 0 ? { replies: [...replies] } : {}),
							...(trace ? { trace } : {}),
						},
					})
			: undefined;
		const result: BashResult | BashInteractiveResult = interactiveUi
			? await this.#runOnTerminal(interactiveUi, {
					command,
					hostCwd,
					urlCwd: virtualCwd,
					sessionId,
					sessionEnv,
					timeoutMs,
					signal,
					mounts: await shellMounts(sessionResolveContext(this.session, { signal }), approvalTier),
					artifactPath,
					artifactId,
				})
			: // executeBash runs its OWN direnv preflight internally — pass the RAW
				// command here so the unset prefix is not applied twice.
				await executeBash(command, {
					cwd: commandCwd,
					env: sessionEnv,
					sessionKey: sessionId,
					minimize: !nativeShapingOff(this.session),
					isSessionCurrent: () => (this.session.getSessionId?.() ?? undefined) === sessionId,
					timeout: timeoutMs ?? 0,
					signal,
					gitGuard: cfgBashGitGuard.get(this.session.settings),
					ovnfs: ovnfsCommand(this.session.settings),
					filesystem: this.#urlFilesystem(signal, {
						tier: approvalTier,
						onReply: text => {
							replies.push(text);
							emitFrame?.();
						},
						onWrite: noticeUrlWrites(pendingNotices),
						toolCallId,
					}).shellFilesystem(),
					speech: sessionShellSpeech(this.session),
					artifactPath,
					artifactId,
					// Stream the sink's own inline view rather than re-buffering chunks.
					onPreview: emitFrame
						? text => {
								preview = text;
								emitFrame();
							}
						: undefined,
					onTrace:
						emitFrame && cfgDisplayShellVisualization.get(this.session.settings)
							? next => {
									trace = next;
									emitFrame();
								}
							: undefined,
					onMinimizedSave: originalText => saveBashOriginalArtifact(this.session, originalText),
				});
		const wallTimeMs = performance.now() - wallTimeStart;
		if (result.cancelled) {
			// A cancelled result is either a timeout (the command's deadline fired)
			// or a user/system abort. Timeouts are handled by #buildCompletedResult
			// which returns a non-throwing error result with details.timedOut=true
			// so the renderer can show a warning border instead of error red.
			// Both interactive and non-interactive results carry an explicit
			// `timedOut` field from the executor/PTY layer.
			const isTimeout = result.timedOut === true;
			if (!isTimeout) {
				const out = normalizeResultOutput(result);
				// The local executor already prepends `[Command cancelled]`; PTY
				// output does not, so preserve one cancellation notice in either case.
				let message = out.startsWith("[Command cancelled]")
					? out
					: out
						? `${out}\n\n[Command aborted]`
						: "Command aborted";
				if (result.artifactError) message += `\n\n[${formatArtifactErrorNotice(result.artifactError)}]`;
				if (signal?.aborted) {
					throw new ToolAbortError(message);
				}
				throw new ToolError(message);
			}
		}
		return this.#buildCompletedResult(result, timeoutSec, {
			command,
			cwd: commandCwd,
			requestedTimeoutSec,
			notices: pendingNotices,
			wallTimeMs,
			replies,
			toolCallId,
		});
	}
}
