import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "openai-codex";
const ACCOUNT_ID = "acct-1";
const EMAIL = "user@example.com";

interface RecordedCall {
	url: string;
	method: string;
}

function zeroCreditFetch(): { usageFetch: typeof fetch; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const usageFetch = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), method: init?.method ?? "GET" });
		return new Response(JSON.stringify({ credits: [], available_count: 0 }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { usageFetch, calls };
}

describe("AuthStorage.redeemResetCredit empty balance", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-reset-consent-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		store?.close();
		store = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	async function seededStorage(usageFetch: typeof fetch): Promise<AuthStorage> {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store, { usageFetch });
		await storage.set(PROVIDER, [
			{
				type: "oauth",
				access: "access-live",
				refresh: "refresh-live",
				expires: Date.now() + 60 * 60_000,
				accountId: ACCOUNT_ID,
				email: EMAIL,
			},
		]);
		await storage.reload();
		return storage;
	}

	test("returns no_credit without spending when the live balance is empty and consent is required", async () => {
		const { usageFetch, calls } = zeroCreditFetch();
		const storage = await seededStorage(usageFetch);
		const outcome = await storage.redeemResetCredit({
			target: { accountId: ACCOUNT_ID, email: EMAIL },
			requireFinalCreditConsent: true,
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.code).toBe("no_credit");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("GET");
	});

	test("returns no_credit without the consent flag too", async () => {
		const { usageFetch, calls } = zeroCreditFetch();
		const storage = await seededStorage(usageFetch);
		const outcome = await storage.redeemResetCredit({
			target: { accountId: ACCOUNT_ID, email: EMAIL },
		});
		expect(outcome.ok).toBe(false);
		expect(outcome.code).toBe("no_credit");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("GET");
	});
});
