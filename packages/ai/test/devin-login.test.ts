import { describe, expect, test } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthController } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("Devin CLI login", () => {
	test("exchanges callback code with CLI token JSON endpoint", async () => {
		let authUrl = "";
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		const fetchImpl: FetchImpl = async (url, init) => {
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
});
