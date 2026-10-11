import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import {
	fitAbortAndRestoreQueueResponse,
	fitRemoveQueuedMessageResponse,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcPromptResultFrame, RpcResponse, RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { isRecord, readJsonl, removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "./helpers/rejection";

describe("RPC queued-message editing", () => {
	let client: RpcClient;
	let directory: string;

	/** `script` selects a scripted first model call; see the fixture's QUEUED_RPC_SCRIPT. */
	function createClient(script?: "internal-steer" | "live-steer" | "todo-error"): RpcClient {
		return new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "queued-message-rpc-agent.ts")],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1", QUEUED_RPC_SCRIPT: script ?? "" },
		});
	}

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-queued-"));
		client = createClient();
	});

	afterEach(async () => {
		await client?.stop();
		await removeWithRetries(directory);
	});

	test("validates removal and delivers only the surviving queued request", async () => {
		await client.start();
		await client.followUp("cancel this");
		await client.followUp("keep this");
		expect(await rejectionOf(client.removeQueuedMessage(null as unknown as string, "followUp"))).toMatchObject({
			command: "remove_queued_message",
		});
		expect(
			await rejectionOf(client.removeQueuedMessage("cancel this", "steer" as unknown as "steering")),
		).toMatchObject({ command: "remove_queued_message" });
		expect(
			await rejectionOf(client.removeQueuedMessage("cancel this", undefined as unknown as "steering")),
		).toMatchObject({ command: "remove_queued_message" });
		expect(await client.removeQueuedMessage("cancel this", "steering")).toEqual({ removed: false });
		expect(await client.removeQueuedMessage("absent", "followUp")).toEqual({ removed: false });
		expect((await client.getState()).queuedMessageCount).toBe(2);

		expect(await client.removeQueuedMessage("cancel this", "followUp")).toEqual({ removed: true });
		expect(await client.removeQueuedMessage("cancel this", "followUp")).toEqual({ removed: false });
		expect((await client.getState()).queuedMessageCount).toBe(1);

		const idle = Promise.withResolvers<void>();
		const unsubscribe = client.onEvent(event => {
			if (event.type === "agent_end") idle.resolve();
		});
		try {
			await client.prompt("resume");
			await withTimeout(idle.promise, 10_000, "Surviving RPC message did not finish");
		} finally {
			unsubscribe();
		}

		expect(await client.removeQueuedMessage("keep this", "followUp")).toEqual({ removed: false });
		expect((await client.getState()).queuedMessageCount).toBe(0);
		const messages = await client.getMessages();
		expect(messages.filter(message => message.role === "user").map(message => message.content)).toEqual([
			[{ type: "text", text: "resume" }],
			[{ type: "text", text: "keep this" }],
		]);
	}, 30_000);

	test("returns the removed message's images so the client can restore its draft", async () => {
		await client.start();
		const image = { type: "image" as const, mimeType: "image/png", data: "AAAA" };
		await client.followUp("with image", [image]);
		expect(await client.removeQueuedMessage("with image", "followUp")).toEqual({ removed: true, images: [image] });
		expect((await client.getState()).queuedMessageCount).toBe(0);
	}, 30_000);

	test("drops a removed message's images over the transport limit but still reports the removal", () => {
		const removed = { text: "draft", images: [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }] };
		const full = fitRemoveQueuedMessageResponse("rm", removed, Number.MAX_SAFE_INTEGER);
		const fullBytes = Buffer.byteLength(JSON.stringify(full));
		// Exactly the size of the full response still admits the images.
		expect(fitRemoveQueuedMessageResponse("rm", removed, fullBytes)).toEqual(full);
		expect(fitRemoveQueuedMessageResponse("rm", removed, fullBytes - 1)).toEqual({
			id: "rm",
			type: "response",
			command: "remove_queued_message",
			success: true,
			data: { removed: true, imagesDropped: true },
		});
	});

	test("queue_update mirrors get_state.queuedMessages, matches the removal invariant, and never repeats", async () => {
		await client.start();

		const updates: Array<{ steering: string[]; followUp: string[]; liveSteered: number }> = [];
		const unsubscribe = client.onSessionEvent(event => {
			if (event.type === "queue_update")
				updates.push({ steering: event.steering, followUp: event.followUp, liveSteered: event.liveSteered });
		});

		try {
			await client.followUp("first");
			await client.followUp("second");
			expect(updates.map(update => update.followUp)).toEqual([["first"], ["first", "second"]]);
			expect(updates.every(update => update.steering.length === 0)).toBe(true);

			expect(await client.removeQueuedMessage("first", "followUp")).toEqual({ removed: true });
			expect(updates.at(-1)?.followUp).toEqual(["second"]);
			expect((await client.getState()).queuedMessages).toEqual(updates.at(-1)!);

			// Snapshot-string-removal invariant: every chip string in a snapshot,
			// passed back verbatim to remove_queued_message with its queue, removes
			// that message.
			const snapshot = (await client.getState()).queuedMessages;
			for (const text of snapshot.steering) {
				expect(await client.removeQueuedMessage(text, "steering")).toEqual({ removed: true });
			}
			for (const text of snapshot.followUp) {
				expect(await client.removeQueuedMessage(text, "followUp")).toEqual({ removed: true });
			}
			expect(updates.at(-1)).toEqual({ steering: [], followUp: [], liveSteered: 0 });
			expect((await client.getState()).queuedMessages).toEqual({ steering: [], followUp: [], liveSteered: 0 });

			// Requeue and let delivery (the next turn dequeuing it) drain the queue.
			await client.followUp("delivered");
			expect(updates.at(-1)?.followUp).toEqual(["delivered"]);

			const idle = Promise.withResolvers<void>();
			const unsubscribeIdle = client.onEvent(event => {
				if (event.type === "agent_end") idle.resolve();
			});
			try {
				await client.prompt("go");
				await withTimeout(idle.promise, 10_000, "Turn did not finish");
			} finally {
				unsubscribeIdle();
			}
			expect(updates.at(-1)).toEqual({ steering: [], followUp: [], liveSteered: 0 });
			expect((await client.getState()).queuedMessages).toEqual({ steering: [], followUp: [], liveSteered: 0 });

			// No duplicate identical consecutive events: every emitted snapshot
			// differs from the one immediately before it.
			for (let i = 1; i < updates.length; i++) {
				expect(updates[i]).not.toEqual(updates[i - 1]);
			}
		} finally {
			unsubscribe();
		}
	}, 30_000);

	test("rejects malformed promotion, preserves missing targets, and promotes without duplicate delivery", async () => {
		await client.start();
		await client.followUp("queued request");
		expect(await rejectionOf(client.promoteQueuedMessage(null as unknown as string))).toMatchObject({
			command: "promote_queued_message",
		});
		expect(await client.promoteQueuedMessage("missing")).toEqual({ promoted: false });
		expect((await client.getState()).queuedMessageCount).toBe(1);

		const idle = Promise.withResolvers<void>();
		const unsubscribe = client.onEvent(event => {
			if (event.type === "agent_end") idle.resolve();
		});
		try {
			expect(await client.promoteQueuedMessage("queued request")).toEqual({ promoted: true });
			await withTimeout(idle.promise, 10_000, "Promoted RPC message did not finish");
		} finally {
			unsubscribe();
		}

		expect(await client.promoteQueuedMessage("queued request")).toEqual({ promoted: false });
		expect((await client.getState()).queuedMessageCount).toBe(0);
		const messages = await client.getMessages();
		expect(messages.filter(message => message.role === "user").map(message => message.content)).toEqual([
			[{ type: "text", text: "queued request" }],
		]);
	}, 30_000);

	test("acknowledges a queued streaming prompt only once it is admitted, so an immediate promote succeeds", async () => {
		// 1x1 PNG. Below resizeImage's 200px minimum, so normalizeImagesForModel
		// does real native resize/encode work — the async gap between the old
		// (pre-fix) immediate ack and actual queue admission.
		const image = {
			type: "image" as const,
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
		};

		await client.start();

		const agentStarted = Promise.withResolvers<void>();
		const unsubscribe = client.onEvent(event => {
			if (event.type === "agent_start") agentStarted.resolve();
		});
		const results: RpcPromptResultFrame[] = [];
		const bothReported = Promise.withResolvers<void>();
		const unsubscribeResults = client.onPromptResult(result => {
			results.push(result);
			if (results.length === 2) bothReported.resolve();
		});
		try {
			const firstId = await client.prompt("start a long turn");
			await withTimeout(agentStarted.promise, 10_000, "First turn never started streaming");

			const queuedId = await client.prompt("queued with image", [image], "followUp");
			expect(await client.promoteQueuedMessage("queued with image")).toEqual({ promoted: true });

			// Admission-gated acknowledgement does not change completion: each accepted
			// prompt still gets exactly one prompt_result under its own id.
			await withTimeout(bothReported.promise, 10_000, "Prompts never reported their results");
			await client.getState();
			expect(results.map(result => result.id).sort()).toEqual([firstId, queuedId].sort());
			for (const result of results) {
				expect(result).toMatchObject({ type: "prompt_result", agentInvoked: true, status: "completed" });
			}
		} finally {
			unsubscribeResults();
			unsubscribe();
		}
	}, 30_000);

	test("settles steered prompts after a failed todo leaves next-turn context pending", async () => {
		client = createClient("todo-error");
		await client.start();
		const todoFailed = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<void>();
		const results: RpcPromptResultFrame[] = [];
		const unsubscribeEvents = client.onEvent(event => {
			if (event.type === "message_end" && event.message.role === "toolResult" && event.message.toolName === "todo") {
				if (event.message.isError) todoFailed.resolve();
			}
		});
		const unsubscribeSession = client.onSessionSettled(() => settled.resolve());
		const unsubscribeResults = client.onPromptResult(result => results.push(result));
		try {
			const firstId = await client.prompt("call todo");
			await withTimeout(todoFailed.promise, 10_000, "Todo did not fail");
			const steerId = await client.prompt("continue after the todo error", undefined, "steer");
			await withTimeout(settled.promise, 10_000, "Steered turn never settled after failed todo");
			const state = await client.getState();
			expect(state).toMatchObject({
				isStreaming: false,
				isSettled: true,
				queuedMessageCount: 0,
				queuedMessages: { steering: [], followUp: [] },
			});
			expect(results.map(result => result.id).sort()).toEqual([firstId, steerId].sort());
			const nextSettled = Promise.withResolvers<void>();
			const unsubscribeNext = client.onSessionSettled(() => nextSettled.resolve());
			try {
				await client.prompt("new explicit turn");
				await withTimeout(nextSettled.promise, 10_000, "Next explicit turn did not settle");
				const messages = await client.getMessages();
				expect(
					messages.some(message => message.role === "custom" && message.customType === "todo-error-reminder"),
				).toBe(true);
			} finally {
				unsubscribeNext();
			}
		} finally {
			unsubscribeEvents();
			unsubscribeSession();
			unsubscribeResults();
		}
	}, 30_000);

	describe("abort_and_restore_queue", () => {
		/** Starts the fixture under `script` with a first turn that is still streaming. */
		async function startStreamingTurn(script?: "internal-steer" | "live-steer"): Promise<void> {
			if (script) client = createClient(script);
			await client.start();
			const agentStarted = Promise.withResolvers<void>();
			const unsubscribe = client.onEvent(event => {
				if (event.type === "agent_start") agentStarted.resolve();
			});
			try {
				await client.prompt("start a long turn");
				await withTimeout(agentStarted.promise, 10_000, "First turn never started streaming");
			} finally {
				unsubscribe();
			}
		}

		/** Re-reads session state until `check` holds. The fixture changes these queues inside
		 *  the model call without emitting an event, so each `get_state` round trip is the wait. */
		async function untilState(check: (state: RpcSessionState) => boolean, message: string): Promise<void> {
			await withTimeout(
				(async () => {
					while (!check(await client.getState()));
				})(),
				10_000,
				message,
			);
		}

		/** Runs one more prompt to completion and returns the transcript. A withdrawn message the
		 *  abort left behind would start its own turn and be recorded before (or instead of) it. */
		async function transcriptAfterNextPrompt(): Promise<AgentMessage[]> {
			const reportedIds = new Set<string | undefined>();
			const reported = Promise.withResolvers<void>();
			let promptId: string | undefined;
			const unsubscribe = client.onPromptResult(result => {
				reportedIds.add(result.id);
				if (result.id === promptId) reported.resolve();
			});
			try {
				promptId = await client.prompt("after abort");
				if (reportedIds.has(promptId)) reported.resolve();
				await withTimeout(reported.promise, 10_000, "Post-abort prompt never reported its result");
			} finally {
				unsubscribe();
			}
			return client.getMessages();
		}

		function userTexts(messages: AgentMessage[]): unknown[] {
			return messages.filter(message => message.role === "user").map(message => message.content);
		}

		const expectedUserTurns = [
			[{ type: "text", text: "start a long turn" }],
			[{ type: "text", text: "after abort" }],
		];

		test("returns queued steering and follow-ups, interrupts as the user, and runs none of them after", async () => {
			await startStreamingTurn();
			await client.steer("queued steer");
			await client.followUp("queued follow-up");

			expect(await client.abortAndRestoreQueue()).toEqual({
				steering: [{ text: "queued steer" }],
				followUp: [{ text: "queued follow-up" }],
			});
			expect((await client.getState()).queuedMessageCount).toBe(0);
			const messages = await transcriptAfterNextPrompt();
			expect(userTexts(messages)).toEqual(expectedUserTurns);
			// The transcript marks the stop as a deliberate user interrupt, as TUI Esc does.
			expect(
				messages.find(message => message.role === "assistant" && message.stopReason === "aborted"),
			).toMatchObject({ errorMessage: USER_INTERRUPT_LABEL });
		}, 30_000);

		test("drops a queued non-user steer without returning or running it", async () => {
			await startStreamingTurn("internal-steer");
			await untilState(state => state.queuedMessageCount === 1, "Internal steer was never queued");
			await client.steer("queued steer");

			expect(await client.abortAndRestoreQueue()).toEqual({ steering: [{ text: "queued steer" }], followUp: [] });
			expect((await client.getState()).queuedMessageCount).toBe(0);
			const messages = await transcriptAfterNextPrompt();
			expect(messages.filter(message => message.role === "custom")).toEqual([]);
			expect(userTexts(messages)).toEqual(expectedUserTurns);
		}, 30_000);

		test("withdraws a steer the streaming response already claimed live", async () => {
			await startStreamingTurn("live-steer");
			await client.steer("live steer");
			// Claimed: it left the pending queue but stays listed until the transcript records it.
			await untilState(
				state => state.queuedMessageCount === 0 && state.queuedMessages.steering.includes("live steer"),
				"Provider never claimed the steer",
			);

			expect(await client.abortAndRestoreQueue()).toEqual({ steering: [{ text: "live steer" }], followUp: [] });
			expect(userTexts(await transcriptAfterNextPrompt())).toEqual(expectedUserTurns);
		}, 30_000);

		test("under protocol v1, a result over the frame limit drops images and still returns every text", async () => {
			// RpcClient always negotiates v2, so speak raw v1 JSONL to the fixture.
			const child = Bun.spawn(
				[process.execPath, path.join(import.meta.dir, "fixtures", "queued-message-rpc-agent.ts")],
				{
					cwd: directory,
					env: { ...Bun.env, PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1", QUEUED_RPC_SCRIPT: "hold" },
					stdin: "pipe",
					stdout: "pipe",
					stderr: "ignore",
				},
			);
			const frames = readJsonl<unknown>(child.stdout)[Symbol.asyncIterator]();
			const next = (match: (frame: Record<string, unknown>) => boolean, message: string) =>
				withTimeout(
					(async () => {
						for (;;) {
							const { value, done } = await frames.next();
							if (done) throw new Error(`RPC output ended: ${message}`);
							if (isRecord(value) && match(value)) return value;
						}
					})(),
					10_000,
					message,
				);
			const send = async (frame: object) => {
				child.stdin.write(`${JSON.stringify(frame)}\n`);
				await child.stdin.flush();
			};
			const isResponse = (id: string) => (frame: Record<string, unknown>) =>
				frame.type === "response" && frame.id === id;
			try {
				await next(frame => frame.type === "ready", "Fixture never became ready");
				await send({ id: "start", type: "prompt", message: "start a long turn" });
				await next(frame => frame.type === "agent_start", "First turn never started streaming");
				// Each steer fits one v1 frame; together they exceed it. Undecodable image bytes skip
				// resizing, so the queued images keep their size.
				const image = { type: "image", mimeType: "image/png", data: "A".repeat(700 * 1024) };
				for (const id of ["first", "second"]) {
					await send({ id, type: "steer", message: `${id} steer`, images: [image] });
					expect(await next(isResponse(id), `Steer ${id} was never acknowledged`)).toMatchObject({
						success: true,
					});
				}

				await send({ id: "stop", type: "abort_and_restore_queue" });
				expect(await next(isResponse("stop"), "abort_and_restore_queue never responded")).toEqual({
					id: "stop",
					type: "response",
					command: "abort_and_restore_queue",
					success: true,
					data: {
						steering: [{ text: "first steer" }, { text: "second steer" }],
						followUp: [],
						imagesDropped: true,
					},
				});
			} finally {
				child.kill();
				await child.exited;
			}
		}, 30_000);

		test("keeps an oldest-first prefix flagged truncated when even the texts exceed the limit", () => {
			const first = { text: "a".repeat(100) };
			const restored = {
				steering: [{ ...first, images: [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }] }],
				followUp: [{ text: "b".repeat(100) }, { text: "c" }],
			};
			const expected: RpcResponse = {
				id: "stop",
				type: "response",
				command: "abort_and_restore_queue",
				success: true,
				data: { steering: [first], followUp: [], imagesDropped: true, truncated: true },
			};
			// Exactly the size of the expected response: the boundary must still admit `first`.
			const maxBytes = Buffer.byteLength(JSON.stringify(expected));
			expect(fitAbortAndRestoreQueueResponse("stop", restored, maxBytes)).toEqual(expected);
		});
	});
});
