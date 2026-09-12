import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";

describe("RPC queued-message removal", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-remove-"));
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
});
