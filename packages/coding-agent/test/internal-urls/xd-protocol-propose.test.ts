import { describe, expect, it } from "bun:test";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { XdProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/xd-protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { PlanProposalHandler } from "@oh-my-pi/pi-coding-agent/tools/resolve";

describe("xd://propose", () => {
	it("hands the write's signal and tool call id to the plan-proposal handler", async () => {
		// A host parked on a human reviewer can only abandon the review when the
		// turn is cancelled if the write's signal reaches it.
		const calls: Parameters<PlanProposalHandler>[] = [];
		const handler: PlanProposalHandler = async (...args) => {
			calls.push(args);
			return { content: [{ type: "text", text: "ok" }] };
		};
		const session = { peekPlanProposalHandler: () => handler } as unknown as ToolSession;
		const turn = new AbortController();

		await new XdProtocolHandler().write(parseInternalUrl("xd://propose"), "Words Counter", {
			session,
			signal: turn.signal,
			toolCall: { id: "call-7" },
		});

		expect(calls).toEqual([["Words Counter", turn.signal, "call-7"]]);
	});
});
