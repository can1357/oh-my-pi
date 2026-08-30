/**
 * DigitalOcean Serverless Inference login.
 *
 * Keys are "model access keys" created in the DigitalOcean Control Panel
 * (INFERENCE → Manage). Validation hits the OpenAI-compatible
 * `https://inference.do-ai.run/v1/models` roster endpoint with Bearer auth —
 * the same listing the model manager discovers from — so login only fails
 * for keys that fail to authenticate.
 */
import { describe, expect, it } from "bun:test";
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import { loginDigitalOcean } from "@oh-my-pi/pi-ai/registry/digitalocean";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const MODELS_HOST = "inference.do-ai.run";
const MODELS_PATH = "/v1/models";

function makeController(fetchImpl: FetchImpl): OAuthLoginCallbacks {
	return {
		fetch: fetchImpl,
		onPrompt: async () => "doo_v1_TESTKEY",
		onAuth: () => {},
		onProgress: () => {},
	};
}

describe("DigitalOcean login", () => {
	it("validates the API key against the models roster endpoint", async () => {
		let capturedUrl = "";
		let capturedAuth = "";
		const fetchImpl: FetchImpl = async (input, init) => {
			capturedUrl = typeof input === "string" ? input : input.toString();
			const header = (init?.headers as Record<string, string> | undefined)?.Authorization;
			capturedAuth = header ?? "";
			return new Response(JSON.stringify({ object: "list", data: [{ id: "glm-5.2" }] }), { status: 200 });
		};

		const key = await loginDigitalOcean(makeController(fetchImpl));

		expect(key).toBe("doo_v1_TESTKEY");
		expect(capturedUrl).not.toBe("");
		const url = new URL(capturedUrl);
		expect(url.host).toBe(MODELS_HOST);
		expect(url.pathname).toBe(MODELS_PATH);
		expect(capturedAuth).toBe("Bearer doo_v1_TESTKEY");
	});

	it("surfaces upstream auth failures with status and body", async () => {
		const fetchImpl: FetchImpl = async () =>
			new Response("invalid api key", { status: 401, statusText: "Unauthorized" });

		await expect(loginDigitalOcean(makeController(fetchImpl))).rejects.toThrow(
			/DigitalOcean Serverless Inference API key validation failed \(401\): invalid api key/,
		);
	});
});
