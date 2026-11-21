import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { runAnonymizeCommand } from "../src/cli/anonymize-cli";
import { CliUsageError } from "../src/cli/usage-error";
import { collectPendingToolCalls } from "../src/session/exit-diagnostics";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

const SESSION = `${JSON.stringify({ type: "session", version: 3, id: "01a0c9ac", timestamp: "2026-10-01T00:00:00.000Z", cwd: "/tmp" })}
${JSON.stringify({ type: "message", id: "a1b2c3d4", parentId: null, timestamp: "2026-10-01T00:00:01.000Z", message: { role: "user", content: "keep me", timestamp: 1 } })}
`;

describe("omp anonymize output", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-anonymize-");
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	it("resumes an anonymized session with a completed read and pending edit without treating text as an image", async () => {
		const seed = SessionManager.inMemory(tempDir.path());
		const assistant: Omit<AssistantMessage, "content" | "stopReason"> = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			timestamp: 1,
			usage: {
				input: 120,
				output: 30,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		seed.appendMessage({ role: "user", content: "Update the invoice parser", timestamp: 1 });
		seed.appendMessage({
			...assistant,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "toolu_01readabcdef", name: "read", arguments: { path: "billing.ts" } }],
		});
		seed.appendMessage({
			role: "toolResult",
			toolCallId: "toolu_01readabcdef",
			toolName: "read",
			content: [{ type: "text", text: "export const customer = 'alice';" }],
			isError: false,
			timestamp: 2,
		});
		seed.appendMessage({
			...assistant,
			stopReason: "toolUse",
			content: [
				{
					type: "toolCall",
					id: "toolu_02editabcdef",
					name: "edit",
					arguments: { path: "billing.ts", old_string: "alice", new_string: "bob" },
				},
			],
		});
		const source = path.join(tempDir.path(), "main.jsonl");
		await Bun.write(
			source,
			`${[seed.getHeader(), ...seed.getEntries()].map(entry => JSON.stringify(entry)).join("\n")}\n`,
		);
		const out = path.join(tempDir.path(), "out");
		await runAnonymizeCommand({ session: source, out });
		const resumed = await SessionManager.open(path.join(out, "session.jsonl"), tempDir.path(), undefined, {
			initialCwd: tempDir.path(),
			suppressBreadcrumb: true,
		});
		try {
			expect(collectPendingToolCalls(resumed.getBranch())).toContainEqual(
				expect.objectContaining({ toolName: "edit", toolCallId: "toolu_02editabcdef" }),
			);
			const model = getBundledModel<"anthropic-messages">("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled model");
			const wire = convertAnthropicMessages(convertToLlm(resumed.buildSessionContext().messages), model, false);
			const result = wire
				.flatMap(message => (typeof message.content === "string" ? [] : message.content))
				.find(block => block.type === "tool_result");
			expect(result?.content).toEqual([{ type: "text", text: expect.stringMatching(/^\[redacted #\d+:/) }]);
		} finally {
			await resumed.close();
			await seed.close();
		}
	});

	it("refuses an --out directory that would overwrite or bundle the source session", async () => {
		const source = path.join(tempDir.path(), "session.jsonl");
		await Bun.write(source, SESSION);

		await expect(runAnonymizeCommand({ session: source, out: tempDir.path() })).rejects.toThrow(
			"would mix the export with raw session transcripts",
		);
		expect(await Bun.file(source).text()).toBe(SESSION);
	});

	it("refuses an --out directory inside the raw subagent directory, even before it exists", async () => {
		const source = path.join(tempDir.path(), "main.jsonl");
		await Bun.write(source, SESSION);
		await Bun.write(path.join(tempDir.path(), "main", "Scout.jsonl"), SESSION);

		await expect(runAnonymizeCommand({ session: source, out: path.join(tempDir.path(), "main") })).rejects.toThrow(
			"would mix the export with raw session transcripts",
		);
		expect(await Bun.file(path.join(tempDir.path(), "main", "session.jsonl")).exists()).toBe(false);
	});

	it("refuses an existing non-empty --out directory instead of merging into it", async () => {
		const source = path.join(tempDir.path(), "main.jsonl");
		const out = path.join(tempDir.path(), "report");
		await Bun.write(source, SESSION);
		await Bun.write(path.join(out, "raw-notes.txt"), "keep me");

		await expect(runAnonymizeCommand({ session: source, out })).rejects.toThrow("is not empty");
		expect(await Bun.file(path.join(out, "session.jsonl")).exists()).toBe(false);
	});

	it("rejects a file without a valid session header instead of writing an empty bundle", async () => {
		const source = path.join(tempDir.path(), "notes.jsonl");
		const out = path.join(tempDir.path(), "out");
		await Bun.write(source, `${JSON.stringify({ hello: "world" })}\n`);

		await expect(runAnonymizeCommand({ session: source, out })).rejects.toThrow("is not a valid session file");
		expect(await Bun.file(path.join(out, "session.jsonl")).exists()).toBe(false);
	});

	it("reports a directory session argument as a usage error", async () => {
		await expect(
			runAnonymizeCommand({ session: `${tempDir.path()}${path.sep}`, out: path.join(tempDir.path(), "out") }),
		).rejects.toBeInstanceOf(CliUsageError);
	});

	it("reports an --out path that is an existing file as a usage error", async () => {
		const source = path.join(tempDir.path(), "main.jsonl");
		const out = path.join(tempDir.path(), "report.zip");
		await Bun.write(source, SESSION);
		await Bun.write(out, "zip");
		await expect(runAnonymizeCommand({ session: source, out })).rejects.toThrow("is not a directory");
	});

	it("reports an unknown session path as a usage error", async () => {
		const missing = path.join(tempDir.path(), "missing.jsonl");
		await expect(
			runAnonymizeCommand({ session: missing, out: path.join(tempDir.path(), "out") }),
		).rejects.toBeInstanceOf(CliUsageError);
	});

	it("finds subagents next to the real file when the session argument is a symlink", async () => {
		const real = path.join(tempDir.path(), "real", "main.jsonl");
		await Bun.write(real, SESSION);
		await Bun.write(path.join(tempDir.path(), "real", "main", "Scout.jsonl"), SESSION);
		const link = path.join(tempDir.path(), "link.jsonl");
		try {
			await fs.symlink(real, link, "file");
		} catch {
			return; // Symlink creation needs developer mode on Windows; nothing to verify without one.
		}
		const out = path.join(tempDir.path(), "out");
		await runAnonymizeCommand({ session: link, out });
		expect(await Array.fromAsync(new Bun.Glob("subagents/*.jsonl").scan(out))).toHaveLength(1);
	});
});
