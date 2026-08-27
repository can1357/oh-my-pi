import type { ToolPresentationEvent } from "@oh-my-pi/pi-agent-core/presentation";
import { checkedNotificationPayload, encodeToolFrames } from "@oh-my-pi/pi-coding-agent/modes/acp/view/encoder";
import type {
	AcpRenderContext,
	AcpToolViewState,
	DeliveryReceipt,
} from "@oh-my-pi/pi-coding-agent/modes/acp/view/reducer";
import { INITIAL_ACP_TOOL_VIEW, reduceAcpToolView } from "@oh-my-pi/pi-coding-agent/modes/acp/view/reducer";
import type { SessionUpdate } from "@oh-my-pi/pi-utils/acp";
import { PresentationDeliveryLedger } from "./acp-delivery-ledger";

/**
 * Drive a whole event list through `reduceAcpToolView`, collecting encoded
 * updates, receipts, and delivery-ledger violations in one place.
 *
 * `acp-view-reducer.test.ts`, `bash-presentation-protocol.test.ts`, and
 * `eval-e2e-wire.test.ts` each hand-rolled this fold independently;
 * this is the single copy all three retarget onto. The ledger records every
 * event alongside the shared reducer replay, so `deliveryViolations` reflects
 * the *same* receipts the caller's own assertions inspect — never a second,
 * possibly-diverging run.
 */
export interface AcpToolViewRun {
	readonly updates: SessionUpdate[];
	readonly receipts: DeliveryReceipt[];
	readonly state: AcpToolViewState;
	readonly deliveryViolations: string[];
}

export function driveAcpToolView(events: readonly ToolPresentationEvent[], context: AcpRenderContext): AcpToolViewRun {
	let state = INITIAL_ACP_TOOL_VIEW;
	const updates: SessionUpdate[] = [];
	const receipts: DeliveryReceipt[] = [];
	const ledger = new PresentationDeliveryLedger();
	for (const event of events) {
		const step = reduceAcpToolView(state, event, context);
		state = step.state;
		receipts.push(...step.receipts);
		ledger.record(event, context);
		for (const checked of encodeToolFrames("session-1", step.frames)) {
			updates.push(checkedNotificationPayload(checked).update);
		}
	}
	return {
		updates,
		receipts,
		state,
		deliveryViolations: [...ledger.check(receipts), ...ledger.checkSourceEcho(updates)],
	};
}
