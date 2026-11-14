import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { removeWithRetries } from "../../utils/src/temp";

const SIGN_IN_URL = "https://console.mistral.ai/api/vibe/sign-in";
const POLL_URL = "https://console.mistral.ai/api/vibe/sign-in/proc-1";
const EXCHANGE_URL = "https://console.mistral.ai/api/vibe/sign-in/proc-1/exchange";
const BROWSER_URL = "https://console.mistral.ai/codestral/cli/authenticate?process_id=proc-1";

const loginMistral = getProviderDefinition("mistral")?.login;
if (!loginMistral) throw new Error("Mistral login is not registered");

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const completed = () => json({ status: "completed", exchange_token: "xt-1" });

interface ConsoleScript {
	polls?: (Response | Error)[];
	start?: Record<string, string>;
	exchange?: Response;
}

/** Scripted console; the poll endpoint answers (or throws) each `polls` entry in order. */
function mockConsole({ polls = [], start = {}, exchange = json({ api_key: "vibe-key" }) }: ConsoleScript = {}) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetchImpl: FetchImpl = async (input, init) => {
		const url = String(input);
		calls.push({ url, init });
		if (url === SIGN_IN_URL) {
			return json({
				process_id: "proc-1",
				sign_in_url: BROWSER_URL,
				poll_url: POLL_URL,
				expires_at: new Date(Date.now() + 60_000).toISOString(),
				...start,
			});
		}
		if (url === POLL_URL) {
			const next = polls.shift();
			if (!next) throw new Error("poll called more times than scripted");
			if (next instanceof Error) throw next;
			return next;
		}
		if (url === EXCHANGE_URL) return exchange;
		throw new Error(`Unexpected URL: ${url}`);
	};
	return { calls, fetchImpl, exchanged: () => calls.some(call => call.url === EXCHANGE_URL) };
}

/** Skips poll waits and records them (signal-less logins wait via `Bun.sleep`). */
function recordPollWaits(): number[] {
	const waits: number[] = [];
	vi.spyOn(Bun, "sleep").mockImplementation((async (ms: number) => {
		waits.push(ms);
	}) as typeof Bun.sleep);
	return waits;
}

describe("mistral vibe browser sign-in", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("exchanges the approval with the PKCE verifier bound to the start challenge", async () => {
		const mistral = mockConsole({ polls: [json({ status: "pending" }), completed()] });
		const onAuth = vi.fn();
		const waits = recordPollWaits();

		await expect(loginMistral({ onAuth, fetch: mistral.fetchImpl })).resolves.toBe("vibe-key");

		expect(onAuth.mock.calls[0]?.[0]).toMatchObject({ url: BROWSER_URL });
		expect(waits).toEqual([3000]);
		const start = JSON.parse(String(mistral.calls[0]?.init?.body));
		const exchange = JSON.parse(String(mistral.calls.find(call => call.url === EXCHANGE_URL)?.init?.body));
		expect(exchange.exchange_token).toBe("xt-1");
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(exchange.code_verifier));
		expect(Buffer.from(digest).toString("base64url")).toBe(start.code_challenge);
		expect(start.code_challenge_method).toBe("S256");
	});

	it.each([
		["an expired process (HTTP 410)", new Response(null, { status: 410 }), "Mistral sign-in expired"],
		["a denied sign-in", json({ status: "denied" }), "Mistral sign-in was denied"],
	])("rejects %s without exchanging", async (_, poll, message) => {
		const mistral = mockConsole({ polls: [poll] });

		await expect(loginMistral({ fetch: mistral.fetchImpl })).rejects.toThrow(message);
		expect(mistral.exchanged()).toBe(false);
	});

	it("rides out two transient poll failures but gives up on the third", async () => {
		recordPollWaits();
		const recovered = mockConsole({ polls: [new TypeError("fetch failed"), json([], 200), completed()] });
		await expect(loginMistral({ fetch: recovered.fetchImpl })).resolves.toBe("vibe-key");

		const exhausted = mockConsole({
			polls: [json({}, 503), new TypeError("fetch failed"), json({}, 503), completed()],
		});
		await expect(loginMistral({ fetch: exhausted.fetchImpl })).rejects.toThrow(
			"Mistral sign-in status unavailable: HTTP 503",
		);
		expect(exhausted.exchanged()).toBe(false);
	});

	it("stretches only the throttled wait to Retry-After, floored at 3 s and capped at 30 s", async () => {
		const mistral = mockConsole({
			polls: [
				json({}, 429, { "retry-after-ms": "50" }),
				json({}, 429, { "Retry-After": "600" }),
				json({ status: "pending" }),
				completed(),
			],
		});
		const waits = recordPollWaits();

		await expect(loginMistral({ fetch: mistral.fetchImpl })).resolves.toBe("vibe-key");
		expect(waits).toEqual([3000, 30_000, 3000]);
	});

	it("explains a workspace that may not mint Vibe keys", async () => {
		const mistral = mockConsole({ polls: [completed()], exchange: json({ error_code: 9004 }, 403) });

		await expect(loginMistral({ fetch: mistral.fetchImpl })).rejects.toThrow(
			"workspace can't be used for Mistral Vibe",
		);
	});

	it.each([
		["a sign-in URL off the console origin", { sign_in_url: "https://evil.example/authenticate" }],
		["a poll URL sharing only a string prefix with /api", { poll_url: "https://console.mistral.ai/api-evil/x" }],
	])("rejects %s before opening the browser", async (_, start) => {
		const mistral = mockConsole({ start });
		const onAuth = vi.fn();

		await expect(loginMistral({ onAuth, fetch: mistral.fetchImpl })).rejects.toThrow("unexpected URL");
		expect(onAuth).not.toHaveBeenCalled();
	});

	it("does not contact the console when the login is already cancelled", async () => {
		const mistral = mockConsole();

		await expect(loginMistral({ fetch: mistral.fetchImpl, signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
			LoginCancelledError,
		);
		expect(mistral.calls).toHaveLength(0);
	});

	it("reports a cancel during the response body read as a cancelled login", async () => {
		const controller = new AbortController();
		// Headers arrive, then the body stream fails once the request signal aborts.
		const fetchImpl: FetchImpl = async (_input, init) => {
			const body = new ReadableStream({
				start(stream) {
					init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason));
				},
			});
			queueMicrotask(() => controller.abort());
			return new Response(body, { status: 200 });
		};

		await expect(loginMistral({ fetch: fetchImpl, signal: controller.signal })).rejects.toBeInstanceOf(
			LoginCancelledError,
		);
	});

	it("times out a stalled console request instead of hanging", async () => {
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(10));
		const stalled: FetchImpl = (_input, init) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			return promise;
		};

		await expect(loginMistral({ fetch: stalled })).rejects.toMatchObject({ name: "TimeoutError" });
	});
});

describe("mistral vibe sign-in persistence", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;

	afterEach(async () => {
		store?.close();
		store = undefined;
		if (tempDir) await removeWithRetries(tempDir);
		tempDir = "";
	});

	it("stores the minted key as a plain API-key credential, not an OAuth row", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-mistral-vibe-login-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const mistral = mockConsole({ polls: [completed()] });

		const outcome = await new AuthStorage(store).oauth.login("mistral", {
			onAuth: () => {},
			onPrompt: async () => {
				throw new Error("browser sign-in must not prompt");
			},
			fetch: mistral.fetchImpl,
		});

		expect(outcome).toEqual({ type: "api_key" });
		expect(store.listAuthCredentials("mistral").map(row => row.credential)).toEqual([
			expect.objectContaining({ type: "api_key", key: "vibe-key" }),
		]);
	});
});
