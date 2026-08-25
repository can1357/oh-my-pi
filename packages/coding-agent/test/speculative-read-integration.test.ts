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
		settings: Settings.isolated({
			"images.autoResize": false,
			"inspect_image.enabled": false,
			"tools.speculativeExecution.enabled": true,
			"tools.speculativeExecution.allowedOperations": ["direct.read"],
		}),
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
});
