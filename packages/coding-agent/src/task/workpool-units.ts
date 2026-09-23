/**
 * Per-unit accounting for `workpool(units=True)`.
 *
 * Every function here is pure: the same items and attempt records produce the
 * same ledger regardless of the order workers finished in. No model calls; a
 * unit is accepted or left residual by fixed rules over the worker's report.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { oneLineLabel } from "@oh-my-pi/pi-tui/tools/task";

/** Worker-reported verification for one unit. OMP does not re-run these commands. */
export interface UnitVerification {
	status: "passed" | "failed" | "not_run";
	commands?: string[];
	details?: string;
}

/** Why an attempt did not reach acceptance. */
export type UnitResidualReason = "missing" | "malformed" | "unresolved" | "verification_failed";

/** Classified result of one attempt at one unit. */
export type UnitOutcome =
	| { kind: "accepted"; value: unknown; evidence: string[]; verification?: UnitVerification }
	| {
			kind: "residual";
			reason: UnitResidualReason;
			detail: string;
			evidence: string[];
			verification?: UnitVerification;
	  };

/** One attempt at one unit, with the worker and batch that produced it. */
export interface UnitAttempt {
	itemId: string;
	/** 1-based attempt number for this unit. */
	attempt: number;
	agentId: string;
	batchId: string;
	outcome: UnitOutcome;
}

/** Live pool state of a unit, mirrored from `WorkPoolItem`. */
export interface UnitItemState {
	id: string;
	seq: number;
	text: string;
	status: "queued" | "running" | "completed" | "failed" | "cancelled";
}

/** Final per-unit state reported to the parent. */
export interface UnitLedgerEntry {
	id: string;
	seq: number;
	text: string;
	state: "pending" | "accepted" | "residual" | "cancelled";
	/** Accepted units only: worker reported `verification.status: "passed"`. */
	verified?: boolean;
	value?: unknown;
	evidence: string[];
	verification?: UnitVerification;
	reason?: UnitResidualReason;
	detail?: string;
	attempts: Array<{ attempt: number; agentId: string; batchId: string; result: "accepted" | UnitResidualReason }>;
}

/** Residual context handed to the next attempt at a unit. */
export interface UnitRetryContext {
	attempt: number;
	reason: UnitResidualReason;
	detail: string;
	evidence: string[];
	verification?: UnitVerification;
}

const VERIFICATION_STATUSES: Record<string, true> = { passed: true, failed: true, not_run: true };

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

function malformed(detail: string): UnitOutcome {
	return { kind: "residual", reason: "malformed", detail, evidence: [] };
}

// Strict-mode providers send omitted optional fields as `null`; every optional field treats `null` as absent.
function parseVerification(value: unknown): UnitVerification | string | undefined {
	if (value == null) return undefined;
	if (!isRecord(value) || typeof value.status !== "string" || !Object.hasOwn(VERIFICATION_STATUSES, value.status)) {
		return 'verification.status must be "passed", "failed", or "not_run"';
	}
	if (value.commands != null && !isStringArray(value.commands)) {
		return "verification.commands must be an array of strings";
	}
	if (value.details != null && typeof value.details !== "string") {
		return "verification.details must be a string";
	}
	return {
		status: value.status as UnitVerification["status"],
		...(value.commands != null ? { commands: [...value.commands] } : {}),
		...(value.details != null ? { details: value.details } : {}),
	};
}

/**
 * Classify one worker report. `report` is the item's yielded `data`;
 * `undefined` means the worker never delivered one, described by `missingDetail`.
 */
export function classifyUnitReport(report: unknown, missingDetail: string): UnitOutcome {
	if (report === undefined) return { kind: "residual", reason: "missing", detail: missingDetail, evidence: [] };
	if (!isRecord(report)) return malformed("unit report must be an object with a status field");
	if (report.status !== "done" && report.status !== "unresolved") {
		return malformed('status must be "done" or "unresolved"');
	}
	if (report.evidence != null && !isStringArray(report.evidence)) {
		return malformed("evidence must be an array of strings");
	}
	const evidence = report.evidence == null ? [] : [...report.evidence];
	const verification = parseVerification(report.verification);
	if (typeof verification === "string") return malformed(verification);
	const verificationField = verification ? { verification } : {};
	if (report.status === "unresolved") {
		const detail =
			typeof report.reason === "string" && report.reason.trim().length > 0
				? report.reason.trim()
				: "worker reported the unit unresolved without a reason";
		return { kind: "residual", reason: "unresolved", detail, evidence, ...verificationField };
	}
	if (report.value == null) return malformed('status "done" requires value');
	if (verification?.status === "failed") {
		return {
			kind: "residual",
			reason: "verification_failed",
			detail: verification.details ?? "worker-reported verification failed",
			evidence,
			verification,
		};
	}
	return { kind: "accepted", value: report.value, evidence, ...verificationField };
}

function attemptsByItem(attempts: readonly UnitAttempt[]): Map<string, UnitAttempt[]> {
	const grouped = new Map<string, UnitAttempt[]>();
	for (const attempt of attempts) {
		const list = grouped.get(attempt.itemId);
		if (list) list.push(attempt);
		else grouped.set(attempt.itemId, [attempt]);
	}
	for (const list of grouped.values()) list.sort((a, b) => a.attempt - b.attempt);
	return grouped;
}

function ledgerEntry(item: UnitItemState, attempts: readonly UnitAttempt[]): UnitLedgerEntry {
	const history = attempts.map(attempt => ({
		attempt: attempt.attempt,
		agentId: attempt.agentId,
		batchId: attempt.batchId,
		result: attempt.outcome.kind === "accepted" ? ("accepted" as const) : attempt.outcome.reason,
	}));
	const base = { id: item.id, seq: item.seq, text: item.text, attempts: history };
	if (item.status === "queued" || item.status === "running") return { ...base, state: "pending", evidence: [] };
	const last = attempts.at(-1)?.outcome;
	if (last?.kind === "accepted") {
		return {
			...base,
			state: "accepted",
			verified: last.verification?.status === "passed",
			value: last.value,
			evidence: last.evidence,
			...(last.verification ? { verification: last.verification } : {}),
		};
	}
	if (item.status === "cancelled") return { ...base, state: "cancelled", evidence: last?.evidence ?? [] };
	if (!last) {
		return { ...base, state: "residual", reason: "missing", detail: "no attempt was recorded", evidence: [] };
	}
	return {
		...base,
		state: "residual",
		reason: last.reason,
		detail: last.detail,
		evidence: last.evidence,
		...(last.verification ? { verification: last.verification } : {}),
	};
}

/**
 * Build the unit ledger in push order. Attempt records may arrive in any order;
 * the ledger depends only on the set of records, never on arrival order.
 */
export function buildUnitLedger(items: readonly UnitItemState[], attempts: readonly UnitAttempt[]): UnitLedgerEntry[] {
	const grouped = attemptsByItem(attempts);
	return [...items].sort((a, b) => a.seq - b.seq).map(item => ledgerEntry(item, grouped.get(item.id) ?? []));
}

/** Residual context for the attempt after `last`, or `undefined` when `last` was accepted. */
export function unitRetryContext(last: UnitAttempt): UnitRetryContext | undefined {
	if (last.outcome.kind === "accepted") return undefined;
	return {
		attempt: last.attempt + 1,
		reason: last.outcome.reason,
		detail: last.outcome.detail,
		evidence: last.outcome.evidence,
		...(last.outcome.verification ? { verification: last.outcome.verification } : {}),
	};
}

/** Template view of a ledger: counts plus one pre-formatted row per unit. */
export function unitLedgerView(pool: string, ledger: readonly UnitLedgerEntry[]) {
	const summary = { total: ledger.length, accepted: 0, verified: 0, residual: 0, pending: 0, cancelled: 0 };
	for (const entry of ledger) {
		summary[entry.state]++;
		if (entry.verified) summary.verified++;
	}
	return {
		pool,
		summary,
		units: ledger.map(entry => ({
			id: entry.id,
			label: oneLineLabel(entry.text),
			state: entry.state,
			verified: entry.verified === true,
			reason: entry.reason,
			detail: entry.detail,
			valueJson: entry.state === "accepted" ? JSON.stringify(entry.value) : undefined,
			evidence: entry.evidence,
			verification: entry.verification,
			attempts: entry.attempts,
		})),
	};
}
