import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { RouteRegistry, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { classifyGatewayError } from "@oh-my-pi/pi-ai/error/gateway";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { encodeResponse, encodeStream } from "@oh-my-pi/pi-ai/providers/openai-responses-server";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

afterEach(() => {
	clearCustomApis();
});

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) return output;
		output += decoder.decode(value);
	}
}

function responseFrames(raw: string): Array<Record<string, unknown>> {
	return raw
		.split("\n\n")
		.filter(chunk => chunk.includes("data: ") && !chunk.includes("data: [DONE]"))
		.map(chunk => JSON.parse(chunk.split("data: ").at(-1) ?? "{}") as Record<string, unknown>);
}

function responseEnvelopeIds(raw: string): string[] {
	return responseFrames(raw).flatMap(frame => {
		const response = frame.response;
		if (typeof response !== "object" || response === null || !("id" in response)) return [];
		return typeof response.id === "string" ? [response.id] : [];
	});
}

function assistant(responseId: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		content: [{ type: "text", text: "ok" }],
		responseId,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: 1_700_000_000_000,
	};
}

describe("PR10139 review regressions", () => {
	it("dispatches a request through the compiled route target", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pr10139-route-target-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "upstream/compiled-target" });
		mock.push({ content: ["ok"] });
		const routeRegistry = new RouteRegistry(id => (id === "client-route" ? mock.model : undefined));
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["test-token"],
			storage,
			routeRegistry,
			resolveModel: id => (id === mock.model.id ? mock.model : undefined),
			version: "test",
		});
		try {
			const response = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: JSON.stringify({ model: "client-route", messages: [{ role: "user", content: "hi" }], stream: false }),
			});
			expect(response.status).toBe(200);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves the upstream response id in non-streaming and streaming Responses output", async () => {
		const message = assistant("resp_upstream_123");
		expect(encodeResponse(message, "gpt-test").id).toBe("resp_upstream_123");

		const events = new AssistantMessageEventStream();
		queueMicrotask(() => {
			events.push({ type: "start", partial: { ...message, content: [] } });
			events.push({ type: "text_start", contentIndex: 0, partial: message });
			events.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
			events.push({ type: "text_end", contentIndex: 0, content: "ok", partial: message });
			events.push({ type: "done", reason: "stop", message });
		});
		const frames = responseFrames(await collectStream(encodeStream(events, "gpt-test")));
		const terminal = frames.find(frame => frame.type === "response.completed");
		expect(terminal).toBeDefined();
		const response = terminal?.response;
		if (typeof response !== "object" || response === null) throw new Error("Expected a completed response envelope");
		expect((response as Record<string, unknown>).id).toBe("resp_upstream_123");
	});

	it("keeps every streaming response envelope on the first chosen upstream id", async () => {
		const upstreamId = "resp_upstream_distinct";
		const startPartial = { ...assistant("unused_start_id"), responseId: undefined, content: [] };
		const contentPartial = assistant(upstreamId);
		const finalMessage = assistant(upstreamId);
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: startPartial });
			stream.push({ type: "text_start", contentIndex: 0, partial: contentPartial });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: contentPartial });
			stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: contentPartial });
			stream.push({ type: "done", reason: "stop", message: finalMessage });
		});

		const ids = responseEnvelopeIds(await collectStream(encodeStream(stream, "gpt-test")));
		expect(ids).toEqual([upstreamId, upstreamId, upstreamId]);

		const terminalOnly = new AssistantMessageEventStream();
		const terminalStart = { ...assistant("unused_terminal_start"), responseId: undefined, content: [] };
		const terminalResponseId = "resp_terminal_only";
		const terminalMessage = assistant(terminalResponseId);
		queueMicrotask(() => {
			terminalOnly.push({ type: "start", partial: terminalStart });
			terminalOnly.push({ type: "done", reason: "stop", message: terminalMessage });
		});
		const terminalIds = responseEnvelopeIds(await collectStream(encodeStream(terminalOnly, "gpt-test")));
		expect(terminalIds).toEqual([terminalResponseId, terminalResponseId, terminalResponseId]);
	});

	it("classifies a bare model-not-available message as model failover", () => {
		const classification = classifyGatewayError(new Error("model-not-available"));
		expect(classification).toMatchObject({
			status: 404,
			owner: "model",
			disposition: "model_unavailable",
		});
	});
});
