/**
 * Contract: no request path sends a descendant of a claimable aside that
 * ended unsent. The main agent loop withholds one at its hand-off; side
 * requests (`/btw`, handoff generation) never pass that hand-off, so pi-ai's
 * provider entry points and the session's side stream function withhold it
 * too. Each case runs a real `AgentSession` against a local HTTP server
 * speaking the OpenAI completions protocol: a notice goes stale while its
 * request is prepared, a host `transformContext` keeps a spread of it, and
 * the side request that follows must not carry it on the wire.
 */
import { describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { YieldQueue } from "@oh-my-pi/pi-coding-agent/session/yield-queue";
import { TempDir } from "@oh-my-pi/pi-utils";

const TEXT = "SIDE_REQUEST_NOTICE: a child is taking longer than you said";

/** A local OpenAI-completions server that records every request body. */
function completionsServer() {
	const bodies: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			bodies.push(await request.text());
			const chunk = {
				id: "chatcmpl-side",
				object: "chat.completion.chunk",
				created: 1,
				model: "side",
				choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
			};
			const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	return { bodies, server };
}

describe("side requests never send a notice that ended unsent", () => {
	for (const side of ["ephemeral", "handoff"] as const) {
		for (const route of ["default side stream", "host side stream"] as const) {
			it(`${side} through the ${route}`, async () => {
				const { bodies, server } = completionsServer();
				const temp = TempDir.createSync("@pi-aside-side-");
				const auth = await AuthStorage.create(temp.join("auth.db"));
				auth.keys.setRuntime("openai", "local-test");
				let session: AgentSession | undefined;
				try {
					const model = buildModel({
						id: "side",
						name: "side",
						api: "openai-completions",
						provider: "openai",
						baseUrl: `http://127.0.0.1:${server.port}/v1`,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 32_000,
						maxTokens: 1024,
					});
					let stale = false;
					let ended = "pending";
					const queue = new YieldQueue({
						isStreaming: () => true,
						injectIdle: async () => {},
						scheduleIdleFlush() {},
					});
					queue.register<string>("notice", {
						claimAtRequest: true,
						isStale: () => stale,
						build: () =>
							({
								role: "custom",
								customType: "subagent-overdue",
								content: TEXT,
								display: true,
								attribution: "agent",
								timestamp: 2,
							}) as AgentMessage,
					});
					const receipt = queue.enqueueWithReceipt<string>("notice", "x").then(
						() => void (ended = "delivered"),
						() => void (ended = "discarded"),
					);
					const notice = queue.drainLazy()[0]!()!;
					// A host cache that keeps a spread of what it first saw: a descendant of the notice.
					let cached: AgentMessage[] | undefined;
					const transform = async (messages: AgentMessage[]) =>
						(cached ??= messages.map(message => ({ ...message })));
					// Straight to the provider, past pi-ai's entry points.
					const rawProvider: StreamFn = (streamModel, context, options) =>
						streamOpenAICompletions(streamModel as Model<"openai-completions">, context, {
							...options,
							apiKey: "local-test",
						});
					const agent = new Agent({
						initialState: { model, systemPrompt: ["test"], messages: [], tools: [] },
						getApiKey: () => "local-test",
						convertToLlm,
						transformContext: transform,
						streamFn: rawProvider,
					});
					const settings = Settings.isolated({
						"compaction.enabled": false,
						// Keep every turn in the handoff's summarizable history.
						"compaction.keepRecentTokens": 1,
						"todo.enabled": false,
						"launch.enabled": false,
					});
					settings.setModelRole("default", "openai/side");
					session = new AgentSession({
						agent,
						sessionManager: SessionManager.inMemory(temp.path()),
						settings,
						modelRegistry: new ModelRegistry(auth),
						toolRegistry: new Map(),
						transformContext: transform,
						// A host side stream that goes straight to the provider, past pi-ai's entry points.
						...(route === "host side stream" ? { sideStreamFn: rawProvider } : {}),
					});
					// The notice goes stale while its request is prepared.
					agent.addBeforeModelCallHook(() => {
						stale = true;
					});
					await agent.prompt([{ role: "user", content: "an ordinary request", timestamp: 1 }, notice]);
					await receipt;
					expect(ended).toBe("discarded");
					expect(bodies.splice(0).some(body => body.includes(TEXT))).toBe(false);
					if (side === "handoff") {
						await session.prompt("another ordinary turn, so there is history to hand off");
						await session.waitForIdle();
						bodies.splice(0);
						await session.handoff();
					} else {
						await session.runEphemeralTurn({ promptText: "reply ok" });
					}
					expect(bodies.length).toBeGreaterThan(0);
					expect(bodies.some(body => body.includes(TEXT))).toBe(false);
				} finally {
					await session?.dispose();
					auth.close();
					server.stop(true);
					temp.removeSync();
				}
			}, 60_000);
		}
	}
});
