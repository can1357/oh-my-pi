import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

async function writeSessionWithoutUsage(dir: string): Promise<string> {
	const file = path.join(dir, "no-usage.jsonl");
	const timestamp = new Date().toISOString();
	const lines = [
		{ type: "session", version: 3, id: "no-usage", timestamp, cwd: dir },
		{
			type: "message",
			id: "a1",
			parentId: null,
			timestamp,
			message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1 },
		},
	];
	await Bun.write(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

describe("assistant messages persisted without usage", () => {
	it("load as zero usage instead of crashing the transcript", async () => {
		using tempDir = TempDir.createSync("@pi-missing-usage-");
		const session = await SessionManager.open(await writeSessionWithoutUsage(tempDir.path()), tempDir.path());

		const [message] = session.buildSessionContext().messages;
		expect(message?.role === "assistant" && message.usage.cacheRead).toBe(0);
		expect(session.getUsageStatistics().cost).toBe(0);
	});

	it("record as zero usage when appended live", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			timestamp: 1,
		} as unknown as AssistantMessage);

		const [message] = session.buildSessionContext().messages;
		expect(message?.role === "assistant" && message.usage.totalTokens).toBe(0);
		expect(session.getUsageStatistics().cost).toBe(0);
	});

	it("loads partial token usage without inventing a charge", async () => {
		using tempDir = TempDir.createSync("@pi-partial-usage-");
		const file = path.join(tempDir.path(), "partial-usage.jsonl");
		const timestamp = new Date().toISOString();
		await Bun.write(
			file,
			[
				JSON.stringify({ type: "session", version: 3, id: "partial-usage", timestamp, cwd: tempDir.path() }),
				JSON.stringify({
					type: "message",
					id: "a1",
					parentId: null,
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hi" }],
						model: "qq",
						provider: "qq",
						usage: { input: 1, output: 2 },
						stopReason: "stop",
						timestamp: 1,
					},
				}),
			].join("\n") + "\n",
		);
		const session = await SessionManager.open(file, tempDir.path());
		const [message] = session.buildSessionContext().messages;
		expect(message?.role === "assistant" && message.usage.totalTokens).toBe(3);
		expect(session.getUsageStatistics()).toMatchObject({ input: 1, output: 2, cost: 0 });
	});

	it("fork as zero usage instead of leaving it undefined", async () => {
		using tempDir = TempDir.createSync("@pi-fork-missing-usage-");
		const source = await writeSessionWithoutUsage(tempDir.path());
		const session = await SessionManager.forkFrom(source, tempDir.path(), path.join(tempDir.path(), "forks"));

		const [message] = session.buildSessionContext().messages;
		expect(message?.role === "assistant" && message.usage.cacheRead).toBe(0);
		expect(session.getUsageStatistics().cost).toBe(0);
	});
});
