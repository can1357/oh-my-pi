import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Issue #12306: Zen refuses its free tier to every client but OpenCode's own.
const MODEL_ID = "muse-spark-1.3-contributor-free";
const KEYS = ["sk-zen-test-A", "sk-zen-test-B"] as const;
const FREE_TIER_BODY = JSON.stringify({
	type: "error",
	error: {
		type: "FreeTierError",
		message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
	},
});

const model = buildModel({
	id: MODEL_ID,
	name: MODEL_ID,
	api: "openai-responses",
	provider: "opencode-zen",
	baseUrl: "http://127.0.0.1:1/zen/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64,
});

describe("OpenCode Zen free-tier client gate (#12306)", () => {
	let dir: string;
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	let previousKey: string | undefined;

	beforeEach(async () => {
		previousKey = process.env.OPENCODE_API_KEY;
		delete process.env.OPENCODE_API_KEY;
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-zen-free-tier-"));
		store = await SqliteAuthCredentialStore.open(path.join(dir, "auth.db"));
		storage = new AuthStorage(store, { usageProviderResolver: () => undefined });
		await storage.credentials.set(
			"opencode-zen",
			KEYS.map(key => ({ type: "api_key" as const, key })),
		);
	});

	afterEach(async () => {
		if (previousKey === undefined) delete process.env.OPENCODE_API_KEY;
		else process.env.OPENCODE_API_KEY = previousKey;
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function turn(authorizations: string[]): Promise<AssistantMessage> {
		const fetch: FetchImpl = async (_input, init) => {
			authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
			return new Response(FREE_TIER_BODY, { status: 403, headers: { "content-type": "application/json" } });
		};
		const sessionId = "zen-free-tier-session";
		return streamSimple(
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: storage.keys.resolver("opencode-zen", { sessionId, modelId: MODEL_ID }),
				sessionId,
				fetch,
				maxRetryDelayMs: 1,
			},
		).result();
	}

	it("fails once with an actionable explanation, without rotating or blocking the key", async () => {
		const authorizations: string[] = [];
		const result = await turn(authorizations);

		// One request: sibling keys fail identically, so no rotation.
		expect(authorizations).toHaveLength(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(403);
		expect(result.errorMessage).toContain("OpenCode Zen only serves its free models to the OpenCode app");
		expect(result.errorMessage).toContain("/model");
		// The provider's own wording stays visible beneath omp's explanation.
		expect(result.errorMessage).toContain("free tier can only be used from within OpenCode");
		expect(AIError.isAuthRetryableError(new AIError.ProviderHttpError(result.errorMessage ?? "", 403))).toBe(false);

		// The key is valid for paid Zen models: neither key may be blocked or dropped.
		const rows = store.listAuthCredentials("opencode-zen");
		expect(rows).toHaveLength(KEYS.length);
		expect(store.listCredentialBlocks(rows.map(row => row.id))).toEqual([]);
	});
});
