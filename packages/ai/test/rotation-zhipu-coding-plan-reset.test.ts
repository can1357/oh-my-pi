import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const PROVIDER = "cc-switch-zhipu-glm";
const CODING_PLAN_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const API_KEY = "zhipu-test-key";
const RESET_WAIT_MS = 82 * 60_000;
const HOUR_MS = 60 * 60 * 1000;

describe("RateLimits rotate: custom Zhipu Coding Plan reset timezone", () => {
	let tempDir = "";
	let store: AuthCredentialStore | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-zhipu-rotate-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
		await authStorage.credentials.set(PROVIDER, [{ type: "api_key", key: API_KEY }]);
	});

	afterEach(async () => {
		authStorage?.close();
		store?.close();
		store = undefined;
		authStorage = undefined;
		if (tempDir.length > 0) await removeWithRetries(tempDir);
		tempDir = "";
	});

	test("blocks a custom Coding Plan credential until the Beijing reset, not eight hours later", async () => {
		if (!authStorage || !store?.listCredentialBlocks) throw new Error("test setup failed");
		// A naive Beijing wall stamp ~82 min out; read as UTC it adds ~8h.
		const resetStamp = new Date(Date.now() + RESET_WAIT_MS + 8 * HOUR_MS)
			.toISOString()
			.slice(0, 19)
			.replace("T", " ");
		const error = Object.assign(
			new Error(`429 已达到 5 小时的使用上限，您的限额将在 ${resetStamp} 重置. (type=1308)`),
			{ status: 429 },
		);

		const blockedBefore = Date.now();
		await authStorage.limits.rotate(PROVIDER, "zhipu-sess", {
			error,
			baseUrl: CODING_PLAN_BASE_URL,
			apiKey: API_KEY,
		});
		const blockedAfter = Date.now();

		const rows = store.listAuthCredentials(PROVIDER);
		const blocks = store.listCredentialBlocks(rows.map(row => row.id));
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.blockedUntilMs).toBeGreaterThanOrEqual(blockedBefore + RESET_WAIT_MS - 10_000);
		expect(blocks[0]!.blockedUntilMs).toBeLessThanOrEqual(blockedAfter + RESET_WAIT_MS + 10_000);
	});
});
