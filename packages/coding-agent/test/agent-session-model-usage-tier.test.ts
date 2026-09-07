import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { closeDb, getOverallStats, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";
import { installStatsTestIsolation } from "../../stats/test/helpers/temp-agent";

const statsIsolation = installStatsTestIsolation("@omp-agent-session-tier-");

function encodeAnthropicEvents(events: Array<Record<string, unknown>>): string {
	return `${events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

function successfulClassification(model: string, id: string): Response {
	return new Response(
		encodeAnthropicEvents([
			{
				type: "message_start",
				message: {
					id,
					model,
					role: "assistant",
					usage: {
						input_tokens: 8,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "low" } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: {
					input_tokens: 8,
					output_tokens: 1,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
			{ type: "message_stop" },
		]),
		{
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"request-id": id,
			},
		},
	);
}

describe("auto-thinking model usage service-tier metadata", () => {
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		closeDb();
	});

	it("persists classifier fallback metadata for stats premium-request aggregation", async () => {
		const tempDir = statsIsolation.current();
		if (!tempDir) throw new Error("Expected stats isolation temp directory");
		const cwd = tempDir.join("project");
		await fs.mkdir(cwd, { recursive: true });

		let rejectFast = true;
		let requestNumber = 0;
		const requestBodies: Array<Record<string, unknown>> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const body = (await request.json()) as Record<string, unknown>;
				requestBodies.push(body);
				if (requestBodies.length === 4) {
					return new Response(
						encodeAnthropicEvents([
							{
								type: "message_start",
								message: {
									id: "msg_transient",
									model: "claude-sonnet-4-5",
									role: "assistant",
									usage: { input_tokens: 8, output_tokens: 0 },
								},
							},
							{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
							{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
							{
								type: "error",
								error: { type: "overloaded_error", message: "local transient classifier failure" },
							},
						]),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					);
				}
				if (rejectFast && body.speed === "fast") {
					return new Response(
						JSON.stringify({
							type: "error",
							error: {
								type: "invalid_request_error",
								message: "claude-sonnet-4-5 does not support the speed parameter",
							},
						}),
						{ status: 400, headers: { "content-type": "application/json" } },
					);
				}
				if (rejectFast) rejectFast = false;
				requestNumber += 1;
				return successfulClassification("claude-sonnet-4-5", `msg_classifier_${requestNumber}`);
			},
		});

		try {
			const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!bundled) throw new Error("Expected bundled Anthropic classifier model");
			const model: Model = buildModel({
				...bundled,
				baseUrl: `http://127.0.0.1:${server.port}`,
			});

			authStorage = await AuthStorage.create(":memory:");
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const modelRegistry = new ModelRegistry(authStorage);
			vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model]);

			const modelSelector = `${model.provider}/${model.id}`;
			const settings = Settings.isolated({
				"compaction.enabled": false,
				"providers.autoThinkingModel": "online",
				"tier.modelOverrides": { [modelSelector]: "priority" },
			});
			settings.setModelRole("tiny", modelSelector);
			settings.setModelRole("smol", modelSelector);

			const manager = SessionManager.create(cwd);
			await manager.ensureOnDisk();
			const agent = new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.Low,
				},
			});
			vi.spyOn(agent, "prompt").mockResolvedValue(undefined);
			session = new AgentSession({
				agent,
				sessionManager: manager,
				settings,
				modelRegistry,
				thinkingLevel: AUTO_THINKING,
			});

			await session.prompt("Classify this first request");
			await session.prompt("Classify this second request");
			await session.prompt("Retry this third classification");
			await manager.flush();

			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected persisted session file");
			const lines = (await fs.readFile(sessionFile, "utf8"))
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as Record<string, unknown>);
			const usageEntries = lines.filter(line => line.type === "model_usage");
			expect(usageEntries.map(entry => entry.stopReason)).toEqual(["stop", "stop", "error", "stop"]);
			expect(usageEntries[2]?.errorMessage).toContain("local transient classifier failure");
			expect(usageEntries.map(entry => entry.serviceTier)).toEqual(["priority", "priority", "priority", "priority"]);
			expect(usageEntries.map(entry => entry.disabledFeatures)).toEqual([
				["priority"],
				undefined,
				undefined,
				undefined,
			]);

			expect(requestBodies.map(body => body.speed)).toEqual(["fast", undefined, "fast", "fast", "fast"]);

			await initDb();
			const parsed = await parseSessionFile(sessionFile);
			expect(parsed.stats).toHaveLength(4);
			expect(insertMessageStats(parsed.stats)).toBe(4);
			expect(parsed.stats.map(stat => stat.usage.premiumRequests ?? 0)).toEqual([0, 1, 1, 1]);
			expect(getOverallStats()).toMatchObject({ totalRequests: 4, totalPremiumRequests: 3 });
		} finally {
			server.stop(true);
		}
	});
});
