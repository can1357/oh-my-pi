import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentMessage, agentLoop } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CodingAgentSpeculativeExecutionHost } from "@oh-my-pi/pi-coding-agent/speculation/host";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => removeWithRetries(directory)));
});

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "images.autoResize": false, "tools.speculativeExecution.enabled": true }),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		message => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

describe("enabled speculative local reads", () => {
	it("starts the physical read before provider completion and commits one normal result", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-read-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "content");
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const finalized = tool.speculation.finalized;
		if (!finalized) throw new Error("read tool has no finalized speculation policy");
		const execute = finalized.execute;
		const started = Promise.withResolvers<void>();
		let providerDone = false;
		let startedBeforeProviderDone = false;
		finalized.execute = async (context, signal) => {
			startedBeforeProviderDone = !providerDone;
			started.resolve();
			return await execute(context, signal);
		};
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });
		const mock = createMockModel({ responses: [] });
		let turn = 0;
		const streamFn = (_model: unknown, _context: Context) => {
			const response = new AssistantMessageEventStream();
			void (async () => {
				if (turn++ === 0) {
					const toolCall = {
						type: "toolCall" as const,
						id: "read-1",
						name: "read",
						arguments: { path: "note.txt" },
					};
					const partial = assistant([toolCall], "toolUse");
					response.push({ type: "start", partial });
					response.push({ type: "toolcall_start", contentIndex: 0, partial });
					response.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
					await started.promise;
					providerDone = true;
					response.push({ type: "done", reason: "toolUse", message: partial });
					return;
				}
				const partial = assistant([{ type: "text", text: "done" }], "stop");
				response.push({ type: "start", partial });
				response.push({ type: "done", reason: "stop", message: partial });
			})();
			return response;
		};

		const messages = await agentLoop(
			[{ role: "user", content: "Read the note", timestamp: Date.now() }],
			{ systemPrompt: [""], messages: [], tools: [tool] },
			{
				model: mock.model,
				convertToLlm: identityConverter,
				speculativeToolExecution: { enabled: true, host },
			},
			undefined,
			streamFn,
		).result();

		expect(startedBeforeProviderDone).toBe(true);
		expect(messages.filter(message => message.role === "toolResult")).toHaveLength(1);
	});

	it("falls back to ordinary image reading when captureEvidence declines a claimed PNG after beforeToolCall", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-read-image-"));
		temporaryDirectories.push(directory);
		// 1x1 PNG generated inline so the test does not depend on external fixtures.
		const tinyPng = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			"base64",
		);
		await fs.writeFile(path.join(directory, "sample.png"), tinyPng);
		const session = createSession(directory);
		const tool = new ReadTool(session);
		const host = new CodingAgentSpeculativeExecutionHost(session.settings, session, { hasHandlers: () => false });
		const captureStarted = Promise.withResolvers<void>();
		const toolExecutionStarted = Promise.withResolvers<void>();
		const captureEvidence = host.captureEvidence.bind(host);
		host.captureEvidence = async context => {
			captureStarted.resolve();
			await toolExecutionStarted.promise;
			return await captureEvidence(context);
		};

		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "read-image-1",
							name: "read",
							arguments: { path: "sample.png" },
						},
					],
				},
				{ content: ["DONE"] },
			],
		});

		const stream = agentLoop(
			[{ role: "user", content: "Use read on sample.png", timestamp: Date.now() }],
			{ systemPrompt: [""], messages: [], tools: [tool] },
			{
				model: mock.model,
				convertToLlm: identityConverter,
				beforeToolCall: async () => undefined,
				speculativeToolExecution: { enabled: true, host },
			},
			undefined,
			mock.stream,
		);

		let sawToolExecutionEnd = false;
		for await (const event of stream) {
			if (event.type === "tool_execution_start" && event.toolCallId === "read-image-1") {
				await captureStarted.promise;
				await Bun.sleep(5);
				toolExecutionStarted.resolve();
			} else if (event.type === "tool_execution_end" && event.toolCallId === "read-image-1") {
				sawToolExecutionEnd = true;
			}
		}

		const messages = await stream.result();
		expect(sawToolExecutionEnd).toBe(true);
		const toolResult = messages.find(message => message.role === "toolResult");
		expect(toolResult).toBeDefined();
		if (!toolResult || toolResult.role !== "toolResult") {
			throw new Error("expected a toolResult message");
		}
		expect(toolResult.isError).toBe(false);
		expect(toolResult.content).toContainEqual({ type: "text", text: "Read image file [image/png]" });
		expect(toolResult.content.some(block => block.type === "image" && block.mimeType === "image/png")).toBe(true);
	});
});
