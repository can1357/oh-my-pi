import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import { cloudflareAiGatewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { serializeCloudflareCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare";
import { getBundledModels } from "../src/models";

const credential = serializeCloudflareCredential({ token: "gateway-secret", accountId: "account", gatewayId: "gateway" });
const reference = getBundledModels("cloudflare-ai-gateway").find(
	model => model.id.startsWith("workers-ai/") && model.api === "openai-completions",
);
if (!reference) throw new Error("Expected a bundled Workers AI gateway chat model");
const response = () => Response.json({
	success: true,
	result: [{ name: reference.id.slice("workers-ai/".length), task: "text-generation" }],
});

describe("Cloudflare discovery credentials", () => {
	test("uses the Gateway token for discovery and inference", async () => {
		const requests: Array<{ url: string; headers: Headers }> = [];
		const fetchMock = (async (input, init) => {
			requests.push({ url: String(input), headers: new Headers(init?.headers) });
			return String(input).includes("api.cloudflare.com") ? response() : Response.json({ data: [] });
		}) as typeof fetch;
		const options = cloudflareAiGatewayModelManagerOptions({
			apiKey: credential,
			baseUrl: "https://gateway.example/v1",
			fetch: fetchMock,
		});
		await options.fetchDynamicModels?.();
		expect(requests.find(request => request.url.includes("api.cloudflare.com"))?.headers.get("Authorization")).toBe("Bearer gateway-secret");
		expect(requests.find(request => request.url.includes("gateway.example"))?.headers.get("x-api-key")).toBe("gateway-secret");
	});

	test("uses the Gateway token even when CLOUDFLARE_API_TOKEN is set", async () => {
		let authorization: string | null = null;
		const fetchMock = (async (_input, init) => {
			authorization = new Headers(init?.headers).get("Authorization");
			return response();
		}) as typeof fetch;
		const previous = process.env.CLOUDFLARE_API_TOKEN;
		process.env.CLOUDFLARE_API_TOKEN = "environment-discovery-token";
		try {
			await cloudflareAiGatewayModelManagerOptions({ apiKey: credential, fetch: fetchMock }).fetchDynamicModels?.();
			expect(authorization).toBe("Bearer gateway-secret");
		} finally {
			if (previous === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
			else process.env.CLOUDFLARE_API_TOKEN = previous;
		}
	});

	test("uses the Gateway token and CLOUDFLARE_ACCOUNT_ID for a plain Gateway credential", async () => {
		const previousToken = process.env.CLOUDFLARE_API_TOKEN;
		const previousAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
		process.env.CLOUDFLARE_API_TOKEN = "environment-discovery-token";
		process.env.CLOUDFLARE_ACCOUNT_ID = "environment-account";
		let requested = "";
		let authorization: string | null = null;
		try {
			const fetchMock = (async (input, init) => {
				requested = String(input);
				authorization = new Headers(init?.headers).get("Authorization");
				return response();
			}) as typeof fetch;
			await cloudflareAiGatewayModelManagerOptions({ apiKey: "gateway-secret", fetch: fetchMock }).fetchDynamicModels?.();
			expect(requested).toContain("/accounts/environment-account/ai/models/search");
			expect(authorization).toBe("Bearer gateway-secret");
		} finally {
			if (previousToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
			else process.env.CLOUDFLARE_API_TOKEN = previousToken;
			if (previousAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
			else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccount;
		}
	});

	test("retains null fallback for network and non-permission HTTP failures", async () => {
		for (const fetchMock of [
			(async () => { throw new Error("network failure"); }) as typeof fetch,
			(async () => new Response(null, { status: 500 })) as typeof fetch,
		]) {
			const options = cloudflareAiGatewayModelManagerOptions({ apiKey: credential, fetch: fetchMock });
			expect(await options.fetchDynamicModels?.()).toBeNull();
		}
	});

	for (const status of [401, 403]) {
		test(`reports HTTP ${status} without leaking credentials`, async () => {
			const fetchMock = (async () => new Response("gateway-secret", { status })) as typeof fetch;
			const options = cloudflareAiGatewayModelManagerOptions({ apiKey: credential, fetch: fetchMock });
			try {
				await options.fetchDynamicModels?.();
				throw new Error("Expected discovery to fail");
			} catch (error) {
				expect(String(error)).toContain(`HTTP ${status}`);
				expect(String(error)).toContain("Workers AI read permission");
				expect(String(error)).not.toContain("secret");
			}
		});
	}

	test("preserves cached models and exposes permission errors after discovery fails", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudflare-discovery-"));
		try {
			let denied = false;
			const fetchMock = (async () => denied ? new Response(null, { status: 403 }) : response()) as typeof fetch;
			const manager = createModelManager({
				...cloudflareAiGatewayModelManagerOptions({ apiKey: credential, fetch: fetchMock }),
				cacheDbPath: path.join(dir, "models.db"),
				modelsDev: undefined,
			});
			const initial = await manager.refresh("online");
			expect(initial.models.some(model => model.id === reference.id)).toBe(true);
			denied = true;
			const fallback = await manager.refresh("online");
			expect(fallback.models.some(model => model.id === reference.id)).toBe(true);
			expect(fallback.fetchError).toContain("HTTP 403");
			expect(fallback.fetchError).not.toContain("gateway-secret");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
