import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentEvent, type AgentMessage, type AgentToolContext, agentLoop } from "@oh-my-pi/pi-agent-core";
import type { Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => removeWithRetries(directory)));
});

/** One assistant message: `bash command`, then `read readPath`. Returns the read's result and the batch's events. */
async function bashThenRead(directory: string, command: string, readPath: string) {
	const session = {
		cwd: directory,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
		}),
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
	const mock = createMockModel({
		responses: [
			{
				content: [
					{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command } },
					{ type: "toolCall", id: "read-1", name: "read", arguments: { path: readPath } },
				],
			},
			{ content: ["done"] },
		],
	});
	const events: AgentEvent[] = [];
	const stream = agentLoop(
		[{ role: "user", content: "Run the command, then read", timestamp: Date.now() }],
		{ systemPrompt: [""], messages: [], tools: [new BashTool(session), new ReadTool(session)] },
		{
			model: mock.model,
			convertToLlm: (all: AgentMessage[]) =>
				all.filter(
					message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
				) as Message[],
			getToolContext: toolCall => ({ toolCall }) as AgentToolContext,
		},
		undefined,
		mock.stream,
	);
	for await (const event of stream) events.push(event);
	const messages = await stream.result();
	const read = messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === "read-1",
	);
	if (!read) throw new Error("no read result");
	const text = read.content.map(block => (block.type === "text" ? block.text : "")).join("");
	return { text, isError: read.isError, events };
}

async function tempDirectory(): Promise<string> {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "read-after-bash-")));
	temporaryDirectories.push(directory);
	return directory;
}

describe("a read after a bash call in the same message", () => {
	it("returns the file as the bash command left it, without waiting to start", async () => {
		const directory = await tempDirectory();
		await Bun.write(path.join(directory, "f"), "old\n");

		const { text, events } = await bashThenRead(directory, "sleep 0.2; echo new > f", "f");

		expect(text).toContain("new");
		expect(text).not.toContain("old");
		// The read still started while the bash call ran.
		const readStart = events.findIndex(
			event => event.type === "tool_execution_start" && event.toolCallId === "read-1",
		);
		const bashEnd = events.findIndex(event => event.type === "tool_execution_end" && event.toolCallId === "bash-1");
		expect(readStart).toBeGreaterThanOrEqual(0);
		expect(readStart).toBeLessThan(bashEnd);
	});

	it("returns a file the bash command created instead of a not-found error", async () => {
		const directory = await tempDirectory();

		const { text, isError } = await bashThenRead(directory, "sleep 0.2; echo created > f", "f");

		expect(isError).toBe(false);
		expect(text).toContain("created");
	});

	it("reports a file the bash command deleted as missing", async () => {
		const directory = await tempDirectory();
		await Bun.write(path.join(directory, "f"), "doomed\n");

		const { text, isError } = await bashThenRead(directory, "sleep 0.2; rm f", "f");

		expect(isError).toBe(true);
		expect(text).not.toContain("doomed");
	});

	it("lists an entry the bash command added to a subdirectory of the listed directory", async () => {
		const directory = await tempDirectory();
		await fs.mkdir(path.join(directory, "out", "nested"), { recursive: true });
		await Bun.write(path.join(directory, "out", "nested", "a.txt"), "a\n");

		const { text } = await bashThenRead(directory, "sleep 0.2; echo b > out/nested/b.txt", "out");

		expect(text).toContain("b.txt");
	});
});
