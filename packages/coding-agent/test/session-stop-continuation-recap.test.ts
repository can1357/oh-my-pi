/**
 * Regression: idle recap turn must not crash with
 * `TypeError: undefined is not an object (evaluating 'H.content.filter')`
 * when a provider "done" event carries a message whose `content` is not a
 * well-formed array (issue #4323 — surfaced after 8 `session_stop`
 * block-decision continuations poisoned the transcript).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, StopReason } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

// Mirrors the reporter's block-reason shape: multi-line prose with U+2717
// glyphs, ~300–600 chars. Persisted as-is on each `session-stop-continuation`
// custom entry.
const BLOCK_REASON =
	"BLOCKED: Session cannot stop — lifecycle phases incomplete.\n\n" +
	["phase-1 not complete", "phase-2 not complete", "phase-3 not complete"].map(f => `  ✗ ${f}`).join("\n") +
	"\n\nComplete all phases before stopping.";

// Emit a well-formed `start` then a `done` whose message drops `content`.
// Mimics a gateway/proxy-wrapped Anthropic OAuth stream that hands back a
// truncated final message (the crash the reporter observed on the recap).
function malformedContentSideStreamFn(
	model: Model,
	_context: Context,
	_options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const base: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as StopReason,
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: base });
		// content dropped — the exact runtime shape the reporter's provider wrapper produced.
		const malformed = { ...base, content: undefined as unknown as AssistantMessage["content"] };
		stream.push({ type: "done", reason: "stop", message: malformed });
	});
	return stream;
}

describe("session_stop block continuation — idle recap resilience (#4323)", () => {
	let session: AgentSession;
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-4323-recap-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		vi.restoreAllMocks();
		await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	});

	it("runEphemeralTurn recovers from a provider 'done' event whose message.content is undefined", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			// Main-loop stream is irrelevant here; the recap uses sideStreamFn.
			streamFn: malformedContentSideStreamFn,
			convertToLlm,
		});
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn(() => false),
			emitSessionStop: vi.fn().mockResolvedValue(undefined),
		} as unknown as ExtensionRunner;
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated();
		const authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		authStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner,
			sideStreamFn: malformedContentSideStreamFn,
		});

		// Seed the exact transcript shape the reporter saw after 8 block
		// continuations were persisted: one real turn, then 8 dead
		// `session-stop-continuation` customs.
		agent.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Hi" }],
			timestamp: Date.now(),
		});
		agent.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Hello" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		for (let i = 0; i < 8; i++) {
			agent.appendMessage({
				role: "custom",
				customType: "session-stop-continuation",
				content: BLOCK_REASON,
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			});
		}

		// Prior to the fix, this threw
		// `TypeError: undefined is not an object (evaluating 'assistantMessage.content.filter')`
		// under the reporter's real-provider setup. The regression is now a
		// graceful empty-reply return.
		const result = await session.runEphemeralTurn({ promptText: "Recap the session." });
		expect(result.assistantMessage.role).toBe("assistant");
		expect(Array.isArray(result.assistantMessage.content)).toBe(true);
		expect(result.assistantMessage.content).toEqual([]);
	});
});
