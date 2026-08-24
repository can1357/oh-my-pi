import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type {
	FactAudience,
	FactId,
	ToolFact,
	ToolFactKind,
	ToolPresentationEvent,
} from "@oh-my-pi/pi-agent-core/presentation";
import { factAudience } from "@oh-my-pi/pi-agent-core/presentation";
import type { TerminalMetaCap } from "@oh-my-pi/pi-coding-agent/modes/acp/view/frames";
import type {
	AcpRenderContext,
	DeliveryReceipt,
	FactChannel,
	FactSuppressionReason,
} from "@oh-my-pi/pi-coding-agent/modes/acp/view/reducer";
import { selectAcpToolRenderMode, terminalMetaCapOf } from "@oh-my-pi/pi-coding-agent/modes/acp/view/reducer";
import { frameTexts } from "./acp-producer-facts";

/**
 * The delivery ledger: the generalized form of the old `EvalSourceDeliveryAuditor`.
 *
 * The auditor answered one tool's one question — "did eval's source text reach the
 * wire?" — by searching rendered frames for it. This ledger answers the general
 * question structurally for *facts*: it replays the *typed* event stream, derives
 * what the wire was obliged to do with every declared fact, and compares that
 * against the `DeliveryReceipt`s the reducer itself issued. Receipts carry
 * `FactId`, so the fact side of the ledger never reads rendered text, content
 * strings, or notice wording — the class of check that made "did a branch drop a
 * fact?" a text-matching problem is gone.
 *
 * Two independent recomputations meet here:
 *
 * 1. {@link EXPECTED_FACT_AUDIENCE} declares, per fact kind, who the fact is for.
 *    It is exhaustive over `ToolFactKind`, so an eleventh fact variant fails to
 *    compile until this ledger states its delivery policy — the compile-time gate
 *    it asks for. It is also cross-checked against `FACT_AUDIENCE` at record
 *    time, so widening the central table without revisiting the ledger is a
 *    reported violation rather than a silently-agreeing tautology.
 * 2. The channel a fact can ride is re-derived from the event stream alone, through
 *    the same `selectAcpToolRenderMode`/`terminalMetaCapOf` the reducer uses, so the
 *    ledger cannot disagree with the reducer about which mode a call is in while
 *    still agreeing about capability.
 *
 * The ledger also folds in the one non-fact obligation the old auditor covered: a
 * call's own `sourceEcho` (eval's cell source) must reach some rendered channel
 * before the call settles. `sourceEcho` is not a `ToolFact` — it carries no
 * `FactId` and the reducer issues no receipt for it, so unlike the fact side above
 * there is no structural record to compare against; the encoded frame text is the
 * only evidence delivery happened at all. Reading it here is the boundary-level
 * check the harness (never production code) is explicitly permitted to make, and
 * it is what generalizes `EvalSourceDeliveryAuditor` onto every migrated route this
 * ledger is wired into (`driveAcpToolView`), not just eval's own mapper tests.
 */

/** The wire channel a call's facts can ride, re-derived from typed events alone. */
export type LedgerFactChannel =
	| { readonly kind: "meta_terminal" }
	| { readonly kind: "live_terminal"; readonly metaCap: TerminalMetaCap | undefined }
	| { readonly kind: "plain" };

/** What the wire owes one declared fact. */
export type FactDeliveryExpectation =
	/** Model-only audience: nothing may reach a human channel. */
	| { readonly outcome: "no_wire_delivery" }
	/** Human-facing audience with a channel that can carry it. */
	| { readonly outcome: "delivered"; readonly channel: FactChannel }
	/** Human-facing audience with nothing able to carry it. */
	| { readonly outcome: "suppressed"; readonly reason: FactSuppressionReason };

/** One stashed expectation, keyed by the fact's own identity. */
export interface FactDeliveryExpectationRecord {
	readonly factId: FactId;
	readonly kind: ToolFactKind;
	readonly expectation: FactDeliveryExpectation;
}

/**
 * The ledger's own audience declaration, kept deliberately separate from
 * `FACT_AUDIENCE` so the two can disagree loudly.
 *
 * `as const satisfies Record<ToolFactKind, FactAudience>` is the same idiom
 * `FACT_AUDIENCE` and `FACT_PLACEMENT` already use: a missing kind, a stray kind,
 * or an audience value outside the union fails `bun check`.
 */
export const EXPECTED_FACT_AUDIENCE = {
	wall_time: "all",
	truncation: "human",
	limit: "human",
	diagnostics: "all",
	artifact: "human",
	model_guidance: "all",
	stop_annotation: "all",
	capability_notice: "all",
	unreported_annotation: "human",
	notice: "all",
} as const satisfies Record<ToolFactKind, FactAudience>;

/** The channel that carries facts in this mode, or `undefined` when none can. */
export function factCarrierChannel(channel: LedgerFactChannel): FactChannel | undefined {
	switch (channel.kind) {
		case "meta_terminal":
			return "terminal_output";
		case "live_terminal":
			// The client owns the terminal; only a negotiated terminal-meta witness can
			// still carry extra bytes for it. A sibling content item would be dropped.
			return channel.metaCap === undefined ? undefined : "terminal_output";
		case "plain":
			return "content";
		default: {
			const exhaustive: never = channel;
			throw new Error(`Unhandled ledger channel: ${JSON.stringify(exhaustive)}`);
		}
	}
}

/** The reducer's three-way split, recomputed from audience and capability. */
export function factDeliveryExpectation(audience: FactAudience, channel: LedgerFactChannel): FactDeliveryExpectation {
	if (audience === "model") return { outcome: "no_wire_delivery" };
	const carrier = factCarrierChannel(channel);
	return carrier === undefined
		? { outcome: "suppressed", reason: "no_capable_channel" }
		: { outcome: "delivered", channel: carrier };
}

function compareOne(record: FactDeliveryExpectationRecord, observed: readonly DeliveryReceipt[]): string[] {
	const label = `${record.factId} (${record.kind})`;
	const delivered = observed.flatMap(receipt => (receipt.kind === "fact" ? [receipt] : []));
	const suppressed = observed.flatMap(receipt => (receipt.kind === "fact_suppressed" ? [receipt] : []));
	const violations: string[] = [];
	switch (record.expectation.outcome) {
		case "delivered": {
			const channel = record.expectation.channel;
			if (delivered.length === 0) {
				violations.push(`${label}: expected delivery on ${channel}, but no fact receipt resolved it`);
			} else if (!delivered.some(receipt => receipt.channel === channel)) {
				const seen = [...new Set(delivered.map(receipt => receipt.channel))].join(", ");
				violations.push(`${label}: expected delivery on ${channel}, got ${seen}`);
			}
			for (const receipt of suppressed) {
				violations.push(`${label}: expected delivery on ${channel}, but it was suppressed as ${receipt.reason}`);
			}
			return violations;
		}
		case "suppressed": {
			const reason = record.expectation.reason;
			if (delivered.length === 0 && suppressed.length === 0) {
				violations.push(`${label}: expected suppression (${reason}), but no receipt resolved it`);
			}
			for (const receipt of delivered) {
				violations.push(`${label}: expected suppression (${reason}), but it was delivered on ${receipt.channel}`);
			}
			for (const receipt of suppressed) {
				if (receipt.reason === reason) continue;
				violations.push(`${label}: expected suppression (${reason}), got ${receipt.reason}`);
			}
			return violations;
		}
		case "no_wire_delivery": {
			// A model-only fact is satisfied by silence *or* by the reducer's explicit
			// `audience_model_only` record of the same decision — both mean nothing
			// reached a human channel. Anything else is a leak or a wrong reason.
			for (const receipt of delivered) {
				violations.push(`${label}: model-only audience, but it was delivered on ${receipt.channel}`);
			}
			for (const receipt of suppressed) {
				if (receipt.reason === "audience_model_only") continue;
				violations.push(`${label}: model-only audience, expected no delivery, got suppression ${receipt.reason}`);
			}
			return violations;
		}
		default: {
			const exhaustive: never = record.expectation;
			throw new Error(`Unhandled delivery expectation: ${JSON.stringify(exhaustive)}`);
		}
	}
}

/**
 * Compare stashed expectations against the receipts a run actually produced.
 *
 * Matching is by `FactId` only. A fact may legitimately collect more than one
 * receipt — the `meta_terminal → content` attachment transition re-delivers every
 * accumulated fact into the replacement snapshot, and plain mode records both the
 * fact-time and settlement-time content delivery — so an expectation is satisfied
 * when *some* receipt names the expected channel and no receipt contradicts it.
 */
export function checkFactDelivery(
	expectations: readonly FactDeliveryExpectationRecord[],
	receipts: readonly DeliveryReceipt[],
): string[] {
	const byFact = new Map<FactId, DeliveryReceipt[]>();
	for (const receipt of receipts) {
		if (receipt.kind !== "fact" && receipt.kind !== "fact_suppressed") continue;
		const bucket = byFact.get(receipt.factId);
		if (bucket === undefined) byFact.set(receipt.factId, [receipt]);
		else bucket.push(receipt);
	}
	const violations: string[] = [];
	const declared = new Set<FactId>();
	for (const record of expectations) {
		declared.add(record.factId);
		violations.push(...compareOne(record, byFact.get(record.factId) ?? []));
	}
	for (const [factId, observed] of byFact) {
		if (declared.has(factId)) continue;
		violations.push(`${factId}: ${observed.length} receipt(s) for a fact no event declared`);
	}
	return violations;
}

/** One call's pending source-echo obligation. */
interface SourceEchoExpectation {
	readonly toolCallId: string;
	readonly sourceEcho: string;
	/** Set once the settlement fold observes this call end, so `checkSourceEcho`
	 * can tell "never delivered before settlement" apart from "not due yet". */
	settled: boolean;
}

/** The event-stream-derived delivery ledger for one tool call. */
export class PresentationDeliveryLedger {
	#channel: LedgerFactChannel | undefined;
	readonly #expectations: FactDeliveryExpectationRecord[] = [];
	readonly #violations: string[] = [];
	readonly #sourceEchoes: SourceEchoExpectation[] = [];

	/** Fold one presentation event: track the channel, stash fact/echo expectations. */
	record(event: ToolPresentationEvent, context: AcpRenderContext): void {
		switch (event.type) {
			case "started":
				// The same single derivation the reducer uses, so mode can never drift.
				this.#channel =
					selectAcpToolRenderMode(context, event.call).mode === "meta_terminal"
						? { kind: "meta_terminal" }
						: { kind: "plain" };
				// An empty string has nothing to search for, so no expectation is worth
				// stashing — mirrors the old auditor's own falsy-code no-op.
				if (event.call.sourceEcho) {
					this.#sourceEchoes.push({
						toolCallId: event.call.toolCallId,
						sourceEcho: event.call.sourceEcho,
						settled: false,
					});
				}
				return;
			case "live_terminal_attached":
				this.#channel = { kind: "live_terminal", metaCap: terminalMetaCapOf(context.terminal) };
				return;
			case "fact":
				this.#recordFact(event.fact);
				return;
			case "settled":
				// Settlement closes the call: a later fact has no channel at all.
				this.#channel = undefined;
				for (const echo of this.#sourceEchoes) echo.settled = true;
				return;
			case "terminal_append":
			case "terminal_gap":
			case "attachment":
			case "display_output":
				// Byte-stream and attachment events carry no fact and change no channel.
				return;
			default: {
				const exhaustive: never = event;
				throw new Error(`Unhandled presentation event: ${JSON.stringify(exhaustive)}`);
			}
		}
	}

	/**
	 * Every call whose `sourceEcho` reached settlement without appearing on any
	 * rendered channel — the wire text of every `SessionUpdate` emitted so far,
	 * `_meta.terminal_output` and `content` text alike. A call not yet settled is
	 * not a violation: the echo may legitimately still ride a later frame (e.g. the
	 * settlement frame itself), the same tolerance the old auditor gave it.
	 */
	checkSourceEcho(updates: readonly SessionUpdate[]): string[] {
		const rendered = updates.flatMap(update => frameTexts(update as unknown as Record<string, unknown>)).join("\n");
		const violations: string[] = [];
		for (const echo of this.#sourceEchoes) {
			if (!echo.settled) continue;
			if (rendered.includes(echo.sourceEcho)) continue;
			violations.push(
				`${echo.toolCallId}: sourceEcho was never delivered on any rendered channel ` +
					`(_meta.terminal_output or content text) before it reached a terminal status.`,
			);
		}
		return violations;
	}

	/** Expectations stashed so far, in declaration order. */
	get expectations(): readonly FactDeliveryExpectationRecord[] {
		return this.#expectations;
	}

	/** Every disagreement between the derived policy and the reducer's receipts. */
	check(receipts: readonly DeliveryReceipt[]): string[] {
		return [...this.#violations, ...checkFactDelivery(this.#expectations, receipts)];
	}

	#recordFact(fact: ToolFact): void {
		const expected = EXPECTED_FACT_AUDIENCE[fact.kind];
		const central = factAudience(fact.kind);
		if (expected !== central) {
			this.#violations.push(
				`${fact.id} (${fact.kind}): ledger declares audience ${expected}, FACT_AUDIENCE says ${central}`,
			);
		}
		const channel = this.#channel;
		if (channel === undefined) {
			this.#violations.push(`${fact.id} (${fact.kind}): declared while the call had no open channel`);
			return;
		}
		this.#expectations.push({
			factId: fact.id,
			kind: fact.kind,
			expectation: factDeliveryExpectation(expected, channel),
		});
	}
}
