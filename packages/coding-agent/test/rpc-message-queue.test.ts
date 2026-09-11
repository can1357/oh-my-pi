import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

/** The mock fixture echoes every inbound command with success, so pointing the
 *  client at it lets us assert the exact command type and payload arrive at a
 *  worker — a regression in command naming (e.g. `get_message_queuee`) fails
 *  here with type/payload evidence rather than as an operator-visible fault.
 *  Lives in its own tiny fixture so assertions can differ per probe. */
const MOCK = path.join(import.meta.dir, "fixtures", "rpc-queue-echo.ts");

describe("RpcClient message queue (operator queued-message controls)", () => {
	test("get_message_queue names the command the worker dispatches on", async () => {
		using client = new RpcClient({ cliPath: MOCK });
		await client.start();
		const queue = (await client.getMessageQueue("s1")) as unknown as Record<string, unknown>;
		// The fixture echoes the received command body; a client regression that
		// renames or drops any field shows up here as the mismatched key/value.
		expect(queue).toEqual({ sessionId: "s1", commandSeen: "get_message_queue" });
	}, 20_000);

	test("update_message_queue forwards revision, item id and action untouched", async () => {
		using client = new RpcClient({ cliPath: MOCK });
		await client.start();
		const queue = (await client.updateMessageQueue({
			sessionId: "s1",
			expectedRevision: "r1",
			itemId: "q1",
			action: "delete",
		})) as unknown as Record<string, unknown>;
		expect(queue).toEqual({
			sessionId: "s1",
			commandSeen: "update_message_queue",
			expectedRevision: "r1",
			itemId: "q1",
			action: "delete",
		});
	}, 20_000);

	test("edit action carries its text through", async () => {
		using client = new RpcClient({ cliPath: MOCK });
		await client.start();
		const queue = (await client.updateMessageQueue({
			sessionId: "s1",
			expectedRevision: "r2",
			itemId: "q2",
			action: "edit",
			text: "new text",
		})) as unknown as Record<string, unknown>;
		expect(queue).toMatchObject({ action: "edit", text: "new text", itemId: "q2" });
	}, 20_000);
});
