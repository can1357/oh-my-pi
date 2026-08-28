import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginPerplexity } from "@oh-my-pi/pi-ai/registry/oauth/perplexity";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { withEnv } from "./helpers";

type CapturedRequest = {
	path: string;
	cookie: string | null;
};

function cookiePairs(header: string | null): Set<string> {
	return new Set(header?.split("; ") ?? []);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Perplexity email OTP login", () => {
	it.each(["token", "challenge_token"] as const)(
		"replays cookies and accepts the %s OTP response field",
		async tokenField => {
			vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected global fetch"));
			const requests: CapturedRequest[] = [];
			const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(input instanceof Request ? input.url : input.toString());
				requests.push({ path: url.pathname, cookie: new Headers(init?.headers).get("Cookie") });

				if (url.pathname.endsWith("/csrf")) {
					const headers = new Headers({ "Content-Type": "application/json" });
					headers.append("Set-Cookie", "next-auth.csrf-token=csrf-cookie; Path=/; HttpOnly; Secure");
					headers.append("Set-Cookie", "__cf_bm=cloudflare-cookie; Path=/; Secure");
					return new Response(JSON.stringify({ csrfToken: "csrf-token" }), { status: 200, headers });
				}
				if (url.pathname.endsWith("/signin-email")) {
					return new Response("{}", {
						status: 200,
						headers: { "Set-Cookie": "next-auth.callback-url=callback-cookie; Path=/; HttpOnly; Secure" },
					});
				}
				return new Response(JSON.stringify({ [tokenField]: "perplexity-jwe", status: "success" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			});
			const answers = ["user@example.com", "123456"];

			await withEnv({ PI_AUTH_NO_BORROW: "1" }, async () => {
				const credentials = await loginPerplexity({
					fetch: fetchMock,
					onPrompt: async () => answers.shift() ?? "",
				});
				expect(credentials.access).toBe("perplexity-jwe");
			});
			expect(requests.map(request => request.path)).toEqual([
				"/api/auth/csrf",
				"/api/auth/signin-email",
				"/api/auth/signin-otp",
			]);
			expect(requests[0]?.cookie).toBeNull();
			expect(cookiePairs(requests[1]?.cookie ?? null)).toEqual(
				new Set(["next-auth.csrf-token=csrf-cookie", "__cf_bm=cloudflare-cookie"]),
			);
			expect(cookiePairs(requests[2]?.cookie ?? null)).toEqual(
				new Set([
					"next-auth.csrf-token=csrf-cookie",
					"__cf_bm=cloudflare-cookie",
					"next-auth.callback-url=callback-cookie",
				]),
			);
		},
	);
});
