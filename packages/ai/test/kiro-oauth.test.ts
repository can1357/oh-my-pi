import { describe, expect, test } from "bun:test";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { refreshKiroToken } from "@oh-my-pi/pi-ai/registry/oauth/kiro";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const expiredCredentials = {
	access: "access-token",
	refresh: "refresh-token",
	expires: Date.now() - 1_000,
	kiroClientId: "client-id",
	kiroClientSecret: "client-secret",
	kiroClientSecretExpiresAt: 0,
	kiroTokenEndpoint: "https://oidc.us-east-1.amazonaws.com/token",
} satisfies OAuthCredentials;

function recordingFetch(calls: { url: string; signal: AbortSignal | undefined }[]): FetchImpl {
	return async (url, init) => {
		calls.push({ url: String(url), signal: init?.signal ?? undefined });
		return new Response(JSON.stringify({ accessToken: "next-access", expiresIn: 3600 }), { status: 200 });
	};
}

describe("refreshKiroToken", () => {
	test("rejects without contacting the token endpoint when the signal is already aborted", async () => {
		const calls: { url: string; signal: AbortSignal | undefined }[] = [];
		const controller = new AbortController();
		controller.abort();

		await expect(
			refreshKiroToken(expiredCredentials, { fetch: recordingFetch(calls), signal: controller.signal }),
		).rejects.toThrow();

		expect(calls).toHaveLength(0);
	});

	test("passes a live caller signal to the refresh request", async () => {
		const calls: { url: string; signal: AbortSignal | undefined }[] = [];
		const controller = new AbortController();

		const refreshed = await refreshKiroToken(expiredCredentials, {
			fetch: recordingFetch(calls),
			signal: controller.signal,
		});

		expect(refreshed.access).toBe("next-access");
		expect(refreshed.refresh).toBe("refresh-token");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.signal).toBeDefined();
		expect(calls[0]?.signal?.aborted).toBe(false);
	});
});
