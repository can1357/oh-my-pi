import { afterEach, describe, expect, it } from "bun:test";
import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
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
		const outcome = await bridge.deliver({
			id: "irc-1",
			from: "B",
			to: "A",
			body: "You hang up",
			ts: Date.now(),
			wakeRelay: true,
		});

		expect(outcome).toBe("woken");
		expect(woken).toHaveLength(1);
		const record = woken[0][0] as CustomMessage;
		expect(record.details).toMatchObject({ from: "B", wakeRelay: true });
		// The model-facing card must not promise a relay that will never come.
		expect(record.content).toContain("No one replies on your behalf");
	});

	it("still advertises the stop relay for genuine messages", async () => {
		const { bridge, woken } = makeBridge();
		await bridge.deliver({ id: "irc-2", from: "B", to: "A", body: "status?", ts: Date.now() });

		const record = woken[0][0] as CustomMessage;
		expect(record.details).not.toHaveProperty("wakeRelay");
		expect(record.content).toContain("is delivered to");
	});
});

describe("IrcBridge broadcast legs reaching a streaming recipient", () => {
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	function makeStreamingChild() {
		const steered: AgentMessage[] = [];
		const host = {
			agent: { steer: (message: AgentMessage) => steered.push(message) } as unknown as Agent,
			isDisposed: () => false,
			isStreaming: () => true,
			planModeEnabled: () => false,
			emitSessionEvent: async () => {},
			wakeForIrc: () => {},
		} as unknown as IrcBridgeHost;
		AgentRegistry.global().register({
			id: "Child",
			displayName: "task",
			kind: "sub",
			status: "running",
			parentId: "Main",
			session: {} as AgentSession,
		});
		return { bridge: new IrcBridge(host), steered };
	}

	it("never steers a parent's broadcast leg; only a direct parent message is a parent request", async () => {
		const { bridge, steered } = makeStreamingChild();
		await bridge.deliver({ id: "b1", from: "Main", to: "Child", body: "everyone: status", ts: 1, broadcast: true });
		await bridge.deliver({ id: "d1", from: "Main", to: "Child", body: "you: status", ts: 2 });

		expect(steered.map(message => bridge.isParentSteer(message))).toEqual([true]);
		expect(bridge.drainPending().map(record => (record as CustomMessage).details)).toMatchObject([
			{ id: "b1", broadcast: true },
		]);
	});

	it("leaves non-parent messages queued at a stop boundary and drains them after work", async () => {
		const { bridge } = makeStreamingChild();
		await bridge.deliver({ id: "p1", from: "Peer", to: "Child", body: "question?", ts: 3 });
		await bridge.deliver({ id: "b3", from: "Main", to: "Child", body: "everyone: status", ts: 4, broadcast: true });
		bridge.queueAside([{ role: "custom", customType: "note", content: "aside", display: false, timestamp: 5 }]);

		expect(bridge.drainPending({ keepPeerMessages: true }).map(record => record.timestamp)).toEqual([5]);
		expect(bridge.drainPending().map(record => record.timestamp)).toEqual([3, 4]);
	});

	it("drains a message from the recipient's own descendant at a stop boundary, since its run may wait on it", async () => {
		const { bridge } = makeStreamingChild();
		AgentRegistry.global().register({
			id: "Child.Kid",
			displayName: "kid",
			kind: "sub",
			parentId: "Child",
			session: null,
		});
		AgentRegistry.global().register({
			id: "Child.Kid.Grand",
			displayName: "grand",
			kind: "sub",
			parentId: "Child.Kid",
			session: null,
		});
		await bridge.deliver({ id: "k1", from: "Child.Kid", to: "Child", body: "question?", ts: 6 });
		await bridge.deliver({ id: "g1", from: "Child.Kid.Grand", to: "Child", body: "question?", ts: 7 });

		expect(bridge.drainPending({ keepPeerMessages: true }).map(record => record.timestamp)).toEqual([6, 7]);
	});

	it("counts only queued IRC messages as a sender's question still waiting for a turn", async () => {
		const { bridge } = makeStreamingChild();
		bridge.queueAside([
			{
				role: "custom",
				customType: "note",
				content: "aside",
				display: false,
				details: { from: "Peer" },
				timestamp: 8,
			},
		]);
		expect(bridge.hasQueuedFrom("Peer")).toBe(false);
		await bridge.deliver({ id: "p2", from: "Peer", to: "Child", body: "question?", ts: 9 });
		expect(bridge.hasQueuedFrom("Peer")).toBe(true);
	});

	it("keeps the broadcast flag on a message drained from the inbox", async () => {
		const { bridge } = makeStreamingChild();
		await bridge.deliver({ id: "b2", from: "Peer", to: "Child", body: "everyone: rebase", ts: 3, broadcast: true });

		expect(bridge.drainInboxMessages("Child")).toMatchObject([{ id: "b2", from: "Peer", broadcast: true }]);
	});
});
