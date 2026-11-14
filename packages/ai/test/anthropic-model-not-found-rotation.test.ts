import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { anthropicChunks, captureFetch, type CapturedRequest } from "./helpers/factory-droid";

const MODEL_ID = "claude-mythos-5-2";
const OPUS_ID = getBundledModel("anthropic", "claude-opus-5-5").id;
const TOKENS = ["sk-ant-oat01-test-A", "sk-ant-oat01-test-B", "sk-ant-oat01-test-C"] as const;
const model = buildModel({
	id: MODEL_ID,
	name: MODEL_ID,
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://127.0.0.1:1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64,
});

function modelNotFoundBody(modelId: unknown = MODEL_ID): string {
	return JSON.stringify({
		type: "error",
		error: { type: "not_found_error", message: `model: ${modelId}` },
		request_id: "req_test",
	});
}

function rejection(body: string, status = 404, headers?: Record<string, string>): Response {
	return new Response(body, { status, headers: { "Content-Type": "application/json", ...headers } });
}

describe("Anthropic OAuth model-not-found credential rotation", () => {
	let dir: string;
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	let requests: CapturedRequest[];
	let unexpectedRequests: string[];
	let previousApiKey: string | undefined;
	let previousOAuthToken: string | undefined;

	beforeEach(async () => {
		previousApiKey = process.env.ANTHROPIC_API_KEY;
		previousOAuthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
		unexpectedRequests = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: string | URL | Request) => {
					const url = input instanceof Request ? input.url : String(input);
					unexpectedRequests.push(url);
					throw new Error(`Unexpected network or OAuth token request: ${url}`);
				},
				{ preconnect: fetch.preconnect },
			),
		);
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-anthropic-model-404-"));
		store = await SqliteAuthCredentialStore.open(path.join(dir, "auth.db"));
		storage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		await storage.credentials.set(
			"anthropic",
			TOKENS.map((access, index) => ({
				type: "oauth" as const,
				access,
				refresh: `test-refresh-${index}`,
				expires: Date.now() + 3_600_000,
				accountId: `test-account-${index}`,
				orgId: `test-org-${index}`,
				email: `account-${index}@example.test`,
			})),
		);
		requests = [];
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = previousApiKey;
		if (previousOAuthToken === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN;
		else process.env.ANTHROPIC_OAUTH_TOKEN = previousOAuthToken;
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
		expect(unexpectedRequests).toEqual([]);
	});

	async function turn(
		respond: (request: CapturedRequest, index: number) => Response | undefined,
		sessionId = "model-404-session",
		signal?: AbortSignal,
	): Promise<AssistantMessage> {
		const success = captureFetch(requests, anthropicChunks("ok"));
		const fetch: FetchImpl = async (input, init) => {
			const response = await success(input, init);
			const request = requests.at(-1)!;
			expect(new URL(request.url).pathname).toBe("/v1/messages");
			expect(request.body.model).toBe(MODEL_ID);
			return respond(request, requests.length - 1) ?? response;
		};
		return streamSimple(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: storage.keys.resolver("anthropic", { sessionId, modelId: MODEL_ID }),
				sessionId,
				signal,
				fetch,
				// Anthropic already pins HTTP maxRetries to zero; cap any provider-level retry hint too.
				maxRetryDelayMs: 1,
			},
		).result();
	}

	function bearers(): string[] {
		return requests.map(request => request.headers.authorization);
	}

	function blocks(index: number): string[] {
		const row = store.listAuthCredentials("anthropic")[index]!;
		const rows = store.listCredentialBlocks([row.id]);
		expect(rows.every(block => block.providerKey === "anthropic:oauth")).toBe(true);
		return rows.map(block => block.blockScope).sort();
	}

	it("retries a denied model on a sibling without denying the first account access to Opus", async () => {
		const result = await turn((request, index) =>
			index === 0 ? rejection(modelNotFoundBody(request.body.model)) : undefined,
		);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(bearers()).toEqual([`Bearer ${TOKENS[0]}`, `Bearer ${TOKENS[1]}`]);
		expect(blocks(0)).toEqual([`model-policy:${MODEL_ID}`]);
		expect(blocks(1)).toEqual([]);
		expect(await storage.credentials.listDisabled("anthropic")).toEqual([]);
		expect(await storage.keys.get("anthropic", "new-opus-session", { modelId: OPUS_ID })).toBe(TOKENS[0]);
	});

	it("tries each denied OAuth sibling before the third account serves the model", async () => {
		const result = await turn((request, index) =>
			index < 2 ? rejection(modelNotFoundBody(request.body.model)) : undefined,
		);
		expect(result.stopReason).toBe("stop");
		expect(bearers()).toEqual(TOKENS.map(token => `Bearer ${token}`));
	});

	it("surfaces the original model 404 after every distinct OAuth account denies it", async () => {
		const body = modelNotFoundBody();
		const result = await turn(() => rejection(body));
		expect(bearers()).toEqual(TOKENS.map(token => `Bearer ${token}`));
		expect(new Set(bearers()).size).toBe(3);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(404);
		expect(result.errorMessage).toBe(`404 ${body}`);
		expect(result.errorId).toBe(404);
		expect(await storage.credentials.listDisabled("anthropic")).toEqual([]);
	});

	it("keeps usage exhaustion and a sibling's model denial in separate block scopes", async () => {
		const result = await turn((request, index) => {
			if (index === 0) {
				return rejection(
					JSON.stringify({
						type: "error",
						error: {
							type: "rate_limit_error",
							message: "This request would exceed your account's monthly spend limit. Please try again later.",
						},
					}),
					429,
					{ "retry-after": "120" },
				);
			}
			return index === 1 ? rejection(modelNotFoundBody(request.body.model)) : undefined;
		});
		expect(result.stopReason).toBe("stop");
		expect(bearers()).toEqual(TOKENS.map(token => `Bearer ${token}`));
		expect(blocks(0)).toEqual(["tier:mythos"]);
		expect(blocks(1)).toEqual([`model-policy:${MODEL_ID}`]);
		expect(blocks(2)).toEqual([]);
	});

	it.each([
		{
			name: "thread-not-found 404",
			status: 404,
			body: JSON.stringify({
				type: "error",
				error: {
					type: "not_found_error",
					message: "thread not found",
					details: { error_code: "thread_not_found" },
				},
			}),
		},
		{ name: "another model's 404", status: 404, body: modelNotFoundBody("claude-opus-5-5") },
		{ name: "differently cased model 404", status: 404, body: modelNotFoundBody("CLAUDE-MYTHOS-5-2") },
		{ name: "plain-text Not Found", status: 404, body: "Not Found" },
		{ name: "model-not-found envelope with status 400", status: 400, body: modelNotFoundBody() },
	])("surfaces $name without retrying or blocking an account", async ({ status, body }) => {
		const result = await turn(() => rejection(body, status));
		expect(bearers()).toEqual([`Bearer ${TOKENS[0]}`]);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(status);
		expect(result.errorMessage?.startsWith(`${status} ${body}`)).toBe(true);
		for (let index = 0; index < TOKENS.length; index++) expect(blocks(index)).toEqual([]);
	});

	it("does not block or send a sibling request when the caller aborts the denied attempt", async () => {
		const controller = new AbortController();
		const result = await turn(
			() => {
				controller.abort();
				return rejection(modelNotFoundBody());
			},
			"aborted-model-404",
			controller.signal,
		);
		expect(result.stopReason).toBe("aborted");
		expect(bearers()).toEqual([`Bearer ${TOKENS[0]}`]);
		for (let index = 0; index < TOKENS.length; index++) expect(blocks(index)).toEqual([]);
	});

	it("preserves healthy session pins when a delayed model denial targets a different credential", async () => {
		const rows = store.listAuthCredentials("anthropic");
		expect(storage.sessions.pin("anthropic", "healthy-session", rows[2]!.id)).toBe(true);
		const sessionId = "overlapping-model-404";
		const result = await turn((_request, index) => {
			if (index !== 0) return undefined;
			// An overlapping request pins B after this attempt has already selected A.
			expect(storage.sessions.pin("anthropic", sessionId, rows[1]!.id)).toBe(true);
			return rejection(modelNotFoundBody());
		}, sessionId);
		expect(result.stopReason).toBe("stop");
		expect(bearers()).toEqual([`Bearer ${TOKENS[0]}`, `Bearer ${TOKENS[1]}`]);
		expect(await storage.keys.get("anthropic", "healthy-session", { modelId: MODEL_ID })).toBe(TOKENS[2]);
		expect(await storage.keys.get("anthropic", sessionId, { modelId: OPUS_ID })).toBe(TOKENS[1]);
		expect(storage.sessions.inherit(sessionId, "copied-healthy-pin", (_provider, explicit) => explicit)).toBe(1);
	});

	it("replaces the denying session's pin with the serving sibling without blocking other models", async () => {
		const firstRow = store.listAuthCredentials("anthropic")[0]!;
		const sessionId = "pinned-model-404";
		expect(storage.sessions.pin("anthropic", sessionId, firstRow.id)).toBe(true);
		expect(storage.sessions.pin("anthropic", "other-model-pin", firstRow.id)).toBe(true);
		const result = await turn(
			(_request, index) => (index === 0 ? rejection(modelNotFoundBody()) : undefined),
			sessionId,
		);
		expect(result.stopReason).toBe("stop");
		expect(bearers()).toEqual([`Bearer ${TOKENS[0]}`, `Bearer ${TOKENS[1]}`]);
		expect(await storage.keys.get("anthropic", sessionId, { modelId: MODEL_ID })).toBe(TOKENS[1]);
		// Pins are provider/session-scoped, not per-model: retry replaces the failed pin.
		expect(await storage.keys.get("anthropic", sessionId, { modelId: OPUS_ID })).toBe(TOKENS[1]);
		expect(storage.sessions.inherit(sessionId, "copied-failed-pin", (_provider, explicit) => explicit)).toBe(0);
		expect(await storage.keys.get("anthropic", "other-model-pin", { modelId: OPUS_ID })).toBe(TOKENS[0]);
	});
});
