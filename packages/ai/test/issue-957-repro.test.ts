import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import * as kimiOauth from "@oh-my-pi/pi-ai/registry/oauth/kimi";
import { removeWithRetries } from "../../utils/src/temp";

afterEach(() => {
	vi.restoreAllMocks();
});

const kimiHeadersStub = {
	"User-Agent": "KimiCLI/0.0.0",
	"X-Msh-Platform": "kimi_cli",
	"X-Msh-Version": "0.0.0",
	"X-Msh-Device-Name": "test",
	"X-Msh-Device-Model": "test",
	"X-Msh-Os-Version": "test",
	"X-Msh-Device-Id": "test",
} as const;

describe("issue #957 - Kimi OAuth refresh", () => {
	it("subtracts the 5-minute skew when mapping Kimi token expiry", async () => {
		// Kimi tokens claim a 60-minute lifetime via `expires_in`, but in
		// practice the server invalidates them roughly 5 minutes earlier than
		// that. The declarative credential map applies the standard 5-minute
		// OAuth skew so we schedule the refresh before the real server cutoff.
		const issuedAt = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(issuedAt);
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(kimiHeadersStub);
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: string | URL | Request, init?: RequestInit) => {
					const params = new URLSearchParams(String(init?.body));
					expect(params.get("grant_type")).toBe("refresh_token");
					expect(params.get("refresh_token")).toBe("refresh-0");
					return new Response(
						JSON.stringify({
							access_token: "access-1",
							refresh_token: "refresh-1",
							expires_in: 60 * 60,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				},
				{ preconnect: fetch.preconnect },
			),
		);

		const refreshToken = getProviderDefinition("kimi-code")?.refreshToken;
		if (!refreshToken) throw new Error("expected kimi-code refresh");
		const refreshed = await refreshToken({ access: "access-0", refresh: "refresh-0", expires: issuedAt });

		expect(refreshed.access).toBe("access-1");
		expect(refreshed.refresh).toBe("refresh-1");
		expect(refreshed.expires).toBe(issuedAt + 55 * 60 * 1000);
	});

	it("refreshes Kimi credentials through AuthStorage before the local expiry", async () => {
		// End-to-end: a kimi-code OAuth credential that is past the 60s
		// AuthStorage skew must be refreshed automatically via the registered
		// `kimi-code` provider when getApiKey() is called.
		const issuedAt = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockReturnValue(issuedAt + 54 * 60 * 1000);
		vi.spyOn(kimiOauth, "getKimiCommonHeaders").mockReturnValue(kimiHeadersStub);

		let refreshCalls = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: string | URL | Request, init?: RequestInit) => {
					refreshCalls += 1;
					const params = new URLSearchParams(String(init?.body));
					expect(params.get("grant_type")).toBe("refresh_token");
					expect(params.get("refresh_token")).toBe("refresh-stored");
					return new Response(
						JSON.stringify({
							access_token: "access-refreshed",
							refresh_token: "refresh-refreshed",
							expires_in: 60 * 60,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				},
				{ preconnect: fetch.preconnect },
			),
		);

		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-issue-957-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		const authStorage = new AuthStorage(store);
		try {
			await authStorage.set("kimi-code", [
				{
					type: "oauth",
					access: "access-stored",
					refresh: "refresh-stored",
					// Token is still nominally valid (4 min remaining), but
					// within the 60s AuthStorage skew the refresh should fire
					// proactively so we never hand out an expired bearer.
					expires: issuedAt + 55 * 60 * 1000,
				},
			]);

			const apiKey = await authStorage.getApiKey("kimi-code");
			expect(apiKey).toBe("access-refreshed");
			expect(refreshCalls).toBe(1);

			const stored = store.listAuthCredentials("kimi-code");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.credential.type).toBe("oauth");
			if (stored[0]?.credential.type === "oauth") {
				expect(stored[0].credential.access).toBe("access-refreshed");
				expect(stored[0].credential.refresh).toBe("refresh-refreshed");
			}
		} finally {
			store.close();
			await removeWithRetries(tempDir);
		}
	});
});
