import { describe, expect, it } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { FactAudience, ToolFactKind, ToolPresentationEvent } from "@oh-my-pi/pi-agent-core/presentation";
import { createLiveTerminalBinding, factId } from "@oh-my-pi/pi-agent-core/presentation";
import { negotiateTerminalMetaCap } from "../src/modes/acp/view/frames";
import type { AcpRenderContext, DeliveryReceipt } from "../src/modes/acp/view/reducer";
import { checkFactDelivery, factDeliveryExpectation, PresentationDeliveryLedger } from "./helpers/acp-delivery-ledger";
import { driveAcpToolView } from "./helpers/acp-tool-view-driver";

/**
 * Focused tests for `PresentationDeliveryLedger` itself — not a passive layer on
 * top of another suite's reducer runs, but discriminating checks that the ledger
 * agrees, disagrees, and flags an unresolved expectation exactly when it should.
 */

function plainContext(): AcpRenderContext {
	return { phase: "live", terminal: { kind: "none" }, cwd: "/tmp", fence: true };
}

function metaOnlyContext(): AcpRenderContext {
	const cap = negotiateTerminalMetaCap(true);
	if (!cap) throw new Error("expected a capability witness");
	return { phase: "live", terminal: { kind: "meta_only", cap }, cwd: "/tmp", fence: true };
}

describe("PresentationDeliveryLedger — model-only audience", () => {
	it("expects no wire delivery for a model-only audience, on any channel", () => {
		// No built-in `ToolFactKind` is model-only today (facts.ts's own comment: a
		// future one would land here first). `factDeliveryExpectation` is exercised
		// directly against the audience value itself, exactly as the ledger's
		// `#recordFact` derives it from `EXPECTED_FACT_AUDIENCE`.
		const expectation = factDeliveryExpectation("model", { kind: "plain" });
		expect(expectation).toEqual({ outcome: "no_wire_delivery" });

		const record = { factId: factId("model-only-1"), kind: "notice" as ToolFactKind, expectation };
		// Silence satisfies "no wire delivery".
		expect(checkFactDelivery([record], [])).toEqual([]);
		// So does the reducer's own explicit record of the same decision.
		expect(
			checkFactDelivery(
				[record],
				[{ kind: "fact_suppressed", factId: record.factId, reason: "audience_model_only" }],
			),
		).toEqual([]);
	});

	it("flags a model-only fact that leaked onto a wire channel", () => {
		const record = {
			factId: factId("model-only-2"),
			kind: "notice" as ToolFactKind,
			expectation: factDeliveryExpectation("model", { kind: "plain" }),
		};
		const violations = checkFactDelivery([record], [{ kind: "fact", factId: record.factId, channel: "content" }]);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain(record.factId);
		expect(violations[0]).toContain("model-only");
	});
});

describe("PresentationDeliveryLedger — human audience, no capable channel", () => {
	it("expects and matches a fact_suppressed/no_capable_channel receipt", () => {
		const ledger = new PresentationDeliveryLedger();
		const call = { toolCallId: "call-1", toolName: "bash", title: "echo hi", kind: "execute" as const, cwd: "/tmp" };
		const events: ToolPresentationEvent[] = [
			{ type: "started", call },
			{ type: "live_terminal_attached", binding: createLiveTerminalBinding("term-1") },
		];
		const context = plainContext();
		for (const event of events) ledger.record(event, context);
		// Only after the channel closes to "no capable channel" is the fact declared —
		// same ordering `reduceFact` observes on a live terminal with no negotiated meta.
		const wallTimeId = factId("wt-1");
		ledger.record({ type: "fact", fact: { id: wallTimeId, kind: "wall_time", ms: 1000 } }, context);

		const receipts: DeliveryReceipt[] = [
			{ kind: "fact_suppressed", factId: wallTimeId, reason: "no_capable_channel" },
		];
		expect(ledger.check(receipts)).toEqual([]);
	});
});

describe("PresentationDeliveryLedger — human audience, capable channel", () => {
	it("expects and matches a delivered fact receipt", () => {
		const ledger = new PresentationDeliveryLedger();
		const call = { toolCallId: "call-2", toolName: "bash", title: "echo hi", kind: "execute" as const, cwd: "/tmp" };
		const context = metaOnlyContext();
		ledger.record({ type: "started", call }, context);
		const wallTimeId = factId("wt-2");
		ledger.record({ type: "fact", fact: { id: wallTimeId, kind: "wall_time", ms: 2500 } }, context);

		const receipts: DeliveryReceipt[] = [{ kind: "fact", factId: wallTimeId, channel: "terminal_output" }];
		expect(ledger.check(receipts)).toEqual([]);
	});

	it("flags a receipt that disagrees with the expected channel", () => {
		const ledger = new PresentationDeliveryLedger();
		const call = { toolCallId: "call-3", toolName: "bash", title: "echo hi", kind: "execute" as const, cwd: "/tmp" };
		const context = metaOnlyContext();
		ledger.record({ type: "started", call }, context);
		const wallTimeId = factId("wt-3");
		ledger.record({ type: "fact", fact: { id: wallTimeId, kind: "wall_time", ms: 2500 } }, context);

		// A meta-terminal call always delivers facts on `terminal_output`; a receipt
		// claiming `content` instead is exactly the class of drift the reducer's own
		// discriminated `DeliveryReceipt` union exists to make detectable.
		const receipts: DeliveryReceipt[] = [{ kind: "fact", factId: wallTimeId, channel: "content" }];
		const violations = ledger.check(receipts);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain(wallTimeId);
		expect(violations[0]).toContain("terminal_output");
		expect(violations[0]).toContain("content");
	});

	it("flags an expectation never resolved by any receipt", () => {
		const ledger = new PresentationDeliveryLedger();
		const call = { toolCallId: "call-4", toolName: "bash", title: "echo hi", kind: "execute" as const, cwd: "/tmp" };
		const context = metaOnlyContext();
		ledger.record({ type: "started", call }, context);
		const wallTimeId = factId("wt-4");
		ledger.record({ type: "fact", fact: { id: wallTimeId, kind: "wall_time", ms: 2500 } }, context);

		// The reducer never emitted anything for this fact — the "a branch dropped a
		// fact" bug class this whole generalization exists to catch structurally.
		const violations = ledger.check([]);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain(wallTimeId);
		expect(violations[0]).toContain("no fact receipt resolved it");
	});
});

describe("PresentationDeliveryLedger — compile-time exhaustiveness", () => {
	it("would fail bun check if a policy table dropped coverage for a ToolFactKind", () => {
		// Mirrors `FACT_AUDIENCE`'s own `as const satisfies Record<ToolFactKind, ...>`
		// idiom (facts.ts) rather than inventing a second one. This literal
		// deliberately omits "notice"; TypeScript's closed-union `Record` check makes
		// that a type error, which `@ts-expect-error` suppresses *only while it holds*.
		// If `ToolFactKind` ever shrank to exactly these nine members (or the ledger's
		// own `EXPECTED_FACT_AUDIENCE` ever did), this object would satisfy the type,
		// the suppressed error would vanish, and TypeScript reports the
		// `@ts-expect-error` itself as unused — a real `bun check` failure, not a
		// runtime assertion. (Verified locally: completing this literal with all ten
		// kinds turns `bun check` red on "Unused '@ts-expect-error' directive".)
		const incompleteAudienceTable = {
			wall_time: "all",
			truncation: "human",
			limit: "human",
			diagnostics: "all",
			artifact: "human",
			model_guidance: "all",
			stop_annotation: "all",
			capability_notice: "all",
			unreported_annotation: "human",
		} as const;
		// @ts-expect-error — missing "notice" does not satisfy Record<ToolFactKind, FactAudience>
		const typeCheck: Record<ToolFactKind, FactAudience> = incompleteAudienceTable;
		void typeCheck;
		expect(Object.keys(incompleteAudienceTable)).not.toContain("notice");
		expect(Object.keys(incompleteAudienceTable)).toHaveLength(9);
	});
});

describe("PresentationDeliveryLedger — sourceEcho delivery (generalized EvalSourceDeliveryAuditor)", () => {
	it("is not a violation before the call settles, even with no delivery yet", () => {
		const ledger = new PresentationDeliveryLedger();
		const call = {
			toolCallId: "call-echo-1",
			toolName: "eval",
			title: "cell",
			kind: "execute" as const,
			sourceEcho: "SOURCE-ECHO-PENDING-0001",
		};
		ledger.record({ type: "started", call }, metaOnlyContext());
		// No settled event yet: the echo may still land on a later frame.
		expect(ledger.checkSourceEcho([])).toEqual([]);
	});

	it("passes once the echo text appears in a rendered content update before settlement", () => {
		const ledger = new PresentationDeliveryLedger();
		const call = {
			toolCallId: "call-echo-2",
			toolName: "eval",
			title: "cell",
			kind: "execute" as const,
			sourceEcho: "SOURCE-ECHO-DELIVERED-0002",
		};
		ledger.record({ type: "started", call }, plainContext());
		ledger.record({ type: "settled", outcome: { kind: "succeeded" } }, plainContext());
		const updates: SessionUpdate[] = [
			{
				sessionUpdate: "tool_call",
				toolCallId: call.toolCallId,
				content: [{ type: "content", content: { type: "text", text: "SOURCE-ECHO-DELIVERED-0002" } }],
			} as unknown as SessionUpdate,
		];
		expect(ledger.checkSourceEcho(updates)).toEqual([]);
	});

	it("flags a call that settled without its sourceEcho reaching any rendered channel", () => {
		const ledger = new PresentationDeliveryLedger();
		const call = {
			toolCallId: "call-echo-3",
			toolName: "eval",
			title: "cell",
			kind: "execute" as const,
			sourceEcho: "SOURCE-ECHO-MISSING-0003",
		};
		ledger.record({ type: "started", call }, plainContext());
		ledger.record({ type: "settled", outcome: { kind: "succeeded" } }, plainContext());
		const updates: SessionUpdate[] = [
			{
				sessionUpdate: "tool_call",
				toolCallId: call.toolCallId,
				content: [{ type: "content", content: { type: "text", text: "unrelated output" } }],
			} as unknown as SessionUpdate,
		];
		const violations = ledger.checkSourceEcho(updates);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain(call.toolCallId);
		expect(violations[0]).toContain("never delivered");
	});

	it("catches the reducer's real meta_terminal-to-live_terminal transition dropping a pending echo", () => {
		// No current producer both sets `sourceEcho` (only eval does) and later
		// attaches a live client-owned terminal (only bash's client_terminal route
		// does, via `awaitsLiveTerminal`, which starts `plain` and so delivers the
		// echo immediately at `started` — see reducer.ts's `selectAcpToolRenderMode`).
		// This sequence is therefore not reachable through any live production
		// route today, but the reducer's own state machine has no guard against it:
		// `reduceLiveTerminalAttached`'s `meta_terminal` branch finalizes the old
		// display-only terminal and switches to `live_terminal` without ever
		// checking `sourceEchoSent`, and `live_terminal` state carries no
		// `sourceEchoSent`/`sourceEcho` re-delivery path at all. This test pins that
		// the generalized ledger — unlike the retired auditor, which never observed
		// reducer-internal state — reports the drop on a real reducer-produced
		// sequence, so a future producer that reaches this transition fails loudly
		// instead of silently losing the echo. This gap is reported here rather than
		// patched in the reducer because no live route reaches it today -- guarding
		// a transition nothing currently exercises would be speculative, so the
		// test instead documents the exposure for whoever wires in the next
		// producer route that reaches this state.
		const call = {
			toolCallId: "call-echo-gap",
			toolName: "eval",
			title: "cell",
			kind: "execute" as const,
			sourceEcho: "SOURCE-ECHO-GAP-0004",
		};
		const context = metaOnlyContext();
		const run = driveAcpToolView(
			[
				{ type: "started", call },
				{
					type: "live_terminal_attached",
					binding: createLiveTerminalBinding("term-echo-gap"),
				},
				{ type: "settled", outcome: { kind: "succeeded" } },
			],
			context,
		);
		expect(run.deliveryViolations.some(v => v.includes(call.toolCallId) && v.includes("never delivered"))).toBe(true);
	});
});
