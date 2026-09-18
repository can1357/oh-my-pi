import type { RlmCompleter } from "./query";
import type { RlmLedger, RlmLease } from "./ledger";
import type { RlmRuntime } from "./runtime";
import type { RlmView } from "./view";
import { formatViewExcerpts, viewCitations } from "./view";

/** Stable worker system instructions — never the root agent system prompt. */
export const RLM_WORKER_SYSTEM =
	"You are an isolated RLM worker. Answer ONLY from the granted excerpts below. " +
	"Cite handle ranges you use. You have no tools and cannot access the parent conversation, " +
	"unrelated handles, or host secrets.";

export type RlmWorkerRole = "system" | "user";

export interface RlmWorkerMessage {
	role: RlmWorkerRole;
	content: string;
}

/**
 * Inspectable worker context built by the membrane (RFC v3 context firewall).
 * Integration tests assert this payload — not a mocked prompt alone.
 */
export interface RlmWorkerContext {
	purpose: "rlm-query" | "rlm-subcall" | "rlm-evidence-packet";
	viewId: string;
	depth: number;
	messages: readonly RlmWorkerMessage[];
	/** Single-string prompt for hosts that only accept one user turn. */
	prompt: string;
	citations: string;
	grantedBytes: number;
	leaseId?: string;
}

export interface RlmBrokerResult {
	text: string;
	citation: string;
	failOpen?: boolean;
	tokens?: number;
	cost?: number;
	overBudget?: boolean;
	lease?: RlmLease;
	context: RlmWorkerContext;
	/** True when completion observed abort. */
	aborted?: boolean;
}

export interface RlmTrajectoryRecord {
	leaseId: string;
	viewId: string;
	operation: "query" | "subcall";
	depth: number;
	grantedBytes: number;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cost?: number;
	startedAt: number;
	completedAt: number;
	status: string;
	citations: string[];
}

/** Build depth-0 query worker context from a resolved view. */
export function buildQueryWorkerContext(view: RlmView, question: string): RlmWorkerContext {
	const excerpts = formatViewExcerpts(view);
	const citations = viewCitations(view);
	const user =
		`Granted excerpts:\n${excerpts}\n\n` +
		`Question:\n${question}\n\n` +
		`Answer from the excerpts only. Cite ${citations || "the grant"} if you use it.`;
	const messages: RlmWorkerMessage[] = [
		{ role: "system", content: RLM_WORKER_SYSTEM },
		{ role: "user", content: user },
	];
	return {
		purpose: "rlm-query",
		viewId: view.id,
		depth: 0,
		messages,
		prompt: messages.map(m => `[${m.role}]\n${m.content}`).join("\n\n"),
		citations,
		grantedBytes: view.grantedBytes,
	};
}

/** Build depth-1 subcall worker context from a resolved view. */
export function buildSubcallWorkerContext(view: RlmView, task: string, depth: number): RlmWorkerContext {
	const excerpts = formatViewExcerpts(view);
	const citations = viewCitations(view);
	const user =
		`You are a depth-${depth} RLM worker. Answer ONLY from the granted excerpts. ` +
		`Cite the handle ranges you use. You cannot call tools or spawn further subcalls.\n\n` +
		`Granted excerpts:\n${excerpts}\n\nTask:\n${task}`;
	const messages: RlmWorkerMessage[] = [
		{ role: "system", content: RLM_WORKER_SYSTEM },
		{ role: "user", content: user },
	];
	return {
		purpose: "rlm-subcall",
		viewId: view.id,
		depth,
		messages,
		prompt: messages.map(m => `[${m.role}]\n${m.content}`).join("\n\n"),
		citations,
		grantedBytes: view.grantedBytes,
	};
}

/**
 * Context firewall probe: does the worker payload contain ambient root text?
 * Used by E1 acceptance tests.
 */
export function workerContextContains(context: RlmWorkerContext, needle: string): boolean {
	if (!needle) return false;
	if (context.prompt.includes(needle)) return true;
	return context.messages.some(m => m.content.includes(needle));
}

/**
 * Execute one leased completion through the membrane.
 * Completer MUST be isolated (no root transcript).
 */
export async function executeLeasedCompletion(
	runtime: RlmRuntime,
	context: RlmWorkerContext,
	complete?: RlmCompleter,
	operation: "query" | "subcall" = "query",
): Promise<RlmBrokerResult> {
	const ledger: RlmLedger = runtime.ledger;
	const approxTokens = Math.ceil(context.prompt.length / 4);
	let lease: RlmLease;
	try {
		lease = ledger.begin({ estimatedTokens: approxTokens });
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		runtime.store.note(operation, msg, true);
		return {
			text: `${msg} (fail-open)`,
			citation: context.citations || context.viewId,
			failOpen: true,
			context,
		};
	}

	const ctx: RlmWorkerContext = { ...context, leaseId: lease.id };

	if (!complete) {
		ledger.close(lease, "failed");
		runtime.store.note(operation, "no completer", true);
		return {
			text: `rlm ${operation}: no completer bound (fail-open)`,
			citation: ctx.citations || ctx.viewId,
			failOpen: true,
			lease,
			context: ctx,
		};
	}

	const startedAt = lease.startedAt;
	try {
		const raw = await complete(ctx.prompt, {
			signal: lease.signal,
			deadlineAt: lease.deadlineAt,
			purpose: ctx.purpose,
			workerMessages: ctx.messages,
		});
		const text = typeof raw === "string" ? raw : raw.text;
		const totalTokens = typeof raw === "string" ? approxTokens : (raw.tokens ?? approxTokens);
		const cost = typeof raw === "string" ? 0 : (raw.cost ?? 0);
		const inputTokens = typeof raw === "string" ? undefined : raw.inputTokens;
		const outputTokens = typeof raw === "string" ? undefined : raw.outputTokens;

		// Completer returned: reconcile exact usage even if cancel raced the return.
		const reconciled = ledger.reconcile(lease, {
			totalTokens,
			cost,
			inputTokens,
			outputTokens,
		});
		emitTrajectory(runtime, {
			leaseId: reconciled.lease.id,
			viewId: ctx.viewId,
			operation,
			depth: ctx.depth,
			grantedBytes: ctx.grantedBytes,
			inputTokens,
			outputTokens,
			totalTokens: reconciled.tokens,
			cost: reconciled.cost,
			startedAt,
			completedAt: Date.now(),
			status: reconciled.lease.status,
			citations: ctx.citations ? ctx.citations.split("; ") : [],
		});

		if (reconciled.overBudget) {
			return {
				text: `${text}\n\n(rlm over-budget after completion; fail-open)`,
				citation: ctx.citations || ctx.viewId,
				failOpen: true,
				tokens: reconciled.tokens,
				cost: reconciled.cost,
				overBudget: true,
				lease: reconciled.lease,
				context: ctx,
			};
		}

		return {
			text,
			citation: ctx.citations || ctx.viewId,
			tokens: reconciled.tokens,
			cost: reconciled.cost,
			lease: reconciled.lease,
			context: ctx,
			aborted: lease.signal.aborted || undefined,
		};
	} catch (error) {
		const aborted = lease.signal.aborted || (error instanceof Error && error.name === "AbortError");
		const msg = error instanceof Error ? error.message : String(error);
		const closed = ledger.close(lease, aborted ? "cancelled" : "failed");
		runtime.store.note(operation, msg, true);
		emitTrajectory(runtime, {
			leaseId: closed.id,
			viewId: ctx.viewId,
			operation,
			depth: ctx.depth,
			grantedBytes: ctx.grantedBytes,
			startedAt,
			completedAt: Date.now(),
			status: closed.status,
			citations: ctx.citations ? ctx.citations.split("; ") : [],
		});
		return {
			text: `${msg} (fail-open)`,
			citation: ctx.citations || ctx.viewId,
			failOpen: true,
			lease: closed,
			context: ctx,
			aborted,
		};
	}
}

function emitTrajectory(runtime: RlmRuntime, record: RlmTrajectoryRecord): void {
	runtime.records.push(record);
	runtime.store.note(
		"trajectory",
		`${record.operation} lease=${record.leaseId} status=${record.status} tokens=${record.totalTokens ?? 0}`,
		record.status !== "completed" && record.status !== "overshoot",
	);
}
