import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "../../utils/src/temp";

const SIGN_IN_URL = "https://console.mistral.ai/api/vibe/sign-in";
const POLL_URL = "https://console.mistral.ai/api/vibe/sign-in/proc-1";
const EXCHANGE_URL = "https://console.mistral.ai/api/vibe/sign-in/proc-1/exchange";
const BROWSER_URL = "https://console.mistral.ai/codestral/cli/authenticate?process_id=proc-1";

const loginMistral = getProviderDefinition("mistral")?.login;
if (!loginMistral) throw new Error("Mistral login is not registered");

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function startResponse(): Response {
	return json({
		process_id: "proc-1",
		sign_in_url: BROWSER_URL,
		poll_url: POLL_URL,
		expires_at: new Date(Date.now() + 60_000).toISOString(),
	});
}

type Call = { url: string; init?: RequestInit };

/** Scripted console: the poll endpoint answers each entry of `polls` in order. */
function mockConsole(polls: Response[], exchange: () => Response = () => json({ api_key: "vibe-key" })) {
	const calls: Call[] = [];
	const fetchImpl: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({ url, init });
		if (url === SIGN_IN_URL) return startResponse();
		if (url === POLL_URL) {
			const next = polls.shift();
			if (!next) throw new Error("poll called more times than scripted");
			return next;
		}
		if (url === EXCHANGE_URL) return exchange();
		throw new Error(`Unexpected URL: ${url}`);
	});
	return { calls, fetchImpl };
}

describe("mistral vibe browser sign-in", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("exchanges the approved sign-in with the PKCE verifier and returns the minted key", async () => {
		const { calls, fetchImpl } = mockConsole([
			json({ status: "pending" }),
			json({ status: "completed", exchange_token: "xt-1" }),
		]);
		const onAuth = vi.fn();
		const sleep = vi.spyOn(piUtils, "sleepLong").mockResolvedValue(undefined);

		const result = await loginMistral({ onAuth, fetch: fetchImpl });

		expect(result).toBe("vibe-key");
		expect(onAuth).toHaveBeenCalledTimes(1);
		expect(onAuth.mock.calls[0]?.[0]).toMatchObject({ url: BROWSER_URL });
		expect(sleep).toHaveBeenCalledTimes(1);

		const start = JSON.parse(String(calls[0]?.init?.body));
		expect(start.code_challenge_method).toBe("S256");
		const exchange = calls.find(call => call.url === EXCHANGE_URL);
		const exchangeBody = JSON.parse(String(exchange?.init?.body));
		expect(exchangeBody.exchange_token).toBe("xt-1");
		const digest = new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(exchangeBody.code_verifier)),
		);
		expect(Buffer.from(digest).toString("base64url")).toBe(start.code_challenge);
	});

	it("rejects an expired process (HTTP 410) without exchanging", async () => {
		const { calls, fetchImpl } = mockConsole([new Response(null, { status: 410 })]);

		await expect(loginMistral({ fetch: fetchImpl })).rejects.toThrow("Mistral sign-in expired");
		expect(calls.some(call => call.url === EXCHANGE_URL)).toBe(false);
	});

	it("rejects a denied sign-in without exchanging", async () => {
		const { calls, fetchImpl } = mockConsole([json({ status: "denied" })]);

		await expect(loginMistral({ fetch: fetchImpl })).rejects.toThrow("Mistral sign-in was denied");
		expect(calls.some(call => call.url === EXCHANGE_URL)).toBe(false);
	});

	it("rejects a sign-in URL outside the Mistral console", async () => {
		const fetchImpl: FetchImpl = vi.fn(async () =>
			json({
				process_id: "proc-1",
				sign_in_url: "https://evil.example/authenticate",
				poll_url: POLL_URL,
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			}),
		);
		const onAuth = vi.fn();

		await expect(loginMistral({ onAuth, fetch: fetchImpl })).rejects.toThrow("unexpected URL");
		expect(onAuth).not.toHaveBeenCalled();
	});

	it("does not contact the console when the login is already cancelled", async () => {
		const { calls, fetchImpl } = mockConsole([]);
		const controller = new AbortController();
		controller.abort();

		await expect(loginMistral({ fetch: fetchImpl, signal: controller.signal })).rejects.toBeInstanceOf(
			LoginCancelledError,
		);
		expect(calls).toHaveLength(0);
	});

	it("cancels the wait between polls through the login signal", async () => {
		const { calls, fetchImpl } = mockConsole([json({ status: "pending" })]);
		const controller = new AbortController();
		const realSleep = piUtils.sleepLong;
		// Abort while the poll wait is in progress; the real sleep must observe the signal.
		const sleep = vi.spyOn(piUtils, "sleepLong").mockImplementation((ms, signal) => {
			controller.abort();
			return realSleep(ms, signal);
		});

		await expect(loginMistral({ fetch: fetchImpl, signal: controller.signal })).rejects.toBeInstanceOf(
			LoginCancelledError,
		);
		expect(sleep.mock.calls[0]?.[1]).toBe(controller.signal);
		expect(calls.map(call => call.url)).toEqual([SIGN_IN_URL, POLL_URL]);
		expect(calls[1]?.init?.signal).toBe(controller.signal);
	});
});

describe("mistral vibe sign-in persistence", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-mistral-vibe-login-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		store?.close();
		store = null;
		await removeWithRetries(tempDir);
	});

	it("stores the minted key as a plain API-key credential, not an OAuth row", async () => {
		if (!store) throw new Error("test setup failed");
		const authStorage = new AuthStorage(store);
		const { fetchImpl } = mockConsole([json({ status: "completed", exchange_token: "xt-1" })]);

		const outcome = await authStorage.oauth.login("mistral", {
			onAuth: () => {},
			onPrompt: async () => {
				throw new Error("browser sign-in must not prompt");
			},
			fetch: fetchImpl,
		});

		expect(outcome).toEqual({ type: "api_key" });
		const rows = store.listAuthCredentials("mistral");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.credential).toMatchObject({ type: "api_key", key: "vibe-key" });
	});
});
