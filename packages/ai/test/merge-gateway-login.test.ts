import { describe, expect, test } from "bun:test";
import { loginMergeGateway } from "@oh-my-pi/pi-ai/registry/merge-gateway";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

describe("Merge Gateway login", () => {
	test("validates pasted keys against the authenticated model catalog", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			calls.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
			return Response.json({ object: "list", data: [], has_more: false, next_cursor: null });
		};
		const key = await loginMergeGateway({
			onPrompt: async () => "  mg_test  ",
			fetch: fetchMock,
		});

		expect(key).toBe("mg_test");
		expect(calls).toEqual([
			{
				url: "https://api-gateway.merge.dev/v1/models?limit=1",
				authorization: "Bearer mg_test",
			},
		]);
	});
});
