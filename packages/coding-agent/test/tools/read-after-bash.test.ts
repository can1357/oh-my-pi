import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentEvent,
	type AgentMessage,
	type AgentToolContext,
	agentLoop,
	type ToolCallContext,
} from "@oh-my-pi/pi-agent-core";
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

async function tempDirectory(): Promise<string> {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "read-after-bash-")));
	temporaryDirectories.push(directory);
	return directory;
}

function createSession(directory: string): ToolSession {
	return {
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
}

/**
 * One assistant message: `bash`, then `read readPath`. The bash command runs
 * `change` only once the read has returned (the test creates `go` when it sees
 * the read end), so a read that does not wait for bash always sees the file
 * before the change. A read that waits never returns first; bash then stops
 * waiting after half a second.
 */
async function bashThenRead(directory: string, change: string, readPath: string, session = createSession(directory)) {
	const command = `i=0; while [ "$i" -lt 50 ]; do [ -e go ] && break; i=$((i + 1)); sleep 0.01; done; ${change}`;
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
	for await (const event of stream) {
		events.push(event);
		if (event.type === "tool_execution_end" && event.toolCallId === "read-1") {
			await Bun.write(path.join(directory, "go"), "");
		}
	}
	const messages = await stream.result();
	const bash = messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === "bash-1",
	);
	if (!bash || bash.isError) throw new Error(`Bash did not succeed: ${JSON.stringify(bash?.content)}`);
	const read = messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === "read-1",
	);
	if (!read) throw new Error("no read result");
	const text = read.content.map(block => (block.type === "text" ? block.text : "")).join("");
	return { text, isError: read.isError, events };
}

describe.skipIf(process.platform === "win32")("a read after a bash call in the same message", () => {
	it("returns the file as the bash command left it, starting while bash runs", async () => {
		const directory = await tempDirectory();
		await Bun.write(path.join(directory, "f"), "old\n");

		const { text, events } = await bashThenRead(directory, "echo new > f", "f");

		expect(text).toContain("new");
		expect(text).not.toContain("old");
		const readStart = events.findIndex(
			event => event.type === "tool_execution_start" && event.toolCallId === "read-1",
		);
		const bashEnd = events.findIndex(event => event.type === "tool_execution_end" && event.toolCallId === "bash-1");
		expect(readStart).toBeGreaterThanOrEqual(0);
		expect(readStart).toBeLessThan(bashEnd);
	});

	it("returns a file the bash command created instead of a not-found error", async () => {
		const directory = await tempDirectory();

		const { text, isError } = await bashThenRead(directory, "echo created > f", "f");

		expect(isError).toBe(false);
		expect(text).toContain("created");
	});

	it("fetches a web URL without waiting for bash", async () => {
		const directory = await tempDirectory();
		const { server, requests } = pageServer();
		try {
			const { text, events } = await bashThenRead(
				directory,
				"true",
				`http://127.0.0.1:${server.port}/x`,
				fetchSession(directory),
			);

			expect(text).toContain("page body");
			expect(requests.count).toBe(1);
			const readEnd = events.findIndex(
				event => event.type === "tool_execution_end" && event.toolCallId === "read-1",
			);
			const bashEnd = events.findIndex(
				event => event.type === "tool_execution_end" && event.toolCallId === "bash-1",
			);
			expect(readEnd).toBeLessThan(bashEnd);
		} finally {
			server.stop(true);
		}
	});

	it("splits a URL from a local file the bash command created in the same `;` list", async () => {
		const directory = await tempDirectory();
		const { server } = pageServer();
		try {
			const { text } = await bashThenRead(
				directory,
				"echo written-by-bash > generated.txt",
				`http://127.0.0.1:${server.port}/page;generated.txt`,
				fetchSession(directory),
			);

			expect(text).toContain("page body");
			expect(text).toContain("written-by-bash");
		} finally {
			server.stop(true);
		}
	});
});

function pageServer() {
	const requests = { count: 0 };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			requests.count++;
			return new Response("page body", { headers: { "content-type": "text/plain" } });
		},
	});
	return { server, requests };
}

function fetchSession(directory: string): ToolSession {
	return {
		...createSession(directory),
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			"fetch.enabled": true,
		}),
		getArtifactsDir: () => path.join(directory, "artifacts"),
		allocateOutputArtifact: async (toolType: string) => ({
			id: "test",
			path: path.join(directory, "artifacts", `test.${toolType}.log`),
		}),
	} as unknown as ToolSession;
}

describe("a read beside an earlier writing call", () => {
	it("stops waiting for that call when the read is aborted", async () => {
		const directory = await tempDirectory();
		await Bun.write(path.join(directory, "f"), "old\n");
		const controller = new AbortController();
		const { promise: neverSettles } = Promise.withResolvers<void>();
		const toolCall: ToolCallContext = {
			batchId: "b",
			index: 1,
			total: 2,
			toolCalls: [],
			earlierEffectsSettled: neverSettles,
		};

		const read = new ReadTool(createSession(directory)).execute(
			"read-1",
			{ path: "f" },
			controller.signal,
			undefined,
			{
				toolCall,
			} as AgentToolContext,
		);
		controller.abort();

		// A read that ignored its signal would wait for the call forever; the
		// abort rejects it instead of returning a read it did not check.
		await expect(read).rejects.toThrow(/^Aborted/);
	});
});
