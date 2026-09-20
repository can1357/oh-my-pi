import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { IrcBridge, type IrcBridgeHost } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

function makeBridge() {
	const woken: AgentMessage[][] = [];
	const host = {
		isDisposed: () => false,
		isStreaming: () => false,
		planModeEnabled: () => false,
		emitSessionEvent: async () => {},
		wakeForIrc: (records: AgentMessage[]) => {
			woken.push(records);
		},
	} as unknown as IrcBridgeHost;
	return { bridge: new IrcBridge(host), woken };
}

describe("IrcBridge wake-relay marking", () => {
	it("marks relay messages so the peer never relays them back", async () => {
		const { bridge, woken } = makeBridge();
		const outcome = await bridge.deliver(
			{ id: "irc-1", from: "B", to: "A", body: "You hang up", ts: Date.now(), wakeRelay: true },
			undefined,
		);

		expect(outcome).toBe("woken");
		expect(woken).toHaveLength(1);
		const record = woken[0][0] as CustomMessage;
		expect(record.details).toMatchObject({ from: "B", wakeRelay: true });
		// The model-facing card must not promise a relay that will never come.
		expect(record.content).toContain("No one replies on your behalf");
	});

	it("still advertises the stop relay for genuine messages", async () => {
		const { bridge, woken } = makeBridge();
		await bridge.deliver({ id: "irc-2", from: "B", to: "A", body: "status?", ts: Date.now() }, undefined);

		const record = woken[0][0] as CustomMessage;
		expect(record.details).not.toHaveProperty("wakeRelay");
		expect(record.content).toContain("is delivered to");
	});
});
