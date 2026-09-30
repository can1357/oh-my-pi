import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthController } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import {
	GetUserStatusRequestSchema,
	GetUserStatusResponseSchema,
	UserStatusSchema,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

describe("Devin CLI login", () => {
	test("exchanges callback code with CLI token JSON endpoint", async () => {
		let authUrl = "";
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		const fetchImpl: FetchImpl = async (url, init) => {
			if (String(url).endsWith("/GetUserStatus")) {
				return new Response(
					toBinary(
						GetUserStatusResponseSchema,
						create(GetUserStatusResponseSchema, {
							userStatus: create(UserStatusSchema, { userId: "user-7", email: "user@example.com" }),
						}),
					),
					{ status: 200 },
				);
			}
			requestUrl = String(url);
			requestInit = init;
			return new Response(JSON.stringify({ token: "devin-jwt" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};
		const callbacks: OAuthController = {
			onAuth: info => {
				authUrl = info.url;
			},
			onManualCodeInput: async () => {
				const state = new URL(authUrl).searchParams.get("state");
				return `callback-code#${state}`;
			},
			fetch: fetchImpl,
		};

		const credentials = await getProviderDefinition("devin")?.login?.(callbacks);

		expect(credentials).not.toBeUndefined();
		expect(typeof credentials).not.toBe("string");
		if (!credentials || typeof credentials === "string") throw new Error("expected structured credentials");
		expect(credentials.access).toBe("devin-jwt");
		expect(credentials.accountId).toBe("user-7");
		expect(credentials.email).toBe("user@example.com");
		expect(requestUrl).toBe("https://api.devin.ai/auth/cli/token");
		expect(requestInit?.method).toBe("POST");
		expect(requestInit?.headers).toEqual({
			Accept: "application/json",
			"Content-Type": "application/json",
		});
		const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
		expect(body.code).toBe("callback-code");
		expect(typeof body.code_verifier).toBe("string");
	});
	test("re-login replaces only the matching Devin user, and an unidentified login cannot create a row", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-devin-login-"));
		const store = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
		try {
			let authUrl = "";
			let nextUserId = "user-7";
			let grant = 0;
			const callbacks: OAuthController = {
				onAuth: info => {
					authUrl = info.url;
				},
				onManualCodeInput: async () => `callback-code#${new URL(authUrl).searchParams.get("state")}`,
				fetch: async url =>
					String(url).endsWith("/GetUserStatus")
						? new Response(
								toBinary(
									GetUserStatusResponseSchema,
									create(GetUserStatusResponseSchema, {
										userStatus: create(UserStatusSchema, { userId: nextUserId }),
									}),
								),
								{ status: 200 },
							)
						: new Response(JSON.stringify({ token: `grant-${++grant}` }), { status: 200 }),
			};
			const login = async () => {
				const credential = await getProviderDefinition("devin")?.login?.(callbacks);
				if (!credential || typeof credential === "string") throw new Error("expected Devin OAuth credentials");
				return store.upsertAuthCredential("devin", { type: "oauth", ...credential });
			};

			await login();
			nextUserId = "user-8";
			await login();
			nextUserId = "user-7";
			const rows = await login();
			expect(rows.map(row => row.id)).toEqual([1, 2]);
			expect(rows[0]?.credential.type === "oauth" && rows[0].credential.access).toBe("grant-3");
			expect(rows[1]?.credential.type === "oauth" && rows[1].credential.access).toBe("grant-2");

			nextUserId = "";
			await expect(login()).rejects.toThrow("Could not identify the Devin account");
			expect(store.listAuthCredentials("devin").map(row => row.id)).toEqual([1, 2]);
		} finally {
			store.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	test("recovers legacy NULL-key rows before replacing only the matching account", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-devin-legacy-"));
		const store = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
		try {
			for (const access of ["legacy-a-1", "legacy-b", "legacy-a-2"]) {
				await store.upsertAuthCredential("devin", {
					type: "oauth",
					access,
					refresh: access,
					expires: Date.now() + 60_000,
				});
			}
			const auth = new AuthStorage(store);
			await auth.reload();
			let authUrl = "";
			await auth.oauth.login("devin", {
				onAuth: info => {
					authUrl = info.url;
				},
				onPrompt: async () => "",
				onManualCodeInput: async () => `callback-code#${new URL(authUrl).searchParams.get("state")}`,
				fetch: async (url, init) => {
					if (!String(url).endsWith("/GetUserStatus")) {
						return new Response(JSON.stringify({ token: "new-grant" }), { status: 200 });
					}
					const body = init?.body;
					if (!(body instanceof Uint8Array)) throw new Error("expected Devin status protobuf request");
					const request = fromBinary(GetUserStatusRequestSchema, body);
					const userId = request.metadata?.apiKey?.endsWith("legacy-b") ? "user-8" : "user-7";
					return new Response(
						toBinary(
							GetUserStatusResponseSchema,
							create(GetUserStatusResponseSchema, { userStatus: create(UserStatusSchema, { userId }) }),
						),
						{ status: 200 },
					);
				},
			});
			const rows = store.listAuthCredentials("devin");
			expect(rows.map(row => row.id)).toEqual([1, 2]);
			expect(rows.map(row => row.credential.type === "oauth" && row.credential.access)).toEqual([
				"new-grant",
				"legacy-b",
			]);
		} finally {
			store.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
