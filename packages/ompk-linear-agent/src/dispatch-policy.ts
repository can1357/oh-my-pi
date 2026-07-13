/**
 * Dispatch authorization for incoming Linear webhooks.
 *
 * Signature verification only proves the payload came from Linear; it does
 * not make an event an authorized dispatch. Per
 * docs/multi-agent-fork-collaboration.md, dispatch requires an explicit
 * queue-admission state: the issue must carry exactly one `Queue/*` label
 * and it must be `Queue/Queued` (dispatcher-selected), be assigned to the
 * configured agent principal, live in an allowlisted project, and name an
 * allowlisted `model:` combo. Replays are rejected by deduplicating on the
 * webhook delivery id plus the issue revision (`updatedAt`).
 */

import { extractModelLabel } from "./linear";

export const DISPATCH_QUEUE_LABEL = "queue/queued";

export interface DispatchConfig {
	agentUserId: string;
	allowedProjectIds: readonly string[];
	allowedModels: readonly string[];
}

export interface WebhookEventInfo {
	type: string | undefined;
	action: string | undefined;
	deliveryId: string | null;
	issueId: string | null;
}

export interface IssueSnapshot {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	labels: string[];
	assigneeId: string | null;
	projectId: string | null;
	updatedAt: string | null;
}

export type DispatchDecision =
	| { dispatch: true; model: string; dedupeKey: string }
	| { dispatch: false; reason: string };

/** Parse a comma-separated allowlist var; whitespace-tolerant, empty entries dropped. */
export function parseAllowlist(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map(entry => entry.trim())
		.filter(entry => entry.length > 0);
}

export function resolveDispatchConfig(env: {
	LINEAR_AGENT_USER_ID?: string;
	ALLOWED_PROJECT_IDS?: string;
	ALLOWED_MODELS?: string;
}): DispatchConfig | null {
	const agentUserId = env.LINEAR_AGENT_USER_ID?.trim() ?? "";
	const allowedProjectIds = parseAllowlist(env.ALLOWED_PROJECT_IDS);
	const allowedModels = parseAllowlist(env.ALLOWED_MODELS);
	if (!agentUserId || allowedProjectIds.length === 0 || allowedModels.length === 0) return null;
	return { agentUserId, allowedProjectIds, allowedModels };
}

const DISPATCHABLE_ACTIONS: Record<string, true> = { create: true, update: true };

export function evaluateDispatch(
	event: WebhookEventInfo,
	issue: IssueSnapshot,
	config: DispatchConfig,
): DispatchDecision {
	if (event.type !== "Issue") return { dispatch: false, reason: "event type is not Issue" };
	if (!event.action || DISPATCHABLE_ACTIONS[event.action] !== true) {
		return { dispatch: false, reason: "event action is not a dispatchable transition" };
	}
	if (!event.deliveryId) return { dispatch: false, reason: "missing webhook delivery id" };
	if (!issue.updatedAt) return { dispatch: false, reason: "issue has no revision timestamp" };

	const queueLabels = issue.labels.filter(label => label.toLowerCase().startsWith("queue/"));
	if (queueLabels.length !== 1 || queueLabels[0]!.toLowerCase() !== DISPATCH_QUEUE_LABEL) {
		return { dispatch: false, reason: "issue is not in the Queue/Queued admission state" };
	}
	if (!issue.assigneeId || issue.assigneeId !== config.agentUserId) {
		return { dispatch: false, reason: "issue is not assigned to the agent principal" };
	}
	if (!issue.projectId || !config.allowedProjectIds.includes(issue.projectId)) {
		return { dispatch: false, reason: "issue project is not allowlisted" };
	}
	const model = extractModelLabel(issue.labels);
	if (!model) return { dispatch: false, reason: "no model:* label on issue" };
	if (!config.allowedModels.includes(model)) {
		return { dispatch: false, reason: "model is not allowlisted" };
	}
	return { dispatch: true, model, dedupeKey: `${event.deliveryId}:${issue.id}:${issue.updatedAt}` };
}
