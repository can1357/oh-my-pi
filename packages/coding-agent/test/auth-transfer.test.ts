import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type AuthCredential, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthTransferError,
	exportAuthCredentials,
	importAuthCredentials,
	parseAuthExport,
} from "@oh-my-pi/pi-coding-agent/commands/auth";
import { TempDir } from "@oh-my-pi/pi-utils";

const API_KEY: AuthCredential = { type: "api_key", key: "sk-laptop" };
const OAUTH: OAuthCredential = {
	type: "oauth",
	access: "access-laptop",
	refresh: "refresh-laptop",
	expires: 1_900_000_000_000,
	email: "dev@example.com",
	accountId: "acct-1",
};

function stored(store: SqliteAuthCredentialStore, provider: string): AuthCredential[] {
	return store.listAuthCredentials(provider).map(row => row.credential);
}

describe("omp auth export/import", () => {
	it("round-trips an API key and an OAuth login, refresh token included, into an empty store", async () => {
		using dir = TempDir.createSync("@omp-auth-transfer-");
		const laptop = await SqliteAuthCredentialStore.open(path.join(dir.path(), "laptop.db"));
		const cloud = await SqliteAuthCredentialStore.open(path.join(dir.path(), "cloud.db"));
		try {
			await laptop.upsertAuthCredential("openai", API_KEY);
			await laptop.upsertAuthCredential("anthropic", OAUTH);

			const document = JSON.stringify(exportAuthCredentials(laptop));
			const summary = await importAuthCredentials(cloud, parseAuthExport(document));

			expect(summary.imported).toBe(2);
			expect(stored(cloud, "openai")).toEqual([API_KEY]);
			expect(stored(cloud, "anthropic")).toEqual([OAUTH]);
		} finally {
			laptop.close();
			cloud.close();
		}
	});

	it("replaces the same account and the provider API key, keeping other accounts", async () => {
		using dir = TempDir.createSync("@omp-auth-transfer-");
		const store = await SqliteAuthCredentialStore.open(path.join(dir.path(), "agent.db"));
		try {
			const otherAccount: OAuthCredential = {
				type: "oauth",
				access: "access-other",
				refresh: "refresh-other",
				expires: 1_900_000_000_000,
				email: "other@example.com",
				accountId: "acct-2",
			};
			await store.upsertAuthCredential("anthropic", { ...OAUTH, access: "stale", refresh: "stale" });
			await store.upsertAuthCredential("anthropic", otherAccount);
			await store.upsertAuthCredential("openai", { type: "api_key", key: "sk-old" });

			await importAuthCredentials(store, {
				version: 1,
				credentials: [
					{ provider: "anthropic", credential: OAUTH },
					{ provider: "openai", credential: API_KEY },
				],
			});

			const anthropic = stored(store, "anthropic");
			expect(anthropic).toHaveLength(2);
			expect(anthropic).toContainEqual(OAUTH);
			expect(anthropic).toContainEqual(otherAccount);
			expect(stored(store, "openai")).toEqual([API_KEY]);
		} finally {
			store.close();
		}
	});

	it("rejects an OAuth entry whose refresh token stayed on an auth broker", () => {
		const document = JSON.stringify({
			version: 1,
			credentials: [{ provider: "anthropic", credential: { ...OAUTH, refresh: "__remote__" } }],
		});
		expect(() => parseAuthExport(document)).toThrow(AuthTransferError);
		expect(() => parseAuthExport(document)).toThrow(/credentials\[0\] \(anthropic\).*refresh token/);
	});
});
