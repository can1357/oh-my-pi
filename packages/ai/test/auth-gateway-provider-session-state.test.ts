/**
 * The auth-gateway owns `providerSessionState` per logical session.
 *
 * Providers learn sticky lessons about an endpoint from rejections: Anthropic's
 * `fastModeDisabled` / `strictToolsDisabled` / `replayUnsignedThinkingDisabled`
 * flags, OpenAI's strict-tools and reasoning-effort fallbacks. The map holding
 * them is non-serializable, so `pi-native-client` strips it from the wire and
 * `pi-native-server` refuses it — a gateway client cannot supply one. Without a
 * server-side owner, every containerized / robomp turn re-pays the rejected
 * upstream round-trip that already taught the lesson.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { AuthGatewaySessionStateStore, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import type { AuthGatewayServerHandle } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

function makeAnthropicModel(baseUrl: string): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-opus-4-7",
		name: "claude-opus-4-7",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

const ANTHROPIC_MODEL: Model<"anthropic-messages"> = makeAnthropicModel("https://api.anthropic.com");

const CONTEXT: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "Hi", timestamp: 1 }],
};

const SSE_EVENTS: Array<Record<string, unknown>> = [
	{
		type: "message_start",
		message: {
			id: "msg_gateway_session_state",
			type: "message",
			role: "assistant",
			model: ANTHROPIC_MODEL.id,
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

/**
 * What the real API answers a `speed: "fast"` request with when the account or
 * model lacks the entitlement. Must stay classifiable as
 * `FastModeUnsupported`: HTTP 400 + `invalid_request_error` + `speed` +
 * "not support".
 */
const FAST_MODE_REJECTION = {
	type: "error",
	error: {
		type: "invalid_request_error",
		message: "speed: this model does not support fast mode for your account",
	},
};

interface UpstreamPayload {
	speed?: string;
}

interface Upstream {
	/** Base URL an `anthropic-messages` model can be pointed at. */
	url: string;
	/** One entry per upstream Anthropic request, in order. */
	payloads: UpstreamPayload[];
	stop(): void;
}

/**
 * Stand-in Anthropic endpoint. Rejects every request carrying `speed` — what
 * the live API does for an account or model without the fast-mode entitlement
 * — so the provider's one-shot fallback fires, and a gateway that retained the
 * lesson never asks again.
 */
function startUpstream(): Upstream {
	const payloads: UpstreamPayload[] = [];
	const sse = `${SSE_EVENTS.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async (req): Promise<Response> => {
			const payload = (await req.json()) as UpstreamPayload;
			payloads.push(payload);
			if (payload.speed !== undefined) {
				return new Response(JSON.stringify(FAST_MODE_REJECTION), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		payloads,
		stop: () => {
			server.stop(true);
		},
	};
}

interface GatewayFixture {
	handle: AuthGatewayServerHandle;
	stop(): Promise<void>;
	cleanup(): Promise<void>;
}

async function startGateway(model: Model<Api>, provider: string): Promise<GatewayFixture> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-session-state-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.setRuntimeApiKey(provider, "sk-ant-api-test");
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["test-token"],
		storage,
		resolveModel: () => model,
		version: "test",
	});
	let stopped = false;
	const stop = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		await handle.close();
	};
	return {
		handle,
		stop,
		cleanup: async () => {
			await stop();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

/**
 * One priority-tier turn through the pi-native route. Returns the status plus
 * the decoded envelope so a failed turn reports the upstream reason instead of
 * a bare number.
 */
async function priorityTurn(
	handle: AuthGatewayServerHandle,
	sessionId: string,
	modelId: string,
): Promise<{ status: number; body: unknown }> {
	const response = await fetch(`${handle.url}/v1/pi/stream`, {
		method: "POST",
		headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
		body: JSON.stringify({
			modelId,
			context: CONTEXT,
			options: { sessionId, serviceTier: "priority" },
			stream: false,
		}),
	});
	return { status: response.status, body: await response.json() };
}

/**
 * One priority-tier turn through a foreign-wire route. No session key is sent,
 * so the gateway derives one from model + system + tools + first message —
 * identical bodies land on the same logical session.
 */
async function priorityChatTurn(
	handle: AuthGatewayServerHandle,
	modelId: string,
	prompt: string,
): Promise<{ status: number; body: unknown }> {
	const response = await fetch(`${handle.url}/v1/chat/completions`, {
		method: "POST",
		headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
		body: JSON.stringify({
			model: modelId,
			messages: [
				{ role: "system", content: "Stay concise." },
				{ role: "user", content: prompt },
			],
			service_tier: "priority",
			stream: false,
		}),
	});
	return { status: response.status, body: await response.json() };
}

withOfficialAnthropicEndpoint();

describe("auth-gateway provider session state", () => {
	it("carries a session's learned fast-mode fallback into its next request", async () => {
		const upstream = startUpstream();
		const model = makeAnthropicModel(upstream.url);
		const gateway = await startGateway(model, "anthropic");
		try {
			expect(await priorityTurn(gateway.handle, "session-a", model.id)).toMatchObject({ status: 200 });
			expect(await priorityTurn(gateway.handle, "session-a", model.id)).toMatchObject({ status: 200 });

			// Turn one: asks for fast mode, gets rejected, retries without it.
			// Turn two: the lesson survived the request boundary, so it never asks
			// again — one wasted round-trip per session instead of one per turn.
			expect(upstream.payloads.map(payload => payload.speed)).toEqual(["fast", undefined, undefined]);
		} finally {
			await gateway.cleanup();
			upstream.stop();
		}
	});

	it("carries the learned fallback across requests on the foreign-wire routes", async () => {
		const upstream = startUpstream();
		const model = makeAnthropicModel(upstream.url);
		const gateway = await startGateway(model, "anthropic");
		try {
			expect(await priorityChatTurn(gateway.handle, model.id, "Hi")).toMatchObject({ status: 200 });
			expect(await priorityChatTurn(gateway.handle, model.id, "Hi")).toMatchObject({ status: 200 });
			// Different conversation seed, so a different derived session: it asks
			// for fast mode on its own account.
			expect(await priorityChatTurn(gateway.handle, model.id, "Other")).toMatchObject({ status: 200 });

			expect(upstream.payloads.map(payload => payload.speed)).toEqual([
				"fast",
				undefined,
				undefined,
				"fast",
				undefined,
			]);
		} finally {
			await gateway.cleanup();
			upstream.stop();
		}
	});

	it("keeps one session's fallback out of another session's requests", async () => {
		const upstream = startUpstream();
		const model = makeAnthropicModel(upstream.url);
		const gateway = await startGateway(model, "anthropic");
		try {
			expect(await priorityTurn(gateway.handle, "session-a", model.id)).toMatchObject({ status: 200 });
			expect(await priorityTurn(gateway.handle, "session-b", model.id)).toMatchObject({ status: 200 });

			// Session B is a different conversation, possibly a different account:
			// it still asks for priority routing rather than inheriting A's
			// downgrade, then learns the same lesson on its own.
			expect(upstream.payloads.map(payload => payload.speed)).toEqual(["fast", undefined, "fast", undefined]);
		} finally {
			await gateway.cleanup();
			upstream.stop();
		}
	});

	it("closes the provider state it evicts at the session ceiling", () => {
		const store = new AuthGatewaySessionStateStore(1);
		const closed: string[] = [];
		const first = store.acquire("session-a", ANTHROPIC_MODEL);
		first.set("probe", { close: () => closed.push("session-a") });

		expect(store.acquire("session-a", ANTHROPIC_MODEL)).toBe(first);
		expect(closed).toEqual([]);

		store.acquire("session-b", ANTHROPIC_MODEL);

		// Dropping an entry without closing it leaks the sockets and timers the
		// ceiling exists to cap, and handing the dropped map back would resurrect
		// state whose `close()` already ran.
		expect(closed).toEqual(["session-a"]);
		expect(store.size).toBe(1);
		expect(store.acquire("session-a", ANTHROPIC_MODEL)).not.toBe(first);
	});

	it("closes every retained provider state when the gateway shuts down", async () => {
		registerMockApi();
		const mock = createMockModel({ provider: "openrouter", id: "gw-session-drain" });
		const gateway = await startGateway(mock, "openrouter");
		try {
			mock.push({ content: ["ok"] });
			const response = await fetch(`${gateway.handle.url}/v1/pi/stream`, {
				method: "POST",
				headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
				body: JSON.stringify({
					modelId: mock.id,
					context: CONTEXT,
					options: { sessionId: "drain-session" },
					stream: false,
				}),
			});
			expect(response.status).toBe(200);
			await response.json();

			// The map the provider was handed IS the gateway's retained entry.
			const states = mock.calls[0]?.options?.providerSessionState;
			expect(states).toBeDefined();
			const closed: string[] = [];
			states?.set("probe", { close: () => closed.push("probe") });

			await gateway.stop();

			expect(closed).toEqual(["probe"]);
		} finally {
			await gateway.cleanup();
			clearCustomApis();
		}
	});
});
