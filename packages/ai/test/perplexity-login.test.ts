import { afterEach, describe, expect, it, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { LoginCancelledError, OAuthError, ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import type { OAuthCredentials, OAuthController } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { withEnv } from "./helpers";

type CapturedRequest = {
	path: string;
	cookie: string | null;
};

function cookiePairs(header: string | null): Set<string> {
	return new Set(header?.split("; ") ?? []);
}

async function loginPerplexity(callbacks: OAuthController): Promise<OAuthCredentials> {
	const provider = getProviderDefinition("perplexity");
	if (!provider?.login) throw new Error("expected perplexity provider");
	const result = await provider.login({
		...callbacks,
		onAuth: callbacks.onAuth ?? (() => {}),
		onPrompt: callbacks.onPrompt ?? (async () => ""),
	});
	if (typeof result === "string") throw new Error("expected Perplexity OAuth credentials");
	return result;
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

	it("completes an authenticator challenge after email OTP verification", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected global fetch"));
		const requests: Array<CapturedRequest & { body: unknown }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			requests.push({
				path: url.pathname,
				cookie: new Headers(init?.headers).get("Cookie"),
				body: init?.body ? JSON.parse(init.body.toString()) : undefined,
			});

			if (url.pathname.endsWith("/csrf")) {
				return new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
					status: 200,
					headers: {
						"Content-Type": "application/json",
						"Set-Cookie": "next-auth.csrf-token=csrf-cookie; Path=/; HttpOnly; Secure",
					},
				});
			}
			if (url.pathname.endsWith("/signin-email")) return new Response("{}", { status: 200 });
			if (requests.length === 3) {
				return new Response(
					JSON.stringify({ challenge_token: "perplexity-challenge", status: "totp_challenge_required" }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.pathname.endsWith("/totp/challenge-verify")) {
				return new Response(JSON.stringify({ redirect_url: "https://www.perplexity.ai/" }), {
					status: 200,
					headers: {
						"Content-Type": "application/json",
						"Set-Cookie": "next-auth.session-token=session-cookie; Path=/; HttpOnly; Secure",
					},
				});
			}
			throw new Error(`Unexpected request: ${url.pathname}`);
		});
		const answers = ["email", "user@example.com", "123456", "654321"];

		await withEnv({ PI_AUTH_NO_BORROW: "1" }, async () => {
			const credentials = await loginPerplexity({
				fetch: fetchMock,
				onPrompt: async () => answers.shift() ?? "",
				onBrowserSession: async () => {
					throw new Error("Email login must not open a browser");
				},
			});
			expect(credentials.access).toBe("session-cookie");
		});
		expect(requests.map(request => request.path)).toEqual([
			"/api/auth/csrf",
			"/api/auth/signin-email",
			"/api/auth/signin-otp",
			"/api/auth/totp/challenge-verify",
		]);
		expect(requests[3]?.body).toEqual({
			token: "perplexity-challenge",
			code: "654321",
		});
		expect(requests[3]?.cookie).toBe("next-auth.csrf-token=csrf-cookie");
	});
});

describe("Perplexity browser SSO login", () => {
	it("stores a validated browser session without prompting for the secret", async () => {
		const storage = await AuthStorage.create(":memory:");
		const token = "sso-session-cookie";
		let prompts = 0;
		try {
			await withEnv({ PI_AUTH_NO_BORROW: "1" }, async () => {
				const identity = await storage.login("perplexity", {
					onAuth: () => {
						throw new Error("The host already owns the login browser");
					},
					onPrompt: async () => {
						if (prompts++) throw new Error("Unexpected credential prompt");
						return " SSO ";
					},
					onBrowserSession: async request => {
						expect(request).toEqual({
							url: "https://www.perplexity.ai/auth/signin",
							cookieNames: ["__Secure-next-auth.session-token", "next-auth.session-token"],
						});
						return token;
					},
					fetch: async (input, init) => {
						expect(String(input)).toBe("https://www.perplexity.ai/api/auth/session");
						expect(new Headers(init?.headers).get("Cookie")).toBe(`__Secure-next-auth.session-token=${token}`);
						expect(init?.redirect).toBe("error");
						return Response.json({ user: { email: "sso@example.com" } });
					},
				});
				expect(identity).toMatchObject({ type: "oauth", email: "sso@example.com" });
				expect((await storage.getOAuthAccess("perplexity"))?.accessToken).toBe(token);
			});
		} finally {
			storage.close();
		}
	});

	it("rejects a successful HTTP response without an authenticated identity", async () => {
		await withEnv({ PI_AUTH_NO_BORROW: "1" }, async () => {
			await expect(
				loginPerplexity({
					onPrompt: async () => "",
					onBrowserSession: async () => "invalid-session",
					fetch: async () => Response.json({ user: { email: " " } }),
				}),
			).rejects.toBeInstanceOf(OAuthError);
		});
	});

	it("surfaces HTTP failure status without exposing the session or response body", async () => {
		await withEnv({ PI_AUTH_NO_BORROW: "1" }, async () => {
			const token = "private-session-cookie";
			const result = loginPerplexity({
				onPrompt: async () => "",
				onBrowserSession: async () => token,
				fetch: async () => new Response(`Rejected ${token}`, { status: 403 }),
			});
			await expect(result).rejects.toBeInstanceOf(ProviderHttpError);
			await expect(result).rejects.toThrow(/403/);
			await expect(result).rejects.not.toThrow(token);
		});
	});

	it("does not expose session content through malformed JSON errors", async () => {
		await withEnv({ PI_AUTH_NO_BORROW: "1" }, async () => {
			const token = "PrivateSessionTokenDontLog";
			const response = new Response(token);
			vi.spyOn(response, "json").mockImplementation(async () => JSON.parse(await response.text()));
			const result = loginPerplexity({
				onPrompt: async () => "",
				onBrowserSession: async () => token,
				fetch: async () => response,
			});
			await expect(result).rejects.not.toThrow(token);
			await expect(result).rejects.toBeInstanceOf(OAuthError);
		});
	});

	it("rejects cookie-header injection before contacting the service", async () => {
		const fetchSession = vi.fn(async () => Response.json({ user: { email: "sso@example.com" } }));
		await withEnv({ PI_AUTH_NO_BORROW: "1" }, async () => {
			await expect(
				loginPerplexity({
					onPrompt: async () => "",
					onBrowserSession: async () => "session; another-cookie=value",
					fetch: fetchSession,
				}),
			).rejects.toBeInstanceOf(OAuthError);
			expect(fetchSession).not.toHaveBeenCalled();
		});
	});

	it("rejects a cookie returned after the user cancels browser sign-in", async () => {
		const controller = new AbortController();
		const captureStarted = Promise.withResolvers<void>();
		const captured = Promise.withResolvers<string>();
		const fetchSession = vi.fn(async () => Response.json({ user: { email: "sso@example.com" } }));
		await withEnv({ PI_AUTH_NO_BORROW: "1" }, async () => {
			const result = loginPerplexity({
				signal: controller.signal,
				onPrompt: async () => "",
				onBrowserSession: () => {
					captureStarted.resolve();
					return captured.promise;
				},
				fetch: fetchSession,
			});
			await captureStarted.promise;
			controller.abort();
			captured.resolve("late-session-cookie");
			await expect(result).rejects.toBeInstanceOf(LoginCancelledError);
			expect(fetchSession).not.toHaveBeenCalled();
		});
	});

	it("does not save credentials when validation finishes after cancellation", async () => {
		const storage = await AuthStorage.create(":memory:");
		const controller = new AbortController();
		const validationStarted = Promise.withResolvers<void>();
		const response = Promise.withResolvers<Response>();
		try {
			await withEnv({ PI_AUTH_NO_BORROW: "1" }, async () => {
				const result = storage.login("perplexity", {
					signal: controller.signal,
					onAuth: () => {},
					onPrompt: async () => "",
					onBrowserSession: async () => "session-cookie",
					fetch: () => {
						validationStarted.resolve();
						return response.promise;
					},
				});
				await validationStarted.promise;
				controller.abort();
				response.resolve(Response.json({ user: { email: "sso@example.com" } }));
				await expect(result).rejects.toBeInstanceOf(LoginCancelledError);
				expect(storage.getAll().perplexity).toBeUndefined();
			});
		} finally {
			storage.close();
		}
	});
});
