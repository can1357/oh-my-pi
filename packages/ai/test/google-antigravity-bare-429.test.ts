/**
 * Google answers a Cloud Code Assist request it refuses on client-fingerprint
 * grounds with a bare 429 RESOURCE_EXHAUSTED: no Retry-After, no
 * `error.details`, no quota-reset text. Rotating that refusal through the
 * Antigravity pool exposed every pooled account to it in milliseconds. These
 * tests pin that the refusal stays on the account that received it, while real
 * quota 429s (and the same body on other Google providers) still rotate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withAuth } from "@oh-my-pi/pi-ai/auth-retry";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import {
	DEFAULT_PROVIDER_COOLDOWN_MS,
	ProviderCooldowns,
	setProviderCooldownMs,
} from "@oh-my-pi/pi-ai/auth/provider-cooldown";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as compatAuth from "@oh-my-pi/pi-catalog/compat/auth";
import { removeWithRetries } from "../../utils/src/temp";

const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const GEMINI_CLI_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ACCOUNTS = 4;
const BARE_429_BODY = JSON.stringify({
	error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" },
});
const QUOTA_RESET_BODY = JSON.stringify({
	error: {
		code: 429,
		message: "You have exhausted your capacity on this model. Your quota will reset after 3h0m0s.",
		status: "RESOURCE_EXHAUSTED",
	},
});
const QUOTA_FAILURE_BODY = JSON.stringify({
	error: {
		code: 429,
		message: "Resource has been exhausted (e.g. check quota).",
		status: "RESOURCE_EXHAUSTED",
		details: [
			{
				"@type": "type.googleapis.com/google.rpc.QuotaFailure",
				violations: [{ quotaMetric: "generate_content_requests", quotaId: "GenerateRequestsPerDayPerProject" }],
			},
		],
	},
});

function errorInfoBody(reason: string): string {
	return JSON.stringify({
		error: {
			code: 429,
			message: "Resource has been exhausted (e.g. check quota).",
			status: "RESOURCE_EXHAUSTED",
			details: [
				{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "cloudcode-pa.googleapis.com" },
			],
		},
	});
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

function cloudCodeModel(provider: "google-antigravity" | "google-gemini-cli"): Model<"google-gemini-cli"> {
	return buildModel({
		id: "gemini-3-flash",
		name: "Gemini 3 Flash",
		api: "google-gemini-cli",
		provider,
		baseUrl: provider === "google-antigravity" ? ANTIGRAVITY_DAILY_ENDPOINT : GEMINI_CLI_ENDPOINT,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 1_024,
	});
}

function credential(index: number): OAuthCredentials {
	return {
		access: `access-${index}`,
		refresh: `refresh-${index}`,
		expires: Date.now() + 3_600_000,
		accountId: `account-${index}`,
		projectId: `project-${index}`,
		email: `account-${index}@example.test`,
	};
}

interface Rejection {
	body: string;
	headers?: Record<string, string>;
}

/** CCA fetch that answers every request with `rejection`, recording the bearer it was sent with. */
function rejectingFetch(rejection: Rejection, bearers: string[]): FetchImpl {
	return async (_input, init) => {
		bearers.push(new Headers(init?.headers).get("authorization") ?? "");
		return new Response(rejection.body, {
			status: 429,
			headers: { "content-type": "application/json", ...rejection.headers },
		});
	};
}

/** Run one CCA request through the real transport and surface its failure like a non-streaming consumer. */
async function requestThroughTransport(
	model: Model<"google-gemini-cli">,
	apiKey: string,
	fetchImpl: FetchImpl,
): Promise<void> {
	const result = await streamGoogleGeminiCli(model, context, {
		apiKey,
		fetch: fetchImpl,
		maxRetryDelayMs: 1,
	}).result();
	if (result.stopReason === "error") {
		throw new AIError.ProviderHttpError(result.errorMessage ?? "", result.errorStatus ?? 0);
	}
}

describe("Cloud Code Assist bare 429", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	const savedVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;

	beforeEach(async () => {
		// Antigravity is paused in its auth rules; this guards users who turn it back on.
		vi.spyOn(compatAuth, "providerDisabledReason").mockReturnValue(undefined);
		process.env.PI_AI_ANTIGRAVITY_VERSION = "2.19.1";
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: string | URL | Request) => {
					throw new Error(`Unexpected network request: ${input instanceof Request ? input.url : String(input)}`);
				},
				{ preconnect: fetch.preconnect },
			),
		);
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const stored = credentials[provider];
			if (!stored) return null;
			return {
				apiKey: JSON.stringify({ token: stored.access, projectId: stored.projectId }),
				newCredentials: stored,
			};
		});
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-cca-bare-429-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "auth.db"));
		storage = new AuthStorage(store, { usageProviderResolver: () => undefined });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProviderCooldownMs(DEFAULT_PROVIDER_COOLDOWN_MS);
		if (savedVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
		else process.env.PI_AI_ANTIGRAVITY_VERSION = savedVersion;
		storage?.close();
		storage = undefined;
		store = undefined;
		if (tempDir) await removeWithRetries(tempDir);
		tempDir = "";
	});

	async function seedAccounts(provider: "google-antigravity" | "google-gemini-cli"): Promise<void> {
		if (!storage) throw new Error("test setup failed");
		await storage.credentials.set(
			provider,
			Array.from({ length: ACCOUNTS }, (_, index) => ({ type: "oauth" as const, ...credential(index) })),
		);
	}

	async function runPooledRequest(
		provider: "google-antigravity" | "google-gemini-cli",
		rejection: Rejection,
		options: { seed?: boolean; sessionId?: string; auth?: AuthStorage; fetchImpl?: FetchImpl } = {},
	): Promise<{ attempts: string[]; bearers: string[]; error: unknown; blockedCredentials: number }> {
		const auth = options.auth ?? storage;
		if (!auth) throw new Error("test setup failed");
		if (options.seed !== false) await seedAccounts(provider);
		const model = cloudCodeModel(provider);
		const attempts: string[] = [];
		const bearers: string[] = [];
		const fetchImpl = options.fetchImpl ?? rejectingFetch(rejection, bearers);
		let error: unknown;
		try {
			await withAuth(
				auth.keys.resolver(provider, { sessionId: options.sessionId ?? "session-bare-429", modelId: model.id }),
				key => {
					attempts.push(JSON.parse(key).token);
					return requestThroughTransport(model, key, fetchImpl);
				},
			);
		} catch (caught) {
			error = caught;
		}
		const credentialIds = auth.credentials.list(provider).map(row => row.id);
		const blockedCredentials = new Set(auth.blocks.list(credentialIds).map(block => block.credentialId)).size;
		return { attempts, bearers, error, blockedCredentials };
	}

	/** Every quota-identified rotation reaches each account once: N accounts, at most N attempts. */
	function expectOneAttemptPerAccount(attempts: string[]): void {
		expect(attempts).toHaveLength(ACCOUNTS);
		expect(new Set(attempts).size).toBe(ACCOUNTS);
	}

	it("keeps a bare Antigravity 429 on the one account that received it", async () => {
		const { attempts, bearers, error, blockedCredentials } = await runPooledRequest("google-antigravity", {
			body: BARE_429_BODY,
		});

		expect(attempts).toHaveLength(1);
		expect(new Set(bearers).size).toBe(1);
		// Not a quota window: neither the failing account nor any sibling is blocked.
		expect(blockedCredentials).toBe(0);
		expect(AIError.status(error)).toBe(429);
		const message = error instanceof Error ? error.message : "";
		expect(message).toContain(AIError.UNATTRIBUTED_REJECTION_PREFIX);
		expect(message).toContain(BARE_429_BODY);
	});

	it("pauses every google-antigravity account after a bare 429, refusing later requests without a fetch", async () => {
		await runPooledRequest("google-antigravity", { body: BARE_429_BODY });

		// Another session in this process: refused before any account is chosen.
		const sameProcess = await runPooledRequest(
			"google-antigravity",
			{ body: BARE_429_BODY },
			{ seed: false, sessionId: "session-other" },
		);
		expect(sameProcess.bearers).toHaveLength(0);
		expect(sameProcess.error).toBeInstanceOf(AIError.ProviderCooldownError);
		expect((sameProcess.error as Error).message).toContain(AIError.UNATTRIBUTED_REJECTION_PREFIX);

		// Another process sharing the credential store sees the persisted pause.
		const otherStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "auth.db"));
		const otherStorage = new AuthStorage(otherStore, { usageProviderResolver: () => undefined });
		try {
			const otherProcess = await runPooledRequest(
				"google-antigravity",
				{ body: BARE_429_BODY },
				{ seed: false, sessionId: "session-subagent", auth: otherStorage },
			);
			expect(otherProcess.bearers).toHaveLength(0);
			expect(otherProcess.error).toBeInstanceOf(AIError.ProviderCooldownError);
			await expect(otherStorage.oauth.access("google-antigravity", "session-subagent")).rejects.toBeInstanceOf(
				AIError.ProviderCooldownError,
			);
		} finally {
			otherStorage.close();
		}

		// Other providers are not paused.
		const gemini = await runPooledRequest("google-gemini-cli", { body: QUOTA_RESET_BODY });
		expect(gemini.bearers.length).toBeGreaterThan(0);
	});

	it("lifts the provider pause once its cooldown expires", () => {
		if (!store) throw new Error("test setup failed");
		const cooldowns = new ProviderCooldowns(store, 60_000);
		cooldowns.trip("google-antigravity", "test refusal");
		expect(() => cooldowns.assertReady("google-antigravity")).toThrow(AIError.ProviderCooldownError);
		expect(new ProviderCooldowns(store).isCooling("google-antigravity")).toBe(true);
		const expiredAt = Date.now() + 60_001;
		vi.spyOn(Date, "now").mockReturnValue(expiredAt);
		expect(() => cooldowns.assertReady("google-antigravity")).not.toThrow();
		expect(new ProviderCooldowns(store).isCooling("google-antigravity")).toBe(false);
	});

	it("reports another instance's later deadline at once and admits only after it", () => {
		if (!store) throw new Error("test setup failed");
		const startedAt = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(startedAt);
		const a = new ProviderCooldowns(store, 60_000);
		const b = new ProviderCooldowns(store, 120_000);
		a.trip("google-antigravity", "first refusal");
		expect(b.isCooling("google-antigravity")).toBe(true);
		b.trip("google-antigravity", "second refusal");

		const untilMs = (cooldowns: ProviderCooldowns) => {
			try {
				cooldowns.assertReady("google-antigravity");
			} catch (error) {
				if (error instanceof AIError.ProviderCooldownError) return error.untilMs;
				throw error;
			}
			return undefined;
		};
		expect(untilMs(a)).toBe(startedAt + 120_000);

		vi.spyOn(Date, "now").mockReturnValue(startedAt + 60_001);
		expect(untilMs(a)).toBe(startedAt + 120_000);
		vi.spyOn(Date, "now").mockReturnValue(startedAt + 120_001);
		expect(untilMs(a)).toBeUndefined();
		expect(b.isCooling("google-antigravity")).toBe(false);
	});

	it("pauses for the configured length", () => {
		if (!store) throw new Error("test setup failed");
		setProviderCooldownMs(5 * 60_000);
		const startedAt = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(startedAt);
		const cooldowns = new ProviderCooldowns(store);
		cooldowns.trip("google-antigravity", "test refusal");
		expect(() => cooldowns.assertReady("google-antigravity")).toThrow(new Date(startedAt + 5 * 60_000).toISOString());
		vi.spyOn(Date, "now").mockReturnValue(startedAt + 5 * 60_000 + 1);
		expect(cooldowns.isCooling("google-antigravity")).toBe(false);
	});

	it("does not pause the provider at 0, yet keeps the bare 429 on one account", async () => {
		if (!store) throw new Error("test setup failed");
		setProviderCooldownMs(0);
		const { attempts, blockedCredentials, error } = await runPooledRequest("google-antigravity", {
			body: BARE_429_BODY,
		});
		expect(attempts).toHaveLength(1);
		expect(blockedCredentials).toBe(0);
		expect(error instanceof Error ? error.message : "").toContain(AIError.UNATTRIBUTED_REJECTION_PREFIX);
		expect(new ProviderCooldowns(store).isCooling("google-antigravity")).toBe(false);
	});

	it("still rotates an Antigravity 429 that carries Retry-After", async () => {
		const { attempts } = await runPooledRequest("google-antigravity", {
			body: BARE_429_BODY,
			headers: { "retry-after": "3600" },
		});
		expectOneAttemptPerAccount(attempts);
	});

	it("still rotates an Antigravity 429 with daily-quota reset text", async () => {
		const { attempts } = await runPooledRequest("google-antigravity", { body: QUOTA_RESET_BODY });
		expectOneAttemptPerAccount(attempts);
	});

	it("still rotates an Antigravity 429 with QuotaFailure details", async () => {
		const { attempts } = await runPooledRequest("google-antigravity", { body: QUOTA_FAILURE_BODY });
		expectOneAttemptPerAccount(attempts);
	});

	it("still rotates an Antigravity 429 with a known quota ErrorInfo reason", async () => {
		const { attempts } = await runPooledRequest("google-antigravity", { body: errorInfoBody("QUOTA_EXHAUSTED") });
		expectOneAttemptPerAccount(attempts);
	});

	it("treats an Antigravity 429 whose only detail is an unknown ErrorInfo reason as bare", async () => {
		const { attempts, error } = await runPooledRequest("google-antigravity", {
			body: errorInfoBody("SOMETHING_ELSE"),
		});
		expect(attempts).toHaveLength(1);
		expect(error instanceof Error ? error.message : "").toContain(AIError.UNATTRIBUTED_REJECTION_PREFIX);
	});

	it("keeps today's rotation for the same bare 429 on google-gemini-cli", async () => {
		const { attempts, error } = await runPooledRequest("google-gemini-cli", { body: BARE_429_BODY });
		expectOneAttemptPerAccount(attempts);
		expect(error instanceof Error ? error.message : "").not.toContain(AIError.UNATTRIBUTED_REJECTION_PREFIX);
	});

	it("sends a bare Antigravity 429 request once, without transport retries or endpoint failover", async () => {
		const requests: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			requests.push(input instanceof Request ? input.url : String(input));
			return new Response(BARE_429_BODY, { status: 429, headers: { "content-type": "application/json" } });
		};
		const result = await streamGoogleGeminiCli(cloudCodeModel("google-antigravity"), context, {
			apiKey: JSON.stringify({ token: "access-0", projectId: "project-0" }),
			fetch: fetchImpl,
			maxRetryDelayMs: 1,
		}).result();

		expect(requests).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(429);
		expect(result.errorMessage).toContain(AIError.UNATTRIBUTED_REJECTION_PREFIX);
		expect(AIError.retriable(result.errorId)).toBe(false);
		expect(AIError.is(result.errorId, AIError.Flag.UsageLimit)).toBe(false);
	});

	it("keeps a bare 429 from an empty-stream replay on one endpoint and pauses the provider", async () => {
		const requests: { url: string; status: number }[] = [];
		const fetchImpl: FetchImpl = async input => {
			const url = input instanceof Request ? input.url : String(input);
			if (requests.length === 0) {
				requests.push({ url, status: 200 });
				// A 200 with an empty SSE body; the replay reuses the response URL.
				const empty = new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
				Object.defineProperty(empty, "url", { value: url });
				return empty;
			}
			requests.push({ url, status: 429 });
			return new Response(BARE_429_BODY, { status: 429, headers: { "content-type": "application/json" } });
		};

		const { attempts, error, blockedCredentials } = await runPooledRequest(
			"google-antigravity",
			{ body: BARE_429_BODY },
			{ fetchImpl },
		);

		expect(attempts).toHaveLength(1);
		expect(requests.filter(request => request.status === 429)).toHaveLength(1);
		// No failover: the replay and the refusal stay on the endpoint that answered first.
		expect(new Set(requests.map(request => request.url)).size).toBe(1);
		expect(blockedCredentials).toBe(0);
		expect(error instanceof Error ? error.message : "").toContain(AIError.UNATTRIBUTED_REJECTION_PREFIX);
		await expect(storage?.oauth.access("google-antigravity", "session-later")).rejects.toBeInstanceOf(
			AIError.ProviderCooldownError,
		);
	});

	it("keeps a bare 429 error chunk in a 200 stream on one endpoint", async () => {
		const requests: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			requests.push(input instanceof Request ? input.url : String(input));
			return new Response(`data: ${BARE_429_BODY}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};
		const result = await streamGoogleGeminiCli(cloudCodeModel("google-antigravity"), context, {
			apiKey: JSON.stringify({ token: "access-0", projectId: "project-0" }),
			fetch: fetchImpl,
			maxRetryDelayMs: 1,
		}).result();

		expect(requests).toHaveLength(1);
		expect(result.errorStatus).toBe(429);
		expect(result.errorMessage).toContain(AIError.UNATTRIBUTED_REJECTION_PREFIX);
	});
});

describe("isUnattributedAntigravity429", () => {
	it("matches only a google-antigravity 429 without retry timing, details, or quota text", () => {
		expect(AIError.isUnattributedAntigravity429("google-antigravity", 429, new Headers(), BARE_429_BODY)).toBe(true);
		expect(AIError.isUnattributedAntigravity429("google-antigravity", 429, undefined, "")).toBe(true);
		expect(
			AIError.isUnattributedAntigravity429(
				"google-antigravity",
				429,
				new Headers({ "retry-after": "30" }),
				BARE_429_BODY,
			),
		).toBe(false);
		expect(AIError.isUnattributedAntigravity429("google-antigravity", 429, undefined, QUOTA_RESET_BODY)).toBe(false);
		expect(AIError.isUnattributedAntigravity429("google-antigravity", 429, undefined, QUOTA_FAILURE_BODY)).toBe(
			false,
		);
		// A QuotaFailure or RetryInfo detail names a quota even when it carries no window or delay.
		for (const detail of [
			{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generate_content" }] },
			{ "@type": "type.googleapis.com/google.rpc.RetryInfo" },
		]) {
			const body = JSON.stringify({
				error: {
					code: 429,
					message: "Resource has been exhausted.",
					status: "RESOURCE_EXHAUSTED",
					details: [detail],
				},
			});
			expect(AIError.isUnattributedAntigravity429("google-antigravity", 429, undefined, body)).toBe(false);
		}
		expect(AIError.isUnattributedAntigravity429("google-antigravity", 503, undefined, BARE_429_BODY)).toBe(false);
		expect(AIError.isUnattributedAntigravity429("google-gemini-cli", 429, undefined, BARE_429_BODY)).toBe(false);
		expect(AIError.isUnattributedAntigravity429("google", 429, undefined, BARE_429_BODY)).toBe(false);
	});
});
