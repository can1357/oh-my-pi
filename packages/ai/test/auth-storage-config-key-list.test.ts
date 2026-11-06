import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { DEFAULT_BLOCK_MS } from "@oh-my-pi/pi-ai/auth/blocks";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";

const PROVIDER = "mistral";
const NOW = new Date("2026-11-06T12:00:00Z");

function authError(): Error & { status: number } {
	return Object.assign(new Error("401 Unauthorized"), { status: 401 });
}

function usageLimitError(): Error & { status: number } {
	return Object.assign(new Error("429 usage limit reached"), { status: 429 });
}

/** `!fail` stands in for a `!command` entry whose command fails or prints nothing. */
async function resolveConfigValue(config: string): Promise<string | undefined> {
	return config === "!fail" ? undefined : config;
}

/** Drive the resolver like the auth-retry loop does after one rejected request. */
async function retryAfterRejection(storage: AuthStorage, error: unknown, previousKey: string) {
	const resolver = storage.keys.resolver(PROVIDER);
	return resolver({ lastChance: true, error, previousKey });
}

describe("AuthStorage ordered config key list", () => {
	let storage: AuthStorage;

	beforeEach(async () => {
		setSystemTime(NOW);
		storage = await AuthStorage.create(":memory:", { configValueResolver: resolveConfigValue });
	});

	afterEach(() => {
		storage.close();
		setSystemTime();
	});

	test("requests use the first entry", async () => {
		storage.keys.setConfig(PROVIDER, ["key-primary", "key-secondary"]);

		expect(await storage.keys.get(PROVIDER)).toBe("key-primary");
		expect(await storage.keys.peek(PROVIDER)).toBe("key-primary");
		expect(storage.keys.source(PROVIDER)).toEqual({ kind: "config", concrete: true });
	});

	test("a 401 on the primary moves to the next entry until the block expires", async () => {
		storage.keys.setConfig(PROVIDER, ["key-primary", "key-secondary"]);
		expect(await storage.keys.get(PROVIDER)).toBe("key-primary");

		expect(await retryAfterRejection(storage, authError(), "key-primary")).toMatchObject({
			apiKey: "key-secondary",
		});
		expect(await storage.keys.get(PROVIDER)).toBe("key-secondary");

		setSystemTime(new Date(NOW.getTime() + DEFAULT_BLOCK_MS + 1));
		expect(await storage.keys.get(PROVIDER)).toBe("key-primary");
	});

	test("a usage limit on the primary moves to the next entry until the block expires", async () => {
		storage.keys.setConfig(PROVIDER, ["key-primary", "key-secondary"]);
		expect(await storage.keys.get(PROVIDER)).toBe("key-primary");

		expect(await retryAfterRejection(storage, usageLimitError(), "key-primary")).toMatchObject({
			apiKey: "key-secondary",
		});
		expect(await storage.keys.get(PROVIDER)).toBe("key-secondary");

		setSystemTime(new Date(NOW.getTime() + DEFAULT_BLOCK_MS + 1));
		expect(await storage.keys.get(PROVIDER)).toBe("key-primary");
	});

	test("a turn-level usage limit without a bearer blocks the entry that served last", async () => {
		storage.keys.setConfig(PROVIDER, ["key-primary", "key-secondary"]);
		expect(await storage.keys.get(PROVIDER)).toBe("key-primary");

		const outcome = await storage.limits.markReached(PROVIDER, "session", { retryAfterMs: 120_000 });
		expect(outcome).toMatchObject({ switched: true, blockedUntilMs: NOW.getTime() + 120_000 });
		expect(await storage.keys.get(PROVIDER)).toBe("key-secondary");
	});

	test("an entry whose command fails is skipped", async () => {
		storage.keys.setConfig(PROVIDER, ["!fail", "key-secondary"]);

		expect(await storage.keys.get(PROVIDER)).toBe("key-secondary");
	});

	test("when every entry is blocked, requests fail the way a single rejected key does", async () => {
		storage.keys.setConfig(PROVIDER, ["key-primary", "key-secondary"]);
		expect(await storage.keys.get(PROVIDER)).toBe("key-primary");
		expect(await retryAfterRejection(storage, authError(), "key-primary")).toMatchObject({
			apiKey: "key-secondary",
		});

		// Auth: the primary is sent again so the provider's 401 surfaces.
		expect(
			(await storage.limits.rotate(PROVIDER, undefined, { error: authError(), apiKey: "key-secondary" })).switched,
		).toBe(false);
		expect(await storage.keys.get(PROVIDER)).toBe("key-primary");

		// Quota: no entry left, so the resolver stops for the outer backoff.
		expect(await retryAfterRejection(storage, usageLimitError(), "key-primary")).toBeUndefined();
	});

	test("a single string apiKey never rotates", async () => {
		storage.keys.setConfig(PROVIDER, "key-only");
		expect(await storage.keys.get(PROVIDER)).toBe("key-only");

		expect(
			(await storage.limits.rotate(PROVIDER, undefined, { error: authError(), apiKey: "key-only" })).switched,
		).toBe(false);
		expect(await storage.keys.get(PROVIDER)).toBe("key-only");
		expect(await retryAfterRejection(storage, usageLimitError(), "key-only")).toBeUndefined();
		expect(await storage.keys.get(PROVIDER)).toBe("key-only");
	});
});
