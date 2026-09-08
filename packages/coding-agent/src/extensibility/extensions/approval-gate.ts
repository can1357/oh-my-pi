import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, ToolApprovalReview, ToolApprovalRevision } from "@oh-my-pi/pi-agent-core";
import { type Static, type TSchema, validateToolArguments } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { type ApprovalMode, denyError, resolveApproval } from "../../tools/approval";
import { freezeApprovalFiles, toolApprovalRevisionSchema } from "../../tools/approval-review";
import { resolveFileWriteApprovalTier } from "../../tools/path-utils";
import type { ExtensionRunner } from "./runner";
import type { ToolApprovalRequestedEvent, ToolApprovalResolvedEvent, ToolApprovalResponse } from "./types";

interface ApprovalGateOptions<TParameters extends TSchema> {
	tool: AgentTool<TParameters>;
	toolCallId: string;
	effectiveParams: Static<TParameters>;
	approvalMode: ApprovalMode;
	userPolicies: Record<string, unknown>;
	approvalReason?: string;
	safetyPrompt: string;
	signal?: AbortSignal;
	context?: AgentToolContext;
	runner: ExtensionRunner;
	review: ToolApprovalReview;
}

const responseSchema = type({ approved: "boolean", "files?": toolApprovalRevisionSchema.array() });

/** Runs only for interactive edit/write requests with a prepared content review. */
export async function runInteractiveApprovalGate<TParameters extends TSchema>(
	options: ApprovalGateOptions<TParameters>,
): Promise<void> {
	const { tool, toolCallId, effectiveParams, approvalMode, userPolicies, signal, context, runner, review } = options;
	const files = freezeApprovalFiles(review.files);
	const eligiblePaths = new Set(files.map(file => file.path));
	const eventIdentity = {
		sessionId: context?.sessionManager?.getSessionId() ?? "",
		toolCallId,
		toolName: tool.name,
	};
	const gate = Promise.withResolvers<boolean>();
	const dialog = new AbortController();
	// Resolved notifications must never overtake the requested delivery: an
	// extension registered later would observe the settlement before the
	// request and open tabs that never receive a close event.
	const requestedDelivery = Promise.withResolvers<void>();
	let requestedStarted = false;
	let selectionFailed = false;
	let selectionError: unknown;
	let settled = false;

	const notify = (event: ToolApprovalRequestedEvent | ToolApprovalResolvedEvent): Promise<void> =>
		runner.emit(event).catch((error: unknown) => {
			logger.warn("Tool approval notification failed", { type: event.type, error: String(error) });
		});
	const settle = (approved: boolean, source: "user" | "extension" | "abort", reason?: string): boolean => {
		if (settled) return false;
		settled = true;
		dialog.abort();
		if (requestedStarted) {
			void requestedDelivery.promise.then(() => {
				void notify({ type: "tool_approval_resolved", ...eventIdentity, approved, source, reason });
			});
		}
		gate.resolve(approved);
		return true;
	};
	const abort = (): void => {
		settle(false, "abort", "approval aborted");
	};
	const respond = async (response: ToolApprovalResponse): Promise<boolean> => {
		if (settled) return false;
		const validated = responseSchema.assert(response);
		if (!validated.approved) return settle(false, "extension", "denied by extension");
		validateToolArguments(tool, {
			type: "toolCall",
			id: toolCallId,
			name: tool.name,
			arguments: effectiveParams as Record<string, unknown>,
		});
		const seen = new Set<string>();
		const revisions: ToolApprovalRevision[] = (validated.files ?? []).map(revision => {
			if (!eligiblePaths.has(revision.path)) throw new Error(`File was not proposed for revision: ${revision.path}`);
			if (seen.has(revision.path)) throw new Error(`Duplicate approval revision: ${revision.path}`);
			seen.add(revision.path);
			const subject = { name: tool.name, approval: resolveFileWriteApprovalTier(revision.path) };
			const decision = resolveApproval(subject, revision, approvalMode, userPolicies);
			if (decision.policy === "deny") throw denyError(decision, tool.name);
			return { path: revision.path, content: revision.content };
		});
		// A revision identical to its proposal is not a human edit: dropping it
		// keeps per-file semantics (e.g. edit auto-repair) tied to real edits.
		const proposals = new Map(files.map(file => [file.path, file.after]));
		review.apply(revisions.filter(revision => revision.content !== proposals.get(revision.path)));
		return settle(true, "extension");
	};

	try {
		signal?.throwIfAborted();
		signal?.addEventListener("abort", abort, { once: true });
		// Opening the TUI first also handles an extension which responds immediately.
		void runner
			.getUIContext()
			.select(options.safetyPrompt, ["Approve", "Deny"], { signal: dialog.signal })
			.then(
				choice => settle(choice === "Approve", "user"),
				(error: unknown) => {
					selectionFailed = true;
					selectionError = error;
					settle(false, "abort", String(error));
				},
			);
		requestedStarted = true;
		void notify({
			type: "tool_approval_requested",
			...eventIdentity,
			approvalMode,
			reason: options.approvalReason,
			files,
			respond,
		}).then(() => requestedDelivery.resolve());
		const approved = await gate.promise;
		signal?.throwIfAborted();
		if (selectionFailed) throw selectionError;
		if (!approved) throw new Error(`Tool call denied by user: ${tool.name}`);
	} catch (error) {
		settle(false, "abort", String(error));
		review.dispose();
		throw error;
	} finally {
		signal?.removeEventListener("abort", abort);
		dialog.abort();
	}
}
