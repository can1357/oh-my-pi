import { describe, expect, it, vi } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { resolveCodexResponsesUrl } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { CODEX_BASE_URL } from "@oh-my-pi/pi-catalog/wire/codex";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchCodex } from "@oh-my-pi/pi-coding-agent/web/search/providers/codex";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

function makeSseResponse(): string {
	return [
		`data: ${JSON.stringify({ type: "response.web_search_call.completed", item_id: "ws_test" })}`,
		"",
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Broker-backed Codex answer",
						annotations: [{ type: "url_citation", url: "https://example.com/broker", title: "Broker" }],
					},
				],
			},
		})}`,
		"",
		`data: ${JSON.stringify({
			type: "response.completed",
			response: { id: "resp_codex_broker", model: "selected-codex-grounding" },
		})}`,
		"",
	].join("\n");
}

describe("Codex web search broker auth", () => {
	it("uses the selected Codex model while preserving broker-refreshed token and account metadata", async () => {
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
		const model = buildModel({
			id: "selected-codex-grounding",
			name: "Selected Codex Grounding",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 16_384,
		});
		const getOAuthAccess = vi.spyOn(authStorage, "getOAuthAccess").mockResolvedValue({
			accessToken: "broker-refreshed-access-token",
			accountId: "broker-account-id",
		});
		const openSpy = vi.spyOn(AgentStorage, "open");
		let requestUrl: string | undefined;
		let requestHeaders: Headers | undefined;
		let requestBody: Record<string, unknown> | undefined;

		const fetchMock: FetchImpl = async (url, init) => {
			requestUrl = String(url);
			requestHeaders = new Headers(init?.headers);
			requestBody = JSON.parse(String(init?.body));
			return new Response(makeSseResponse(), { status: 200, headers: { "Content-Type": "text/event-stream" } });
		};

		const params: SearchParams = {
			query: "broker codex search",
			systemPrompt: "Use web search.",
			authStorage,
			modelRegistry,
			model,
			sessionId: "codex-broker-session",
		};

		try {
			const result = await searchCodex({ ...params, fetch: fetchMock });

			expect(result.provider).toBe("codex");
			expect(getOAuthAccess).toHaveBeenCalledWith(model.provider, "codex-broker-session", { signal: undefined });
			expect(requestUrl).toBe(resolveCodexResponsesUrl(model.baseUrl));
			expect(requestBody?.model).toBe(model.id);
			expect(requestHeaders?.get("authorization")).toBe("Bearer broker-refreshed-access-token");
			expect(requestHeaders?.get("chatgpt-account-id")).toBe("broker-account-id");
			expect(openSpy).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			authStorage.close();
		}
	});
});
