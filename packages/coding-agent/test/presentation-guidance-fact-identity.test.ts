import { describe, expect, it } from "bun:test";
import type { ToolCallPresentation, ToolPresentationEvent } from "@oh-my-pi/pi-agent-core/presentation";
import { streamId, ToolPresentationStream } from "@oh-my-pi/pi-agent-core/presentation";
import { negotiateTerminalMetaCap } from "../src/modes/acp/view/frames";
import type { AcpRenderContext } from "../src/modes/acp/view/reducer";
import { INITIAL_ACP_TOOL_VIEW, reduceAcpToolView } from "../src/modes/acp/view/reducer";
import { hydrateReplayableToolExecution } from "../src/presentation/hydrate";
import { MODEL_PROJECTION_VERSION, TOOL_JOURNAL_RECORD_VERSION, toolCallRecordOf } from "../src/presentation/journal";
import { LiveToolPresentationRecord } from "../src/presentation/live-record";
import { persistedToolJournalSchema } from "../src/presentation/schemas/journal";

/**
 * Proves that the `model_guidance` fact the `add_guidance_fact` effect
 * declares on the stream, the ACP delivery receipt for it, and the
 * persisted record all share the stream-minted `FactId`.
 * `packages/agent/test/presentation-lifecycle.test.ts`
 * pins the id at the producer/stream boundary only — it cannot reach the
 * downstream consumers, `LiveToolPresentationRecord` and the ACP reducer,
 * which live in this package. This test drives a real producer through both
 * consumers and the actual on-disk schema hop, and would fail if either
 * downstream consumer dropped or reminted the guidance fact's id.
 */

const CALL_ID = "call-guidance-identity-1";

function execCall(): ToolCallPresentation {
	return { toolCallId: CALL_ID, toolName: "bash", title: "run tests", kind: "execute", cwd: "/repo" };
}

function metaOnlyContext(phase: "live" | "replay"): AcpRenderContext {
	const cap = negotiateTerminalMetaCap(true);
	if (!cap) throw new Error("expected a capability witness");
	return { phase, terminal: { kind: "meta_only", cap }, cwd: "/repo", fence: true };
}

describe("model_guidance fact identity across the live receipt, finished record, and persisted journal", () => {
	it("carries the same stream-minted FactId through every downstream consumer", () => {
		const events: ToolPresentationEvent[] = [];
		const producer = new ToolPresentationStream(streamId(CALL_ID), event => events.push(event));

		const factId = producer.fact({
			kind: "model_guidance",
			source: "ttsr",
			text: "<reminder>run the tests</reminder>",
		});
		expect(factId as string).toBe(`${CALL_ID}:f0`);

		// The live ACP receipt: reduceAcpToolView must issue a "fact" receipt
		// carrying the same id, not a suppressed or reminted one.
		let state = INITIAL_ACP_TOOL_VIEW;
		const context = metaOnlyContext("live");
		const liveEvents: ToolPresentationEvent[] = [{ type: "started", call: execCall() }, ...events];
		let liveFactReceipt: { readonly kind: "fact"; readonly factId: string } | undefined;
		for (const event of liveEvents) {
			const step = reduceAcpToolView(state, event, context);
			state = step.state;
			const receipt = step.receipts.find((r): r is typeof r & { kind: "fact" } => r.kind === "fact");
			if (receipt) liveFactReceipt = receipt;
		}
		expect(liveFactReceipt?.factId).toBe(factId);

		// The finished record: LiveToolPresentationRecord must retain the same id.
		const acc = new LiveToolPresentationRecord();
		for (const event of events) acc.fold(event);
		const presentation = acc.finish();
		expect(presentation.facts.map(fact => fact.id)).toEqual([factId]);

		// The persisted round trip: the exact on-disk hop (JSON.stringify/parse,
		// schema-validated) must not drop or remint the fact either.
		const entry = {
			type: "tool_execution_settled" as const,
			recordVersion: TOOL_JOURNAL_RECORD_VERSION,
			executionId: "exec-guidance-identity-1",
			outcome: { kind: "succeeded" as const },
			presentation,
			modelProjection: { version: MODEL_PROJECTION_VERSION, content: [] },
		};
		const roundTripped = JSON.parse(JSON.stringify(entry));
		const parsed = persistedToolJournalSchema.safeParse(roundTripped);
		expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		if (!parsed.success || parsed.data.type !== "tool_execution_settled") {
			throw new Error("expected a parsed tool_execution_settled record");
		}
		expect(parsed.data.presentation.facts.map(fact => fact.id)).toEqual([factId]);

		// Replay: hydrating the persisted record and re-driving the reducer must
		// reproduce the same live receipt, proving live and replay agree on identity.
		const replayEvents = hydrateReplayableToolExecution({
			state: "settled",
			call: toolCallRecordOf(execCall()),
			outcome: parsed.data.outcome,
			presentation: parsed.data.presentation,
			modelProjection: parsed.data.modelProjection,
		});
		let replayState = INITIAL_ACP_TOOL_VIEW;
		const replayContext = metaOnlyContext("replay");
		let replayFactReceipt: { readonly kind: "fact"; readonly factId: string } | undefined;
		for (const event of replayEvents) {
			const step = reduceAcpToolView(replayState, event, replayContext);
			replayState = step.state;
			const receipt = step.receipts.find((r): r is typeof r & { kind: "fact" } => r.kind === "fact");
			if (receipt) replayFactReceipt = receipt;
		}
		expect(replayFactReceipt?.factId).toBe(factId);
	});
});
