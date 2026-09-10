import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

for (const mode of ["chat", "chat-no-sampling", "responses"] as const) {
	it(`forwards gateway fields in the ${mode} provider request body`, async () => {
		const captured: Record<string, unknown>[] = [];
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				captured.push((await request.json()) as Record<string, unknown>);
				const events =
					mode === "responses"
						? [
								{ type: "response.created", response: { id: "resp_capture" } },
								{
									type: "response.output_item.added",
									item: {
										type: "message",
										id: "msg_capture",
										role: "assistant",
										status: "in_progress",
										content: [],
									},
								},
								{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
								{ type: "response.output_text.delta", delta: "ok" },
								{
									type: "response.output_item.done",
									item: {
										type: "message",
										id: "msg_capture",
										role: "assistant",
										status: "completed",
										content: [{ type: "output_text", text: "ok" }],
									},
								},
								{
									type: "response.completed",
									response: {
										id: "resp_capture",
										status: "completed",
										usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
									},
								},
							]
						: [
								{
									id: "chat_capture",
									object: "chat.completion.chunk",
									choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
								},
								{
									id: "chat_capture",
									object: "chat.completion.chunk",
									choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
								},
							];
				return new Response(
					events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") +
						(mode === "responses" ? "" : "data: [DONE]\n\n"),
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-wire-fields-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openai", "local-test-key");
		const model = buildModel({
			id: "wire-capture",
			name: "Wire capture",
			provider: "openai",
			api: mode === "responses" ? "openai-responses" : "openai-completions",
			baseUrl: `${upstream.url}v1`,
			reasoning: false,
			input: ["text"],
			contextWindow: 8192,
			maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		if (mode === "chat-no-sampling") model.compat = { ...model.compat, supportsSamplingParams: false };
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => model,
			version: "test",
		});
		const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
		try {
			const response = await fetch(`${gateway.url}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
				body: JSON.stringify({
					model: model.id,
					messages: [{ role: "user", content: "hello" }],
					stream: false,
					seed: 7,
					logit_bias: { "42": -1 },
					user: "account-1",
					parallel_tool_calls: false,
					response_format: { type: "json_schema", json_schema: { name: "answer", schema, strict: true } },
				}),
			});
			expect(response.status).toBe(200);
			await response.text();
			expect(captured.length).toBe(1);
			const payload = captured[0]!;
			expect(payload.parallel_tool_calls).toBe(false);
			expect(payload.user).toBe("account-1");
			if (mode === "responses") {
				expect(payload.text).toEqual(
					expect.objectContaining({ format: { type: "json_schema", name: "answer", schema, strict: true } }),
				);
				expect(payload).not.toHaveProperty("seed");
				expect(payload).not.toHaveProperty("logit_bias");
				expect(payload).not.toHaveProperty("response_format");
			} else {
				expect(payload.response_format).toEqual({
					type: "json_schema",
					json_schema: { name: "answer", schema, strict: true },
				});
				if (mode === "chat") {
					expect(payload.seed).toBe(7);
					expect(payload.logit_bias).toEqual({ "42": -1 });
				} else {
					expect(payload).not.toHaveProperty("seed");
					expect(payload).not.toHaveProperty("logit_bias");
				}
			}
		} finally {
			await gateway.close();
			storage.close();
			upstream.stop(true);
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
}
