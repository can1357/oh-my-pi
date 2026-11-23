/**
 * Staged-action commands: one string argument each, runnable as a bash
 * command (`resolve "<reason>"`) or, without the bash tool, as a top-level tool.
 *
 *   resolve <reason>  → APPLY the pending staged preview
 *   reject <reason>   → DISCARD the pending staged preview
 *   propose <title>   → submit the plan for approval (plan mode)
 *
 * Nothing rides the system prompt: the flows that stage work teach the call
 * shape at the moment it becomes relevant (the preview reminder for
 * resolve/reject, the plan-mode prompt for propose).
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, CustomMessage } from "@oh-my-pi/pi-agent-core";
import {
	PROPOSE_COMMAND_NAME,
	REJECT_COMMAND_NAME,
	RESOLVE_COMMAND_NAME,
	type ResolveAction,
	type ResolveDetails,
	type ResolveInvocation,
} from "@oh-my-pi/pi-tui/tools/resolve";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import resolveReminderPrompt from "../prompts/system/resolve-reminder.md" with { type: "text" };
import resolveUnsatisfiedPrompt from "../prompts/system/resolve-unsatisfied.md" with { type: "text" };
import type { Tool, ToolSession } from ".";
import { createReportIssueTool, isAutoQaEnabled } from "./report-tool-issue";
import { toolCommandCallName, toolCommandDispatches } from "./tool-commands";

/**
 * Model-visible banner prepended to a staged preview's tool result text. The
 * TUI badge (`⟨proposed⟩`) never reaches the model, and preview diffs are
 * byte-identical to applied-edit output — without this line the model reads
 * the result as an already-applied change.
 */
export const PREVIEW_PENDING_NOTICE =
	"Staged as a proposal — files NOT modified yet. To apply: `resolve <one-sentence reason>`. To discard: `reject <one-sentence reason>`.";

/** Handler installed by plan mode; `propose` hands the plan title to it. */
export type PlanProposalHandler = (title: string) => Promise<AgentToolResult<unknown>>;

/** A (possibly partial) assistant tool call. */
type ToolCallLike = { name: string; arguments?: Record<string, unknown> };

/** Command a tool call runs: its own name for a direct call, the leading command word of a `bash` call. */
function invokedCommandName(toolCall: ToolCallLike): string {
	return toolCommandCallName(toolCall) ?? toolCall.name;
}

/**
 * Whether an assistant tool call runs `resolve` or `reject`, directly or as a
 * `bash` command. Used as the SoftToolRequirement compliance check while a
 * preview is pending — any other call resolves nothing.
 */
export function isPreviewResolutionToolCall(toolCall: ToolCallLike): boolean {
	const name = invokedCommandName(toolCall);
	return name === RESOLVE_COMMAND_NAME || name === REJECT_COMMAND_NAME;
}

/** Whether an assistant tool call runs `propose`, directly or as a `bash` command (plan-mode decision detection). */
export function isProposeToolCall(toolCall: ToolCallLike): boolean {
	return invokedCommandName(toolCall) === PROPOSE_COMMAND_NAME;
}

/** Parse resolve/reject details out of an arbitrary details value. */
function parseResolveDetails(value: unknown): ResolveDetails | undefined {
	if (!value || typeof value !== "object") return undefined;
	const action = "action" in value ? value.action : undefined;
	const reason = "reason" in value ? value.reason : undefined;
	if ((action !== "apply" && action !== "discard") || typeof reason !== "string") return undefined;
	return {
		action,
		reason,
		...("sourceToolName" in value && typeof value.sourceToolName === "string"
			? { sourceToolName: value.sourceToolName }
			: {}),
		...("label" in value && typeof value.label === "string" ? { label: value.label } : {}),
		...("sourceResultDetails" in value ? { sourceResultDetails: value.sourceResultDetails } : {}),
	};
}

/**
 * Resolution details of a completed `resolve`/`reject`: read from a direct
 * tool result, or from the last `resolve`/`reject` dispatch recorded on a
 * `bash` result.
 */
export function resolveDispatchDetails(toolName: string, result: unknown): ResolveDetails | undefined {
	if (toolName === RESOLVE_COMMAND_NAME || toolName === REJECT_COMMAND_NAME) {
		if (!result || typeof result !== "object" || !("details" in result)) return undefined;
		return parseResolveDetails(result.details);
	}
	for (const dispatch of toolCommandDispatches(toolName, result).toReversed()) {
		if (dispatch.mode !== "execute") continue;
		if (dispatch.tool !== RESOLVE_COMMAND_NAME && dispatch.tool !== REJECT_COMMAND_NAME) continue;
		const details = parseResolveDetails(dispatch.inner);
		if (details) return details;
	}
	return undefined;
}

/**
 * Details of a plan submission: the result details of a direct successful
 * `propose` call, or the `inner` details of the last successful `propose`
 * execution recorded on a `bash` result; `undefined` when the result submitted
 * no plan.
 */
export function proposeDispatchDetails(toolName: string, result: unknown): unknown {
	if (toolName === PROPOSE_COMMAND_NAME) {
		if (!result || typeof result !== "object" || !("details" in result)) return undefined;
		if ("isError" in result && result.isError === true) return undefined;
		return result.details;
	}
	for (const dispatch of toolCommandDispatches(toolName, result).toReversed()) {
		if (dispatch.tool === PROPOSE_COMMAND_NAME && dispatch.mode === "execute" && dispatch.exitCode === 0) {
			return dispatch.inner;
		}
	}
	return undefined;
}

/** Monotonic suffix making each staged preview's pending-invoker id UNIQUE, so
 *  stacked previews never clobber one another by label. */
let pendingPreviewSeq = 0;

/** Whether a queued invoker input is a resolve/reject invocation. */
function isResolveInvocation(input: unknown): input is ResolveInvocation {
	if (!input || typeof input !== "object") return false;
	const action = "action" in input ? input.action : undefined;
	return (action === "apply" || action === "discard") && "reason" in input && typeof input.reason === "string";
}

/** Whether a pending invoker produced a tool result. */
function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
	return !!value && typeof value === "object" && "content" in value && Array.isArray(value.content);
}

/**
 * Register a non-forcing resolve-protocol handler for a staged preview. Wraps the
 * caller's apply/reject into an onInvoked closure and stores it on the tool-choice
 * queue's pending-invoker registry under a UNIQUE id. `resolve` or `reject`
 * dispatches to it; the agent-loop's SoftToolRequirement lifecycle injects the
 * preview reminder and escalates to a forced call only if the model declines —
 * so a compliant turn pays ZERO tool_choice change (no prompt-cache
 * messages-cache invalidation).
 *
 * This is the canonical entry point for any tool that wants preview/apply
 * semantics. No session-level abstraction is needed: callers pass their
 * apply/reject functions directly.
 */
export function queueResolveHandler(
	session: ToolSession,
	options: {
		label: string;
		sourceToolName: string;
		apply(reason: string): Promise<AgentToolResult<unknown>>;
		reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
	},
): void {
	const queue = session.getToolChoiceQueue?.();
	if (!queue) return;

	// Unique per preview: stacked/sequential previews each get their own entry.
	const id = `pending-action:${options.sourceToolName}:${pendingPreviewSeq++}`;

	const onInvoked = async (input: unknown): Promise<AgentToolResult<unknown>> => {
		if (!isResolveInvocation(input)) throw new ToolError("Invalid resolution: expected an action and a reason.");
		const result = await runResolveInvocation(input, {
			sourceToolName: options.sourceToolName,
			label: options.label,
			apply: options.apply,
			reject: options.reject,
			onApplyError: () => {
				// Apply threw (e.g. ast_edit overlapping replacements). Keep the preview
				// pending under the SAME id so the model can reject or fix-and-retry;
				// runResolveInvocation rethrows, so the success-path removal below is skipped.
				queue.registerPendingInvoker(id, options.sourceToolName, onInvoked);
			},
		});
		// Resolved (apply succeeded, or discard): consume the staged action exactly once.
		queue.removePendingInvoker(id);
		return result;
	};

	// NON-FORCING: register so `resolve`/`reject` can dispatch here WITHOUT
	// changing tool_choice. The agent-loop injects the reminder (from the
	// SoftToolRequirement the session builds) and forces a call only on
	// non-compliance.
	queue.registerPendingInvoker(id, options.sourceToolName, onInvoked);
}

/**
 * The canonical preview reminder. The resolve mechanism owns the wording; the
 * agent-loop delivers it via the session's `SoftToolRequirement.reminder` (injected
 * once per pending-preview head) instead of a host-side steer, so it lands as a
 * stable mid-history append and never churns the cached prefix.
 */
export function buildResolveReminderMessage(
	session: Pick<ToolSession, "toolCommands">,
	sourceToolName: string,
): CustomMessage {
	return {
		role: "custom",
		customType: "resolve-reminder",
		content: prompt
			.render(resolveReminderPrompt, {
				toolName: sourceToolName,
				isCommand: session.toolCommands !== undefined,
				bashToolName: "bash",
			})
			.trim(),
		display: false,
		details: { toolName: sourceToolName },
		attribution: "agent",
		timestamp: Date.now(),
	};
}

/**
 * Skipped-result notice for a `bash` call made while a preview is pending that
 * does not run `resolve` or `reject`: names the command it ran, when that is a
 * session tool command, and the command that finalizes the preview.
 */
export function buildResolveUnsatisfiedNotice(toolCall: ToolCallLike, sourceToolName: string): string {
	return prompt
		.render(resolveUnsatisfiedPrompt, {
			toolName: sourceToolName,
			transportToolName: toolCall.name,
			invokedCommand: toolCommandCallName(toolCall),
		})
		.trim();
}

/**
 * Invocation runner for queued pending-preview handlers. Discriminates on
 * action, routes through the caller's apply/reject, and wraps the resulting
 * tool payload with `ResolveDetails` so the renderer and event-controller see
 * a consistent shape.
 */
async function runResolveInvocation(
	params: ResolveInvocation,
	options: {
		sourceToolName: string;
		label: string;
		apply(reason: string): Promise<AgentToolResult<unknown>>;
		reject?(reason: string): Promise<AgentToolResult<unknown> | undefined>;
		/** Invoked synchronously when `apply()` throws, before the error is rethrown.
		 *  The queued caller uses this to re-push the pending invoker so the
		 *  pending preview survives a failed apply (e.g. overlapping ast_edit
		 *  replacements) and the model can reject or fix-and-retry. */
		onApplyError?(error: unknown): void;
	},
): Promise<AgentToolResult<ResolveDetails>> {
	const baseDetails: ResolveDetails = {
		action: params.action,
		reason: params.reason,
		sourceToolName: options.sourceToolName,
		label: options.label,
	};
	if (params.action === "apply") {
		let result: AgentToolResult<unknown>;
		try {
			result = await options.apply(params.reason);
		} catch (error) {
			try {
				options.onApplyError?.(error);
			} catch {
				// Requeue hook must not mask the original apply failure.
			}
			if (error instanceof ToolError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			throw new ToolError(`Apply failed: ${message}`);
		}
		return {
			...result,
			details: {
				...baseDetails,
				...(result.details != null ? { sourceResultDetails: result.details } : {}),
			},
		};
	}
	if (options.reject != null) {
		const result = await options.reject(params.reason);
		if (result != null) {
			return {
				...result,
				details: {
					...baseDetails,
					...(result.details != null ? { sourceResultDetails: result.details } : {}),
				},
			};
		}
	}
	return {
		content: [{ type: "text" as const, text: `Discarded: ${options.label}. Reason: ${params.reason}` }],
		details: baseDetails,
	};
}

/**
 * Apply or discard the pending staged action (in-flight queue directive first).
 * Discarding with nothing pending succeeds: the "no staged change" end-state
 * already holds. Applying with nothing pending fails.
 */
async function resolvePendingAction(
	session: ToolSession,
	action: ResolveAction,
	rawReason: string,
): Promise<AgentToolResult<unknown>> {
	const reason = rawReason.trim();
	const invoker = session.peekQueueInvoker?.() ?? session.peekPendingInvoker?.();
	if (!invoker) {
		session.clearPendingInvokers?.();
		const proposeHint = session.peekPlanProposalHandler?.()
			? ` To submit the plan for approval, use \`${PROPOSE_COMMAND_NAME}\` with its title instead.`
			: "";
		if (action === "discard") {
			const details: ResolveDetails = { action, reason };
			return {
				content: [{ type: "text", text: `Nothing to reject; no pending action remains.${proposeHint}` }],
				details,
			};
		}
		throw new ToolError(
			`No pending action to apply — \`${RESOLVE_COMMAND_NAME}\` is only valid while a staged preview is pending.${proposeHint}`,
		);
	}
	const invocation: ResolveInvocation = { action, reason };
	const result = await invoker(invocation);
	if (!isAgentToolResult(result)) throw new ToolError("The pending action returned no result.");
	return result;
}

const resolveSchema = type({
	reason: type("string").describe("One-sentence reason for applying the pending staged action."),
	"+": "reject",
});

const rejectSchema = type({
	reason: type("string").describe("One-sentence reason for discarding the pending staged action."),
	"+": "reject",
});

const proposeSchema = type({
	title: type("string").describe("Plan slug matching local://<slug>-plan.md."),
	"+": "reject",
});

/** `resolve <reason>`: apply the pending staged action. */
function createResolveTool(session: ToolSession): AgentTool<typeof resolveSchema> {
	return {
		name: RESOLVE_COMMAND_NAME,
		label: "Resolve",
		summary: "Apply the pending staged action",
		description: "Apply the pending staged action (e.g. a tool preview), giving a one-sentence reason.",
		parameters: resolveSchema,
		strict: true,
		intent: "omit",
		approval: "read",
		async execute(_toolCallId, params) {
			return resolvePendingAction(session, "apply", params.reason);
		},
	};
}

/** `reject <reason>`: discard the pending staged action. */
function createRejectTool(session: ToolSession): AgentTool<typeof rejectSchema> {
	return {
		name: REJECT_COMMAND_NAME,
		label: "Reject",
		summary: "Discard the pending staged action",
		description: "Discard the pending staged action (e.g. a tool preview), giving a one-sentence reason.",
		parameters: rejectSchema,
		strict: true,
		intent: "omit",
		approval: "read",
		async execute(_toolCallId, params) {
			return resolvePendingAction(session, "discard", params.reason);
		},
	};
}

/** `propose <title>`: submit the plan for approval while plan mode is active. */
function createProposeTool(session: ToolSession): AgentTool<typeof proposeSchema> {
	return {
		name: PROPOSE_COMMAND_NAME,
		label: "Propose",
		summary: "Submit the plan for approval",
		description:
			"Submit the plan for approval by its <slug> (matching local://<slug>-plan.md). Valid only while plan mode is active.",
		parameters: proposeSchema,
		strict: true,
		intent: "omit",
		approval: "read",
		async execute(_toolCallId, params) {
			const handler = session.peekPlanProposalHandler?.();
			if (!handler) {
				throw new ToolError(
					`No plan is awaiting approval — \`${PROPOSE_COMMAND_NAME}\` only accepts a plan title while plan mode is active.`,
				);
			}
			return handler(params.title.trim());
		},
	};
}

/**
 * Tools behind the plain-text special commands this session supports: `resolve`,
 * `reject`, `propose`, and `report_issue` (when Auto-QA is enabled). Each has one
 * required string field, so the CLI form is `resolve "<reason>"`. The set is stable
 * for the session; a command with nothing to act on fails with a message.
 */
export function specialToolCommands(session: ToolSession): Tool[] {
	const tools: Tool[] = [createResolveTool(session), createRejectTool(session), createProposeTool(session)];
	if (isAutoQaEnabled(session.settings)) tools.push(createReportIssueTool(session));
	return tools;
}
