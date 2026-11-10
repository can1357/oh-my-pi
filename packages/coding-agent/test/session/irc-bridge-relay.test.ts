import { afterEach, describe, expect, it } from "bun:test";
import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import { IncomingRequests } from "@oh-my-pi/pi-coding-agent/a2a/incoming-requests";
import { sendA2aMessage } from "@oh-my-pi/pi-coding-agent/a2a/rpc";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { IrcBridge, type IrcBridgeHost } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import { convertToLlm, type CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

function makeBridge(hasWakeRelay = true) {
	const woken: AgentMessage[][] = [];
	const host = {
		isDisposed: () => false,
		isStreaming: () => false,
		planModeEnabled: () => false,
		hasWakeRelay: () => hasWakeRelay,
		emitSessionEvent: async () => {},
		wakeForIrc: (records: AgentMessage[]) => {
			woken.push(records);
		},
	} as unknown as IrcBridgeHost;
	return { bridge: new IrcBridge(host), woken };
}

describe("IrcBridge wake-relay marking", () => {
	it("carries request correlation from A2A through IRC without treating replies as requests", async () => {
		const { bridge, woken } = makeBridge();
		const registry = new AgentRegistry();
		registry.register({ id: "Main", displayName: "Main", kind: "main", status: "idle", session: null });
		const deps = {
			registry,
			send: async (message: Omit<Parameters<typeof bridge.deliver>[0], "id" | "ts">) => {
				const outcome = await bridge.deliver({ ...message, id: "irc-bus-id", ts: 123 });
				return { to: message.to, outcome };
			},
		};
		await sendA2aMessage(
			{
				message: { messageId: "a2a-request-id", parts: [{ text: "question" }] },
				metadata: { to: "Main", from: "peer" },
			},
			deps,
		);
		await sendA2aMessage(
			{
				message: { messageId: "a2a-reply-id", parts: [{ text: "answer" }] },
				metadata: { to: "Main", from: "peer", inReplyTo: "earlier-request" },
			},
			deps,
		);
		expect((woken[0][0] as CustomMessage).details).toMatchObject({
			id: "irc-bus-id",
			external: true,
			a2aMessageId: "a2a-request-id",
		});
		expect((woken[1][0] as CustomMessage).details).toMatchObject({
			id: "irc-bus-id",
			external: true,
			a2aInReplyTo: "earlier-request",
		});
		expect((woken[1][0] as CustomMessage).details).not.toHaveProperty("a2aMessageId");
	});

	it("records the incoming request on the ledger before the recipient can finish its turn", async () => {
		const { bridge, woken } = makeBridge();
		const registry = new AgentRegistry();
		registry.register({ id: "Main", displayName: "Main", kind: "main", status: "idle", session: null });
		const incoming = new IncomingRequests();
		// The recipient looks for the request from inside the synchronous wake the
		// IRC bridge performs during delivery — before the send receipt exists.
		let claimedByRecipient = false;
		let wakeDone = false;
		const wokenBridge = new IrcBridge({
			isDisposed: () => false,
			isStreaming: () => false,
			planModeEnabled: () => false,
			hasWakeRelay: () => true,
			emitSessionEvent: async () => {},
			wakeForIrc: (records: AgentMessage[]) => {
				woken.push(records);
				// The recipient looks for the request the moment it is woken —
				// synchronously inside the IRC delivery, before any receipt.
				void incoming.list("Main").then(open => {
					claimedByRecipient = open.some(request => request.messageId === "origin-request");
					wakeDone = true;
				});
			},
		} as unknown as IrcBridgeHost);
		const deps = {
			registry,
			incoming,
			send: async (message: Omit<Parameters<typeof bridge.deliver>[0], "id" | "ts">) => {
				const outcome = await wokenBridge.deliver({ ...message, id: "irc-bus-id", ts: 123 });
				return { to: message.to, outcome };
			},
		};
		const task = await sendA2aMessage(
			{
				message: { messageId: "origin-request", parts: [{ text: "question" }] },
				metadata: { to: "Main", from: "peer" },
			},
			deps,
		);
		// End to end: the ledger held the origin request before the recipient's
		// wake turn (let alone its answer) could finish, and the receipt reports
		// the delivery the recipient already saw.
		expect(claimedByRecipient).toBe(true);
		expect(wakeDone).toBe(true);
		expect(task.metadata?.delivery).toMatchObject({ to: "Main", outcome: "woken" });
		expect((woken[0][0] as CustomMessage).details).toMatchObject({
			id: "irc-bus-id",
			external: true,
			a2aMessageId: "origin-request",
		});
		// The record is still present after the recipient's turn ended without
		// a reply: it stays open for a manual or later automatic answer.
		const open = await incoming.list("Main");
		expect(open.map(request => request.messageId)).toEqual(["origin-request"]);
	});

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
	it("wakes an idle lead for a progress notice without asking it to reply", async () => {
		const { bridge, woken } = makeBridge();
		expect(
			await bridge.deliver({
				id: "idle-1",
				from: "member",
				to: "lead",
				body: "member is idle",
				ts: Date.now(),
				progress: true,
			}),
		).toBe("woken");
		const record = woken[0][0] as CustomMessage;
		expect(record.details).toMatchObject({ from: "member", progress: true });
		expect(record.content).not.toContain("If response expected");
		expect(record.content).not.toContain("sent to the sender automatically");
	});

	it.each([true, false])("renders a plan approval as a no-reply team notice with progress=%s", async progress => {
		const { bridge, woken } = makeBridge();
		await bridge.deliver({
			id: "plan-approved",
			from: "Lead",
			to: "Builder",
			body: "Plan approved. Mutation tools are available.",
			ts: Date.now(),
			progress,
			teamNotice: true,
		});
		const record = woken[0][0] as CustomMessage;
		const rendered = JSON.stringify(convertToLlm([record]));
		expect(rendered).toContain("Plan approved. Mutation tools are available.");
		expect(rendered).toContain("(team notice; no reply needed)");
		expect(rendered).not.toContain("reply follows");
		expect(rendered).not.toContain("If response expected");
		expect(rendered).not.toContain("is delivered to");
		expect(record.details).toMatchObject({ teamNotice: true });
	});

	it("keeps ordinary progress wording distinct from team notices", async () => {
		const { bridge, woken } = makeBridge();
		await bridge.deliver({
			id: "ordinary-progress",
			from: "Peer",
			to: "Builder",
			body: "Reviewing the plan.",
			ts: Date.now(),
			progress: true,
		});
		const rendered = JSON.stringify(convertToLlm(woken[0]));
		expect(rendered).toContain("(progress; its reply follows later)");
		expect(rendered).not.toContain("team notice");
	});

	it("routes a bridge request's reply through an a2a: spawn, not the pseudo-sender", async () => {
		const { bridge, woken } = makeBridge();
		// An A2A request arrives from the bridge's `a2a` pseudo-sender, which no
		// agent:// write reaches; its body names the a2a: agent that carries the answer.
		await bridge.deliver({
			id: "irc-3",
			from: "a2a",
			to: "Main",
			body: "[A2A task from peer terminal builder. ...]\n\nreview src/",
			ts: Date.now(),
			external: true,
			a2aMessageId: "request-main-1",
		});

		const record = woken[0][0] as CustomMessage;
		expect(record.details).toMatchObject({ external: true, a2aMessageId: "request-main-1" });
		expect(record.content).toContain("A2A task from peer terminal builder");
		expect(record.content).not.toContain("agent://a2a");
		expect(record.content).not.toContain("No one replies on your behalf");
		expect(record.content).toContain("with the `task` tool to the `a2a:` agent");
		// The main agent's plain-text answer is relayed by `a2a/reply-relay.ts`.
		expect(record.content).toContain("sent to the sender automatically");
	});

	it("offers a subagent the same automatic reply guidance for a bridge request", async () => {
		const { bridge, woken } = makeBridge();
		await bridge.deliver({
			id: "irc-4",
			from: "a2a",
			to: "Scout",
			body: "[A2A task from peer terminal builder. ...]\n\nreview src/",
			ts: Date.now(),
			external: true,
			a2aMessageId: "request-scout-1",
		});

		const record = woken[0][0] as CustomMessage;
		expect(record.details).toMatchObject({ external: true, a2aMessageId: "request-scout-1" });
		expect(record.content).toContain("sent to the sender automatically");
		expect(record.content).not.toContain("never reaches the sender");
		expect(record.content).toContain("with the `task` tool to the `a2a:` agent");
	});

	it("does not promise an automatic reply to a subagent without a wake relay", async () => {
		const { bridge, woken } = makeBridge(false);
		await bridge.deliver({
			id: "irc-no-relay",
			from: "a2a",
			to: "Scout",
			body: "review src/",
			ts: Date.now(),
			external: true,
			a2aMessageId: "request-scout-2",
		});
		const record = woken[0][0] as CustomMessage;
		expect(record.content).toContain("with the `task` tool to the `a2a:` agent");
		expect(record.content).not.toContain("sent to the sender automatically");
	});

	it("owes nothing back on an answer to this terminal's own A2A request", async () => {
		const { bridge, woken } = makeBridge();
		await bridge.deliver({
			id: "irc-5",
			from: "a2a",
			to: "Main",
			body: "[A2A reply to your request req-1 from peer terminal reviewer. ...]\n\ntotal() skips line 1",
			ts: Date.now(),
			external: true,
			a2aInReplyTo: "req-1",
		});

		const record = woken[0][0] as CustomMessage;
		expect(record.details).toMatchObject({ external: true, a2aInReplyTo: "req-1" });
		expect(record.details).not.toHaveProperty("a2aMessageId");
		expect(record.content).toContain("total() skips line 1");
		expect(record.content).not.toContain("If response expected");
		expect(record.content).not.toContain("sent to the sender automatically");
	});

	it("does not request a reply from a subagent receiving an A2A answer", async () => {
		const { bridge, woken } = makeBridge();
		await bridge.deliver({
			id: "irc-sub-reply",
			from: "a2a",
			to: "Scout",
			body: "[A2A reply to your request req-1 from peer terminal reviewer. ...]\n\nreview complete",
			ts: Date.now(),
			external: true,
			a2aInReplyTo: "req-1",
		});

		const record = woken[0][0] as CustomMessage;
		expect(record.details).toMatchObject({ external: true, a2aInReplyTo: "req-1" });
		expect(record.content).not.toContain("If response expected");
		expect(record.content).not.toContain("sent to the sender automatically");
	});

	it("gives another terminal's request a user turn, never developer authority", async () => {
		const { bridge, woken } = makeBridge();
		await bridge.deliver({
			id: "irc-6",
			from: "a2a",
			to: "Main",
			body: "Review src/invoice.ts",
			ts: Date.now(),
			external: true,
		});
		await bridge.deliver({ id: "irc-7", from: "B", to: "A", body: "in-process note", ts: Date.now() });

		const [peer] = convertToLlm(woken[0]);
		expect(peer?.role).toBe("user");
		expect(JSON.stringify(peer?.content)).toContain("Review src/invoice.ts");
		// In-process IRC between agents of one session keeps its existing role.
		expect(convertToLlm(woken[1])[0]?.role).toBe("developer");
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

	it("keeps a parent's team notice rendered and drainable instead of turning it into a request steer", async () => {
		const { bridge, steered } = makeStreamingChild();
		await bridge.deliver({
			id: "parent-approval",
			from: "Main",
			to: "Child",
			body: "Plan approved.",
			ts: 3,
			progress: true,
			teamNotice: true,
		});
		expect(steered).toEqual([]);
		// Informational: queued for the next step boundary, never a wait-cutting
		// interrupt.
		expect(bridge.hasInterrupts()).toBe(false);
		expect(bridge.hasPending()).toBe(true);
		expect(bridge.drainInboxMessages("Child")).toMatchObject([
			{ id: "parent-approval", body: "Plan approved.", teamNotice: true },
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
