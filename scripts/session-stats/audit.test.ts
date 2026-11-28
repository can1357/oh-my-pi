import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { scanFile } from "./audit";

// The audit estimates prompt and result tokens: an elide pass's record must count
// as its placeholder, as the session reads after a full rewrite.
it("scanFile reads entries with the fields their entry_patch records set, as when written inline", async () => {
	using dir = TempDir.createSync("@omp-audit-entry-patch-");
	const prompt = `fix the bug\n${"a pasted log line\n".repeat(100)}(end)`;
	const promptElided = "fix the bug\n[shaken ~450 tokens — recover: artifact://1 (region 1)]";
	const output = "z".repeat(8000);
	const outputElided = "[shaken ~2000 tokens — recover: artifact://1 (region 2)]";
	const transcript = (inline: boolean): string => {
		const lines: Record<string, unknown>[] = [
			{ type: "session", id: "s1", timestamp: "2026-06-09T10:00:00.000Z", title: "Patched session" },
			{
				type: "message",
				id: "u1",
				parentId: null,
				message: { role: "user", content: inline ? promptElided : prompt, timestamp: 1000 },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				message: {
					role: "assistant",
					model: "test-model",
					stopReason: "toolUse",
					timestamp: 2000,
					usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
					content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "cat big.log" } }],
				},
			},
			{
				type: "message",
				id: "r1",
				parentId: "a1",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "bash",
					isError: false,
					timestamp: 2500,
					content: [{ type: "text", text: inline ? outputElided : output }],
				},
			},
		];
		if (!inline) {
			lines.push({
				type: "custom",
				customType: "entry_patch",
				id: "p1",
				parentId: "r1",
				data: {
					patches: [
						{ entryId: "u1", message: { content: promptElided } },
						{ entryId: "r1", message: { content: [{ type: "text", text: outputElided }] } },
					],
				},
			});
		}
		return `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
	};
	for (const inline of [false, true]) {
		const file = path.join(dir.path(), `entry-patch-${inline ? "inline" : "patched"}.jsonl`);
		await Bun.write(file, transcript(inline));
		const scan = await scanFile(file);
		expect({
			inline,
			promptTokens: scan?.turns.map(turn => turn.tokens),
			resultTokens: scan?.toolAgg.get("bash")?.resultToks,
		}).toEqual({
			inline,
			promptTokens: [Math.ceil(promptElided.length / 4)],
			resultTokens: Math.ceil(outputElided.length / 4),
		});
	}
});
