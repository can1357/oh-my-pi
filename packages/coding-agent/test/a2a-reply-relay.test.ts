/**
 * A2A reply relay: the main agent's plain-text answer to a peer request is sent
 * back to the sender once, correlated by `inReplyTo`, and never again.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	A2aAgentBridge,
	type SpawnA2aAgentOptions,
	type SpawnA2aAgentResult,
} from "@oh-my-pi/pi-coding-agent/a2a/agent-bridge";
import { IncomingRequests } from "@oh-my-pi/pi-coding-agent/a2a/incoming-requests";
import { installA2aReplyRelay } from "@oh-my-pi/pi-coding-agent/a2a/reply-relay";
import { TASK_STATE } from "@oh-my-pi/pi-coding-agent/a2a/rpc";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";

afterEach(() => {
	IncomingRequests.resetGlobalForTests();
});

function assistant(text: string, timestamp: number, stopReason = "stop"): AgentMessage {
	return {
		role: "assistant",
		content: text.length > 0 ? [{ type: "text", text }] : [],
		stopReason,
		timestamp,
	} as unknown as AgentMessage;
}

function peer(bridge: A2aAgentBridge, skillId: string): void {
	bridge.add({
		name: `a2a:${skillId}`,
		description: "peer terminal",
		url: "http://127.0.0.1:1/",
		cardName: skillId,
		skillId,
	});
}

function harness(options: { rescan?: (bridge: A2aAgentBridge) => void } = {}) {
	const bridge = new A2aAgentBridge();
	const sent: SpawnA2aAgentOptions[] = [];
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	let delivery = Promise.withResolvers<void>();
	installA2aReplyRelay({
		bridge,
		subscribe: next => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		identity: async () => ({ name: "reviewer", url: "http://127.0.0.1:2/" }),
		rescan: async () => options.rescan?.(bridge),
		send: async (send): Promise<SpawnA2aAgentResult> => {
			sent.push(send);
			delivery.resolve();
			return { exitCode: 0, output: "delivered", state: TASK_STATE.WORKING };
		},
	});
	const end = (messages: AgentMessage[], isTerminal?: boolean) =>
		listener?.({
			type: "agent_end",
			messages,
			...(isTerminal !== undefined ? { isTerminal } : {}),
		} as AgentSessionEvent);
	const nextDelivery = async () => {
		await delivery.promise;
		delivery = Promise.withResolvers<void>();
	};
	return { bridge, sent, end, nextDelivery };
}

describe("A2A reply relay", () => {
	it("sends the last text after the request back to the sender, correlated, exactly once", async () => {
		const { bridge, sent, end, nextDelivery } = harness();
		peer(bridge, "builder");
		await IncomingRequests.global().note({ from: "builder", messageId: "req-1", to: "Main", at: 100 });

		end([
			assistant("earlier work for the human", 50),
			assistant("looking", 110),
			assistant("total() skips line 1", 120),
		]);
		await nextDelivery();

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			agent: { skillId: "builder" },
			prompt: "total() skips line 1",
			inReplyTo: "req-1",
			fromIdentity: { name: "reviewer", url: "http://127.0.0.1:2/" },
		});
		expect(await IncomingRequests.global().list("Main")).toEqual([]);

		// The next run belongs to the human: nothing more goes to the peer.
		end([assistant("unrelated follow-up", 200)]);
		await Bun.sleep(0);
		expect(sent).toHaveLength(1);
	});

	it("leaves a request the model already answered through a2a: alone", async () => {
		const { bridge, sent, end } = harness();
		peer(bridge, "builder");
		await IncomingRequests.global().note({ from: "builder", messageId: "req-1", to: "Main", at: 100 });
		// The task tool's a2a: spawn consumes the request while the run is live.
		expect((await IncomingRequests.global().consume({ to: "Main", from: "builder" }))?.messageId).toBe("req-1");

		end([assistant("Sent the review to builder.", 150)]);
		await Bun.sleep(0);
		expect(sent).toEqual([]);
	});

	it("waits for the terminal end of the run", async () => {
		const { bridge, sent, end, nextDelivery } = harness();
		peer(bridge, "builder");
		await IncomingRequests.global().note({ from: "builder", messageId: "req-1", to: "Main", at: 100 });

		end([assistant("interim", 110)], false);
		await Bun.sleep(0);
		expect(sent).toEqual([]);

		end([assistant("final answer", 130)]);
		await nextDelivery();
		expect(sent.map(send => send.prompt)).toEqual(["final answer"]);
	});

	it("relays nothing from an aborted run and never relays a later run instead", async () => {
		const { bridge, sent, end } = harness();
		peer(bridge, "builder");
		await IncomingRequests.global().note({ from: "builder", messageId: "req-1", to: "Main", at: 100 });

		end([assistant("half an answer", 110, "aborted")]);
		end([assistant("something the human asked next", 200)]);
		await Bun.sleep(0);

		expect(sent).toEqual([]);
		// Still open, so a manual a2a: reply stays correlated.
		expect((await IncomingRequests.global().consume({ to: "Main", from: "builder" }))?.messageId).toBe("req-1");
	});

	it("does not answer requests delivered to a subagent or relay text written before the request", async () => {
		const { bridge, sent, end } = harness();
		peer(bridge, "builder");
		await IncomingRequests.global().note({ from: "builder", messageId: "req-sub", to: "Scout", at: 100 });
		await IncomingRequests.global().note({ from: "builder", messageId: "req-main", to: "Main", at: 300 });

		end([assistant("answer for the human, written before the request", 200)]);
		await Bun.sleep(0);

		expect(sent).toEqual([]);
		expect((await IncomingRequests.global().list()).map(request => request.messageId)).toEqual([
			"req-sub",
			"req-main",
		]);
	});

	it("rescans the roster when the sender is not registered yet", async () => {
		const { sent, end, nextDelivery } = harness({ rescan: bridge => peer(bridge, "late-terminal") });
		await IncomingRequests.global().note({ from: "late-terminal", messageId: "req-9", to: "Main", at: 100 });

		end([assistant("done", 110)]);
		await nextDelivery();

		expect(sent).toHaveLength(1);
		expect(sent[0]?.agent.skillId).toBe("late-terminal");
		expect(sent[0]?.inReplyTo).toBe("req-9");
	});
});
