/**
 * Test for compaction with thinking models.
 *
 * Tests both:
 * - Claude via Antigravity (google-gemini-cli API)
 * - Claude via real Anthropic API (anthropic-messages API)
 *
 * Reproduces issue where compact fails when maxTokens < thinkingBudget.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel, type Model } from "@oh-my-pi/pi-ai";
import { Agent, type ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { nanoid } from "nanoid";
import { AgentSession } from "../src/core/agent-session";
import { AuthStorage } from "../src/core/auth-storage";
import { ModelRegistry } from "../src/core/model-registry";
import { SessionManager } from "../src/core/session-manager";
import { SettingsManager } from "../src/core/settings-manager";
import { createTools, type ToolSession } from "../src/core/tools/index";
import { API_KEY } from "./utilities";

// Check for auth
const HAS_ANTIGRAVITY_AUTH = false; // OAuth not available in test environment
const HAS_ANTHROPIC_AUTH = !!API_KEY;

describe.skipIf(!HAS_ANTIGRAVITY_AUTH)("Compaction with thinking models (Antigravity)", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-thinking-compaction-test-${nanoid()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(
		modelId: "claude-opus-4-5-thinking" | "claude-sonnet-4-5",
		thinkingLevel: ThinkingLevel = "high"
	) {
		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			rulebookRules: [],
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		};
		const tools = await createTools(toolSession);

		const model = getModel("google-antigravity", modelId);
		if (!model) {
			throw new Error(`Model not found: google-antigravity/${modelId}`);
		}

		const agent = new Agent({
			getApiKey: () => API_KEY,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant. Be concise.",
				tools,
				thinkingLevel,
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		// Use minimal keepRecentTokens so small test conversations have something to summarize
		// settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });

		const authStorage = new AuthStorage(join(tempDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			modelRegistry,
		});

		session.subscribe(() => {});

		return session;
	}

	it("should compact successfully with claude-opus-4-5-thinking and thinking level high", async () => {
		createSession("claude-opus-4-5-thinking", "high");

		// Send a simple prompt
		await session.prompt("Write down the first 10 prime numbers.");
		await session.agent.waitForIdle();

		// Verify we got a response
		const messages = session.messages;
		expect(messages.length).toBeGreaterThan(0);

		const assistantMessages = messages.filter((m) => m.role === "assistant");
		expect(assistantMessages.length).toBeGreaterThan(0);

		// Now try to compact - this should not throw
		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);
		expect(result.tokensBefore).toBeGreaterThan(0);

		// Verify session is still usable after compaction
		const messagesAfterCompact = session.messages;
		expect(messagesAfterCompact.length).toBeGreaterThan(0);
		expect(messagesAfterCompact[0].role).toBe("compactionSummary");
	}, 180000);

	it("should compact successfully with claude-sonnet-4-5 (non-thinking) for comparison", async () => {
		createSession("claude-sonnet-4-5", "off");

		await session.prompt("Write down the first 10 prime numbers.");
		await session.agent.waitForIdle();

		const messages = session.messages;
		expect(messages.length).toBeGreaterThan(0);

		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);
	}, 180000);
});

// ============================================================================
// Real Anthropic API tests (for comparison)
// ============================================================================

describe.skipIf(!HAS_ANTHROPIC_AUTH)("Compaction with thinking models (Anthropic)", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-thinking-compaction-anthropic-test-${nanoid()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(model: Model<any>, thinkingLevel: ThinkingLevel = "high") {
		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			rulebookRules: [],
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		};
		const tools = await createTools(toolSession);

		const agent = new Agent({
			getApiKey: () => API_KEY,
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant. Be concise.",
				tools,
				thinkingLevel,
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);

		const authStorage = new AuthStorage(join(tempDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			modelRegistry,
		});

		session.subscribe(() => {});

		return session;
	}

	it("should compact successfully with claude-3-7-sonnet and thinking level high", async () => {
		const model = getModel("anthropic", "claude-3-7-sonnet-latest")!;
		createSession(model, "high");

		// Send a simple prompt
		await session.prompt("Write down the first 10 prime numbers.");
		await session.agent.waitForIdle();

		// Verify we got a response
		const messages = session.messages;
		expect(messages.length).toBeGreaterThan(0);

		const assistantMessages = messages.filter((m) => m.role === "assistant");
		expect(assistantMessages.length).toBeGreaterThan(0);

		// Now try to compact - this should not throw
		const result = await session.compact();

		expect(result.summary).toBeDefined();
		expect(result.summary.length).toBeGreaterThan(0);
		expect(result.tokensBefore).toBeGreaterThan(0);

		// Verify session is still usable after compaction
		const messagesAfterCompact = session.messages;
		expect(messagesAfterCompact.length).toBeGreaterThan(0);
		expect(messagesAfterCompact[0].role).toBe("compactionSummary");
	}, 180000);
});
