import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { AnthropicApiError } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import { AnthropicUserProfilesClient, type UserProfile } from "@oh-my-pi/pi-ai/providers/anthropic-user-profiles";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const profile: UserProfile = {
	type: "user_profile",
	id: "uprof_123",
	created_at: "2026-09-04T00:00:00Z",
	updated_at: "2026-09-04T00:00:00Z",
	metadata: { tier: "pro" },
	trust_grants: { inference: { status: "active" } },
	external_user_details: {
		account_status: "active",
		country: "US",
		email_hash: null,
		entity_type: "individual",
		name_hash: null,
		onboarded_at: null,
		reference_id: "customer-123",
	},
};

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

describe("AnthropicUserProfilesClient", () => {
	it("creates a profile with workspace, beta and API-key auth and parses the response", async () => {
		const requests: Array<{ method: string; url: string; headers: Headers; body: unknown }> = [];
		const upstream = Bun.serve({
			port: 0,
			fetch: async request => {
				requests.push({
					method: request.method,
					url: request.url,
					headers: new Headers(request.headers),
					body: await request.json(),
				});
				return json(profile);
			},
		});
		try {
			const client = new AnthropicUserProfilesClient({ apiKey: "sk-test", baseURL: upstream.url.toString() });
			const result = await client.createUserProfile(
				{ name: "Alice", external_user_details: { reference_id: "customer-123" } },
				{ workspaceId: "wrkspc_test" },
			);
			expect(result).toEqual(profile);
			const request = requests[0]!;
			expect(request.method).toBe("POST");
			expect(new URL(request.url).pathname).toBe("/v1/user_profiles");
			expect(request.headers.get("anthropic-beta")).toBe("user-profiles-2026-09-04");
			expect(request.headers.get("anthropic-version")).toBe("2023-06-01");
			expect(request.headers.get("anthropic-workspace-id")).toBe("wrkspc_test");
			expect(request.headers.get("x-api-key")).toBe("sk-test");
			expect(request.body).toEqual({ name: "Alice", external_user_details: { reference_id: "customer-123" } });
		} finally {
			upstream.stop(true);
		}
	});

	it("follows next_page cursors and supports retrieve, update, and enrollment URL", async () => {
		const requests: Array<{ method: string; path: string; body: unknown }> = [];
		const upstream = Bun.serve({
			port: 0,
			fetch: async request => {
				const url = new URL(request.url);
				requests.push({
					method: request.method,
					path: `${url.pathname}${url.search}`,
					body: request.method === "GET" ? null : await request.text(),
				});
				if (url.pathname.endsWith("/enrollment_url"))
					return json({
						type: "enrollment_url",
						expires_at: "2026-09-05T00:00:00Z",
						url: "https://example.com/enroll",
					});
				if (url.pathname !== "/v1/user_profiles") return json(profile);
				return json({
					data: url.searchParams.has("page") ? [] : [profile],
					next_page: url.searchParams.has("page") ? null : "next cursor",
				});
			},
		});
		try {
			const client = new AnthropicUserProfilesClient({ authToken: "bearer", baseURL: upstream.url.toString() });
			const pages = [];
			for await (const page of client.iterateUserProfilePages({ limit: 3, order: "asc", order_by: "name" }))
				pages.push(page);
			expect(pages).toEqual([
				{ data: [profile], next_page: "next cursor" },
				{ data: [], next_page: null },
			]);
			expect(requests[0]?.path).toBe("/v1/user_profiles?limit=3&order=asc&order_by=name");
			expect(requests[1]?.path).toBe("/v1/user_profiles?limit=3&order=asc&order_by=name&page=next+cursor");
			expect(await client.getUserProfile(profile.id)).toEqual(profile);
			expect(await client.updateUserProfile(profile.id, { metadata: { tier: "" } })).toEqual(profile);
			expect(requests[3]?.body).toBe(JSON.stringify({ metadata: { tier: "" } }));
			expect(await client.createEnrollmentUrl(profile.id)).toEqual({
				type: "enrollment_url",
				expires_at: "2026-09-05T00:00:00Z",
				url: "https://example.com/enroll",
			});
			expect(requests[4]).toEqual({
				method: "POST",
				path: `/v1/user_profiles/${profile.id}/enrollment_url`,
				body: "",
			});
		} finally {
			upstream.stop(true);
		}
	});

	it("maps an API rejection to AnthropicApiError with status", async () => {
		const upstream = Bun.serve({
			port: 0,
			fetch: () => json({ type: "error", error: { type: "not_found_error", message: "Unknown user profile" } }, 404),
		});
		try {
			const client = new AnthropicUserProfilesClient({ apiKey: "sk-test", baseURL: upstream.url.toString() });
			const error = await client.getUserProfile("uprof_missing").catch(error => error);
			expect(error).toBeInstanceOf(AnthropicApiError);
			expect(error.status).toBe(404);
			expect(error.message).toContain("Unknown user profile");
		} finally {
			upstream.stop(true);
		}
	});
});

it("forwards inbound Anthropic user-profile attribution through the gateway to upstream", async () => {
	const upstreamHeaders: string[] = [];
	const sseEvents = [
		{
			type: "message_start",
			message: {
				id: "msg_test",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	const upstream = Bun.serve({
		port: 0,
		fetch: request => {
			upstreamHeaders.push(request.headers.get("anthropic-user-profile-id") ?? "");
			return new Response(
				`${sseEvents.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`,
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-gateway-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("anthropic", "sk-test");
	const model: Model<"anthropic-messages"> = buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: upstream.url.toString(),
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["test-token"],
		storage,
		resolveModel: () => model,
		version: "test",
	});
	try {
		const response = await fetch(`${gateway.url}/v1/messages`, {
			method: "POST",
			headers: {
				authorization: "Bearer test-token",
				"content-type": "application/json",
				"anthropic-user-profile-id": "uprof_gateway",
			},
			body: JSON.stringify({ model: model.id, max_tokens: 16, messages: [{ role: "user", content: "hello" }] }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ content: [{ type: "text", text: "ok" }] });
		expect(upstreamHeaders).toEqual(["uprof_gateway"]);
		const nativeResponse = await fetch(`${gateway.url}/v1/pi/stream`, {
			method: "POST",
			headers: { authorization: "Bearer test-token", "content-type": "application/json" },
			body: JSON.stringify({
				modelId: model.id,
				stream: true,
				context: { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
				options: { userProfileId: "uprof_native" },
			}),
		});
		expect(nativeResponse.status).toBe(200);
		expect(await nativeResponse.text()).toContain("ok");
		expect(upstreamHeaders).toEqual(["uprof_gateway", "uprof_native"]);
		const preflight = await fetch(`${gateway.url}/v1/messages`, {
			method: "OPTIONS",
			headers: { origin: "https://example.com", "access-control-request-headers": "anthropic-user-profile-id" },
		});
		expect(preflight.headers.get("access-control-allow-headers")).toContain("anthropic-user-profile-id");
	} finally {
		await gateway.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
		upstream.stop(true);
	}
});
