import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";

describe("RPC queued-message promotion", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-promote-"));
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

	test("rejects malformed input, preserves missing targets, and promotes without duplicate delivery", async () => {
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
});
