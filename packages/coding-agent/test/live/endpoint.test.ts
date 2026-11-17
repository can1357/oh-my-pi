import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { OPENAI_HEADERS } from "@oh-my-pi/pi-catalog/wire/codex";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController, type LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import { buildLiveSessionUpdate } from "@oh-my-pi/pi-coding-agent/live/protocol";
import * as liveTransport from "@oh-my-pi/pi-coding-agent/live/transport";
import {
	buildLiveSidebandUrl,
	type LiveEndpoint,
	LiveTransport,
	type LiveTransportOptions,
	liveEndpointCallsUrl,
	liveEndpointHeaders,
	liveEndpointSidebandUrl,
	parseLiveEndpointCallId,
	resolveLiveEndpoint,
} from "@oh-my-pi/pi-coding-agent/live/transport";

/** Headers only Codex calls carry besides {@link OPENAI_HEADERS}; a custom endpoint must never see any. */
const CODEX_ONLY_HEADERS = ["x-oai-attestation", "openai-alpha", "x-session-id"];

/** Auth storage that fails the test if a custom-endpoint call asks for a Codex login. */
const noCodexLogin = {
	oauth: {
		access: () => {
			throw new Error("a custom live endpoint must not use Codex OAuth");
		},
	},
} as unknown as AuthStorage;

const callbacks = { onEvent: () => {}, onOutputLevel: () => {} };

/** A local OpenAI Realtime WebRTC-shaped server recording what it receives. */
function realtimeServer() {
	const calls: Request[] = [];
	const offers: string[] = [];
	const upgrades: Request[] = [];
	const messages: string[] = [];
	const message = Promise.withResolvers<string>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, srv) {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname === "/v1/realtime/calls") {
				calls.push(request);
				offers.push(await request.text());
				return new Response("v=0 answer", { status: 201, headers: { Location: "/v1/realtime/calls/rtc_local" } });
			}
			if (url.pathname === "/v1/realtime" && srv.upgrade(request)) {
				upgrades.push(request);
				return undefined;
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message(_socket, data) {
				messages.push(String(data));
				message.resolve(String(data));
			},
		},
	});
	return { server, calls, offers, upgrades, messages, firstMessage: message.promise };
}

function endpointTransport(endpoint: LiveEndpoint): LiveTransport {
	return new LiveTransport({
		authStorage: noCodexLogin,
		endpoint,
		sessionId: "s1",
		instructions: "Be brief.",
		voice: "marin",
		sdpOffer: "v=0 offer",
		callbacks,
	});
}

function expectNoCodexHeaders(request: Request): void {
	for (const name of CODEX_ONLY_HEADERS) expect(request.headers.has(name)).toBe(false);
	for (const key in OPENAI_HEADERS) {
		expect(request.headers.has(OPENAI_HEADERS[key as keyof typeof OPENAI_HEADERS])).toBe(false);
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("live endpoint URLs", () => {
	test("hangs the realtime paths off the base, with or without a trailing slash", () => {
		for (const base of ["http://127.0.0.1:8080/v1", "http://127.0.0.1:8080/v1/"]) {
			expect(liveEndpointCallsUrl(base)).toBe("http://127.0.0.1:8080/v1/realtime/calls");
			expect(liveEndpointSidebandUrl(base, "rtc_1")).toBe("ws://127.0.0.1:8080/v1/realtime?call_id=rtc_1");
		}
	});

	test("maps https to wss and keeps the base's query", () => {
		expect(liveEndpointSidebandUrl("https://voice.example.com", "abc")).toBe(
			"wss://voice.example.com/realtime?call_id=abc",
		);
		expect(liveEndpointCallsUrl("https://voice.example.com/openai?api-version=1")).toBe(
			"https://voice.example.com/openai/realtime/calls?api-version=1",
		);
		expect(liveEndpointSidebandUrl("https://voice.example.com/openai?api-version=1", "a b")).toBe(
			"wss://voice.example.com/openai/realtime?api-version=1&call_id=a+b",
		);
	});

	test("takes the call ID from the Location header's last path segment", () => {
		expect(parseLiveEndpointCallId("/v1/realtime/calls/rtc_abc")).toBe("rtc_abc");
		expect(parseLiveEndpointCallId("http://127.0.0.1:8080/v1/realtime/calls/call-9/?x=1")).toBe("call-9");
		expect(parseLiveEndpointCallId(null)).toBeUndefined();
		expect(parseLiveEndpointCallId("/")).toBeUndefined();
	});

	test("leaves the Codex sideband URL unchanged", () => {
		expect(buildLiveSidebandUrl("rtc_1")).toBe("wss://api.openai.com/v1/live/rtc_1");
	});
});

describe("live endpoint credentials", () => {
	test("sends only the endpoint's own bearer key", () => {
		expect(liveEndpointHeaders({ baseUrl: "http://127.0.0.1:8080/v1", apiKey: "k" })).toEqual({
			Authorization: "Bearer k",
		});
		expect(liveEndpointHeaders({ baseUrl: "http://127.0.0.1:8080/v1" })).toEqual({});
	});

	test("resolves live.apiKey like other configured secrets", async () => {
		expect(await resolveLiveEndpoint(Settings.isolated())).toBeUndefined();
		expect(await resolveLiveEndpoint(Settings.isolated({ "live.endpoint": "  " }))).toBeUndefined();
		process.env.OMP_LIVE_ENDPOINT_TEST_KEY = "from-env";
		try {
			const settings = Settings.isolated({
				"live.endpoint": " http://127.0.0.1:8080/v1 ",
				"live.apiKey": "OMP_LIVE_ENDPOINT_TEST_KEY",
			});
			expect(await resolveLiveEndpoint(settings)).toEqual({
				baseUrl: "http://127.0.0.1:8080/v1",
				apiKey: "from-env",
			});
		} finally {
			delete process.env.OMP_LIVE_ENDPOINT_TEST_KEY;
		}
		const literal = Settings.isolated({ "live.endpoint": "http://127.0.0.1:8080/v1", "live.apiKey": "sk-local" });
		expect(await resolveLiveEndpoint(literal)).toEqual({ baseUrl: "http://127.0.0.1:8080/v1", apiKey: "sk-local" });
	});
});

describe("live transport on a custom endpoint", () => {
	test("signals the bare SDP and configures the session over the sideband without a Codex login", async () => {
		const local = realtimeServer();
		const transport = endpointTransport({
			baseUrl: `http://127.0.0.1:${local.server.port}/v1/`,
			apiKey: "local-key",
		});
		try {
			await transport.connect();
			expect(transport.sdpAnswer).toBe("v=0 answer");
			expect(local.offers).toEqual(["v=0 offer"]);
			const call = local.calls[0]!;
			expect(call.headers.get("content-type")).toBe("application/sdp");
			expect(call.headers.get("authorization")).toBe("Bearer local-key");
			expectNoCodexHeaders(call);
			const upgrade = local.upgrades[0]!;
			expect(new URL(upgrade.url).searchParams.get("call_id")).toBe("rtc_local");
			expect(upgrade.headers.get("authorization")).toBe("Bearer local-key");
			expectNoCodexHeaders(upgrade);
			expect(JSON.parse(await local.firstMessage)).toEqual(buildLiveSessionUpdate("Be brief.", "marin"));
		} finally {
			await transport.close();
			local.server.stop(true);
		}
	});

	test("sends no Authorization header without a key", async () => {
		const local = realtimeServer();
		const transport = endpointTransport({ baseUrl: `http://127.0.0.1:${local.server.port}/v1` });
		try {
			await transport.connect();
			expect(local.calls[0]!.headers.has("authorization")).toBe(false);
			expect(local.upgrades[0]!.headers.has("authorization")).toBe(false);
		} finally {
			await transport.close();
			local.server.stop(true);
		}
	});

	test("refuses a redirect to another origin without sending it the key", async () => {
		const elsewhere = realtimeServer();
		const redirecting = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response(null, {
					status: 307,
					headers: { Location: `http://127.0.0.1:${elsewhere.server.port}/v1/realtime/calls` },
				}),
		});
		const transport = endpointTransport({ baseUrl: `http://127.0.0.1:${redirecting.port}/v1`, apiKey: "local-key" });
		try {
			await expect(transport.connect()).rejects.toThrow(/redirected \(307\)/);
			expect(elsewhere.calls).toEqual([]);
		} finally {
			await transport.close();
			redirecting.stop(true);
			elsewhere.server.stop(true);
		}
	});
});

describe("live transport without an endpoint", () => {
	test("still signals Codex with the openai-codex login", async () => {
		const providers: string[] = [];
		const authStorage = {
			oauth: {
				access: async (provider: string) => {
					providers.push(provider);
					return undefined;
				},
			},
		} as unknown as AuthStorage;
		const transport = new LiveTransport({
			authStorage,
			sessionId: "s1",
			instructions: "Be brief.",
			voice: "sol",
			sdpOffer: "v=0 offer",
			callbacks,
		});
		await expect(transport.connect()).rejects.toThrow("No Codex OAuth credential is available for a live call.");
		expect(providers).toEqual(["openai-codex"]);
	});
});

describe("live session offline mode", () => {
	function controllerFor(settings: Settings): { controller: LiveSessionController; endpoints: unknown[] } {
		const endpoints: unknown[] = [];
		// bun's spyOn types a class export's implementation as `never`; a plain constructible function suffices.
		const transportSpy = vi.spyOn(liveTransport, "LiveTransport") as unknown as {
			mockImplementation(implementation: (options: LiveTransportOptions) => object): void;
		};
		transportSpy.mockImplementation(function (options: LiveTransportOptions) {
			endpoints.push(options.endpoint);
			return {
				connect: async () => {},
				setMuted: async () => {},
				send: async () => {},
				close: async () => {},
				sdpAnswer: "v=0 answer",
			};
		});
		const session = {
			modelRegistry: { authStorage: noCodexLogin },
			model: { provider: "anthropic" },
			settings,
			sessionId: "s1",
			subscribe: () => () => {},
			sendCustomMessage: async () => {},
		} as unknown as LiveSessionControllerOptions["session"];
		const controller = new LiveSessionController({
			session,
			extractAssistantText: () => "",
			sdpOffer: "v=0 offer",
			callbacks: { onPhase: () => {}, onLevels: () => {}, onTranscript: () => {}, onTerminal: () => {} },
		});
		return { controller, endpoints };
	}

	test("allows an explicitly configured live endpoint", async () => {
		const settings = Settings.isolated({ "models.offline": true, "live.endpoint": "http://127.0.0.1:8080/v1" });
		const { controller, endpoints } = controllerFor(settings);
		await controller.start();
		expect(endpoints).toEqual([{ baseUrl: "http://127.0.0.1:8080/v1" }]);
		await controller.stop();
	});

	test("still requires the openai-codex provider without one", async () => {
		const { controller, endpoints } = controllerFor(Settings.isolated({ "models.offline": true }));
		await expect(controller.start()).rejects.toThrow("openai-codex session provider or live.endpoint");
		expect(endpoints).toEqual([]);
	});
});
