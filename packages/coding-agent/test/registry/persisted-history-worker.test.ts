import { expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { readHistoryOffThread } from "../../src/registry/persisted-history-client";
import { readPersistedAgentHistoryInline } from "../../src/registry/persisted-agents";

it("returns the same usage and model attribution as the transcript reader", async () => {
	using dir = TempDir.createSync("history-worker-");
	const file = `${dir.path()}/child.jsonl`;
	await Bun.write(
		file,
		[
			{ type: "session", id: "child", version: 3, timestamp: "2026-10-01T00:00:00Z", cwd: dir.path() },
			{
				type: "message",
				id: "reply",
				parentId: null,
				timestamp: "2026-10-01T00:00:01Z",
				message: {
					role: "assistant",
					provider: "test",
					model: "test-model",
					stopReason: "stop",
					content: [{ type: "text", text: "x".repeat(1024 * 1024) }],
					usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.5 } },
				},
			},
		]
			.map(value => JSON.stringify(value))
			.join("\n") + "\n",
	);
	const transcript = { id: "child", sessionFile: file };
	const expected = await readPersistedAgentHistoryInline(transcript, () => true);
	const history = await readHistoryOffThread(transcript, () => true);
	expect(history).toEqual(expected);
	expect(history.directCost).toBe(0.5);
});

it("does not accept results after the caller cancels", async () => {
	let active = true;
	const pending = readHistoryOffThread({ id: "absent", sessionFile: "/nonexistent/worker.jsonl" }, () => active);
	active = false;
	expect(await pending).toEqual({});
});
