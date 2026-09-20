/**
 * Regression test for issue #10716.
 *
 * Snapcompact's no-reduction guard (#10023) rejects a result whose imaged
 * projection is not smaller than the pre-compaction context. The baseline it
 * compared against counted opaque provider-replay payloads
 * (`thinkingSignature` / `redactedThinking`) as ordinary text tokens, while the
 * imaged projection and the stored-context estimate exclude them (#2628). A
 * large OpenAI Codex `encrypted_content` signature in the archived region then
 * inflated the removable baseline above the frame projection, so an
 * inflating image-frame result was accepted and persisted (context grew).
 *
 * Contract defended: opaque reasoning bytes are excluded symmetrically from the
 * no-reduction comparison, so a result that grows reliable local content is
 * rejected regardless of how large the archived region's signature is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as snapcompact from "@oh-my-pi/snapcompact";

describe("AgentSession snapcompact no-reduction guard: opaque reasoning", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.inMemory();

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled claude-sonnet-4-5 model");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		// A tiny real conversation whose archived region carries an opaque
		// reasoning-replay signature far larger than its text.
		const bigSignature = "x".repeat(400_000);
		const seed: Message[] = [
			{ role: "user", content: [{ type: "text", text: "first question" }], timestamp: Date.now() },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "short", thinkingSignature: bigSignature },
					{ type: "text", text: "first answer" },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 20,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 30,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			},
			{ role: "user", content: [{ type: "text", text: "second question" }], timestamp: Date.now() },
		];
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: seed },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		});
		for (const message of seed) sessionManager.appendMessage(message);

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.methodOrder": ["snapcompact"],
				"compaction.autoContinue": false,
				"compaction.asyncEnabled": false,
				"compaction.keepRecentTokens": 1,
			}),
			modelRegistry,
		});
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		vi.restoreAllMocks();
	});

	it("rejects an inflating snapcompact result even when the archived region has a huge opaque signature", async () => {
		const branchEntries = sessionManager.getBranch();
		const firstKeptEntry = branchEntries[branchEntries.length - 1];
		if (!firstKeptEntry?.id) throw new Error("Expected branch entry with id");

		const frame = { data: "ZmFrZQ==", mimeType: "image/png", cols: 64, rows: 40, chars: 4 } as const;
		vi.spyOn(snapcompact, "compact").mockResolvedValue({
			summary: "archived onto frames",
			shortSummary: "archived",
			firstKeptEntryId: firstKeptEntry.id,
			tokensBefore: 100_000,
			details: { readFiles: [], modifiedFiles: [] },
			preserveData: {
				snapcompact: { frames: [frame, frame, frame], totalChars: 12, truncatedChars: 0 },
			},
		});

		// 3 frames ≈ 15k tokens >> the handful of tokens of real archived text,
		// so this result grows reliable local content and must be rejected.
		await expect(session.compact(undefined, { mode: "snapcompact" })).rejects.toThrow(
			"snapcompact would not reduce context locally.",
		);
		expect(sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(false);
	});
});
