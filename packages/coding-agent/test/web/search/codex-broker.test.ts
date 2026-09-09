import { describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchCodex } from "@oh-my-pi/pi-coding-agent/web/search/providers/codex";

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
			response: { id: "resp_codex_broker", model: "gpt-5-codex-mini" },
		})}`,
		"",
	].join("\n");
}

describe("Codex web search broker auth", () => {
	it("uses AuthStorage.getOAuthAccess for token + account metadata without opening AgentStorage", async () => {
		const getOAuthAccess = vi.fn(async () => ({
			accessToken: "broker-refreshed-access-token",
			accountId: "broker-account-id",
		}));
		const authStorage = { getOAuthAccess } as unknown as AuthStorage;
		const openSpy = vi.spyOn(AgentStorage, "open");
		let requestHeaders: Headers | undefined;

		const fetchMock: FetchImpl = async (_url, init) => {
			requestHeaders = new Headers(init?.headers);
			return new Response(makeSseResponse(), { status: 200, headers: { "Content-Type": "text/event-stream" } });
		};

		const params: SearchParams = {
			query: "broker codex search",
			systemPrompt: "Use web search.",
			authStorage,
			sessionId: "codex-broker-session",
		};

		const result = await searchCodex({ ...params, fetch: fetchMock });

		expect(result.provider).toBe("codex");
		expect(getOAuthAccess).toHaveBeenCalledWith("openai-codex", "codex-broker-session", { signal: undefined });
		expect(requestHeaders?.get("authorization")).toBe("Bearer broker-refreshed-access-token");
		expect(requestHeaders?.get("chatgpt-account-id")).toBe("broker-account-id");
		expect(openSpy).not.toHaveBeenCalled();
	});
});
