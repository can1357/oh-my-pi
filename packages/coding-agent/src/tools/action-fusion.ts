/**
 * Minimal Action Fusion: optional `then_run` on write/edit.
 *
 * The approval wrapper preflights, strips `then_run`, applies the mutation,
 * then runs the original command through the full Bash wrapper gate under
 * {@link withFollowUpVerification}. Native write/edit fail closed if `then_run`
 * reaches them. Not a generic tool dispatcher.
 *
 * JSON schemas (write, replace, patch, hashline, sloppy, apply_patch) carry
 * `then_run`. Raw Lark grammar cannot encode the field; the wrapper still
 * accepts JSON hashline `{ input, then_run }` without a native grammar change
 * because `then_run` is stripped before EditSession sees the payload.
 */
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import { isRecord } from "@oh-my-pi/pi-utils";
import { parseArchivePathCandidates } from "@oh-my-pi/pi-utils/ar";
import { parseXdUrl } from "@oh-my-pi/pi-tui/tools/xd-url";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { getLspBatchRequest } from "../lsp/batch";
import { denyError, resolveApproval, resolveApprovalFromContext } from "./approval";
import { parseConflictUri } from "./conflict-detect";
import { isInternalUrlPath, pathTargetsSsh, peelWriteUrlSelector } from "./path-utils";
import { unwrapHashlineHeaderPath } from "./plan-mode-guard";
import { parseSqlitePathCandidates } from "./sqlite-reader";
import { ToolAbortError } from "./tool-errors";

/** Follow-up bash timeout cap; Bash also clamps and may lower via tools.maxTimeout. */
export const THEN_RUN_MAX_TIMEOUT_SEC = 60;

export const FUSION_TOOL_NAMES: Record<string, true> = { write: true, edit: true };

export const THEN_RUN_SCHEMA_DESCRIPTION =
	"Optional shell command to run after this local filesystem mutation succeeds. Uses the bash tool with independent full approval — write/edit approval and inherited xd:// or ACP grants do not authorize it. The original command is sent to bash unchanged. " +
	"Rejected before any mutation for xd://, ssh://, archive members, sqlite rows, other internal URLs, and ACP/client-bridge remote filesystem or terminal sessions. " +
	"Not allowed on a non-final write/edit in the same tool-call batch: only the last write/edit in that batch may set then_run, after that call's LSP diagnostics flush. There is no deferred multi-call queue. " +
	"JSON hashline/sloppy/apply_patch schemas accept then_run; the raw Lark grammar payload cannot encode it. " +
	"Outcomes: pass, fail, cancel, timed_out, skipped. Verification failure, cancel, or timeout keeps the applied mutation and diff. Mutation failure skips verification.";

export const thenRunFieldSchema = type("string").describe(THEN_RUN_SCHEMA_DESCRIPTION);

export const NATIVE_THEN_RUN_MESSAGE =
	"then_run cannot be executed by the native write/edit tool. Direct native calls fail closed rather than silently ignoring follow-up verification. then_run runs only through the approval wrapper after a successful local mutation.";

export const GRAMMAR_THEN_RUN_MESSAGE =
	"The raw hashline/sloppy/apply_patch grammar cannot encode then_run. Pass then_run as a JSON field alongside `input` (default hashline JSON schema supports it); the wrapper strips it before native apply.";

export const THEN_RUN_BATCH_MESSAGE =
	"then_run is not allowed on a non-final write/edit in the same tool-call batch. Only the last write/edit in that batch may set then_run, after that call's LSP diagnostics flush. There is no deferred multi-call queue.";

export const THEN_RUN_MISSING_BASH_MESSAGE =
	"then_run requires the bash tool in this session. Follow-up verification is fail-closed when bash is unavailable.";

export const THEN_RUN_SKIPPED_REASON = "mutation failed; verification not run";

const USER_DENIED_PREFIX = "Tool call denied by user:";
const NO_UI_APPROVAL_SNIPPET = "requires approval but no interactive UI available";

export type ThenRunOutcome = "pass" | "fail" | "cancel" | "timed_out" | "skipped";

export interface ThenRunReport {
	outcome: ThenRunOutcome;
	content: string;
	details?: unknown;
	reason?: string;
}

/** Verification metadata attached onto write/edit details without changing TUI types. */
export type ThenRunAttachment = {
	outcome: ThenRunOutcome;
	content: string;
	details?: unknown;
	reason?: string;
};

export type WithThenRunDetails<TDetails> = TDetails & { thenRun: ThenRunAttachment };

export interface PreparedThenRun {
	command: string;
	mutationParams: Record<string, unknown>;
}

export interface ThenRunRunner {
	getFollowUpBashTool(): AgentTool | undefined;
	sessionSettings?: { get(key: string): unknown };
}

type ClientBridgeLike = {
	capabilities?: { writeTextFile?: boolean; terminal?: boolean };
	writeTextFile?: unknown;
	createTerminal?: unknown;
};

type SessionLike = {
	getClientBridge?: () => ClientBridgeLike | undefined;
};

function sessionOf(tool: AgentTool | undefined): SessionLike | undefined {
	if (!tool || !("session" in tool)) return undefined;
	const session = tool.session;
	return session && typeof session === "object" ? (session as SessionLike) : undefined;
}

export function hasThenRun(params: unknown): boolean {
	return isRecord(params) && Object.hasOwn(params, "then_run") && params.then_run !== undefined;
}

/** Original command string, or undefined when then_run is absent. Invalid shapes fail closed. */
export function extractThenRunCommand(params: unknown): string | undefined {
	if (!isRecord(params) || !Object.hasOwn(params, "then_run") || params.then_run === undefined) {
		return undefined;
	}
	if (typeof params.then_run !== "string") {
		throw new ToolError("then_run must be a shell command string");
	}
	if (params.then_run.trim().length === 0) {
		throw new ToolError("then_run must be a non-empty shell command");
	}
	return params.then_run;
}

export function stripThenRun(params: unknown): Record<string, unknown> {
	if (!isRecord(params)) return {};
	const { then_run: _thenRun, ...rest } = params;
	return rest;
}

export function assertNativeThenRunForbidden(params: unknown): void {
	if (!hasThenRun(params)) return;
	throw new ToolError(NATIVE_THEN_RUN_MESSAGE);
}

function mutationPaths(tool: AgentTool, params: unknown): string[] {
	try {
		const paths = tool.matcherPaths?.(params);
		if (paths && paths.length > 0) return [...paths];
	} catch {
		// Native inspect may reject partial args; fall through to `path`.
	}
	if (isRecord(params) && typeof params.path === "string" && params.path.length > 0) {
		return [params.path];
	}
	return [];
}

export function thenRunUnsupportedTargetReason(rawPath: string): string | undefined {
	const target = peelWriteUrlSelector(unwrapHashlineHeaderPath(rawPath));
	if (parseXdUrl(target)) {
		return "then_run is not supported for xd:// device writes; follow-up verification only runs after local filesystem mutations.";
	}
	if (pathTargetsSsh(target)) {
		return "then_run is not supported for ssh:// paths; remote writes must not be verified by a local shell.";
	}
	if (parseConflictUri(target)) {
		return "then_run is not supported for conflict:// writes.";
	}
	if (isInternalUrlPath(target)) {
		return `then_run is not supported for internal URL writes (${target.split(":")[0]}://); follow-up verification only runs after local filesystem mutations.`;
	}
	if (parseArchivePathCandidates(target).some(candidate => candidate.archivePath !== target)) {
		return "then_run is not supported for archive member writes.";
	}
	if (parseSqlitePathCandidates(target).some(candidate => candidate.sqlitePath !== target)) {
		return "then_run is not supported for sqlite row writes.";
	}
	return undefined;
}

export function thenRunUnsupportedSessionReason(session: SessionLike | undefined): string | undefined {
	const bridge = session?.getClientBridge?.();
	if (!bridge) return undefined;
	if (bridge.capabilities?.writeTextFile && bridge.writeTextFile) {
		return "then_run is not supported in ACP/client-bridge filesystem sessions; a remote write must not be verified by a local shell.";
	}
	if (bridge.capabilities?.terminal && bridge.createTerminal) {
		return "then_run is not supported in ACP/client-bridge terminal sessions; follow-up verification is fail-closed rather than silently running locally.";
	}
	return undefined;
}

function firstText(result: AgentToolResult<unknown>): string {
	const parts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

export function formatThenRunReport(report: ThenRunReport): string {
	const lines = [`then_run: ${report.outcome}`];
	if (report.reason) lines.push(report.reason);
	if (report.content) lines.push(report.content);
	return lines.join("\n");
}

export function skippedThenRunReport(): ThenRunReport {
	return { outcome: "skipped", content: "", reason: THEN_RUN_SKIPPED_REASON };
}

export function thenRunReportFromResult(result: AgentToolResult<{ timedOut?: boolean } | undefined>): ThenRunReport {
	const content = firstText(result);
	if (result.details && typeof result.details === "object" && result.details.timedOut === true) {
		return { outcome: "timed_out", content, details: result.details };
	}
	if (result.isError === true) {
		return { outcome: "fail", content, details: result.details };
	}
	return { outcome: "pass", content, details: result.details };
}

export function thenRunReportFromError(error: unknown, signal?: AbortSignal): ThenRunReport {
	const message = error instanceof Error ? error.message : String(error);
	const aborted =
		signal?.aborted === true ||
		error instanceof ToolAbortError ||
		(error instanceof Error && error.name === "AbortError");
	const denied =
		error instanceof Error &&
		(error.message.startsWith(USER_DENIED_PREFIX) || error.message.includes(NO_UI_APPROVAL_SNIPPET));
	if (aborted || denied) {
		return { outcome: "cancel", content: message, reason: message };
	}
	return { outcome: "fail", content: message, reason: message };
}

export function followUpBashContext(context: AgentToolContext | undefined): AgentToolContext | undefined {
	if (!context) return undefined;
	const next = { ...context };
	delete next.xdevApproved;
	delete next.acpApprovedArgs;
	delete next.toolCall;
	return next;
}

export function followUpBashArgs(command: string): { command: string; timeout: number } {
	return { command, timeout: THEN_RUN_MAX_TIMEOUT_SEC };
}

export function attachThenRun<TDetails>(
	result: AgentToolResult<TDetails>,
	report: ThenRunReport,
): AgentToolResult<TDetails> {
	const text = formatThenRunReport(report);
	const thenRun: ThenRunAttachment = {
		outcome: report.outcome,
		content: report.content,
		...(report.details !== undefined ? { details: report.details } : {}),
		...(report.reason ? { reason: report.reason } : {}),
	};
	const base = isRecord(result.details) ? result.details : {};
	return {
		...result,
		content: [...result.content, { type: "text", text }],
		details: { ...base, thenRun } as TDetails,
	};
}

/**
 * Extract `then_run`, reject unsupported/batch/deny cases, and return stripped
 * mutation params. Throws before the caller mutates. `undefined` when absent.
 * Hashline JSON `{ input, then_run }` is supported; inspect uses stripped params
 * so native grammar never sees `then_run`.
 */
export function prepareThenRunFusion(options: {
	tool: AgentTool;
	params: unknown;
	runner: ThenRunRunner;
	context?: AgentToolContext;
}): PreparedThenRun | undefined {
	if (!FUSION_TOOL_NAMES[options.tool.name]) return undefined;
	const command = extractThenRunCommand(options.params);
	if (command === undefined) return undefined;

	const mutationParams = stripThenRun(options.params);

	const batch = getLspBatchRequest(options.context?.toolCall);
	if (batch && batch.flush === false) {
		throw new ToolError(THEN_RUN_BATCH_MESSAGE);
	}

	const paths = mutationPaths(options.tool, mutationParams);
	if (paths.length === 0) {
		throw new ToolError(
			"then_run requires a local filesystem path on write/edit. Follow-up verification is fail-closed when the mutation target cannot be confirmed.",
		);
	}
	for (const mutationPath of paths) {
		const reason = thenRunUnsupportedTargetReason(mutationPath);
		if (reason) throw new ToolError(reason);
	}

	const bash = options.runner.getFollowUpBashTool();
	if (!bash) {
		throw new ToolError(THEN_RUN_MISSING_BASH_MESSAGE);
	}

	const session = sessionOf(options.tool) ?? sessionOf(bash);
	const remoteReason = thenRunUnsupportedSessionReason(session);
	if (remoteReason) throw new ToolError(remoteReason);

	const { approvalMode, userPolicies } = resolveApprovalFromContext(
		options.context ?? (options.runner.sessionSettings ? { settings: options.runner.sessionSettings } : undefined),
	);
	const resolved = resolveApproval(bash, { command }, approvalMode, userPolicies);
	if (resolved.policy === "deny") {
		throw denyError(resolved, "bash");
	}

	return { command, mutationParams };
}
