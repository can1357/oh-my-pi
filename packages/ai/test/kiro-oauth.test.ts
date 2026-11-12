import { describe, expect, test } from "bun:test";
import { refreshKiroToken } from "@oh-my-pi/pi-ai/registry/oauth/kiro";

describe("refreshKiroToken", () => {
	test("rejects without contacting the token endpoint when the signal is already aborted", async () => {
		let calls = 0;
		const credentials = {
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() - 1_000,
			kiroClientId: "client-id",
			kiroClientSecret: "client-secret",
			kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
		};
		const fetch = async () => {
			calls += 1;
			return Response.json({ accessToken: "next-access", expiresIn: 3600 });
		};
		await expect(refreshKiroToken(credentials, { fetch, signal: AbortSignal.abort() })).rejects.toThrow();
		expect(calls).toBe(0);
	});
});
