/**
 * When a stream's credential fails in a rotatable way, `streamSimple` turns the
 * failed AssistantMessage into an Error for the `ApiKeyResolver`, and the
 * credential layers behind it (`limits.rotate`, the auth gateway's usage mark)
 * read the failure's header retry wait from that Error's headers. The Error is
 * rebuilt field by field, so the message's structured wait
 * (`errorRetryAfterMs`) must be carried onto it: otherwise the credential is
 * blocked for the 200 ms the body names instead of the header's 9 s.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/** A body that names a shorter wait than the header did. */
const BODY_TEXT = "usage_limit_reached retry-after-ms=200";
const SESSION_ID = "stream-auth-retry-wait";
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	clearCustomApis();
});

interface Credentials {
	storage: AuthStorage;
	store: SqliteAuthCredentialStore;
	credentialId(): number;
}

/** Storage holding one API key for `provider`. */
async function credentialsFor(provider: string): Promise<Credentials> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-auth-retry-wait-"));
	const store = await SqliteAuthCredentialStore.open(path.join(dir, "auth.db"));
	const storage = new AuthStorage(store);
	await storage.credentials.set(provider, [{ type: "api_key", key: `${provider}-key` }]);
	cleanups.push(async () => {
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	});
	return {
		storage,
		store,
		credentialId: () => {
			const row = store.listAuthCredentials(provider)[0];
			if (!row) throw new Error("expected a stored credential");
			return row.id;
		},
	};
}

/** Run one turn with the storage's resolver and return the failure plus the block the rotation stored. */
async function runAndReadBlock(
	model: Model<Api>,
	credentials: Credentials,
	options: { maxHttpAttempts?: number } = {},
) {
	const markReached = spyOn(credentials.storage.limits, "markReached");
	cleanups.push(() => markReached.mockRestore());
	const before = Date.now();
	const message = await streamSimple(model, context, {
		apiKey: credentials.storage.keys.resolver(model.provider, { sessionId: SESSION_ID }),
		sessionId: SESSION_ID,
		...options,
	}).result();
	const after = Date.now();
	const marks = markReached.mock.calls.map(call => call[2]?.retryAfterMs);
	const blocks = credentials.store.listCredentialBlocks([credentials.credentialId()]);
	return { message, marks, blocks, before, after };
}

describe("streamSimple credential rotation — the failed attempt's header retry wait", () => {
	it("blocks the credential for a real 429's Retry-After, not the body's wait", async () => {
		let upstreamRequests = 0;
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(req) {
				await req.text();
				upstreamRequests++;
				return Response.json(
					{ error: { message: BODY_TEXT, type: "rate_limit_error" } },
					{ status: 429, headers: { "retry-after": "9" } },
				);
			},
		});
		cleanups.push(() => upstream.stop(true));
		const model = buildModel({
			id: "rotation-model",
			name: "Rotation model",
			api: "openai-completions",
			provider: "openai",
			baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 4096,
		} as ModelSpec<"openai-completions">);
		const credentials = await credentialsFor(model.provider);

		const { message, marks, blocks, before, after } = await runAndReadBlock(model, credentials, {
			maxHttpAttempts: 1,
		});

		expect(message.stopReason).toBe("error");
		expect(message.errorStatus).toBe(429);
		expect(message.errorRetryAfterMs).toBe(9000);
		expect(marks).toEqual([9000]);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.blockedUntilMs).toBeGreaterThanOrEqual(before + 9000);
		expect(blocks[0]!.blockedUntilMs).toBeLessThanOrEqual(after + 9000);
		expect(upstreamRequests).toBe(1);
	});

	it("carries the wait when the failure names no HTTP status", async () => {
		// The rebuilt Error takes its no-status form for this text.
		expect(AIError.status({ message: BODY_TEXT })).toBeUndefined();
		registerMockApi();
		const model = createMockModel({
			provider: "mock",
			id: "rotation-mock",
			handler: () => ({ stopReason: "error", errorMessage: BODY_TEXT, errorRetryAfterMs: 9000 }),
		});
		const credentials = await credentialsFor(model.provider);

		const { message, marks, blocks, before, after } = await runAndReadBlock(model, credentials);

		expect(message.stopReason).toBe("error");
		expect(message.errorStatus).toBeUndefined();
		expect(message.errorRetryAfterMs).toBe(9000);
		expect(marks).toEqual([9000]);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.blockedUntilMs).toBeGreaterThanOrEqual(before + 9000);
		expect(blocks[0]!.blockedUntilMs).toBeLessThanOrEqual(after + 9000);
		expect(model.calls).toHaveLength(1);
	});

	it("leaves the body's wait in charge when the failure carried no header wait", async () => {
		registerMockApi();
		const model = createMockModel({
			provider: "mock",
			id: "rotation-mock-headerless",
			handler: () => ({ stopReason: "error", errorMessage: BODY_TEXT }),
		});
		const credentials = await credentialsFor(model.provider);

		const { message, marks } = await runAndReadBlock(model, credentials);

		expect(message.errorRetryAfterMs).toBeUndefined();
		expect(marks[0]).toBe(200);
	});
});
