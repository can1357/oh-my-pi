import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { opencodeGoUsageProvider } from "@oh-my-pi/pi-ai/usage/opencode-go";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "opencode-go";
const METERED_MODEL = "kimi-k3";
const FREE_MODEL = "longcat-2.5-preview-free";
const DAY_MS = 24 * 60 * 60 * 1000;

/** `GET /zen/go/v1/usage` for an account whose weekly subscription window is spent. */
const exhaustedWeeklyFetch = (async () =>
	new Response(
		JSON.stringify({
			usage: {
				rolling: { status: "ok", percent: 40, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
				weekly: { status: "rate-limited", percent: 100, resetsAt: new Date(Date.now() + 3 * DAY_MS).toISOString() },
				monthly: { status: "ok", percent: 60, resetsAt: new Date(Date.now() + 20 * DAY_MS).toISOString() },
			},
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	)) as unknown as typeof fetch;

// Documented unlimited Go SKUs sit outside the subscription allowances;
// a model-id suffix alone is not proof that it is exempt (#15183).
describe("OpenCode Go free-SKU credential selection", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;

	async function openStorage(usageFetch?: typeof fetch): Promise<AuthStorage> {
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (usageFetch && provider === PROVIDER ? opencodeGoUsageProvider : undefined),
			usageFetch,
		});
		await storage.credentials.set(PROVIDER, [
			{ type: "api_key", key: "go-a", source: "login" },
			{ type: "api_key", key: "go-b", source: "login" },
		]);
		return storage;
	}

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-opencode-go-blocks-"));
	});

	afterEach(async () => {
		storage?.close();
		store?.close();
		storage = undefined;
		store = undefined;
		if (tempDir) await removeWithRetries(tempDir);
		tempDir = "";
	});

	test("a metered usage limit keeps the credential selectable for free SKUs", async () => {
		const auth = await openStorage();
		for (const apiKey of ["go-a", "go-b"]) {
			await auth.limits.markReached(PROVIDER, "metered", {
				apiKey,
				modelId: METERED_MODEL,
				retryAfterMs: 7 * DAY_MS,
			});
		}
		// Both subscriptions are spent: no metered sibling is left to rotate to.
		expect(
			(await auth.limits.markReached(PROVIDER, "metered", { apiKey: "go-a", modelId: METERED_MODEL })).switched,
		).toBe(false);

		// The free SKU still has both credentials: rotating off one lands on the other.
		expect(await auth.keys.get(PROVIDER, "free", { modelId: FREE_MODEL })).toBe("go-a");
		expect((await auth.limits.markReached(PROVIDER, "free", { apiKey: "go-a", modelId: FREE_MODEL })).switched).toBe(
			true,
		);
		expect(await auth.keys.get(PROVIDER, "free", { modelId: FREE_MODEL })).toBe("go-b");
	});

	test("a free-SKU rate limit keeps the credential selectable for metered models", async () => {
		const auth = await openStorage();
		await auth.limits.markReached(PROVIDER, "free", { apiKey: "go-a", modelId: FREE_MODEL });

		expect(await auth.keys.get(PROVIDER, "metered", { modelId: METERED_MODEL })).toBe("go-a");
		expect(await auth.keys.get(PROVIDER, "free", { modelId: FREE_MODEL })).toBe("go-b");
	});

	test("an exhausted subscription window gates bundled Space Bunny but not free SKUs", async () => {
		const auth = await openStorage(exhaustedWeeklyFetch);
		await auth.usage.reports();

		// Selection turns each credential's exhausted weekly window into a block.
		await auth.keys.get(PROVIDER, "metered", { modelId: "space-bunny-free" });
		expect(
			(await auth.limits.markReached(PROVIDER, "metered", { apiKey: "go-a", modelId: "space-bunny-free" })).switched,
		).toBe(false);

		expect(await auth.keys.get(PROVIDER, "free", { modelId: FREE_MODEL })).toBe("go-a");
		expect((await auth.limits.markReached(PROVIDER, "free", { apiKey: "go-a", modelId: FREE_MODEL })).switched).toBe(
			true,
		);
		expect(await auth.keys.get(PROVIDER, "free", { modelId: FREE_MODEL })).toBe("go-b");
	});
});
