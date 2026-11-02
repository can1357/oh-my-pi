import { describe, expect, test } from "bun:test";
import { RpcSessionSettleWatcher } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-settle";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const agentStart: AgentSessionEvent = { type: "agent_start" };
const terminalEnd: AgentSessionEvent = { type: "agent_end", messages: [], isTerminal: true };

/** Session whose live-run and background-work state the test drives. */
function createSession() {
	const backgroundDone = Promise.withResolvers<void>();
	const session = {
		isStreaming: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
		pendingAsyncWork: false,
		settleCalls: 0,
		hasPendingAsyncWork() {
			return this.pendingAsyncWork;
		},
		async settleAsyncWork() {
			this.settleCalls++;
			await backgroundDone.promise;
		},
	};
	return { session, finishBackgroundWork: backgroundDone.resolve };
}

async function settleLoop(): Promise<void> {
	for (let hop = 0; hop < 4; hop++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

describe("RpcSessionSettleWatcher", () => {
	test("a yield with background work pending settles only after that work wakes and ends the session", async () => {
		const { session, finishBackgroundWork } = createSession();
		const frames: object[] = [];
		const watcher = new RpcSessionSettleWatcher(session, frame => frames.push(frame));

		// A transition check without agent activity owes no frame.
		await watcher.check();
		expect(frames).toEqual([]);

		session.pendingAsyncWork = true;
		watcher.observe(agentStart);
		watcher.observe(terminalEnd);
		await settleLoop();
		expect(frames).toEqual([]);
		expect(session.settleCalls).toBe(1);

		// The background job delivers: a follow-up run starts, yields, and nothing remains.
		session.pendingAsyncWork = false;
		watcher.observe(agentStart);
		watcher.observe(terminalEnd);
		finishBackgroundWork();
		await settleLoop();
		await settleLoop();

		expect(frames).toEqual([{ type: "session_settled" }]);
	});

	test("does not settle while another run is live, then settles on that run's terminal end", async () => {
		const { session } = createSession();
		const frames: object[] = [];
		const watcher = new RpcSessionSettleWatcher(session, frame => frames.push(frame));

		watcher.observe(agentStart);
		session.isStreaming = true;
		watcher.observe(terminalEnd);
		await settleLoop();
		expect(frames).toEqual([]);

		session.isStreaming = false;
		watcher.observe(terminalEnd);
		await settleLoop();
		watcher.observe(terminalEnd);
		await settleLoop();

		// One stretch of activity settles once, even with a repeated terminal end.
		expect(frames).toEqual([{ type: "session_settled" }]);
	});
});
