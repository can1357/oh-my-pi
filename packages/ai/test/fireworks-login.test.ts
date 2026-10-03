/**
 * Regression for issue #3219.
 *
 * The legacy validator pinged `https://api.fireworks.ai/inference/v1/models`,
 * which Fireworks serves from the per-account deployment registry and 500s
 * (`Error listing deployed models`) for accounts without active deployments.
 * That rejected valid `fw_…` keys during `/login`. Validation now uses the
 * static control-plane `List Models` API — the same endpoint discovery hits —
 * so login only fails for keys that fail to authenticate, not for accounts in
 * a "no deployments" state.
 */
import { describe, expect, it } from "bun:test";

import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthController } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const loginFireworks = getProviderDefinition("fireworks")?.login;
if (!loginFireworks) throw new Error("Fireworks login is not registered");

const CONTROL_PLANE_HOST = "api.fireworks.ai";
const CONTROL_PLANE_PATH = "/v1/accounts/fireworks/models";

function makeController(fetchImpl: FetchImpl): OAuthController {
	return {
		fetch: fetchImpl,
		onPrompt: async () => "fw_TESTKEY",
		onAuth: () => {},
		onProgress: () => {},
	};
}

describe("loginFireworks", () => {
	it("validates the API key against the control-plane List Models endpoint", async () => {
		let capturedUrl = "";
		let capturedAuth = "";
		const fetchImpl: FetchImpl = async (input, init) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			const header = (init?.headers as Record<string, string> | undefined)?.Authorization;
			capturedAuth = header ?? "";
			return new Response(JSON.stringify({ models: [] }), { status: 200 });
		};

		const key = await loginFireworks(makeController(fetchImpl));

		expect(key).toBe("fw_TESTKEY");
		expect(capturedUrl).not.toBe("");
		const url = new URL(capturedUrl);
		expect(url.host).toBe(CONTROL_PLANE_HOST);
		expect(url.pathname).toBe(CONTROL_PLANE_PATH);
		expect(url.searchParams.get("filter")).toBe("supports_serverless=true");
		// The inference listing — which returned 500 on the reporter's account — must NOT be hit.
		expect(url.pathname).not.toBe("/inference/v1/models");
		expect(capturedAuth).toBe("Bearer fw_TESTKEY");
	});

	it("surfaces upstream auth failures with status and body", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response("invalid api key", { status: 401, statusText: "Unauthorized" });

		await expect(loginFireworks(makeController(fetchImpl))).rejects.toThrow(
			/Fireworks API key validation failed \(401\): invalid api key/,
		);
	});
});
