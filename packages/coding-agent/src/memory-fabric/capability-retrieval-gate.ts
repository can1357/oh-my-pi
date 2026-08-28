/**
 * Capability Retrieval Gate + Report.
 *
 * Additive, disabled-by-default, OBSERVE-ONLY gate adapter for the
 * `CapabilityRetrieval` result. This is the retriever analog of the
 * planner-adapter: it turns a retrieval projection into a *decision*
 * (`approved` / `needs-approval` / `denied`) but NEVER executes, applies, or
 * mutates anything. The decision is advisory and stays human-gated.
 *
 * Decision rules (defence-in-depth, safety cannot be bypassed):
 *   - Disabled-by-default: `enabled !== true` -> an inert `off` decision
 *     (`denied`, decidedBy `disabled`). Byte-for-byte a no-op.
 *   - A retrieval that is `blocked` (an unbreakable / mandatory ordering cycle)
 *     can NEVER be approved — always `denied`, regardless of the gate.
 *   - A retrieval with any `needsUser` flags (safety-standoff / ask-user
 *     conflicts) can NEVER be auto-approved — always `needs-approval`, even if
 *     the injected gate says allow.
 *   - Otherwise consult the injected gate:
 *       * gate throws  -> FAIL-CLOSED (`denied`).
 *       * gate.allow === true -> `approved`.
 *       * else -> `needs-approval`.
 *   - The gate is injected; there is no default "allow" gate. With no gate the
 *     result is `needs-approval` (a human must look).
 *
 * The engine returns decisions only. `approved` means "safe for a human to
 * proceed", not "the retriever acted".
 *
 * Discipline: imports NOTHING (structural input types), additive,
 * deterministic, fail-open at the top level / fail-closed at the gate.
 */

/** Structural subset of a retrieval flag. */
export interface RetrievalFlagLike {
	kind: string;
	reason: string;
	ids: string[];
}

/** Structural subset of the `CapabilityRetrieval` this gate reads. */
export interface RetrievalLike {
	enabled?: boolean;
	seeds?: string[];
	included?: string[];
	order?: string[] | null;
	blocked?: boolean;
	missing?: string[];
	decisions?: Array<{ a?: string; b?: string; action?: string; keep?: string; drop?: string }>;
	needsUser?: RetrievalFlagLike[];
	truncated?: boolean;
}

export type GateStatus = "approved" | "needs-approval" | "denied";

/** Injected gate verdict. */
export interface GateVerdict {
	allow: boolean;
	reason?: string;
}

/** A gate is a pure function over the retrieval; it may throw (fails closed). */
export type RetrievalGate = (retrieval: RetrievalLike) => GateVerdict;

export interface GateOptions {
	/** Disabled by default. When not true an inert `off` decision is returned. */
	enabled?: boolean;
	/** Injected gate. When absent, a clean retrieval resolves to needs-approval. */
	gate?: RetrievalGate;
}

export type GateDecidedBy =
	| "disabled"
	| "mandatory-cycle"
	| "needs-user"
	| "gate-allow"
	| "gate-deny"
	| "gate-throw"
	| "no-gate";

export interface RetrievalGateDecision {
	mode: "observe";
	enabled: boolean;
	status: GateStatus;
	/** What drove the status. */
	decidedBy: GateDecidedBy;
	reason: string;
	/** Count of items a human must resolve before proceeding. */
	needsUserCount: number;
	/** True when the underlying retrieval was blocked by a mandatory cycle. */
	blocked: boolean;
}

function offDecision(): RetrievalGateDecision {
	return {
		mode: "observe",
		enabled: false,
		status: "denied",
		decidedBy: "disabled",
		reason: "retrieval gate disabled",
		needsUserCount: 0,
		blocked: false,
	};
}

/**
 * Evaluate a retrieval into an advisory gate decision. Observe-only,
 * disabled-by-default, fail-open at the top / fail-closed at the gate.
 */
export function gateRetrieval(retrieval: RetrievalLike, options: GateOptions = {}): RetrievalGateDecision {
	if (options.enabled !== true) return offDecision();

	try {
		const r = retrieval ?? {};
		const blocked = r.blocked === true;
		const needsUserCount = Array.isArray(r.needsUser) ? r.needsUser.length : 0;

		// 1) A mandatory-cycle-blocked retrieval can never be approved.
		if (blocked) {
			return {
				mode: "observe",
				enabled: true,
				status: "denied",
				decidedBy: "mandatory-cycle",
				reason: "retrieval blocked by an unbreakable ordering cycle; cannot proceed",
				needsUserCount,
				blocked: true,
			};
		}

		// 2) Any human-gated flags force needs-approval (safety cannot be
		//    auto-approved even if the gate would allow it).
		if (needsUserCount > 0) {
			return {
				mode: "observe",
				enabled: true,
				status: "needs-approval",
				decidedBy: "needs-user",
				reason: `${needsUserCount} item(s) require a human decision before proceeding`,
				needsUserCount,
				blocked: false,
			};
		}

		// 3) Consult the injected gate (fail-closed if it throws).
		if (typeof options.gate !== "function") {
			return {
				mode: "observe",
				enabled: true,
				status: "needs-approval",
				decidedBy: "no-gate",
				reason: "no gate supplied; a human must review",
				needsUserCount: 0,
				blocked: false,
			};
		}

		let verdict: GateVerdict;
		try {
			verdict = options.gate(r);
		} catch {
			return {
				mode: "observe",
				enabled: true,
				status: "denied",
				decidedBy: "gate-throw",
				reason: "gate threw; failing closed (deny)",
				needsUserCount: 0,
				blocked: false,
			};
		}

		const verdictReason =
			typeof verdict?.reason === "string" && verdict.reason.trim().length > 0 ? verdict.reason : undefined;

		if (verdict?.allow === true) {
			return {
				mode: "observe",
				enabled: true,
				status: "approved",
				decidedBy: "gate-allow",
				reason: verdictReason ?? "gate approved",
				needsUserCount: 0,
				blocked: false,
			};
		}

		return {
			mode: "observe",
			enabled: true,
			status: "needs-approval",
			decidedBy: "gate-deny",
			reason: verdictReason ?? "gate did not allow; a human must review",
			needsUserCount: 0,
			blocked: false,
		};
	} catch {
		// Top-level guard: never throw. Fail closed to a safe deny.
		return {
			mode: "observe",
			enabled: true,
			status: "denied",
			decidedBy: "gate-throw",
			reason: "unexpected error; failing closed (deny)",
			needsUserCount: 0,
			blocked: false,
		};
	}
}

/**
 * Render a deterministic, human-reviewable multi-line report of a retrieval
 * and (optionally) its gate decision. Pure; no clocks; fail-open to a short
 * string. Never leaks anything beyond the ids already present in the input.
 */
export function formatRetrievalReport(retrieval: RetrievalLike, decision?: RetrievalGateDecision): string {
	try {
		const r = retrieval ?? {};
		if (r.enabled !== true) return "Capability retrieval: disabled (no projection).";

		const lines: string[] = [];
		lines.push("Capability retrieval (observe-only):");
		lines.push(`  seeds:    ${(r.seeds ?? []).join(", ") || "(none)"}`);
		lines.push(`  included: ${(r.included ?? []).join(", ") || "(none)"}`);
		lines.push(`  order:    ${r.order ? r.order.join(" -> ") : "(blocked — mandatory cycle)"}`);
		if ((r.missing ?? []).length > 0) lines.push(`  missing:  ${(r.missing ?? []).join(", ")}`);

		const decisions = r.decisions ?? [];
		if (decisions.length > 0) {
			lines.push("  conflict decisions:");
			for (const d of decisions) {
				const a = typeof d.a === "string" ? d.a : "?";
				const b = typeof d.b === "string" ? d.b : "?";
				const detail = d.keep ? ` keep=${d.keep}${d.drop ? ` drop=${d.drop}` : ""}` : "";
				lines.push(`    - ${a} vs ${b}: ${d.action ?? "?"}${detail}`);
			}
		}

		const needsUser = r.needsUser ?? [];
		if (needsUser.length > 0) {
			lines.push("  needs a human decision:");
			for (const f of needsUser) {
				lines.push(`    - [${f.kind}] ${f.reason}${f.ids?.length ? ` (${f.ids.join(", ")})` : ""}`);
			}
		}

		if (r.truncated === true) lines.push("  note: some stage hit a budget/limit guard (truncated).");

		if (decision) {
			lines.push(`  gate decision: ${decision.status} (${decision.decidedBy}) — ${decision.reason}`);
		}

		return lines.join("\n");
	} catch {
		return "Capability retrieval: report unavailable.";
	}
}
