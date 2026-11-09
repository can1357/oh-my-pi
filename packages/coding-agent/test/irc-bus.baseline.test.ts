/**
 * BASELINE — IrcBus delivery contract, pinned for fork integration.
 *
 * These tests freeze the upstream (18.16) mailbox behavior that the fork's
 * agent-messaging work builds on, so a rebase that silently changes it goes red
 * before any fork code depends on it. They are a tripwire, not a second copy of
 * the IRC suite: upstream already covers the headline scenarios, so this file
 * asserts only the gaps those leave open.
 *
 * Upstream coverage (packages/coding-agent/test/tools/irc.test.ts at 96e4d8eb):
 *   - send → waiter resolution .. "wait consumes a matching send instead of
 *     delivering it to the session" (also "wait from-filter ignores messages
 *     from other senders", "resolves waiters in FIFO order")
 *   - send → parked revive ....... "send revives a parked recipient through the
 *     lifecycle manager" (also "send revives a killed recipient from its
 *     transcript", "multiple concurrent sends during park coalesce revive")
 *   - send → busy aside .......... "queues peer IRC as an interrupt while a
 *     turn is streaming" (also "queues parent IRC as steering …")
 *   - failed → unknown id ........ "send to an unknown agent or a killed one
 *     without a transcript fails" (also "send surfaces the reviver's error")
 *   - MAILBOX_CAP drop-oldest .... "mailbox drops the oldest message beyond the
 *     100-message cap"
 * Wake relay is covered by test/session/irc-bridge-relay.test.ts and
 * test/task/executor-irc-wake-yield-reset.test.ts.
 *
 * Gaps asserted here:
 *   1. a failed send is never buffered — no unread residue, no later drain;
 *   2. a pending waiter on a parked recipient still goes through revival, and
 *      the waiter consumes the message instead of the revived session;
 *   3. at bus level a streaming recipient receives the message as an IRC
 *      interrupt aside, not as a prompt;
 *   4. the cap holds as an unread-count bound, and `wait` drains a capped
 *      mailbox oldest-first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus, type IrcBusApi } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, type AgentRegistryApi } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

interface FakeSession {
	session: AgentSession;
	/** Messages delivered into this session via deliverIrcMessage. */
	delivered: IrcMessage[];
	/** Outcome the fake reports (busy vs idle recipient). */
	setOutcome: (outcome: "injected" | "woken") => void;
	/** Cause the next deliverIrcMessage call to throw. */
	setError: (error: Error) => void;
}

function makeFakeSession(): FakeSession {
	let outcome: "injected" | "woken" = "injected";
	let nextError: Error | null = null;
	const delivered: IrcMessage[] = [];
	const session = {
		isStreaming: true,
		deliverIrcMessage: async (msg: IrcMessage) => {
			if (nextError) {
				const err = nextError;
				nextError = null;
				throw err;
			}
			delivered.push(msg);
			return outcome;
		},
	};
	return {
		session: session as unknown as AgentSession,
		delivered,
		setOutcome: value => {
			outcome = value;
		},
		setError: error => {
			nextError = error;
		},
	};
}

function createRealSession(): { session: AgentSession } {
	const sessionManager = SessionManager.inMemory("/tmp");
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				systemPrompt: ["system prompt"],
				messages: [],
				tools: [],
			},
		}),
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {} as never,
	});
	return { session };
}

describe("IrcBus baseline", () => {
	let registry: AgentRegistryApi;
	let bus: IrcBusApi;

	const sessions: AgentSession[] = [];
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		bus = IrcBus.global();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
	});

	it("a failed send to an unknown id is never buffered", async () => {
		const receipt = await bus.send({ from: "0-Main", to: "0-Ghost", body: "hello?" });

		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toContain("0-Ghost");
		// No mailbox residue: a failed permanent hand-off must not inflate
		// unread counts or surface later through wait/inbox.
		expect(bus.unreadCount("0-Ghost")).toBe(0);
		expect(await bus.wait("0-Ghost", {}, 5)).toBeNull();
		expect(bus.take("0-Ghost")).toBeUndefined();
	});

	it("a pending waiter on a parked recipient receives the message through revival", async () => {
		const revived = makeFakeSession();
		revived.setOutcome("woken");
		registry.register({ id: "0-Parked", displayName: "task", kind: "sub", session: null, status: "parked" });
		let reviverRuns = 0;
		AgentLifecycleManager.global().adopt("0-Parked", {
			idleTtlMs: 0,
			revive: async () => {
				reviverRuns++;
				return revived.session;
			},
		});

		const waiting = bus.wait("0-Parked", { from: "0-Main" }, 1000);
		const receipt = await bus.send({ from: "0-Main", to: "0-Parked", body: "continue where you stopped" });

		expect(receipt.outcome).toBe("revived");
		expect((await waiting)?.body).toBe("continue where you stopped");
		// The waiter consumed the message: revival still runs (a parked agent
		// has no session to answer from), but the revived session gets no copy.
		expect(reviverRuns).toBe(1);
		expect(revived.delivered).toEqual([]);
		expect(bus.take("0-Parked")).toBeUndefined();
	});

	it("send to a streaming recipient is queued as an IRC interrupt, not prompted", async () => {
		const { session } = createRealSession();
		sessions.push(session);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		Object.defineProperty(session, "isStreaming", { value: true, configurable: true });
		registry.register({ id: "0-Busy", displayName: "task", kind: "sub", session });

		const receipt = await bus.send({ from: "0-Main", to: "0-Busy", body: "mid-turn note" });

		expect(receipt).toEqual({ to: "0-Busy", outcome: "injected" });
		expect(promptSpy).not.toHaveBeenCalled();
		expect(await session.agent.hasIrcInterrupts?.()).toBe(true);
		// Delivered as an aside: no mailbox copy waits for a later drain.
		expect(bus.take("0-Busy")).toBeUndefined();
	});

	it("a team notice neither answers the question nor counts as the reply that wakes the relay", async () => {
		const asker = makeFakeSession();
		const replier = makeFakeSession();
		registry.register({ id: "0-Ask", displayName: "ask", kind: "main", session: asker.session });
		registry.register({ id: "0-Rep", displayName: "rep", kind: "sub", parentId: "0-Ask", session: replier.session });

		const t0 = Date.now();
		await bus.send({ from: "0-Ask", to: "0-Rep", body: "which codeword?" });
		await bus.send({ from: "0-Rep", to: "0-Ask", body: "Plan approved.", progress: true, teamNotice: true });

		// A notice is informational: the question is still open, with no promise
		// of a later answer, and the wake relay has nothing to skip the agent for.
		expect(bus.unansweredSends("0-Ask", t0)).toEqual([{ to: "0-Rep", sentAt: expect.any(Number), promised: false }]);
		expect(bus.sentSince("0-Rep", "0-Ask", t0)).toBe(false);

		// An ordinary message back does answer it.
		await bus.send({ from: "0-Rep", to: "0-Ask", body: "heliotrope" });
		expect(bus.unansweredSends("0-Ask", t0)).toEqual([]);
		expect(bus.sentSince("0-Rep", "0-Ask", t0)).toBe(true);
	});

	it("a waiter that refuses team notices leaves the notice to ordinary delivery", async () => {
		const sink = makeFakeSession();
		registry.register({ id: "0-Sink", displayName: "sink", kind: "sub", session: sink.session });

		const waiting = bus.wait("0-Sink", { directOnly: true, teamNotices: false }, 1_000);
		const notice = await bus.send({
			from: "0-Owner",
			to: "0-Sink",
			body: "Plan approved.",
			progress: true,
			teamNotice: true,
		});

		// Rejected by the filter, not dropped: the recipient gets it as an ordinary
		// delivery and nothing lingers in the mailbox.
		expect(notice.outcome).toBe("injected");
		expect(sink.delivered).toMatchObject([{ body: "Plan approved.", teamNotice: true }]);
		expect(bus.unreadCount("0-Sink")).toBe(0);

		await bus.send({ from: "0-Owner", to: "0-Sink", body: "codeword" });
		expect((await waiting)?.body).toBe("codeword");
	});

	it("take refuses a team notice under a notice-refusing filter", async () => {
		const sink = makeFakeSession();
		registry.register({ id: "0-Mail", displayName: "mail", kind: "sub", session: sink.session });

		sink.setError(new Error("down"));
		await bus.send({ from: "0-Owner", to: "0-Mail", body: "Plan approved.", progress: true, teamNotice: true });
		sink.setError(new Error("down"));
		await bus.send({ from: "0-Owner", to: "0-Mail", body: "codeword" });
		expect(bus.unreadCount("0-Mail")).toBe(2);

		// The notice is skipped, not silently dropped: it stays for the caller to
		// drain as ordinary mail once the work it waits on is done.
		expect(bus.take("0-Mail", undefined, { teamNotices: false })?.body).toBe("codeword");
		expect(bus.unreadCount("0-Mail")).toBe(1);
		expect(bus.take("0-Mail")?.body).toBe("Plan approved.");
	});

	it("the mailbox cap bounds unread count and wait drains the survivors oldest-first", async () => {
		const sink = makeFakeSession();
		registry.register({ id: "0-Sink", displayName: "task", kind: "sub", session: sink.session });

		const sent = 101;
		for (let i = 0; i < sent; i++) {
			sink.setError(new Error(`down ${i}`));
			await bus.send({ from: "0-Source", to: "0-Sink", body: `msg-${i}` });
		}

		// MAILBOX_CAP = 100 in src/irc/bus.ts: the oldest message was dropped.
		expect(bus.unreadCount("0-Sink")).toBe(100);

		const drained: string[] = [];
		for (let msg = await bus.wait("0-Sink", {}, 5); msg; msg = await bus.wait("0-Sink", {}, 5)) {
			drained.push(msg.body);
		}
		expect(drained).toHaveLength(100);
		expect(drained[0]).toBe("msg-1");
		expect(drained.at(-1)).toBe("msg-100");
		expect(bus.unreadCount("0-Sink")).toBe(0);
	});
});
