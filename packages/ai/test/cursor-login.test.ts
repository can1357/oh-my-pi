import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthAccountPolicies, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

const EMAIL = "dev@example.com";
const POLICIES = [{ provider: "cursor", account: { email: EMAIL }, priority: -1 }] satisfies AuthAccountPolicies;

function cursorAccessToken(label: string): string {
	const claims = { sub: "github|user_1", exp: Math.floor(Date.now() / 1000) + 86_400, label };
	const payload = btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
	return `header.${payload}.signature`;
}

/** Answer Cursor's login poll and token exchange with `access`, and its profile with the account email. */
function stubCursor(access: string): void {
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url === "https://cursor.com/api/auth/me") return Response.json({ sub: "user_1", email: EMAIL });
		if (
			url.startsWith("https://api2.cursor.sh/auth/poll?") ||
			url === "https://api2.cursor.sh/auth/exchange_user_api_key"
		) {
			return Response.json({ accessToken: access, refreshToken: access });
		}
		throw new Error(`unexpected request: ${url}`);
	}) as typeof fetch);
}

describe("Cursor account email", () => {
	let dir = "";

	afterEach(async () => {
		vi.restoreAllMocks();
		if (dir) await removeWithRetries(dir);
		dir = "";
	});

	test("a Cursor login stores the email an account policy selects", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cursor-login-"));
		const store = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
		const auth = new AuthStorage(store, { accountPolicies: POLICIES });
		try {
			vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
			stubCursor(cursorAccessToken("login"));

			await auth.oauth.login("cursor", { onAuth() {}, onPrompt: async () => "" });

			expect(auth.oauth.accounts("cursor").map(account => account.email)).toEqual([EMAIL]);
		} finally {
			auth.close();
			store.close();
		}
	});

	test("a Cursor login stored without an email gains it at the next token refresh", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cursor-refresh-"));
		const store = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
		const stale = cursorAccessToken("stale");
		await store.upsertAuthCredential("cursor", {
			type: "oauth",
			access: stale,
			refresh: stale,
			expires: Date.now() - 1,
		});
		const auth = new AuthStorage(store);
		const restarted = new AuthStorage(store, { accountPolicies: POLICIES });
		try {
			await auth.credentials.reload();
			const fresh = cursorAccessToken("fresh");
			stubCursor(fresh);

			expect(await auth.keys.get("cursor", "session")).toBe(fresh);

			await restarted.credentials.reload();
			expect(restarted.oauth.accounts("cursor").map(account => account.email)).toEqual([EMAIL]);
		} finally {
			auth.close();
			restarted.close();
			store.close();
		}
	});

	test("a stalled profile lookup still keeps the tokens a refresh minted", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cursor-stall-"));
		const store = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
		const stale = cursorAccessToken("stale");
		await store.upsertAuthCredential("cursor", {
			type: "oauth",
			access: stale,
			refresh: stale,
			expires: Date.now() - 1,
		});
		const auth = new AuthStorage(store);
		try {
			await auth.credentials.reload();
			const fresh = cursorAccessToken("fresh");
			const profileDeadline = new AbortController();
			vi.spyOn(AbortSignal, "timeout").mockReturnValue(profileDeadline.signal);
			vi.spyOn(globalThis, "fetch").mockImplementation((async (
				input: string | URL | Request,
				init?: RequestInit,
			) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url === "https://api2.cursor.sh/auth/exchange_user_api_key") {
					return Response.json({ accessToken: fresh, refreshToken: fresh });
				}
				if (url !== "https://cursor.com/api/auth/me") throw new Error(`unexpected request: ${url}`);
				// The profile never answers; only the lookup's own deadline ends it.
				const { promise, reject } = Promise.withResolvers<Response>();
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				profileDeadline.abort();
				return promise;
			}) as typeof fetch);

			expect(await auth.keys.get("cursor", "session")).toBe(fresh);
		} finally {
			auth.close();
			store.close();
		}
	});
});
