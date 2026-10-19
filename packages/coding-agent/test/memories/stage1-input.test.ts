import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildStage1RolloutItems } from "@oh-my-pi/pi-coding-agent/memories";
import { parseJsonlLenient } from "@oh-my-pi/pi-utils";

/** Reference: the whole-file read + stringify + head/tail truncation the streaming builder replaces. */
function referenceItems(raw: string, tokenLimit: number): string {
	const messages: unknown[] = [];
	for (const row of parseJsonlLenient<Record<string, unknown>>(raw)) {
		if (!row || typeof row !== "object" || row.type !== "message") continue;
		const message = row.message as { role?: string; toolName?: string; content?: unknown } | undefined;
		if (!message || typeof message !== "object") continue;
		const role = message.role;
		if (role === "system" || role === "developer" || role === "user" || role === "assistant") {
			messages.push(message);
			continue;
		}
		if (role !== "toolResult" || !["bash", "eval", "read", "grep"].includes(message.toolName ?? "")) continue;
		const content = Array.isArray(message.content) ? (message.content as Array<{ type: string; text?: string }>) : [];
		const text = content.map(item => (item.type === "text" ? (item.text ?? "") : "")).join("\n");
		if (text.length > 0 && text.length <= 32_000) messages.push(message);
	}
	const text = JSON.stringify(messages);
	if (tokenLimit <= 0) return "";
	const maxChars = tokenLimit * 4;
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.6);
	return `${text.slice(0, head)}\n\n...[truncated]...\n\n${text.slice(-(maxChars - head))}`;
}

function messageLine(index: number, body: string): string {
	const role = index % 3 === 0 ? "user" : index % 3 === 1 ? "assistant" : "toolResult";
	const message =
		role === "toolResult"
			? { role, toolName: index % 2 ? "bash" : "edit", content: [{ type: "text", text: body }] }
			: { role, content: [{ type: "text", text: body }] };
	return JSON.stringify({ type: "message", id: `m${index}`, message });
}

describe("buildStage1RolloutItems", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stage1-input-test-"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function expectParity(raw: string, limits: number[]): Promise<void> {
		const filePath = path.join(tempDir, "rollout.jsonl");
		await Bun.write(filePath, raw);
		for (const limit of limits) {
			expect(await buildStage1RolloutItems(filePath, limit)).toBe(referenceItems(raw, limit));
		}
	}

	it("matches whole-file truncation for small rollouts, malformed lines and multibyte text", async () => {
		const lines = ['{"type":"session","id":"s"}', "not json", ""];
		for (let i = 0; i < 40; i++) lines.push(messageLine(i, `turn ${i} — ünïcødé 🚀 ${"x".repeat(i * 7)}`));
		await expectParity(`${lines.join("\n")}\n`, [0, 1, 5, 50, 400, 4000, 1_000_000]);
		await expectParity(lines.join("\r\n"), [3, 120, 4000]);
		await expectParity("", [10]);
	});

	it("matches whole-file truncation when lines straddle multi-megabyte windows", async () => {
		const lines: string[] = [];
		let size = 0;
		for (let i = 0; size < 3_500_000; i++) {
			const line = messageLine(i, `${i}:${"é".repeat((i * 9973) % 20_000)}🚀`);
			lines.push(line);
			size += line.length + 1;
		}
		// One record larger than a whole window.
		lines.splice(lines.length - 3, 0, messageLine(3, "y".repeat(1_500_000)));
		await expectParity(`${lines.join("\n")}\n`, [1, 4000, 100_000, 10_000_000]);
	});

	it("rejects missing rollouts", async () => {
		await expect(buildStage1RolloutItems(path.join(tempDir, "missing.jsonl"), 100)).rejects.toThrow();
	});
});
