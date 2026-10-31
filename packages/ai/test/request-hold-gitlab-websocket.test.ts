/**
 * The GitLab Duo workflow transport sends nothing over its WebSocket in a held scope: it opens no
 * socket, cuts a socket it created whose hold began before it opened (its upgrade would land after
 * the handshake), and returns no tool result on a socket a previous turn preserved. WebSocket traffic
 * never passes through the global fetch the hold wraps, so the transport checks the hold itself, right
 * before each send.
 *
 * The server is a real loopback WebSocket over `wss` on `localhost` (`helpers/loopback-tls.ts`), as a
 * production GitLab host serves `https`, and each case counts what it receives. The socket is opened
 * as in production: Bun's `WebSocket` with the workflow's headers (the default factory, or one case's
 * factory that builds the same socket). Only the host differs.
 *
 * One property differs from production on purpose: the REST setup is answered by the `fetch` option,
 * in process. Production sends it over the network through the same gate (`gatedFetch` around the
 * transport fetch). But a hold that begins while a REST request waits for its answer aborts that
 * request (the gate links each request to the hold until its response arrives), which would end the
 * turn before it reaches the socket, and the case would pass without exercising the socket's own
 * check. The cases wait real time where they assert that nothing arrives, which fake time can neither
 * deliver nor rule out.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
	type GitLabDuoWorkflowWebSocketFactory,
	type GitLabDuoWorkflowWebSocketLike,
	streamGitLabDuoWorkflow,
} from "@oh-my-pi/pi-ai/providers/gitlab-duo-workflow";
import type { AssistantMessage, Context, FetchImpl, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { runInRequestHoldScope } from "../src/request-hold";
import { LOOPBACK_TLS, loopbackOrigin, trustLoopbackTls } from "./helpers/loopback-tls";

trustLoopbackTls();

type Frame = Record<string, unknown>;

const context: Context = { messages: [{ role: "user", content: "Help me.", timestamp: 1 }] };

/** A final checkpoint whose agent text is `Answer`. */
const ANSWER = {
	newCheckpoint: {
		status: "INPUT_REQUIRED",
		checkpoint: JSON.stringify({ channel_values: { ui_chat_log: [{ message_type: "agent", content: "Answer" }] } }),
	},
};

/** A running checkpoint, then the `read` tool call the next turn answers. */
const TOOL_CALL = [
	{
		newCheckpoint: {
			status: "RUNNING",
			checkpoint: JSON.stringify({
				channel_values: { ui_chat_log: [{ message_type: "agent", message_id: "pre-1", content: "PRE_TOOL" }] },
			}),
		},
	},
	{ requestID: "req-read-1", runMCPTool: { name: "mcp__omp__read", args: JSON.stringify({ path: "README.md" }) } },
];

/** The workflow REST endpoints, answered without the network. */
const rest =
	(onCreate: () => void = () => {}): FetchImpl =>
	async input => {
		const url = String(input);
		if (url.includes("/direct_access")) {
			return new Response(JSON.stringify({ gitlab_rails: { token: "workflow-token" } }), { status: 201 });
		}
		if (url.includes("/workflows")) {
			onCreate();
			return new Response(JSON.stringify({ id: "workflow-1" }), { status: 201 });
		}
		if (url.includes("/api/graphql")) {
			return Response.json({
				data: {
					aiChatAvailableModels: {
						defaultModel: { name: "Default", ref: "claude_sonnet_4_6_vertex" },
						selectableModels: [],
						pinnedModel: null,
					},
				},
			});
		}
		return new Response("{}", { status: 404 });
	};

describe("the GitLab Duo WebSocket transport in a hold scope", () => {
	let held: AbortController;
	let ended: AbortController;
	let request: AbortController;
	let server: Bun.Server<undefined>;
	let upgrades: number;
	let frames: string[];
	/** What the server answers to a `startRequest`. */
	let onStart: Frame[];
	let model: Model<"gitlab-duo-agent">;
	let providerSessionState: Map<string, ProviderSessionState>;

	beforeEach(() => {
		held = new AbortController();
		ended = new AbortController();
		request = new AbortController();
		upgrades = 0;
		frames = [];
		onStart = [ANSWER];
		providerSessionState = new Map();
		server = Bun.serve({
			...LOOPBACK_TLS,
			port: 0,
			fetch(incoming, server) {
				upgrades++;
				if (server.upgrade(incoming)) return undefined;
				return new Response("WebSocket required", { status: 400 });
			},
			websocket: {
				message(socket: ServerWebSocket<unknown>, message) {
					const frame = JSON.parse(String(message)) as Frame;
					const kind = Object.keys(frame)[0] ?? "unknown";
					frames.push(kind);
					const replies = kind === "startRequest" ? onStart : [ANSWER];
					for (const reply of replies) socket.send(JSON.stringify(reply));
				},
			},
		});
		model = buildModel({
			id: "claude_sonnet_4_6_vertex",
			name: "Claude Sonnet 4.6 - Vertex",
			api: "gitlab-duo-agent",
			provider: "gitlab-duo-agent",
			baseUrl: loopbackOrigin(server),
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
			supportsTools: true,
		});
	});

	afterEach(() => {
		request.abort();
		ended.abort();
		for (const state of providerSessionState.values()) state.close?.();
		server.stop(true);
	});

	/** One turn of the workflow, in the hold scope. */
	function turn(
		turnContext: Context,
		extra?: { fetch?: FetchImpl; webSocketFactory?: GitLabDuoWorkflowWebSocketFactory },
	): Promise<AssistantMessage> {
		return runInRequestHoldScope(held.signal, ended.signal, () =>
			streamGitLabDuoWorkflow(model, turnContext, {
				apiKey: "pat-token",
				rootNamespaceId: "gid://gitlab/Group/1",
				providerSessionState,
				signal: request.signal,
				fetch: extra?.fetch ?? rest(),
				webSocketFactory: extra?.webSocketFactory,
			}).result(),
		);
	}

	/** As when a held job is cancelled: its scope ends and its turn is aborted. */
	async function cancel(pending: Promise<unknown>): Promise<void> {
		ended.abort();
		request.abort();
		await pending.catch(() => undefined);
	}

	it("opens a socket and sends its startRequest when the scope is not held", async () => {
		const reply = await turn(context);

		expect(reply.stopReason).toBe("stop");
		expect({ upgrades, frames }).toEqual({ upgrades: 1, frames: ["startRequest"] });
	});

	it("opens no socket once the hold began during the workflow's setup", async () => {
		const pending = turn(context, { fetch: rest(() => held.abort()) });
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await Bun.sleep(150);

		// Still waiting, not ended: a turn whose socket failed in the client (on TLS, say) would show no
		// upgrade either, but it would have ended.
		expect({ upgrades, frames, settled }).toEqual({ upgrades: 0, frames: [], settled: false });

		await cancel(pending);
		expect({ upgrades, frames }).toEqual({ upgrades: 0, frames: [] });
	});

	it("cuts a socket whose hold began after it was created, before it opened: no upgrade, no startRequest", async () => {
		const pending = turn(context, {
			webSocketFactory: (url, options) => {
				const socket = new WebSocket(url, {
					headers: options.headers,
				}) as unknown as GitLabDuoWorkflowWebSocketLike;
				// The socket is not open yet: its upgrade lands only after the handshake, and its
				// startRequest is sent when it opens.
				held.abort();
				return socket;
			},
		});
		await Bun.sleep(150);

		expect({ upgrades, frames }).toEqual({ upgrades: 0, frames: [] });

		await cancel(pending);
		expect(frames).toEqual([]);
	});

	describe("a tool result for a socket a previous turn preserved", () => {
		/** The first turn, not held: the workflow asks for the `read` tool and keeps its socket open. */
		async function firstTurnAsksForTool(): Promise<Context> {
			onStart = TOOL_CALL;
			const first = await turn(context);
			expect(first.content).toContainEqual(expect.objectContaining({ type: "toolCall", id: "req-read-1" }));
			return {
				messages: [
					...context.messages,
					first,
					{
						role: "toolResult",
						toolCallId: "req-read-1",
						toolName: "read",
						content: [{ type: "text", text: "README file text" }],
						isError: false,
						timestamp: 2,
					},
				],
			};
		}

		it("is sent when the scope is not held", async () => {
			const resumed = await firstTurnAsksForTool();

			const reply = await turn(resumed);

			expect(reply.stopReason).toBe("stop");
			expect({ upgrades, frames }).toEqual({ upgrades: 1, frames: ["startRequest", "actionResponse"] });
		});

		it("is not sent once the hold began", async () => {
			const resumed = await firstTurnAsksForTool();

			held.abort();
			const pending = turn(resumed);
			await Bun.sleep(150);

			expect({ upgrades, frames }).toEqual({ upgrades: 1, frames: ["startRequest"] });

			await cancel(pending);
			expect(frames).toEqual(["startRequest"]);
		});
	});
});
