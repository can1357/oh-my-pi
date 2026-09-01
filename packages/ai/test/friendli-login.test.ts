import { describe, expect, test, vi } from "bun:test";
import { loginFriendli } from "@oh-my-pi/pi-ai/registry/friendli";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const CHAT_COMPLETIONS_URL = "https://api.friendli.ai/serverless/v1/chat/completions";

function createController(fetch: FetchImpl): Parameters<typeof loginFriendli>[0] {
	return {
		fetch,
		onPrompt: async () => "invalid-friendli-key",
	};
}

describe("loginFriendli", () => {
	test("rejects an invalid key through the authenticated chat completions endpoint", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === CHAT_COMPLETIONS_URL) {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toEqual({
					"Content-Type": "application/json",
					Authorization: "Bearer invalid-friendli-key",
				});
				return new Response('{"detail":"Unauthorized"}', { status: 401 });
			}
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		});

		await expect(loginFriendli(createController(fetchMock))).rejects.toThrow(
			'FriendliAI API key validation failed (401): {"detail":"Unauthorized"}',
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
