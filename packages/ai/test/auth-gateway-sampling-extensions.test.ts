/**
 * Gateway clients can target a model that rejects temperature and top_p but
 * still advertises top_k, min_p, or the penalty/stop group. Both ingress
 * paths have to forward those advertised values; a model that only turns the
 * core group off must still lose all of them.
 */
import { describe, expect, it } from "bun:test";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type CapturedRequest, captureFetch, completionsChunks } from "./helpers/factory-droid";

const SAMPLING = {
	temperature: 0.2,
	topP: 0.9,
	topK: 40,
	minP: 0.05,
	presencePenalty: 0.1,
	frequencyPenalty: 0.2,
	repetitionPenalty: 1.1,
	stopSequences: ["END"],
};

function openzooModel(id: string, compat: ModelSpec<"openai-completions">["compat"]): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "openzoo",
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
		compat,
	});
}

async function upstreamBody(
	model: Model<"openai-completions">,
	route: "/v1/chat/completions" | "/v1/messages" | "/v1/pi/stream",
	body: unknown,
): Promise<Record<string, unknown>> {
	const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
	storage.keys.setRuntime(model.provider, "test-key");
	const upstream: CapturedRequest[] = [];
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["test-token"],
		storage,
		resolveModel: () => model,
		fetch: captureFetch(upstream, completionsChunks("ok", model.id)),
		version: "test",
	});
	try {
		const response = await fetch(`${gateway.url}${route}`, {
			method: "POST",
			headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(response.status).toBe(200);
		await response.body?.cancel();
		expect(upstream).toHaveLength(1);
		return upstream[0].body;
	} finally {
		await gateway.close();
		storage.close();
	}
}

describe("auth-gateway sampling extensions", () => {
	const advertised = openzooModel("example-lab/extensions", {
		supportsSamplingParams: false,
		supportsTopK: true,
		supportsMinP: true,
		supportsPenaltyAndStopParams: true,
	});

	it("keeps advertised top_k, min_p, penalties, and stop on the pi-native path", async () => {
		// supportsSamplingParams is false, so temperature and top_p stay off.
		// The pi-native ingress used to delete every sampling field with that
		// flag, before streamSimple could honor the independent ones.
		const body = await upstreamBody(advertised, "/v1/pi/stream", {
			modelId: advertised.id,
			context: { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
			options: SAMPLING,
			stream: false,
		});
		expect(body.temperature).toBeUndefined();
		expect(body.top_p).toBeUndefined();
		expect(body.top_k).toBe(40);
		expect(body.min_p).toBe(0.05);
		expect(body.presence_penalty).toBe(0.1);
		expect(body.frequency_penalty).toBe(0.2);
		expect(body.repetition_penalty).toBe(1.1);
		expect(body.stop).toBe("END");
	});

	it("keeps advertised penalties and stop on the chat-completions path", async () => {
		// The chat ingress builds stream options behind the same core flag.
		// Penalties and stop the roster listed must reach the provider.
		const body = await upstreamBody(advertised, "/v1/chat/completions", {
			model: advertised.id,
			messages: [{ role: "user", content: "Hi" }],
			temperature: 0.2,
			top_p: 0.9,
			presence_penalty: 0.1,
			frequency_penalty: 0.2,
			stop: ["END"],
			stream: false,
		});
		expect(body.temperature).toBeUndefined();
		expect(body.top_p).toBeUndefined();
		expect(body.presence_penalty).toBe(0.1);
		expect(body.frequency_penalty).toBe(0.2);
		expect(body.stop).toBe("END");
	});

	it("keeps advertised top_k on the anthropic messages path", async () => {
		// top_k arrives through the messages parser, then buildStreamOptions.
		// Gating it on the core sampling flag dropped a value the spec listed.
		const topKOnly = openzooModel("example-lab/top-k", {
			supportsSamplingParams: false,
			supportsTopK: true,
		});
		const body = await upstreamBody(topKOnly, "/v1/messages", {
			model: topKOnly.id,
			max_tokens: 16,
			messages: [{ role: "user", content: "Hi" }],
			temperature: 0.2,
			top_k: 40,
			stream: false,
		});
		expect(body.temperature).toBeUndefined();
		expect(body.top_k).toBe(40);
	});

	it("drops an extension the spec did not list while keeping one it did", async () => {
		// Listing top_k must not turn min_p, penalties, or stop back on.
		const topKOnly = openzooModel("example-lab/top-k-only", {
			supportsSamplingParams: false,
			supportsTopK: true,
		});
		const body = await upstreamBody(topKOnly, "/v1/pi/stream", {
			modelId: topKOnly.id,
			context: { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
			options: SAMPLING,
			stream: false,
		});
		expect(body.temperature).toBeUndefined();
		expect(body.top_k).toBe(40);
		expect(body.min_p).toBeUndefined();
		expect(body.presence_penalty).toBeUndefined();
		expect(body.frequency_penalty).toBeUndefined();
		expect(body.repetition_penalty).toBeUndefined();
		expect(body.stop).toBeUndefined();
	});

	it("still drops every sampling field when the spec only turns the core group off", async () => {
		// A resolved default of supportsTopK true is not an advertisement.
		// Codex-class models keep losing temperature, top_k, penalties, and stop.
		const coreOff = openzooModel("example-lab/core-off", { supportsSamplingParams: false });
		expect(coreOff.compat.supportsSamplingParams).toBe(false);
		expect(coreOff.compatConfig?.supportsTopK).toBeUndefined();
		const body = await upstreamBody(coreOff, "/v1/pi/stream", {
			modelId: coreOff.id,
			context: { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
			options: SAMPLING,
			stream: false,
		});
		expect(body.temperature).toBeUndefined();
		expect(body.top_p).toBeUndefined();
		expect(body.top_k).toBeUndefined();
		expect(body.min_p).toBeUndefined();
		expect(body.presence_penalty).toBeUndefined();
		expect(body.frequency_penalty).toBeUndefined();
		expect(body.repetition_penalty).toBeUndefined();
		expect(body.stop).toBeUndefined();
	});
});
