/**
 * Resolution devices: staged work is finalized through plain-text writes to
 * always-available `xd://` URLs — no tool schema, no JSON protocol.
 *
 *   write xd://resolve   reason text  → APPLY the pending staged preview
 *   write xd://reject    reason text  → DISCARD the pending staged preview
 *   write xd://propose   plan <slug>  → submit the plan for approval (plan mode)
 *
 * Nothing rides the system prompt: the flows that stage work teach the call
 * shape at the moment it becomes relevant (the preview reminder for
 * resolve/reject, the plan-mode prompt for propose).
 *
 * Rendering rides the write tool's xd:// delegation: renderers.ts keys the
 * resolve renderer under `resolve` and `reject` so device writes and legacy
 * `resolve` tool transcripts draw the same block.
 */
import type { AgentToolResult, CustomMessage } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { parseXdUrl, XD_URL_PREFIX } from "../internal-urls/xd-protocol";
import type { Theme } from "../modes/theme/theme";
import resolveReminderPrompt from "../prompts/system/resolve-device-reminder.md" with { type: "text" };
import { Ellipsis, padToWidth, renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { replaceTabs } from "./render-utils";
import { ToolError } from "./tool-errors";
import type { XdevDispatch } from "./xdev";

export const RESOLVE_DEVICE_NAME = "resolve";
export const REJECT_DEVICE_NAME = "reject";
export const PROPOSE_DEVICE_NAME = "propose";

/** The plain-text resolution device URLs (`xd://resolve`, …). */
export const RESOLVE_DEVICE_PATH = `${XD_URL_PREFIX}${RESOLVE_DEVICE_NAME}`;
export const REJECT_DEVICE_PATH = `${XD_URL_PREFIX}${REJECT_DEVICE_NAME}`;
export const PROPOSE_DEVICE_PATH = `${XD_URL_PREFIX}${PROPOSE_DEVICE_NAME}`;

/**
 * Model-visible banner prepended to a staged preview's tool result text. The
 * TUI badge (`⟨proposed⟩`) never reaches the model, and preview diffs are
 * byte-identical to applied-edit output — without this line the model reads
 * the result as an already-applied change.
 */
export const PREVIEW_PENDING_NOTICE = `Staged as a proposal — files NOT modified yet. To apply: write a one-sentence reason to ${RESOLVE_DEVICE_PATH}. To discard: write to ${REJECT_DEVICE_PATH}.`;

export type ResolutionDeviceName = typeof RESOLVE_DEVICE_NAME | typeof REJECT_DEVICE_NAME | typeof PROPOSE_DEVICE_NAME;

/** Whether an xd:// device name is one of the plain-text resolution devices. */
export function isResolutionDeviceName(name: string): name is ResolutionDeviceName {
	return name === RESOLVE_DEVICE_NAME || name === REJECT_DEVICE_NAME || name === PROPOSE_DEVICE_NAME;
}

/** One-line usage string returned by `read xd://<device>` — the only "docs" these devices carry. */
export function resolutionDeviceUsage(device: ResolutionDeviceName): string {
	switch (device) {
		case RESOLVE_DEVICE_NAME:
			return `Write a one-sentence reason as plain text to ${RESOLVE_DEVICE_PATH} to APPLY the pending staged action (e.g. a tool preview).`;
		case REJECT_DEVICE_NAME:
			return `Write a one-sentence reason as plain text to ${REJECT_DEVICE_PATH} to DISCARD the pending staged action (e.g. a tool preview).`;
		case PROPOSE_DEVICE_NAME:
			return `Write your plan's <slug> (matching local://<slug>-plan.md) as plain text to ${PROPOSE_DEVICE_PATH} to submit the plan for approval. Valid only while plan mode is active.`;
	}
}

/** Path of a (possibly partial) write tool call, or undefined. */
function toolCallWritePath(toolCall: { name: string; arguments?: Record<string, unknown> }): string | undefined {
	if (toolCall.name !== "write") return undefined;
	const args = toolCall.arguments;
	return typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : undefined;
}

/**
 * Whether an assistant tool call is a `write` targeting `xd://resolve` or
 * `xd://reject`. Used as the SoftToolRequirement compliance check while a
 * preview is pending — a plain `write` elsewhere resolves nothing.
 */
export function isPreviewResolutionToolCall(toolCall: { name: string; arguments?: Record<string, unknown> }): boolean {
	const path = toolCallWritePath(toolCall);
	if (path === undefined) return false;
	const device = parseXdUrl(path)?.name;
	return device === RESOLVE_DEVICE_NAME || device === REJECT_DEVICE_NAME;
}

/** Whether an assistant tool call is a `write` targeting `xd://propose` (plan-mode decision detection). */
export function isProposeToolCall(toolCall: { name: string; arguments?: Record<string, unknown> }): boolean {
	const path = toolCallWritePath(toolCall);
	return path !== undefined && parseXdUrl(path)?.name === PROPOSE_DEVICE_NAME;
}

/**
 * The XdevDispatch metadata carried on a completed `write` execution result, or
 * `undefined` when the execution was not a device dispatch. Consumers check
 * `.tool` (e.g. `PROPOSE_DEVICE_NAME` for plan-mode decision tracking and the
 * event-controller's plan-approval hook).
 */
export function writeDeviceDispatch(toolName: string, result: unknown): XdevDispatch | undefined {
	if (toolName !== "write") return undefined;
	if (!result || typeof result !== "object" || !("details" in result)) return undefined;
	const details = result.details;
	if (!details || typeof details !== "object" || !("xdev" in details)) return undefined;
	const xdev = details.xdev;
	if (!xdev || typeof xdev !== "object" || !("tool" in xdev) || !("mode" in xdev)) return undefined;
	// Envelope verified above; the write tool stored a real XdevDispatch here.
	return xdev as XdevDispatch;
}

/** Handler installed by plan mode; `xd://propose` dispatches the written plan title to it. */
export type PlanProposalHandler = (title: string) => Promise<AgentToolResult<unknown>>;

type ResolveAction = "apply" | "discard";

/** Details payload carried on a resolve/reject dispatch result (`XdevDispatch.inner`). */
export interface ResolveDetails {
	action: ResolveAction;
	reason: string;
	sourceToolName?: string;
	label?: string;
	sourceResultDetails?: unknown;
}
/** Parse a completed `write` dispatch targeting `xd://resolve` or `xd://reject`. */
export function resolveDispatchDetails(toolName: string, result: unknown): ResolveDetails | undefined {
	const dispatch = writeDeviceDispatch(toolName, result);
	if (!dispatch || (dispatch.tool !== RESOLVE_DEVICE_NAME && dispatch.tool !== REJECT_DEVICE_NAME)) return undefined;
	const inner = dispatch.inner;
	if (!inner || typeof inner !== "object") return undefined;
	const action = "action" in inner ? inner.action : undefined;
	const reason = "reason" in inner ? inner.reason : undefined;
	if ((action !== "apply" && action !== "discard") || typeof reason !== "string") return undefined;
	return {
		action,
		reason,
		...("sourceToolName" in inner && typeof inner.sourceToolName === "string"
			? { sourceToolName: inner.sourceToolName }
			: {}),
		...("label" in inner && typeof inner.label === "string" ? { label: inner.label } : {}),
		...("sourceResultDetails" in inner ? { sourceResultDetails: inner.sourceResultDetails } : {}),
	};
}

/** Invoker input for queued pending-preview handlers. */
interface ResolveInvocation {
	action: ResolveAction;
	reason: string;
}

/** Monotonic suffix making each staged preview's pending-invoker id UNIQUE, so
 *  stacked previews never clobber one another by label. */
let pendingPreviewSeq = 0;

/**
 * Register a non-forcing resolve-protocol handler for a staged preview. Wraps the
 * caller's apply/reject into an onInvoked closure and stores it on the tool-choice
 * queue's pending-invoker registry under a UNIQUE id. A `write` to `xd://resolve`
 * or `xd://reject` dispatches to it; the agent-loop's SoftToolRequirement
 * lifecycle injects the preview reminder and escalates to a forced `write` only
 * if the model declines — so a compliant turn pays ZERO tool_choice change (no
 * prompt-cache messages-cache invalidation).
 *
 * This is the canonical entry point for any tool that wants preview/apply
 * semantics. No session-level abstraction is needed: callers pass their
 * apply/reject functions directly. Resolution requires the `write` tool to be
 * active — the session's soft requirement names it.
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
		const result = await runResolveInvocation(input as ResolveInvocation, {
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

	// NON-FORCING: register so a resolution-device write can dispatch here WITHOUT
	// changing tool_choice. The agent-loop injects the reminder (from the
	// SoftToolRequirement the session builds) and forces a `write` turn only on
	// non-compliance.
	queue.registerPendingInvoker(id, options.sourceToolName, onInvoked);
}

/**
 * The canonical preview reminder. The resolve mechanism owns the wording; the
 * agent-loop delivers it via the session's `SoftToolRequirement.reminder` (injected
 * once per pending-preview head) instead of a host-side steer, so it lands as a
 * stable mid-history append and never churns the cached prefix.
 */
export function buildResolveReminderMessage(sourceToolName: string): CustomMessage {
	return {
		role: "custom",
		customType: "resolve-reminder",
		content: prompt.render(resolveReminderPrompt, { toolName: sourceToolName }).trim(),
		display: false,
		details: { toolName: sourceToolName },
		attribution: "agent",
		timestamp: Date.now(),
	};
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
 * Execute a resolution-device write. `text` is the raw plain-text body:
 * - `xd://resolve` / `xd://reject` → the reason; dispatches to the pending
 *   preview invoker (in-flight queue directive first).
 * - `xd://propose` → the plan title; dispatches to the plan-proposal handler
 *   installed by plan mode.
 */
export async function dispatchResolutionDevice(
	session: ToolSession,
	device: ResolutionDeviceName,
	text: string,
): Promise<{ result: AgentToolResult<unknown>; xdev: XdevDispatch }> {
	const body = text.trim();
	if (device === PROPOSE_DEVICE_NAME) {
		const handler = session.peekPlanProposalHandler?.();
		if (!handler) {
			throw new ToolError(
				`No plan is awaiting approval — ${PROPOSE_DEVICE_PATH} only accepts a plan title while plan mode is active.`,
			);
		}
		const result = await handler(body);
		return { result, xdev: { tool: device, mode: "execute", args: { title: body }, inner: result.details } };
	}

	const action: ResolveAction = device === RESOLVE_DEVICE_NAME ? "apply" : "discard";
	const xdevBase: XdevDispatch = { tool: device, mode: "execute", args: { reason: body } };
	const invoker = session.peekQueueInvoker?.() ?? session.peekPendingInvoker?.();
	if (!invoker) {
		session.clearPendingInvokers?.();
		const proposeHint = session.peekPlanProposalHandler?.()
			? ` To submit the plan for approval, write its title to ${PROPOSE_DEVICE_PATH} instead.`
			: "";
		// Rejecting is a request to reach the "no staged change" end-state, which
		// already holds when nothing is pending — honor it as a successful
		// cancellation instead of surfacing a hard error. Apply still errors.
		if (action === "discard") {
			const details: ResolveDetails = { action, reason: body };
			return {
				result: {
					content: [{ type: "text", text: `Nothing to reject; no pending action remains.${proposeHint}` }],
					details,
				},
				xdev: { ...xdevBase, inner: details },
			};
		}
		throw new ToolError(
			`No pending action to apply — ${RESOLVE_DEVICE_PATH} is only valid while a staged preview is pending.${proposeHint}`,
		);
	}
	const invocation: ResolveInvocation = { action, reason: body };
	const result = (await invoker(invocation)) as AgentToolResult<ResolveDetails>;
	return { result, xdev: { ...xdevBase, inner: result.details } };
}

/** Streaming-safe call preview for a resolution-device write: `Resolve/Reject/Propose: <text>`. */
export function renderResolutionDeviceCall(device: ResolutionDeviceName, content: unknown, uiTheme: Theme): Component {
	const body = typeof content === "string" ? replaceTabs(content.trim().split("\n")[0] ?? "") : "";
	const title = device === PROPOSE_DEVICE_NAME ? "Propose" : device === REJECT_DEVICE_NAME ? "Reject" : "Resolve";
	const text = renderStatusLine(
		{
			icon: "pending",
			title,
			description: body ? truncateToWidth(body, 72, Ellipsis.Omit) : undefined,
		},
		uiTheme,
	);
	return new Text(text, 0, 0);
}

export const resolveRenderer = {
	renderCall(args: Partial<ResolveInvocation>, _options: RenderResultOptions, uiTheme: Theme): Component {
		const reasonTrimmed = args.reason?.trim();
		const reason = reasonTrimmed ? truncateToWidth(reasonTrimmed, 72, Ellipsis.Omit) : undefined;
		const text = renderStatusLine(
			{
				icon: "pending",
				title: "Resolve",
				description: args.action,
				badge: {
					label: args.action === "apply" ? "proposed -> resolved" : "proposed -> rejected",
					color: args.action === "apply" ? "success" : "warning",
				},
				meta: reason ? [uiTheme.fg("muted", reason)] : undefined,
			},
			uiTheme,
		);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ResolveDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		const details = result.details;
		const label = replaceTabs(details?.label ?? "pending action");
		const reason = replaceTabs(details?.reason?.trim() || "No reason provided");
		const action = details?.action ?? "apply";
		const isApply = action === "apply" && !result.isError;
		const isFailedApply = action === "apply" && result.isError;
		const bgColor = result.isError ? "error" : isApply ? "success" : "warning";
		// Bare symbol: the line is wrapped in inverse(fg(...)), so any embedded fg
		// reset (styledSymbol/status glyphs carry their own \x1b[39m) would drop the
		// inverse block back to the default background mid-line.
		const icon = uiTheme.symbol(isApply ? "tool.resolve" : "status.error");
		const verb = isApply ? "Accept" : isFailedApply ? "Failed" : "Discard";
		const separator = ": ";
		const separatorIndex = label.indexOf(separator);
		const sourceLabel = separatorIndex > 0 ? label.slice(0, separatorIndex).trim() : undefined;
		const summaryLabel = separatorIndex > 0 ? label.slice(separatorIndex + separator.length).trim() : label;
		const sourceBadge = sourceLabel
			? uiTheme.bold(`${uiTheme.format.bracketLeft}${sourceLabel}${uiTheme.format.bracketRight}`)
			: undefined;
		const headerLine = `${icon} ${uiTheme.bold(`${verb}:`)} ${summaryLabel}${sourceBadge ? ` ${sourceBadge}` : ""}`;
		const lines = ["", headerLine, "", uiTheme.italic(reason), ""];

		return {
			render(width: number): readonly string[] {
				const lineWidth = Math.max(3, width);
				const innerWidth = Math.max(1, lineWidth - 2);
				return lines.map(line => {
					const truncated = truncateToWidth(line, innerWidth, Ellipsis.Omit);
					const framed = ` ${padToWidth(truncated, innerWidth)} `;
					const padded = padToWidth(framed, lineWidth);
					return uiTheme.inverse(uiTheme.fg(bgColor, padded));
				});
			},
			invalidate() {},
		};
	},

	inline: true,
	mergeCallAndResult: true,
};
