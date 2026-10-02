import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcPromptResultFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";

describe("RPC queued-message editing", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-queued-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "queued-message-rpc-agent.ts")],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
	});

	afterEach(async () => {
		await client?.stop();
		await removeWithRetries(directory);
	});

	test("validates removal and delivers only the surviving queued request", async () => {
		await client.start();
		await client.followUp("cancel this");
		await client.followUp("keep this");
		await expect(client.removeQueuedMessage(null as unknown as string, "followUp")).rejects.toMatchObject({
			command: "remove_queued_message",
		});
		await expect(client.removeQueuedMessage("cancel this", "steer" as unknown as "steering")).rejects.toMatchObject({
			command: "remove_queued_message",
		});
		await expect(client.removeQueuedMessage("cancel this", undefined as unknown as "steering")).rejects.toMatchObject(
			{ command: "remove_queued_message" },
		);
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

	test("queue_update mirrors get_state.queuedMessages, matches the removal invariant, and never repeats", async () => {
		await client.start();

		const updates: Array<{ steering: string[]; followUp: string[] }> = [];
		const unsubscribe = client.onSessionEvent(event => {
			if (event.type === "queue_update") updates.push({ steering: event.steering, followUp: event.followUp });
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
			expect(updates.at(-1)).toEqual({ steering: [], followUp: [] });
			expect((await client.getState()).queuedMessages).toEqual({ steering: [], followUp: [] });

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
			expect(updates.at(-1)).toEqual({ steering: [], followUp: [] });
			expect((await client.getState()).queuedMessages).toEqual({ steering: [], followUp: [] });

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
		await expect(client.promoteQueuedMessage(null as unknown as string)).rejects.toMatchObject({
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
});
