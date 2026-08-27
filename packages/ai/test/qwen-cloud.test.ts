import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessageEvent, FetchImpl, Model, ModelSpec, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { QWEN_CLOUD_OPENAI_BASE_URL } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const originalQwenCloudApiKey = Bun.env.QWEN_CLOUD_API_KEY;

afterEach(() => {
	if (originalQwenCloudApiKey === undefined) {
		delete Bun.env.QWEN_CLOUD_API_KEY;
	} else {
		Bun.env.QWEN_CLOUD_API_KEY = originalQwenCloudApiKey;
	}
	vi.restoreAllMocks();
});

function qwenCloudModel(): Model<"openai-completions"> {
	const spec = (getBundledModels("qwen-cloud") as ModelSpec<"openai-completions">[]).find(
		model => model.id === "qwen3.8-max",
	);
	if (!spec) throw new Error("expected bundled qwen3.8-max");
	return buildModel(spec);
}
/**
 * Anthropic-route fixture: a minimal but complete messages SSE stream. The
 * transport resolves on `message_stop`, so an incomplete stream hangs the turn.
 */
function interceptingFetch(wire: "openai" | "anthropic"): {
	fetch: FetchImpl;
	seen: { url: string; auth: string | null }[];
} {
	const seen: { url: string; auth: string | null }[] = [];
	const body =
		wire === "anthropic"
			? `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","role":"assistant","type":"message","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n` +
				`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n` +
				`event: message_stop\ndata: {"type":"message_stop"}\n\n`
			: `data: {"choices":[{"delta":{"reasoning_content":"th"},"finish_reason":null,"index":0}]}\n\n` +
				`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop","index":0}]}\n\ndata: [DONE]\n\n`;
	const fetch: FetchImpl = async (input, init) => {
		let url: string;
		if (typeof input === "string") url = input;
		else if (input instanceof URL) url = input.toString();
		else url = input.url;
		seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	return { fetch, seen };
}

async function firstEvent(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent | undefined> {
	for await (const event of stream) return event;
	return undefined;
}

describe("Qwen Cloud wiring", () => {
	test("registers Qwen Cloud in the login provider selector", () => {
		const provider = getOAuthProviders().find(item => item.id === "qwen-cloud");
		expect(provider).toBeDefined();
		expect(provider?.name).toContain("Qwen Cloud");
		expect(provider?.available).toBe(true);
	});

	test("resolves QWEN_CLOUD_API_KEY from environment", () => {
		Bun.env.QWEN_CLOUD_API_KEY = "sk-ws-env-key";
		expect(getEnvApiKey("qwen-cloud")).toBe("sk-ws-env-key");
	});

	test("AuthStorage.login('qwen-cloud') validates against /models and stores the pasted key", async () => {
		const fetchCalls: Array<{ url: string }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			fetchCalls.push({ url });
			if (url === `${QWEN_CLOUD_OPENAI_BASE_URL}/models`) {
				return new Response(JSON.stringify({ object: "list", data: [{ id: "qwen3.8-max" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		});

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();

		await storage.login("qwen-cloud", {
			onAuth: () => {},
			onPrompt: async () => "sk-ws-validated",
			fetch: fetchMock,
		});

		expect(fetchCalls.map(call => call.url)).toEqual([`${QWEN_CLOUD_OPENAI_BASE_URL}/models`]);
		const stored = await storage.getApiKey("qwen-cloud");
		expect(stored).toBe("sk-ws-validated");
	});

	test("default format streams against the OpenAI compatible-mode endpoint with bearer auth", async () => {
		const { fetch, seen } = interceptingFetch("openai");
		const options: SimpleStreamOptions = { apiKey: "sk-ws-test", fetch };
		await firstEvent(
			streamSimple(qwenCloudModel(), { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, options),
		);
		expect(seen[0]?.auth).toBe("Bearer sk-ws-test");
		expect(seen[0]?.url.startsWith(QWEN_CLOUD_OPENAI_BASE_URL)).toBe(true);
	});

	test("anthropic format routes to the apps/anthropic surface via x-api-key-compatible transport", async () => {
		const { fetch, seen } = interceptingFetch("anthropic");
		const options: SimpleStreamOptions = { apiKey: "sk-ws-test", fetch, qwenCloudApiFormat: "anthropic" };
		await firstEvent(
			streamSimple(qwenCloudModel(), { messages: [{ role: "user", content: "hi", timestamp: 0 }] }, options),
		);
		expect(seen[0]?.url).toBe("https://dashscope-intl.aliyuncs.com/apps/anthropic/v1/messages");
	});
});
