import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
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
		tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-stage1-input-test-"));
	});

	afterEach(async () => {
		try {
			vi.restoreAllMocks();
		} finally {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		}
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
	}, 30_000);

	it("excludes signed and redacted reasoning from the stage-1 extraction payload", async () => {
		const filePath = path.join(tempDir, "reasoning.jsonl");
		const messages = [
			{ role: "user", content: [{ type: "text", text: "Find the broken build step" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "private analysis", thinkingSignature: "signed-reasoning" },
					{ type: "text", text: "I found the failing step" },
					{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "bun check" } },
				],
				providerPayload: {
					type: "openaiResponsesHistory",
					items: [{ type: "reasoning", summary: "private trace" }],
				},
			},
			{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "type error in build.ts" }] },
			{
				role: "assistant",
				content: [
					{ type: "redactedThinking", data: "opaque-reasoning" },
					{ type: "text", text: "Fix build.ts before running again" },
				],
			},
		];
		await Bun.write(filePath, messages.map(message => JSON.stringify({ type: "message", message })).join("\n"));

		const items = JSON.parse(await buildStage1RolloutItems(filePath, 1000));
		expect(items).toEqual([
			messages[0],
			{ role: "assistant", content: messages[1].content.slice(1) },
			messages[2],
			{ ...messages[3], content: messages[3].content.slice(1) },
		]);
	});

	it("rejects missing rollouts", async () => {
		await expect(buildStage1RolloutItems(path.join(tempDir, "missing.jsonl"), 100)).rejects.toThrow();
	});

	it("builds one file's stage-1 input when another file is renamed over the rollout between its record scan and its message reads", async () => {
		// If this regresses, a memory extracted from a session file another process replaced meanwhile
		// applies the old file's records to the new file's messages, and the extraction model gets the
		// output the new file's record elided.
		const rollout = path.join(tempDir, "rollout.jsonl");
		const result = (id: string, text: string) =>
			JSON.stringify({
				type: "message",
				id,
				message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text }] },
			});
		const elide = (recordId: string, entryId: string) =>
			JSON.stringify({
				type: "custom",
				customType: "entry_patch",
				id: recordId,
				data: { patches: [{ entryId, message: { content: [{ type: "text", text: "elided" }] } }] },
			});
		const body = (...lines: string[]) =>
			`${['{"type":"session","id":"s"}', messageLine(0, "go"), ...lines].join("\n")}\n`;
		// The old file is the longer one, so a read sized by it takes all of the new one.
		const oldFile = body(result("t1", "o".repeat(4096)), elide("p1", "t1"));
		const newFile = body(result("t1", "fresh output"), result("t2", "HEAVY"), elide("p2", "t2"));
		await Bun.write(rollout, oldFile);
		// Every read of the rollout goes through the `read` of its file handle, wherever the runtime defines it.
		const probe = await fs.promises.open(rollout, "r");
		await probe.close();
		let owner: fs.promises.FileHandle = Object.getPrototypeOf(probe);
		while (!Object.hasOwn(owner, "read")) owner = Object.getPrototypeOf(owner);
		const realRead = owner.read;
		let replaced = false;
		// The record scan's first read, then the new file renamed over the rollout, synchronously, before the
		// scan goes on and before any message is read.
		vi.spyOn(owner, "read").mockImplementation(async function (
			this: fs.promises.FileHandle,
			...args: Parameters<typeof realRead>
		) {
			const read = await realRead.apply(this, args);
			if (!replaced) {
				replaced = true;
				fs.writeFileSync(`${rollout}.new`, newFile);
				fs.renameSync(`${rollout}.new`, rollout);
			}
			return read;
		});

		// The whole input from the front, and a budget whose tail is read from the back.
		for (const limit of [10_000_000, 20]) {
			await Bun.write(rollout, oldFile);
			replaced = false;

			const built = await buildStage1RolloutItems(rollout, limit);

			expect({ limit, replaced }).toEqual({ limit, replaced: true });
			expect([
				referenceItems(body(result("t1", "elided")), limit),
				referenceItems(body(result("t1", "fresh output"), result("t2", "elided")), limit),
			]).toContain(built);
		}
	});
});
