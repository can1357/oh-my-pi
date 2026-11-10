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
import {
	type A2aReplyRelayHandle,
	installA2aReplyRelay,
	sendA2aReply,
} from "@oh-my-pi/pi-coding-agent/a2a/reply-relay";
import { TASK_STATE } from "@oh-my-pi/pi-coding-agent/a2a/rpc";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";

const relays: A2aReplyRelayHandle[] = [];

afterEach(() => {
	for (const relay of relays.splice(0)) relay.stop();
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
	const handle = installA2aReplyRelay({
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
	relays.push(handle);
	const end = (messages: AgentMessage[], isTerminal?: boolean) =>
		listener?.({
			type: "agent_end",
			messages,
			...(isTerminal !== undefined ? { isTerminal } : {}),
		} as AgentSessionEvent);
	const nextDelivery = async () => {
		await delivery.promise;
		// The send was observed; drain it (and anything it queued) so the
		// assertions and the fixture teardown see a settled relay.
		await handle.settled();
		delivery = Promise.withResolvers<void>();
	};
	return { bridge, sent, end, nextDelivery, handle };
}

describe("sendA2aReply", () => {
	it("rescans and sends a correlated reply with the supplied identity and timeout", async () => {
		const bridge = new A2aAgentBridge();
		const sent: SpawnA2aAgentOptions[] = [];
		let rescans = 0;
		await sendA2aReply({
			bridge,
			request: { from: "builder", messageId: "req-sub", to: "Scout", at: 100 },
			answer: "review complete",
			identity: async () => ({ name: "reviewer", url: "http://127.0.0.1:2/" }),
			rescan: async () => {
				rescans++;
				peer(bridge, "builder");
			},
			timeoutMs: 1234,
			send: async options => {
				sent.push(options);
				return { exitCode: 0, output: "delivered", state: TASK_STATE.WORKING };
			},
		});

		expect(rescans).toBe(1);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			agent: { skillId: "builder" },
			prompt: "review complete",
			inReplyTo: "req-sub",
			fromIdentity: { name: "reviewer", url: "http://127.0.0.1:2/" },
			timeoutMs: 1234,
		});
	});

	it("does not send when a rescan cannot find the originating peer", async () => {
		const sent: SpawnA2aAgentOptions[] = [];
		await sendA2aReply({
			bridge: new A2aAgentBridge(),
			request: { from: "missing", messageId: "req-1", to: "Scout", at: 100 },
			answer: "answer",
			identity: async () => ({ name: "reviewer" }),
			rescan: async () => {},
			send: async options => {
				sent.push(options);
				return { exitCode: 0, output: "delivered", state: TASK_STATE.WORKING };
			},
		});
		expect(sent).toEqual([]);
	});
});

describe("A2A reply relay", () => {
	it("sends the last text after the request back to the sender, correlated, exactly once", async () => {
		const { bridge, sent, end, nextDelivery, handle } = harness();
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
		await handle.settled();
		expect(sent).toHaveLength(1);
	});

	it("settled waits for selection and detached transport while terminal finalization stays nonblocking", async () => {
		const bridge = new A2aAgentBridge();
		const sent: SpawnA2aAgentOptions[] = [];
		let listener: ((event: AgentSessionEvent) => void) | undefined;
		const rescanReached = Promise.withResolvers<void>();
		const rescanGate = Promise.withResolvers<void>();
		const sendGate = Promise.withResolvers<void>();
		const handle = installA2aReplyRelay({
			bridge,
			subscribe: next => {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			identity: async () => ({ name: "reviewer", url: "http://127.0.0.1:2/" }),
			rescan: async () => {
				rescanReached.resolve();
				await rescanGate.promise;
				peer(bridge, "gated-builder");
			},
			send: async options => {
				await sendGate.promise;
				sent.push(options);
				return { exitCode: 0, output: "delivered", state: TASK_STATE.WORKING };
			},
		});
		relays.push(handle);
		await IncomingRequests.global().note({ from: "gated-builder", messageId: "req-gated", to: "Main", at: 100 });

		// The terminal end is handled and returns synchronously: nothing in the
		// relay holds the event pipeline (finalization) hostage to the send.
		const terminalEnd = {
			type: "agent_end",
			messages: [assistant("blocked transport answer", 110)],
		} as AgentSessionEvent;
		listener?.(terminalEnd);
		let relaySettled = false;
		const settledDone = handle.settled().then(() => {
			relaySettled = true;
		});

		// Selection ran all the way to the detached send while both gates held:
		// the request was consumed and the send is parked inside its rescan, yet
		// the event handling above is already done — finalization never waits
		// for the transport.
		await rescanReached.promise;
		expect(await IncomingRequests.global().list("Main")).toEqual([]);
		expect(relaySettled).toBe(false);

		rescanGate.resolve();
		expect(relaySettled).toBe(false);

		// Work enqueued while draining: a second request plus terminal run must
		// be awaited too, not skipped by the already-running settled() promise.
		await IncomingRequests.global().note({ from: "gated-builder", messageId: "req-late", to: "Main", at: 120 });
		listener?.({ ...terminalEnd, messages: [assistant("late answer", 130)] } as AgentSessionEvent);
		expect(relaySettled).toBe(false);

		sendGate.resolve();
		await settledDone;
		expect(relaySettled).toBe(true);
		expect(sent.map(send => send.prompt)).toEqual(["blocked transport answer", "late answer"]);
		expect(sent.map(send => send.inReplyTo)).toEqual(["req-gated", "req-late"]);
	});

	it("leaves a request the model already answered through a2a: alone", async () => {
		const { bridge, sent, end, handle } = harness();
		peer(bridge, "builder");
		await IncomingRequests.global().note({ from: "builder", messageId: "req-1", to: "Main", at: 100 });
		// The task tool's a2a: spawn consumes the request while the run is live.
		expect((await IncomingRequests.global().consume({ to: "Main", from: "builder" }))?.messageId).toBe("req-1");

		end([assistant("Sent the review to builder.", 150)]);
		await handle.settled();
		expect(sent).toEqual([]);
	});

	it("waits for the terminal end of the run", async () => {
		const { bridge, sent, end, nextDelivery, handle } = harness();
		peer(bridge, "builder");
		await IncomingRequests.global().note({ from: "builder", messageId: "req-1", to: "Main", at: 100 });

		end([assistant("interim", 110)], false);
		await handle.settled();
		expect(sent).toEqual([]);

		end([assistant("final answer", 130)]);
		await nextDelivery();
		expect(sent.map(send => send.prompt)).toEqual(["final answer"]);
	});

	it("relays nothing from an aborted run and never relays a later run instead", async () => {
		const { bridge, sent, end, handle } = harness();
		peer(bridge, "builder");
		await IncomingRequests.global().note({ from: "builder", messageId: "req-1", to: "Main", at: 100 });

		end([assistant("half an answer", 110, "aborted")]);
		end([assistant("something the human asked next", 200)]);
		await handle.settled();

		expect(sent).toEqual([]);
		// Still open, so a manual a2a: reply stays correlated.
		expect((await IncomingRequests.global().consume({ to: "Main", from: "builder" }))?.messageId).toBe("req-1");
	});

	it("does not answer requests delivered to a subagent or relay text written before the request", async () => {
		const { bridge, sent, end, handle } = harness();
		peer(bridge, "builder");
		await IncomingRequests.global().note({ from: "builder", messageId: "req-sub", to: "Scout", at: 100 });
		await IncomingRequests.global().note({ from: "builder", messageId: "req-main", to: "Main", at: 300 });

		end([assistant("answer for the human, written before the request", 200)]);
		await handle.settled();

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
