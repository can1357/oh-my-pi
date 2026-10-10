import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { type AuthAccountPolicies, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";

const EMAIL = "dev@example.com";
const POLICIES = [{ provider: "cursor", account: { email: EMAIL }, priority: -1 }] satisfies AuthAccountPolicies;

function cursorAccessToken(label: string): string {
	const claims = { sub: "github|user_1", exp: Math.floor(Date.now() / 1000) + 86_400, label };
	const payload = btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
	return `header.${payload}.signature`;
}

/** Cursor's session renewal: `renewed` for the IDE's refresh grant on `session`; every other session is signed out. */
function renewCursorSession(init: RequestInit | undefined, session: string | undefined, renewed: string): Response {
	const body = JSON.parse(String(init?.body));
	if (
		body.grant_type === "refresh_token" &&
		body.client_id === "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB" &&
		body.refresh_token === session
	) {
		return Response.json({ access_token: renewed, id_token: "", shouldLogout: false });
	}
	return Response.json({ access_token: "", id_token: "", shouldLogout: true });
}

/** Answer Cursor's login poll with `access`, renew `session` into `access`, and answer its profile with the account email. */
function stubCursor(access: string, session?: string): void {
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url === "https://cursor.com/api/auth/me") return Response.json({ sub: "user_1", email: EMAIL });
		if (url.startsWith("https://api2.cursor.sh/auth/poll?")) {
			return Response.json({ accessToken: access, refreshToken: access });
		}
		if (url === "https://api2.cursor.sh/oauth/token") return renewCursorSession(init, session, access);
		throw new Error(`unexpected request: ${url}`);
	}) as typeof fetch);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Cursor account email", () => {
	test("a Cursor login stores the email an account policy selects", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
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
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
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
			stubCursor(fresh, stale);

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
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
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
				if (url === "https://api2.cursor.sh/oauth/token") return renewCursorSession(init, stale, fresh);
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

describe("Cursor session refresh", () => {
	// `keys.get` falls back to the environment, so an ambient Cursor token would mask the stored row.
	let savedAccessToken: string | undefined;

	beforeEach(() => {
		savedAccessToken = process.env.CURSOR_ACCESS_TOKEN;
		delete process.env.CURSOR_ACCESS_TOKEN;
	});

	afterEach(() => {
		if (savedAccessToken === undefined) delete process.env.CURSOR_ACCESS_TOKEN;
		else process.env.CURSOR_ACCESS_TOKEN = savedAccessToken;
	});

	async function storeExpiredSession(session: string): Promise<SqliteAuthCredentialStore> {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		await store.upsertAuthCredential("cursor", {
			type: "oauth",
			access: session,
			refresh: session,
			expires: Date.now() - 1,
			email: EMAIL,
		});
		return store;
	}

	test("an expired Cursor login renews its access token and keeps its refresh token", async () => {
		const stale = cursorAccessToken("stale");
		const store = await storeExpiredSession(stale);
		const auth = new AuthStorage(store);
		try {
			await auth.credentials.reload();
			const fresh = cursorAccessToken("fresh");
			stubCursor(fresh, stale);

			expect(await auth.keys.get("cursor", "session")).toBe(fresh);
			expect(store.listAuthCredentials("cursor").map(row => row.credential)).toMatchObject([
				{ type: "oauth", access: fresh, refresh: stale },
			]);
		} finally {
			auth.close();
			store.close();
		}
	});

	test("a renewal that rotates the refresh token stores the rotated one", async () => {
		const stale = cursorAccessToken("stale");
		const store = await storeExpiredSession(stale);
		const auth = new AuthStorage(store);
		try {
			await auth.credentials.reload();
			const fresh = cursorAccessToken("fresh");
			const rotated = cursorAccessToken("rotated");
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				Response.json({ access_token: fresh, refresh_token: rotated, shouldLogout: false }),
			);

			expect(await auth.keys.get("cursor", "session")).toBe(fresh);
			expect(store.listAuthCredentials("cursor").map(row => row.credential)).toMatchObject([
				{ type: "oauth", access: fresh, refresh: rotated },
			]);
		} finally {
			auth.close();
			store.close();
		}
	});

	test("a session Cursor signs out is disabled instead of stored without a token", async () => {
		const store = await storeExpiredSession(cursorAccessToken("ended"));
		const auth = new AuthStorage(store);
		try {
			await auth.credentials.reload();
			stubCursor(cursorAccessToken("fresh"));

			expect(await auth.keys.get("cursor", "session")).toBeUndefined();
			expect(store.listAuthCredentials("cursor")).toEqual([]);
			const causes = (await store.listDisabledCredentials("cursor")).map(row => row.cause);
			expect(causes).toHaveLength(1);
			expect(causes[0]).toContain("run /login cursor again");
		} finally {
			auth.close();
			store.close();
		}
	});

	test("a renewal that returns no token keeps the stored session active", async () => {
		const stale = cursorAccessToken("stale");
		const store = await storeExpiredSession(stale);
		const auth = new AuthStorage(store);
		try {
			await auth.credentials.reload();
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				Response.json({ access_token: "", id_token: "", shouldLogout: false }),
			);

			expect(await auth.keys.get("cursor", "session")).toBeUndefined();
			expect(store.listAuthCredentials("cursor").map(row => row.credential)).toMatchObject([
				{ type: "oauth", access: stale, refresh: stale },
			]);
			expect(await store.listDisabledCredentials("cursor")).toEqual([]);
		} finally {
			auth.close();
			store.close();
		}
	});
});
