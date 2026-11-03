import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const primary = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const fallback = getBundledModel("anthropic", "claude-opus-4-5")!;
const creditBody = {
	type: "error",
	error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." },
};

/** An Anthropic SSE reply; `signed` adds a signed thinking block, which pins later turns to the same model. */
function reply(text: string, signed: boolean): Response {
	const frames: Array<[string, unknown]> = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_ok",
					type: "message",
					role: "assistant",
					content: [],
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
		],
	];
	if (signed) {
		frames.push(
			[
				"content_block_start",
				{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
			],
			[
				"content_block_delta",
				{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Reasoning" } },
			],
			[
				"content_block_delta",
				{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
			],
			["content_block_stop", { type: "content_block_stop", index: 0 }],
		);
	}
	const index = signed ? 1 : 0;
	frames.push(
		["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }],
		["content_block_stop", { type: "content_block_stop", index }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
		["message_stop", { type: "message_stop" }],
	);
	return new Response(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

describe("credit-balance rejection with a fallback chain", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	it("falls back when retry.maxDelayMs is below the credit wait, even with signed thinking in history", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "credit-fallback-"));
		cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
		const requests: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				const body = (await req.json()) as { model: string };
				requests.push(body.model);
				if (requests.length === 1) return reply("Seeded", true);
				if (body.model === primary.id) return Response.json(creditBody, { status: 400 });
				return reply("Recovered on fallback", false);
			},
		});
		cleanups.push(() => server.stop(true));
		const auth = await AuthStorage.create(path.join(dir, "auth.db"));
		cleanups.push(() => auth.close());
		auth.keys.setRuntime("anthropic", "test");
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 1000,
			"retry.maxRetries": 1,
			"retry.fallbackChains": { "anthropic/*": [`anthropic/${fallback.id}`] },
		});
		const baseUrl = server.url.toString().replace(/\/$/, "");
		const agent = new Agent({
			getApiKey: () => "test",
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => streamSimple({ ...model, baseUrl }, context, options),
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(auth, path.join(dir, "models.yml"), { settings }),
		});
		cleanups.push(() => session.dispose());

		await session.prompt("Seed");
		await session.waitForIdle();
		await session.prompt("Continue");
		await session.waitForIdle();

		const last = agent.state.messages.findLast(message => message.role === "assistant");
		expect(last?.stopReason).toBe("stop");
		expect(requests).toEqual([primary.id, primary.id, fallback.id]);
	});
});
