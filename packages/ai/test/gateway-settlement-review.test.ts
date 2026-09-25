import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { ProviderHealthBook } from "@oh-my-pi/pi-ai/auth-gateway/provider-health";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as Stream from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

afterEach(() => vi.restoreAllMocks());
for (const succeeds of [true, false]) {
	it(`settles stream health and hooks only after ${succeeds ? "success" : "late failure"}`, async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-settlement-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const model = createMockModel({ provider: "openrouter", id: "late-result" }).model;
		const events = new AssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			api: "mock",
			provider: "openrouter",
			model: model.id,
			content: [{ type: "text", text: "started" }],
			stopReason: "stop",
			timestamp: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		vi.spyOn(Stream, "streamSimple").mockImplementation((_model, _context, options) => {
			options?.onSseEvent?.(
				{ event: "response.output_text.delta", data: "{}", raw: ["event: response.output_text.delta", "data: {}"] },
				model,
			);
			return events;
		});
		const success = vi.spyOn(ProviderHealthBook.prototype, "recordSuccess");
		const attempts: boolean[] = [];
		const requests: boolean[] = [];
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => model,
			version: "test",
			hooks: {
				afterAttempt: ctx => {
					attempts.push(ctx.ok);
				},
				afterRequest: ctx => {
					requests.push(ctx.ok);
				},
			},
		});
		try {
			events.push({ type: "start", partial: message });
			events.push({ type: "text_delta", contentIndex: 0, delta: "started", partial: message });
			const response = await fetch(`${gateway.url}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
				body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "hello" }], stream: true }),
			});
			expect(response.status).toBe(200);
			const reader = response.body!.getReader();
			expect((await reader.read()).done).toBe(false);
			expect(success).toHaveBeenCalledTimes(0);
			expect(requests).toEqual([]);
			expect(attempts).toEqual([]);
			if (succeeds) events.push({ type: "done", reason: "stop", message });
			else
				events.push({
					type: "error",
					reason: "error",
					error: { ...message, stopReason: "error", errorMessage: "service unavailable" },
				});
			while (!(await reader.read()).done) {}
			expect(success).toHaveBeenCalledTimes(succeeds ? 1 : 0);
			expect(requests).toEqual([succeeds]);
		} finally {
			events.end();
			await gateway.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
}
