import { afterEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { buildFactoryDroidModel } from "@oh-my-pi/pi-catalog/discovery";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { streamFactoryDroid } from "../src/providers/factory-droid";
import type { AssistantMessageEvent, Model, ProviderSessionState, Tool } from "../src/types";
import { workosJwt } from "./helpers/factory-droid";

/**
 * Responses-over-WebSocket transport (`openai-responses-ws`).
 *
 * The contract under test is equivalence: a WebSocket turn must produce the
 * same event stream as the SSE turn carrying the same frames, must fall back to
 * the HTTPS POST whenever the socket cannot serve the turn, and must never
 * engage at all while the account gate is off.
 *
 * Everything runs against a real `Bun.serve` instance speaking the real
 * protocols — upgrade, frames, SSE, and the feature-flags lookup — so the
 * transport is exercised end to end rather than through a socket stub.
 *
 * Server frames are the captured droid 0.203.0 turn
 * (`/tmp/flows203/012-ws-frames.txt`, one JSON per frame), verbatim except for
 * the echoed `instructions`/`tools` inside the lifecycle frames, which are
 * elided to keep the fixture small — no field the transport reads is touched.
 */

const SERVER_FRAMES = (
	await Bun.file(new URL("fixtures/factory-droid-responses-ws-frames.jsonl", import.meta.url)).text()
)
	.trim()
	.split("\n");

/** `sequence_number` 3 lands mid-response, before any terminal frame. */
const MIDSTREAM_FRAME_COUNT = 4;

const readTool: Tool = {
	name: "Read",
	description: "Read a file",
	parameters: type({ path: "string" }),
};

type WsMode = "frames" | "reject-upgrade" | "close-midstream";

interface DroidTestState {
	/** Identity headers seen on each accepted upgrade; length = socket count. */
	upgrades: Array<Record<string, string>>;
	/** Request frames the client sent, parsed. */
	clientFrames: Array<Record<string, unknown>>;
	/** Bodies of HTTPS Responses POSTs (the fallback path). */
	posts: Array<Record<string, unknown>>;
	flagEnabled: boolean;
	wsMode: WsMode;
}

interface DroidTestServer extends DroidTestState {
	baseUrl: string;
	stop(): void;
}

/** Factory's proxy surface for one test: flags, the upgrade, and the SSE POST. */
function startDroidServer(init: { flagEnabled?: boolean; wsMode?: WsMode } = {}): DroidTestServer {
	const state: DroidTestState = {
		upgrades: [],
		clientFrames: [],
		posts: [],
		flagEnabled: init.flagEnabled ?? true,
		wsMode: init.wsMode ?? "frames",
	};
	const server = Bun.serve({
		port: 0,
		fetch: async (request, bunServer) => {
			const url = new URL(request.url);
			if (url.pathname === "/api/feature-flags") {
				return Response.json({ flags: { openai_responses_websocket_mode: state.flagEnabled } });
			}
			if (url.pathname === "/api/llm/o/v1/responses/ws") {
				if (state.wsMode === "reject-upgrade") return new Response("no websockets here", { status: 500 });
				const headers: Record<string, string> = {};
				for (const [key, value] of request.headers.entries()) headers[key] = value;
				state.upgrades.push(headers);
				if (bunServer.upgrade(request)) return undefined;
				return new Response("upgrade failed", { status: 400 });
			}
			if (url.pathname === "/api/llm/o/v1/responses" && request.method === "POST") {
				state.posts.push(JSON.parse(await request.text()) as Record<string, unknown>);
				return new Response(`${SERVER_FRAMES.map(frame => `data: ${frame}`).join("\n\n")}\n\n`, {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message: (ws, message) => {
				state.clientFrames.push(JSON.parse(String(message)) as Record<string, unknown>);
				const frames =
					state.wsMode === "close-midstream" ? SERVER_FRAMES.slice(0, MIDSTREAM_FRAME_COUNT) : SERVER_FRAMES;
				for (const frame of frames) ws.send(frame);
				if (state.wsMode === "close-midstream") ws.close(1011, "midstream");
			},
		},
	});
	return Object.assign(state, {
		baseUrl: `http://127.0.0.1:${server.port}`,
		stop: () => {
			server.stop(true);
		},
	});
}

/** gpt-5.6-sol shaping: openai upstream, extended cache, safety id, verbosity. */
function gptSol(baseUrl: string, id = "gpt-5.6-sol"): Model<"factory-droid-agent"> {
	return buildModel({
		...buildFactoryDroidModel({
			id,
			name: "GPT-5.6-Sol",
			wire: "openai-responses",
			contextWindow: 400_000,
			maxTokens: 128_000,
			apiProviders: ["openai"],
			supportedReasoningEfforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			defaultReasoningEffort: Effort.High,
			responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
		}),
		baseUrl: `${baseUrl}/api/llm/o/v1`,
	});
}

function context() {
	return {
		systemPrompt: ["OMP prompt"],
		messages: [{ role: "user" as const, content: "hello", timestamp: 1 }],
		tools: [readTool],
	};
}

/** A distinct credential per case: the gate cache is keyed by host and token. */
function token(tag: string): string {
	return workosJwt({ sub: `user_${tag}`, external_org_id: "org-1" });
}

const sessions: Array<Map<string, ProviderSessionState>> = [];

function newSession(): Map<string, ProviderSessionState> {
	const session = new Map<string, ProviderSessionState>();
	sessions.push(session);
	return session;
}

/**
 * Wall-clock measurements (`ttft`, `duration`, message `timestamp`) differ
 * between any two runs; everything else in an event is transport shape.
 */
function stripTimings(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripTimings);
	if (value == null || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key === "ttft" || key === "duration" || key === "timestamp") continue;
		out[key] = stripTimings(entry);
	}
	return out;
}

async function runTurn(input: {
	model: Model<"factory-droid-agent">;
	apiKey: string;
	providerSessionState: Map<string, ProviderSessionState>;
}): Promise<{ events: AssistantMessageEvent[]; text: string; stopReason: string }> {
	const stream = streamFactoryDroid(input.model, context(), {
		apiKey: input.apiKey,
		sessionId: "sess-ws",
		reasoning: Effort.High,
		providerSessionState: input.providerSessionState,
	});
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	const message = await stream.result();
	const text = message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("");
	return { events, text, stopReason: message.stopReason };
}

afterEach(() => {
	// Release every socket the transport parked for reuse.
	for (const session of sessions.splice(0)) {
		for (const state of session.values()) state.close();
	}
});

describe("Factory Droid responses websocket transport", () => {
	it("emits the same event stream as the SSE transport carrying the same frames", async () => {
		// One server, one frame sequence, two transports: the gate is the only
		// difference between the runs (the gate cache is keyed by credential).
		const server = startDroidServer({ flagEnabled: true });
		try {
			const overWebsocket = await runTurn({
				model: gptSol(server.baseUrl),
				apiKey: token("ws-parity"),
				providerSessionState: newSession(),
			});
			server.flagEnabled = false;
			const overSse = await runTurn({
				model: gptSol(server.baseUrl),
				apiKey: token("sse-parity"),
				providerSessionState: newSession(),
			});

			expect(server.upgrades.length).toBe(1);
			expect(server.posts.length).toBe(1);

			expect(overWebsocket.text).toBe("ok");
			expect(overWebsocket.stopReason).toBe("stop");
			expect(stripTimings(overWebsocket.events)).toEqual(stripTimings(overSse.events));

			// Same request too: the frame is the POST body plus the `_factory`
			// identity block, minus `stream` (the socket streams by construction).
			const { type: frameType, _factory: factory, ...frameBody } = server.clientFrames[0] ?? {};
			const { stream: _stream, ...postBody } = server.posts[0] ?? {};
			expect(frameType).toBe("response.create");
			expect(frameBody).toEqual(postBody);
			expect(factory).toEqual({
				assistantMessageId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
			});
		} finally {
			server.stop();
		}
	});

	it("carries the identity headers on the upgrade and drops the HTTP-only ones", async () => {
		const server = startDroidServer({ flagEnabled: true });
		try {
			await runTurn({
				model: gptSol(server.baseUrl),
				apiKey: token("headers"),
				providerSessionState: newSession(),
			});
			const upgrade = server.upgrades[0] ?? {};
			expect(upgrade["user-agent"]).toMatch(/^factory-cli\//);
			expect(upgrade["x-factory-client"]).toBe("cli");
			expect(upgrade["x-api-provider"]).toBe("openai");
			expect(upgrade["x-session-id"]).toMatch(/^[0-9a-f]{8}-/);
			expect(upgrade["openai-platform"]).toBe("org-bHuLtG1fGmYk5YaOihAAXFBw");
			expect(upgrade.authorization).toBe(`Bearer ${token("headers")}`);
			// The captured upgrade carries neither: they describe a JSON POST.
			expect(upgrade.accept).toBeUndefined();
			expect(upgrade["content-type"]).toBeUndefined();
		} finally {
			server.stop();
		}
	});

	it("keeps one socket across turns and reconnects when the model changes", async () => {
		const server = startDroidServer({ flagEnabled: true });
		const session = newSession();
		const apiKey = token("reuse");
		try {
			await runTurn({ model: gptSol(server.baseUrl), apiKey, providerSessionState: session });
			await runTurn({ model: gptSol(server.baseUrl), apiKey, providerSessionState: session });
			expect(server.upgrades.length).toBe(1);

			await runTurn({
				model: gptSol(server.baseUrl, "gpt-5.6-terra"),
				apiKey,
				providerSessionState: session,
			});
			expect(server.upgrades.length).toBe(2);
			expect(server.posts.length).toBe(0);
		} finally {
			server.stop();
		}
	});

	it("routes a concurrent second turn over HTTPS instead of sharing the socket", async () => {
		const server = startDroidServer({ flagEnabled: true });
		const session = newSession();
		const apiKey = token("concurrent");
		try {
			const model = gptSol(server.baseUrl);
			const [first, second] = await Promise.all([
				runTurn({ model, apiKey, providerSessionState: session }),
				runTurn({ model, apiKey, providerSessionState: session }),
			]);
			// The Responses socket carries one response at a time, so the loser of
			// the race is served over HTTPS rather than stealing the stream.
			expect(first.text).toBe("ok");
			expect(second.text).toBe("ok");
			expect(server.upgrades.length).toBe(1);
			expect(server.posts.length).toBe(1);
		} finally {
			server.stop();
		}
	});

	it("falls back to the HTTPS Responses path when the upgrade fails", async () => {
		const server = startDroidServer({ flagEnabled: true, wsMode: "reject-upgrade" });
		try {
			const turn = await runTurn({
				model: gptSol(server.baseUrl),
				apiKey: token("connect-fail"),
				providerSessionState: newSession(),
			});
			// The caller cannot tell a socket was attempted.
			expect(turn.stopReason).toBe("stop");
			expect(turn.text).toBe("ok");
			expect(server.posts.length).toBe(1);
		} finally {
			server.stop();
		}
	});

	it("surfaces a mid-stream socket close and drops the session back to HTTPS", async () => {
		const server = startDroidServer({ flagEnabled: true, wsMode: "close-midstream" });
		const session = newSession();
		const apiKey = token("midstream");
		try {
			// The turn is already committed to the socket, so the death is an
			// error rather than a silent fallback.
			const first = await runTurn({ model: gptSol(server.baseUrl), apiKey, providerSessionState: session });
			expect(first.stopReason).toBe("error");
			expect(first.events.some(event => event.type === "error")).toBe(true);
			expect(server.posts.length).toBe(0);

			// A single failure is a blip: the transport tries the socket again.
			const second = await runTurn({ model: gptSol(server.baseUrl), apiKey, providerSessionState: session });
			expect(second.stopReason).toBe("error");
			expect(server.upgrades.length).toBe(2);

			// Two is a property of this network or account: the session stops
			// paying for sockets and serves the turn over HTTPS.
			server.wsMode = "frames";
			const third = await runTurn({ model: gptSol(server.baseUrl), apiKey, providerSessionState: session });
			expect(third.stopReason).toBe("stop");
			expect(third.text).toBe("ok");
			expect(server.upgrades.length).toBe(2);
			expect(server.posts.length).toBe(1);
		} finally {
			server.stop();
		}
	});

	it("never touches the socket while the account gate is off", async () => {
		const server = startDroidServer({ flagEnabled: false });
		try {
			const turn = await runTurn({
				model: gptSol(server.baseUrl),
				apiKey: token("gate-off"),
				providerSessionState: newSession(),
			});
			expect(turn.stopReason).toBe("stop");
			expect(server.upgrades.length).toBe(0);
			expect(server.posts.length).toBe(1);
		} finally {
			server.stop();
		}
	});

	it("never upgrades a non-openai rotation even with the gate on", async () => {
		const server = startDroidServer({ flagEnabled: true });
		try {
			const model = buildModel({
				...buildFactoryDroidModel(
					{
						id: "gpt-5.4",
						name: "GPT-5.4",
						wire: "openai-responses",
						contextWindow: 400_000,
						maxTokens: 128_000,
						apiProviders: ["bedrock_openai"],
						supportedReasoningEfforts: [Effort.Low, Effort.Medium, Effort.High],
						defaultReasoningEffort: Effort.High,
						responsesConfig: { verbosity: "low", parallelToolCalls: true, extendedCache: true, safetyId: true },
					},
					["bedrock_openai"],
				),
				baseUrl: `${server.baseUrl}/api/llm/o/v1`,
			});
			const turn = await runTurn({
				model,
				apiKey: token("bedrock"),
				providerSessionState: newSession(),
			});
			expect(turn.stopReason).toBe("stop");
			expect(server.upgrades.length).toBe(0);
			expect(server.posts.length).toBe(1);
		} finally {
			server.stop();
		}
	});
});
