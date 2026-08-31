import { describe, expect, it } from "bun:test";
import { loginClinePass } from "@oh-my-pi/pi-ai/registry/cline-pass";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

describe("ClinePass login", () => {
	it("opens the dashboard and validates the key against the account identity route", async () => {
		const authUrls: string[] = [];
		let authorization = "";
		let requestUrl = "";
		let requestMethod = "";
		let hasBody = false;
		const fetchMock: FetchImpl = async (input, init) => {
			requestUrl = String(input);
			requestMethod = init?.method ?? "GET";
			authorization = String((init?.headers as Record<string, string> | undefined)?.Authorization);
			hasBody = init?.body !== undefined;
			return Response.json({ email: "user@example.com" });
		};

		const result = await loginClinePass({
			onAuth: info => authUrls.push(info.url),
			onPrompt: async () => "  sk_test  ",
			fetch: fetchMock,
		});

		expect(result).toBe("sk_test");
		expect(authUrls).toEqual(["https://app.cline.bot/dashboard/account"]);
		expect(requestUrl).toBe("https://api.cline.bot/api/v1/users/me");
		expect(requestMethod).toBe("GET");
		expect(authorization).toBe("Bearer sk_test");
		expect(hasBody).toBe(false);
	});
});
