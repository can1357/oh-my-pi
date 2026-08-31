import { describe, expect, test } from "bun:test";
import { loginAimlApi } from "../src/registry/oauth/aimlapi";
import type { OAuthAuthInfo, OAuthController } from "../src/registry/oauth/types";

type FetchCall = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Fetch mock returning queued responses in order, recording every call. */
function queuedFetch(responses: Response[]): { fetch: typeof fetch; calls: FetchCall[] } {
	const calls: FetchCall[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		const next = responses.shift();
		if (!next) throw new Error("unexpected extra fetch call");
		return next;
	}) as typeof fetch;
	return { fetch: fetchImpl, calls };
}

/**
 * Fetch mock that routes by URL — needed once the paste path validates the key
 * (balance probe) concurrently with token polling, so response order isn't
 * deterministic. Each handler returns a fresh Response per call.
 */
function routingFetch(handlers: { authorizations: () => Response; token: () => Response; balance?: () => Response }): {
	fetch: typeof fetch;
	calls: FetchCall[];
} {
	const calls: FetchCall[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init: init ?? {} });
		if (url.includes("/v3/agent-auth/authorizations")) return handlers.authorizations();
		if (url.includes("/v3/agent-auth/token")) return handlers.token();
		if (url.includes("/billing/balance")) return (handlers.balance ?? (() => jsonResponse({}, 500)))();
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof fetch;
	return { fetch: fetchImpl, calls };
}

function makeCallbacks(fetchImpl: typeof fetch): {
	controller: OAuthController;
	auth: OAuthAuthInfo[];
	progress: string[];
} {
	const auth: OAuthAuthInfo[] = [];
	const progress: string[] = [];
	return {
		controller: {
			fetch: fetchImpl,
			onAuth: info => auth.push(info),
			onProgress: message => progress.push(message),
		},
		auth,
		progress,
	};
}

describe("loginAimlApi (device authorization)", () => {
	test("starts authorization, shows consent URL, returns the issued key", async () => {
		const { fetch: fetchImpl, calls } = queuedFetch([
			jsonResponse({ requestId: "req_123", deviceCode: "dev_456", interval: 1, expiresIn: 900 }),
			jsonResponse({ status: "ready", apiKey: "aiml-test-key" }),
		]);
		const { controller, auth, progress } = makeCallbacks(fetchImpl);

		const key = await loginAimlApi(controller);

		expect(key).toBe("aiml-test-key");

		// Consent URL is built from the verification base, carrying the requestId.
		expect(auth).toHaveLength(1);
		expect(auth[0]?.url).toContain("/agent/authorize?request=req_123");
		expect(progress.at(-1)).toBe("Your API key was successfully generated.");

		// Start hits the authorizations endpoint with partner attribution.
		const startCall = calls[0];
		expect(startCall?.url).toContain("/v3/agent-auth/authorizations");
		const startHeaders = startCall?.init.headers as Record<string, string>;
		expect(startHeaders["X-AIMLAPI-Source"]).toBe("agent/oh-my-pi");
		expect(startHeaders["X-AIMLAPI-Partner-ID"]).toBeTruthy();
		const startBody = JSON.parse(String(startCall?.init.body)) as Record<string, unknown>;
		expect(startBody.agentName).toBe("Oh My Pi");
		expect(startBody.partnerName).toBe("oh-my-pi");

		// Poll hits the token endpoint with the device-code grant.
		const pollCall = calls[1];
		expect(pollCall?.url).toContain("/v3/agent-auth/token");
		const pollBody = JSON.parse(String(pollCall?.init.body)) as Record<string, unknown>;
		expect(pollBody.deviceCode).toBe("dev_456");
		expect(pollBody.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code");
	});

	test("fills the paste field and resolves it when the browser flow wins", async () => {
		const { fetch: fetchImpl } = queuedFetch([
			jsonResponse({ requestId: "req_9", deviceCode: "dev_9", interval: 1, expiresIn: 900 }),
			jsonResponse({ status: "ready", apiKey: "aiml-browser-key" }),
		]);
		const resolved: Array<{ value: string; message?: string }> = [];
		const progress: string[] = [];
		const controller: OAuthController = {
			fetch: fetchImpl,
			onAuth: () => {},
			onProgress: message => progress.push(message),
			// A rendered paste field that the user never submits.
			onPrompt: () => new Promise<string>(() => {}),
			onPromptResolve: (value, message) => resolved.push({ value, message }),
		};

		const key = await loginAimlApi(controller);

		expect(key).toBe("aiml-browser-key");
		// The minted key is pushed into the field with the green confirmation…
		expect(resolved).toEqual([
			{ value: "aiml-browser-key", message: "Your key has already been generated and added above" },
		]);
		// …and the plain progress fallback is not also emitted.
		expect(progress).not.toContain("Your API key was successfully generated.");
	});

	test("validates a manually pasted key against the balance endpoint and accepts it", async () => {
		const { fetch: fetchImpl, calls } = routingFetch({
			authorizations: () => jsonResponse({ requestId: "req_p", deviceCode: "dev_p", interval: 1, expiresIn: 900 }),
			// Browser side never approves within the test — poll stays pending.
			token: () => jsonResponse({ status: "pending" }),
			// Valid key → balance readable.
			balance: () => jsonResponse({ balance: 1000 }),
		});
		let promptResolved = false;
		const progress: string[] = [];
		const controller: OAuthController = {
			fetch: fetchImpl,
			onAuth: () => {},
			onProgress: message => progress.push(message),
			onPrompt: () => Promise.resolve("  pasted-key-123  "),
			onPromptResolve: () => {
				promptResolved = true;
			},
		};

		const key = await loginAimlApi(controller);

		expect(key).toBe("pasted-key-123");
		expect(promptResolved).toBe(false); // browser flow didn't win → no auto-fill
		expect(progress).toContain("Validating API key...");
		// The key was checked against the non-inference balance probe, bearer-authed.
		const balanceCall = calls.find(call => call.url.includes("/billing/balance"));
		expect(balanceCall).toBeDefined();
		expect(balanceCall?.url).toContain("/v1/billing/balance");
		const balanceHeaders = balanceCall?.init.headers as Record<string, string> | undefined;
		expect(balanceHeaders?.Authorization).toBe("Bearer pasted-key-123");
	});

	test("rejects an invalid manually pasted key with a validation error", async () => {
		const { fetch: fetchImpl } = routingFetch({
			authorizations: () => jsonResponse({ requestId: "req_x", deviceCode: "dev_x", interval: 1, expiresIn: 900 }),
			token: () => jsonResponse({ status: "pending" }),
			// Bad key → balance endpoint 401s.
			balance: () => jsonResponse({ message: "This request requires a valid API key." }, 401),
		});
		const controller: OAuthController = {
			fetch: fetchImpl,
			onAuth: () => {},
			onPrompt: () => Promise.resolve("bad-key"),
		};

		await expect(loginAimlApi(controller)).rejects.toThrow(/key validation failed \(401\)/i);
	});

	test("throws when the authorization is denied", async () => {
		const { fetch: fetchImpl } = queuedFetch([
			jsonResponse({ requestId: "req_1", deviceCode: "dev_1", interval: 1, expiresIn: 900 }),
			jsonResponse({ status: "denied" }),
		]);
		const { controller } = makeCallbacks(fetchImpl);

		await expect(loginAimlApi(controller)).rejects.toThrow(/denied/i);
	});

	test("throws when the start response is incomplete", async () => {
		const { fetch: fetchImpl } = queuedFetch([jsonResponse({ requestId: "req_1" })]);
		const { controller } = makeCallbacks(fetchImpl);

		await expect(loginAimlApi(controller)).rejects.toThrow(/incomplete/i);
	});
});
