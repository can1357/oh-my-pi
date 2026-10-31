/**
 * The finding this guards: a turn whose stream dies after reasoning gets one
 * held retry on the same model before `retry.fallbackChains` is consulted. When
 * the route is gone — every later request cut before a response header — that
 * one held call ran the Anthropic provider's whole replay ceiling (11 requests,
 * about 49 s of backoff) while a healthy fallback waited.
 *
 * Driven against real local routes through the real Anthropic provider, with
 * real waits, so the request counts and elapsed time are the ones a user sees.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, streamSimple } from "@oh-my-pi/pi-ai";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function sse(events: Array<Record<string, unknown> & { type: string }>): string {
	return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function messageStart(model: string): Record<string, unknown> & { type: string } {
	return {
		type: "message_start",
		message: {
			id: `msg_${model}`,
			type: "message",
			role: "assistant",
			model,
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 1 },
		},
	};
}

/** Reasoning that streams and then stops: the stream is cut before its terminal event. */
const REASONING_THEN_CUT = sse([
	messageStart("primary-model"),
	{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "planning the edit" } },
]);

const BACKUP_ANSWER = "answered on the backup";
const BACKUP_SUCCESS = sse([
	messageStart("backup-model"),
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: BACKUP_ANSWER } },
	{ type: "content_block_stop", index: 0 },
	{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
	{ type: "message_stop" },
]);

/**
 * The primary route: the first request streams reasoning and then the
 * connection closes mid-body; every later request is closed before a byte of
 * response.
 */
function dyingPrimary(): { url: string; requestTimes: number[]; stop(): void } {
	const requestTimes: number[] = [];
	const server = Bun.listen<{ answered: boolean }>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				socket.data = { answered: false };
			},
			data(socket) {
				if (socket.data.answered) return;
				socket.data.answered = true;
				requestTimes.push(performance.now());
				if (requestTimes.length > 1) {
					socket.end();
					return;
				}
				const body = Buffer.from(REASONING_THEN_CUT);
				socket.write(
					`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n`,
				);
				socket.write(body);
				socket.write("\r\n");
				// A real socket: a close that lands in the same read as the chunk
				// discards the chunk, so the cut waits until the reasoning has been read.
				setTimeout(() => socket.end(), 100);
			},
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, requestTimes, stop: () => server.stop(true) };
}

function healthyBackup(): { url: string; requestTimes: number[]; stop(): void } {
	const requestTimes: number[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			await request.arrayBuffer();
			requestTimes.push(performance.now());
			return new Response(BACKUP_SUCCESS, { headers: { "content-type": "text/event-stream" } });
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, requestTimes, stop: () => server.stop(true) };
}

function modelsYml(primaryUrl: string, backupUrl: string): string {
	const provider = (name: string, url: string, model: string) => `  ${name}:
    api: anthropic-messages
    baseUrl: ${url}
    apiKey: "test-key"
    models:
      - id: ${model}
        name: ${model}
        reasoning: true
        input:
          - text
        contextWindow: 200000
        maxTokens: 8192
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
`;
	return `providers:\n${provider("dying", primaryUrl, "primary-model")}${provider("standby", backupUrl, "backup-model")}`;
}

describe("a held retry against a route that is gone", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	const cleanups: Array<() => Promise<void> | void> = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-held-retry-budget-");
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("fails over after a few requests inside the held budget instead of the provider's ceiling", async () => {
		const primary = dyingPrimary();
		const backup = healthyBackup();
		cleanups.push(primary.stop, backup.stop);
		const modelsPath = path.join(tempDir.path(), "models.yml");
		fs.writeFileSync(modelsPath, modelsYml(primary.url, backup.url));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.modelFallback": true,
			"retry.fallbackChains": { default: ["standby/backup-model"] },
			"features.unexpectedStopDetection": "none",
		});
		const modelRegistry = new ModelRegistry(authStorage, modelsPath, { settings });
		await modelRegistry.refresh();
		const primaryModel = modelRegistry.find("dying", "primary-model");
		if (!primaryModel) throw new Error("expected the primary model from models.yml");
		settings.setModelRole("default", "dying/primary-model");

		const budgets: Array<number | undefined> = [];
		const agent = new Agent({
			getApiKey: requested => modelRegistry.resolver(requested, agent.sessionId),
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			// What the SDK's session stream function does for every main-loop request.
			streamFn: (requested, context, options) => {
				const replayBudgetMs = session.consumeHeldRetryReplayBudget(requested);
				budgets.push(replayBudgetMs);
				return streamSimple(requested, context, {
					...options,
					...(replayBudgetMs !== undefined ? { replayBudgetMs } : {}),
				});
			},
		});
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		cleanups.push(
			() => session.dispose(),
			() => sessionManager.close(),
		);

		const started = performance.now();
		await session.prompt("Make the edit");
		await session.waitForIdle();

		const failoverAfterMs = (backup.requestTimes[0] ?? Number.POSITIVE_INFINITY) - started;
		const assistants = session.agent.state.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		const failures = sessionManager
			.getEntries()
			.flatMap(entry =>
				entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error"
					? [entry.message]
					: [],
			);

		// The cut request, then the held call: its first request and the two
		// replays that fit in the held budget. Today: 12 requests over about 49 s.
		// A loaded machine can use up the second quick replay before it is decided, so
		// two to four primary requests all count: the property is that the held call
		// stopped far short of the provider's 12 requests and 47 s.
		expect(primary.requestTimes.length).toBeGreaterThanOrEqual(2);
		expect(primary.requestTimes.length).toBeLessThanOrEqual(4);
		expect(backup.requestTimes).toHaveLength(1);
		expect(failoverAfterMs).toBeLessThan(15_000);
		// Only the held call carries the budget; the fallback runs on its own ceiling.
		expect(budgets).toEqual([undefined, 2_000, undefined]);
		// The held call says the budget ended it, so the failover is the caller's
		// choice; the cut that started the saga ended on its own.
		expect(failures.map(failure => failure.replayBudgetExhausted)).toEqual([undefined, true]);
		expect(assistants.at(-1)?.content).toEqual([{ type: "text", text: BACKUP_ANSWER }]);
	}, 90_000);
});
