import { describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import * as compatAuth from "@oh-my-pi/pi-catalog/compat/auth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { claudeUsageProvider } from "@oh-my-pi/pi-ai/usage/claude";
import { antigravityUsageProvider } from "@oh-my-pi/pi-ai/usage/google-antigravity";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "../../utils/src/temp";

const HOUR_MS = 60 * 60 * 1000;

async function probeOnce(provider: string, accountId: string): Promise<string[]> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-usage-probe-"));
	const store = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
	const storage = new AuthStorage(store, {
		usageProviderResolver: candidate =>
			candidate === "google-antigravity"
				? antigravityUsageProvider
				: candidate === "anthropic"
					? claudeUsageProvider
					: undefined,
	});
	const minted: string[] = [];
	try {
		const credential: OAuthCredentials = {
			access: `access-${accountId}`,
			refresh: `refresh-${accountId}`,
			// Expired, so a probe that is willing to refresh will reach the refresher.
			expires: Date.now() - HOUR_MS,
			accountId,
			email: `${accountId}@example.com`,
		};
		await storage.credentials.set(provider as never, [{ type: "oauth", ...credential }]);
		vi.spyOn(oauthUtils, "getOAuthProvider").mockImplementation(
			() =>
				({
					refreshToken: async (current: OAuthCredentials) => {
						minted.push(current.accountId ?? "unknown");
						return { ...current, access: `access-new-${current.accountId}`, expires: Date.now() + HOUR_MS };
					},
				}) as unknown as ReturnType<typeof oauthUtils.getOAuthProvider>,
		);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		await storage.usage.reports({ provider: provider as never });
		return minted;
	} finally {
		vi.restoreAllMocks();
		storage.close();
		store.close();
		await removeWithRetries(dir);
	}
}

describe("usage probe refresh policy", () => {
	// Antigravity is paused in its auth rules; this exercises the refresh rule, not the pause.
	test("does not mint an expired Antigravity token from a usage probe", async () => {
		vi.spyOn(compatAuth, "providerDisabledReason").mockReturnValue(undefined);
		expect(await probeOnce("google-antigravity", "acct-probe")).toEqual([]);
	});

	test("still mints an expired token for a provider that refreshes eagerly", async () => {
		vi.spyOn(compatAuth, "providerDisabledReason").mockReturnValue(undefined);
		expect(await probeOnce("anthropic", "acct-probe")).toEqual(["acct-probe"]);
	});
});
