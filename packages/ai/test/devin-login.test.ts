import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthController } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { devinUsageProvider } from "@oh-my-pi/pi-ai/usage/devin";
import {
	DevinPlanInfoSchema,
	GetUserStatusRequestSchema,
	GetUserStatusResponseSchema,
	PlanInfoSchema,
	UserStatusSchema,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("Devin CLI login", () => {
	test("exchanges callback code with CLI token JSON endpoint", async () => {
		let authUrl = "";
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		const fetchImpl: FetchImpl = async (url, init) => {
			// The token exchange is the first request; the identity read follows it.
			requestUrl ||= String(url);
			requestInit ??= init;
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
		// The identity read got no seat status back, so the login still completes, without identity.
		expect(credentials.orgId).toBeUndefined();
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

	test("two organizations of one user sign in as two accounts with their own usage", async () => {
		// One Devin user (same id and email) in two organizations; each token is scoped to one.
		const plans: Record<string, string> = { "org-team": "Pro", "org-personal": "Max" };
		let nextToken = "";
		const fetchImpl: FetchImpl = async (url, init) => {
			if (String(url) === "https://api.devin.ai/auth/cli/token") return Response.json({ token: nextToken });
			const apiKey = fromBinary(GetUserStatusRequestSchema, init?.body as Uint8Array).metadata?.apiKey ?? "";
			const orgId = apiKey.slice(apiKey.indexOf("$") + 1);
			const response = create(GetUserStatusResponseSchema, {
				userStatus: create(UserStatusSchema, { email: "will@example.com", userId: "user-1" }),
				planInfo: create(PlanInfoSchema, {
					planName: plans[orgId],
					devinInfo: create(DevinPlanInfoSchema, { orgId }),
				}),
			});
			return new Response(toBinary(GetUserStatusResponseSchema, response));
		};
		const db = new Database(":memory:");
		const storage = new AuthStorage(new SqliteAuthCredentialStore(db), {
			usageProviderResolver: provider => (provider === "devin" ? devinUsageProvider : undefined),
			usageFetch: fetchImpl as typeof fetch,
		});
		try {
			await storage.credentials.reload();
			for (const token of Object.keys(plans)) {
				nextToken = token;
				let authUrl = "";
				await storage.oauth.login("devin", {
					onAuth: info => {
						authUrl = info.url;
					},
					onPrompt: async () => "",
					onManualCodeInput: async () => `callback-code#${new URL(authUrl).searchParams.get("state")}`,
					fetch: fetchImpl,
				});
			}

			const keys = db.query("SELECT identity_key FROM auth_credentials WHERE provider = 'devin' ORDER BY id").all();
			expect(keys).toEqual([
				{ identity_key: "email:will@example.com|org:org-team" },
				{ identity_key: "email:will@example.com|org:org-personal" },
			]);
			const reports = ((await storage.usage.reports()) ?? []).filter(report => report.provider === "devin");
			expect(reports.map(report => [report.metadata?.orgId, report.metadata?.planType]).sort()).toEqual([
				["org-personal", "Max"],
				["org-team", "Pro"],
			]);
		} finally {
			storage.close();
		}
	});
});
