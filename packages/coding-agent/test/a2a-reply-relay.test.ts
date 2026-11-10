/**
 * A2A reply relay: the main agent's plain-text answer to a peer request is sent
 * back to the sender once, correlated by `inReplyTo`, and never again. A send
 * holds a lease: it is confirmed only on a successful send and released on
 * failure, so a failed attempt leaves the request open for a manual reply.
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
		await IncomingRequests.global().note({
			from: "builder",
			messageId: "req-sub",
			to: "Scout",
			at: 100,
		});
		const lease = await IncomingRequests.global().consume({
			to: "Scout",
			messageId: "req-sub",
		});
		expect(lease?.request.messageId).toBe("req-sub");
		const delivered = await sendA2aReply({
			bridge,
			lease: lease!,
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

		expect(delivered).toBe(true);
		expect(rescans).toBe(1);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			agent: { skillId: "builder" },
			prompt: "review complete",
			inReplyTo: "req-sub",
			fromIdentity: { name: "reviewer", url: "http://127.0.0.1:2/" },
			timeoutMs: 1234,
		});
		// The successful send confirmed the lease: the request is gone.
		expect(await IncomingRequests.global().list("Scout")).toEqual([]);
	});

	it("does not send when a rescan cannot find the originating peer", async () => {
		const sent: SpawnA2aAgentOptions[] = [];
		await IncomingRequests.global().note({
			from: "missing",
			messageId: "req-1",
			to: "Scout",
			at: 100,
		});
		const lease = await IncomingRequests.global().consume({
			to: "Scout",
			messageId: "req-1",
		});
		const delivered = await sendA2aReply({
			bridge: new A2aAgentBridge(),
			lease: lease!,
			answer: "answer",
			identity: async () => ({ name: "reviewer" }),
			rescan: async () => {},
			send: async options => {
				sent.push(options);
				return { exitCode: 0, output: "delivered", state: TASK_STATE.WORKING };
			},
		});
		expect(delivered).toBe(false);
		expect(sent).toEqual([]);
		// The lease was released, so a manual reply stays possible.
		expect((await IncomingRequests.global().list("Scout")).map(request => request.messageId)).toEqual(["req-1"]);
	});

	it("removes the request only after a successful send confirms the lease", async () => {
		const bridge = new A2aAgentBridge();
		peer(bridge, "builder");
		await IncomingRequests.global().note({
			from: "builder",
			messageId: "req-gate",
			to: "Main",
			at: 100,
		});
		const lease = await IncomingRequests.global().consume({
			to: "Main",
			messageId: "req-gate",
		});
		const sendEntered = Promise.withResolvers<void>();
		const sendGate = Promise.withResolvers<void>();
		const delivered = sendA2aReply({
			bridge,
			lease: lease!,
			answer: "gated answer",
			identity: async () => ({ name: "reviewer" }),
			rescan: async () => {},
			send: async () => {
				sendEntered.resolve();
				await sendGate.promise;
				return { exitCode: 0, output: "delivered", state: TASK_STATE.WORKING };
			},
		});

		// The send is in flight: the request is leased, neither open in the
		// ledger nor claimable by another consumer, and not yet confirmed.
		await sendEntered.promise;
		expect(await IncomingRequests.global().list("Main")).toEqual([]);
		expect(await IncomingRequests.global().consume({ to: "Main" })).toBeUndefined();

		sendGate.resolve();
		expect(await delivered).toBe(true);
		expect(await IncomingRequests.global().list("Main")).toEqual([]);
	});

	it("restores the request for a manual reply when the send fails or throws", async () => {
		const bridge = new A2aAgentBridge();
		peer(bridge, "builder");
		const sent: SpawnA2aAgentOptions[] = [];
		const base = {
			bridge,
			answer: "answer",
			identity: async () => ({ name: "reviewer" }),
			rescan: async () => {},
		};

		// A failed send (nonzero exit code) releases the lease.
		await IncomingRequests.global().note({
			from: "builder",
			messageId: "req-fail",
			to: "Main",
			at: 100,
		});
		const failed = await sendA2aReply({
			...base,
			lease: (await IncomingRequests.global().consume({
				to: "Main",
				messageId: "req-fail",
			}))!,
			send: async options => {
				sent.push(options);
				return {
					exitCode: 1,
					output: "refused",
					error: "refused",
					state: TASK_STATE.FAILED,
				};
			},
		});
		expect(failed).toBe(false);
		expect((await IncomingRequests.global().list("Main")).map(request => request.messageId)).toEqual(["req-fail"]);

		// A throwing send releases the lease too.
		const thrown = await sendA2aReply({
			...base,
			lease: (await IncomingRequests.global().consume({
				to: "Main",
				messageId: "req-fail",
			}))!,
			send: async () => {
				throw new Error("transport exploded");
			},
		});
		expect(thrown).toBe(false);
		expect((await IncomingRequests.global().list("Main")).map(request => request.messageId)).toEqual(["req-fail"]);

		// A later successful send confirms the same request once.
		const ok = await sendA2aReply({
			...base,
			lease: (await IncomingRequests.global().consume({
				to: "Main",
				messageId: "req-fail",
			}))!,
			send: async options => {
				sent.push(options);
				return { exitCode: 0, output: "delivered", state: TASK_STATE.WORKING };
			},
		});
		expect(ok).toBe(true);
		expect(await IncomingRequests.global().list("Main")).toEqual([]);
		expect(sent.map(send => send.inReplyTo)).toEqual(["req-fail", "req-fail"]);
	});
});

describe("A2A reply relay", () => {
	it("sends the last text after the request back to the sender, correlated, exactly once", async () => {
		const { bridge, sent, end, nextDelivery, handle } = harness();
		peer(bridge, "builder");
		await IncomingRequests.global().note({
			from: "builder",
			messageId: "req-1",
			to: "Main",
			at: 100,
		});

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
		await IncomingRequests.global().note({
			from: "gated-builder",
			messageId: "req-gated",
			to: "Main",
			at: 100,
		});

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
		// the request was leased and the send is parked inside its rescan, yet
		// the event handling above is already done — finalization never waits
		// for the transport.
		await rescanReached.promise;
		expect(await IncomingRequests.global().list("Main")).toEqual([]);
		expect(relaySettled).toBe(false);

		rescanGate.resolve();
		expect(relaySettled).toBe(false);

		// Work enqueued while draining: a second request plus terminal run must
		// be awaited too, not skipped by the already-running settled() promise.
		await IncomingRequests.global().note({
			from: "gated-builder",
			messageId: "req-late",
			to: "Main",
			at: 120,
		});
		listener?.({
			...terminalEnd,
			messages: [assistant("late answer", 130)],
		} as AgentSessionEvent);
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
		await IncomingRequests.global().note({
			from: "builder",
			messageId: "req-1",
			to: "Main",
			at: 100,
		});
		// The task tool's a2a: spawn claims the request while the run is live.
		const lease = await IncomingRequests.global().consume({
			to: "Main",
			from: "builder",
		});
		expect(lease?.request.messageId).toBe("req-1");

		end([assistant("Sent the review to builder.", 150)]);
		await handle.settled();
		expect(sent).toEqual([]);
	});

	it("waits for the terminal end of the run", async () => {
		const { bridge, sent, end, nextDelivery, handle } = harness();
		peer(bridge, "builder");
		await IncomingRequests.global().note({
			from: "builder",
			messageId: "req-1",
			to: "Main",
			at: 100,
		});

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
		await IncomingRequests.global().note({
			from: "builder",
			messageId: "req-1",
			to: "Main",
			at: 100,
		});

		end([assistant("half an answer", 110, "aborted")]);
		end([assistant("something the human asked next", 200)]);
		await handle.settled();

		expect(sent).toEqual([]);
		// Still open, so a manual a2a: reply stays correlated.
		const lease = await IncomingRequests.global().consume({
			to: "Main",
			from: "builder",
		});
		expect(lease?.request.messageId).toBe("req-1");
	});

	it("does not answer requests delivered to a subagent or relay text written before the request", async () => {
		const { bridge, sent, end, handle } = harness();
		peer(bridge, "builder");
		await IncomingRequests.global().note({
			from: "builder",
			messageId: "req-sub",
			to: "Scout",
			at: 100,
		});
		await IncomingRequests.global().note({
			from: "builder",
			messageId: "req-main",
			to: "Main",
			at: 300,
		});

		end([assistant("answer for the human, written before the request", 200)]);
		await handle.settled();

		expect(sent).toEqual([]);
		expect((await IncomingRequests.global().list()).map(request => request.messageId)).toEqual([
			"req-sub",
			"req-main",
		]);
	});

	it("rescans the roster when the sender is not registered yet", async () => {
		const { sent, end, nextDelivery } = harness({
			rescan: bridge => peer(bridge, "late-terminal"),
		});
		await IncomingRequests.global().note({
			from: "late-terminal",
			messageId: "req-9",
			to: "Main",
			at: 100,
		});

		end([assistant("done", 110)]);
		await nextDelivery();

		expect(sent).toHaveLength(1);
		expect(sent[0]?.agent.skillId).toBe("late-terminal");
		expect(sent[0]?.inReplyTo).toBe("req-9");
	});

	it("keeps a failed relay attempt open for a manual reply without retrying it on a later run", async () => {
		const bridge = new A2aAgentBridge();
		const sent: SpawnA2aAgentOptions[] = [];
		let listener: ((event: AgentSessionEvent) => void) | undefined;
		let fail = true;
		const handle = installA2aReplyRelay({
			bridge,
			subscribe: next => {
				listener = next;
				return () => {
					listener = undefined;
				};
			},
			identity: async () => ({ name: "reviewer", url: "http://127.0.0.1:2/" }),
			rescan: async () => {},
			send: async options => {
				sent.push(options);
				if (fail)
					return {
						exitCode: 1,
						output: "refused",
						error: "refused",
						state: TASK_STATE.FAILED,
					};
				return { exitCode: 0, output: "delivered", state: TASK_STATE.WORKING };
			},
		});
		relays.push(handle);
		peer(bridge, "builder");
		await IncomingRequests.global().note({
			from: "builder",
			messageId: "req-1",
			to: "Main",
			at: 100,
		});

		listener?.({
			type: "agent_end",
			messages: [assistant("first attempt", 110)],
		} as AgentSessionEvent);
		await handle.settled();
		expect(sent.map(send => send.prompt)).toEqual(["first attempt"]);
		// The failed send released the lease: the request is open again.
		expect((await IncomingRequests.global().list("Main")).map(request => request.messageId)).toEqual(["req-1"]);

		// A later human turn is not an automatic retry of the same request.
		listener?.({
			type: "agent_end",
			messages: [assistant("a human turn's text", 200)],
		} as AgentSessionEvent);
		await handle.settled();
		expect(sent.map(send => send.prompt)).toEqual(["first attempt"]);
		expect((await IncomingRequests.global().list("Main")).map(request => request.messageId)).toEqual(["req-1"]);

		// A manual claim can still answer it.
		const lease = await IncomingRequests.global().consume({
			to: "Main",
			from: "builder",
		});
		expect(lease?.request.messageId).toBe("req-1");
		fail = false;
		expect(
			await sendA2aReply({
				bridge,
				lease: lease!,
				answer: "manual answer",
				identity: async () => ({ name: "reviewer" }),
				rescan: async () => {},
				send: async options => {
					sent.push(options);
					return {
						exitCode: 0,
						output: "delivered",
						state: TASK_STATE.WORKING,
					};
				},
			}),
		).toBe(true);
		expect(await IncomingRequests.global().list("Main")).toEqual([]);
	});
});
