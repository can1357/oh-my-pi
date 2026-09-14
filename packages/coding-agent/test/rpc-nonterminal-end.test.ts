import { describe, expect, test } from "bun:test";
import type { AgentEvent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { RpcAgentProcess } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

/**
 * A nonterminal `agent_end` (`isTerminal: false`) is a scheduled continuation,
 * not the session's final settle: the session streams a successor turn right
 * after it (a queued steer, IRC wake, yield delivery, or barrier continuation —
 * see `AgentSession#flushPendingAgentEnd`). The RPC client's `waitForIdle()` and
 * `collectEvents()` resolve on `agent_end`, so they MUST ignore the nonterminal
 * one, or they report completion before the successor turn runs and its output
 * is lost from the request.
 */
describe("RpcClient nonterminal agent_end", () => {
	function assistantMessage(text: string): AgentMessage {
		return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } as AgentMessage;
	}

	/**
	 * A fake RPC agent process whose stdout emits the `ready` handshake and then
	 * whatever frames the test pushes. The controller stays open so the test can
	 * stream the successor turn only after the client has observed the first end.
	 */
	function fakeAgentProcess(): {
		process: RpcAgentProcess;
		push: (frame: object) => void;
		close: () => void;
	} {
		const encoder = new TextEncoder();
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const stdout = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
				controller.enqueue(encoder.encode(`${JSON.stringify({ type: "ready", protocolVersion: 1 })}\n`));
			},
		});
		const exited = Promise.withResolvers<number>();
		return {
			process: {
				stdin: { write: () => 0 },
				stdout,
				peekStderr: () => "",
				kill: () => {
					exited.resolve(0);
					controller.close();
				},
				exited: exited.promise,
			},
			push: frame => controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`)),
			close: () => controller.close(),
		};
	}

	test("collectEvents ignores a nonterminal end and captures the successor turn", async () => {
		const agent = fakeAgentProcess();
		const client = new RpcClient({ spawn: () => agent.process });
		await client.start();

		const collected = client.collectEvents(5000);

		// First turn ends, but the session has a queued continuation: isTerminal
		// is false, so the request is NOT complete.
		agent.push({ type: "agent_start" });
		agent.push({ type: "message_end", message: assistantMessage("first") });
		agent.push({ type: "agent_end", messages: [assistantMessage("first")], isTerminal: false });

		// Successor turn streams after the nonterminal end. Its output must land
		// inside the same collectEvents() request.
		agent.push({ type: "agent_start" });
		agent.push({ type: "message_end", message: assistantMessage("successor") });
		agent.push({ type: "agent_end", messages: [assistantMessage("successor")], isTerminal: true });

		const events = await collected;
		const messageTexts = events
			.filter((e): e is Extract<AgentEvent, { type: "message_end" }> => e.type === "message_end")
			.flatMap(e => {
				if (e.message.role !== "assistant") return [];
				const content = e.message.content[0];
				return content && content.type === "text" ? [content.text] : [];
			});
		expect(messageTexts).toEqual(["first", "successor"]);
		// Exactly two ends collected: the nonterminal one did not resolve the
		// promise, so the successor's terminal end is present too.
		expect(events.filter(e => e.type === "agent_end")).toHaveLength(2);

		await client.stop();
	}, 10000);
	test("waitForIdle does not resolve on a nonterminal end", async () => {
		const agent = fakeAgentProcess();
		const client = new RpcClient({ spawn: () => agent.process });
		await client.start();

		let resolved = false;
		const idle = client.waitForIdle(5000).then(() => {
			resolved = true;
		});

		// A later event whose arrival proves the reader has already processed the
		// nonterminal end — the deterministic signal to assert non-resolution on,
		// instead of a guessed wall-clock wait.
		const sawSuccessorStart = Promise.withResolvers<void>();
		let successorStartSeen = false;
		const unsubscribe = client.onEvent(event => {
			if (event.type === "agent_start" && successorStartSeen) sawSuccessorStart.resolve();
			if (event.type === "agent_start") successorStartSeen = true;
		});

		agent.push({ type: "agent_start" });
		agent.push({ type: "agent_end", messages: [assistantMessage("first")], isTerminal: false });
		agent.push({ type: "agent_start" });

		// Once the successor's agent_start has been dispatched, the nonterminal end
		// before it has definitely been seen by waitForIdle's listener.
		await sawSuccessorStart.promise;
		unsubscribe();
		expect(resolved).toBe(false);

		// The terminal end settles it.
		agent.push({ type: "agent_end", messages: [assistantMessage("successor")], isTerminal: true });
		await idle;
		expect(resolved).toBe(true);

		await client.stop();
	});
});
