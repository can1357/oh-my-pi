import { describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { handleRpcGenerateTitle, type RpcGenerateTitleSession } from "../src/modes/rpc/rpc-mode";

function userMessage(text: string, timestamp = Date.now()): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function sessionWith(
	messages: AgentMessage[],
	generateTitle: RpcGenerateTitleSession["generateTitle"] = async firstMessage =>
		firstMessage.trim() ? "Generated Title" : null,
): RpcGenerateTitleSession {
	return { messages, generateTitle };
}

describe("RPC generate_title command", () => {
	it("responds with a title generated from the first user message", async () => {
		const generateTitle = vi.fn(async () => "Deploy fix");
		const session = sessionWith(
			[
				userMessage("Deploy the fix"),
				{
					role: "assistant",
					content: [{ type: "text", text: "Done" }],
					timestamp: 1,
					api: "anthropic-messages",
					provider: "anthropic",
					model: "test",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
				},
			],
			generateTitle,
		);

		const response = await handleRpcGenerateTitle("t-1", session, undefined);

		expect(response).toEqual({
			id: "t-1",
			type: "response",
			command: "generate_title",
			success: true,
			data: { title: "Deploy fix" },
		});
		expect(generateTitle).toHaveBeenCalledWith("Deploy the fix", undefined);
	});

	it("forwards custom instructions as the title prompt override", async () => {
		const generateTitle = vi.fn(async () => "Ops ticket");
		const session = sessionWith([userMessage("Deploy the fix")], generateTitle);

		await handleRpcGenerateTitle("t-2", session, "Name it like an ops ticket");

		expect(generateTitle).toHaveBeenCalledWith("Deploy the fix", "Name it like an ops ticket");
	});

	it("responds title null without calling the generator when there is no user message yet", async () => {
		const generateTitle = vi.fn();
		const session = sessionWith([], generateTitle);

		const response = await handleRpcGenerateTitle("t-3", session, undefined);

		expect(response).toEqual({
			id: "t-3",
			type: "response",
			command: "generate_title",
			success: true,
			data: { title: null },
		});
		expect(generateTitle).not.toHaveBeenCalled();
	});

	it("skips empty user messages when locating the title anchor", async () => {
		const generateTitle = vi.fn(async () => "Deploy fix");
		const session = sessionWith([userMessage("   "), userMessage("Deploy the fix")], generateTitle);

		await handleRpcGenerateTitle("t-4", session, undefined);

		expect(generateTitle).toHaveBeenCalledWith("Deploy the fix", undefined);
	});

	it("propagates generator failure as a failed response", async () => {
		const session = sessionWith([userMessage("Deploy the fix")], async () => {
			throw new Error("title model unavailable");
		});

		const response = await handleRpcGenerateTitle("t-5", session, undefined);

		expect(response).toEqual({
			id: "t-5",
			type: "response",
			command: "generate_title",
			success: false,
			error: "title model unavailable",
		});
	});
});
