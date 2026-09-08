/**
 * Tests for AgentSession branching behavior.
 *
 * These tests verify:
 * - Branching from a single message works
 * - Branching in --no-session mode (in-memory only)
 * - getUserMessagesForBranching returns correct entries
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, UserMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { assistantMsg, createTestSession, e2eApiKey } from "./utilities";

describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("AgentSession branching", () => {
	let session: AgentSession;
	let tempDir: string;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		// Create temp directory for session files
		tempDir = path.join(os.tmpdir(), `pi-branching-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	async function createSession(noSession: boolean = false) {
		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const tools = await createTools(toolSession);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => e2eApiKey("ANTHROPIC_API_KEY"),
			initialState: {
				model,
				systemPrompt: ["You are a helpful assistant. Be extremely concise, reply with just a few words."],
				tools,
			},
		});

		sessionManager = noSession ? SessionManager.inMemory() : SessionManager.create(tempDir, tempDir);
		const settings = Settings.isolated();
		authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});

		// Must subscribe to enable session persistence
		session.subscribe(() => {});

		return session;
	}

	it("should allow branching from single message", async () => {
		await createSession();

		// Send one message
		await session.prompt("Say hello");
		await session.agent.waitForIdle();

		// Should have exactly 1 user message available for branching
		const userMessages = session.getUserMessagesForBranching();
		expect(userMessages.length).toBe(1);
		expect(userMessages[0].text).toBe("Say hello");

		// Branch from the first message
		const result = await session.branch(userMessages[0].entryId);
		expect(result.selectedText).toBe("Say hello");
		expect(result.cancelled).toBe(false);

		// After branching, conversation should be empty (branched before the first message)
		expect(session.messages.length).toBe(0);

		// Session file should exist (new branch)
		expect(session.sessionFile).not.toBeNull();
		expect(fs.existsSync(session.sessionFile!)).toBe(true);
	});

	it("should support in-memory branching in --no-session mode", async () => {
		await createSession(true);

		// Verify sessions are disabled
		expect(session.sessionFile).toBeUndefined();

		// Send one message
		await session.prompt("Say hi");
		await session.agent.waitForIdle();

		// Should have 1 user message
		const userMessages = session.getUserMessagesForBranching();
		expect(userMessages.length).toBe(1);

		// Verify we have messages before branching
		expect(session.messages.length).toBeGreaterThan(0);

		// Branch from the first message
		const result = await session.branch(userMessages[0].entryId);
		expect(result.selectedText).toBe("Say hi");
		expect(result.cancelled).toBe(false);

		// After branching, conversation should be empty
		expect(session.messages.length).toBe(0);

		// Session file should still be undefined (no file created)
		expect(session.sessionFile).toBeUndefined();
	});

	it("should branch from middle of conversation", async () => {
		await createSession();

		// Send multiple messages
		await session.prompt("Say one");
		await session.agent.waitForIdle();

		await session.prompt("Say two");
		await session.agent.waitForIdle();

		await session.prompt("Say three");
		await session.agent.waitForIdle();

		// Should have 3 user messages
		const userMessages = session.getUserMessagesForBranching();
		expect(userMessages.length).toBe(3);

		// Branch from second message (keeps first message + response)
		const secondMessage = userMessages[1];
		const result = await session.branch(secondMessage.entryId);
		expect(result.selectedText).toBe("Say two");

		// After branching, should have first user message + assistant response
		expect(session.messages.length).toBe(2);
		expect(session.messages[0].role).toBe("user");
		expect(session.messages[1].role).toBe("assistant");
	});
});

const HISTORICAL_IMAGE: ImageContent = {
	type: "image",
	data: "aW1hZ2U=",
	mimeType: "image/png",
};

function historicalImagePrompt(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }, HISTORICAL_IMAGE],
		timestamp: Date.now(),
	};
}

describe("AgentSession branch title metadata", () => {
	it("preserves an explicit title when branching before the first prompt", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const entryId = ctx.sessionManager.appendMessage({
				role: "user",
				content: "hello",
				timestamp: Date.now(),
			});
			await ctx.sessionManager.setSessionName("new-ds", "user");

			await ctx.session.branch(entryId);

			expect(ctx.sessionManager.getSessionName()).toBe("new-ds");
			expect(ctx.sessionManager.titleSource).toBe("user");
			expect(await ctx.sessionManager.setSessionName("automatic", "auto")).toBe(false);
			expect(ctx.sessionManager.getSessionName()).toBe("new-ds");
		} finally {
			await ctx.cleanup();
		}
	});
});

describe("AgentSession historical image prompts", () => {
	it("returns the selected images when branching from a user prompt", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const text = "Inspect [Image #1, 1x1]";
			const entryId = ctx.sessionManager.appendMessage(historicalImagePrompt(text));

			const result = await ctx.session.branch(entryId);

			expect(result).toEqual({
				selectedText: text,
				selectedImages: [HISTORICAL_IMAGE],
				cancelled: false,
			});
		} finally {
			await ctx.cleanup();
		}
	});

	it("returns the target images when navigating to a user prompt", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const text = "Compare [Image #1, 1x1]";
			const entryId = ctx.sessionManager.appendMessage(historicalImagePrompt(text));
			ctx.sessionManager.appendMessage(assistantMsg("Compared."));

			const result = await ctx.session.navigateTree(entryId);

			expect(result).toMatchObject({
				editorText: text,
				editorImages: [HISTORICAL_IMAGE],
				cancelled: false,
			});
		} finally {
			await ctx.cleanup();
		}
	});

	it("preserves multi-image order so positional markers stay aligned", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const second: ImageContent = { type: "image", data: "Qg==", mimeType: "image/jpeg" };
			const text = "compare [Image #1, 1x1] with [Image #2, 2x2]";
			const entryId = ctx.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text }, HISTORICAL_IMAGE, second],
				timestamp: Date.now(),
			} satisfies UserMessage);
			ctx.sessionManager.appendMessage(assistantMsg("Compared."));

			const result = await ctx.session.navigateTree(entryId);

			expect(result.editorText).toBe(text);
			expect(result.editorImages).toEqual([HISTORICAL_IMAGE, second]);
		} finally {
			await ctx.cleanup();
		}
	});

	it("leaves editorImages unset when the prompt has no images", async () => {
		const ctx = await createTestSession({ inMemory: true });
		try {
			const entryId = ctx.sessionManager.appendMessage({
				role: "user",
				content: "plain text turn",
				timestamp: Date.now(),
			} satisfies UserMessage);
			ctx.sessionManager.appendMessage(assistantMsg("ok"));

			const result = await ctx.session.navigateTree(entryId);

			expect(result.editorText).toBe("plain text turn");
			expect(result.editorImages).toBeUndefined();
		} finally {
			await ctx.cleanup();
		}
	});

	it("rewinds past a user prompt that is the current leaf", async () => {
		// A turn aborted before any assistant reply leaves the user prompt as
		// the leaf; rewinding to it must still move the leaf to its parent and
		// hand the prompt back, not report a no-op.
		const ctx = await createTestSession({ inMemory: true });
		try {
			ctx.sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
			const parentId = ctx.sessionManager.appendMessage(assistantMsg("reply"));
			const leafId = ctx.sessionManager.appendMessage({
				role: "user",
				content: "aborted prompt",
				timestamp: Date.now(),
			});
			expect(ctx.sessionManager.getLeafId()).toBe(leafId);

			const result = await ctx.session.navigateTree(leafId);

			expect(result).toMatchObject({ editorText: "aborted prompt", cancelled: false });
			expect(ctx.sessionManager.getLeafId()).toBe(parentId);
		} finally {
			await ctx.cleanup();
		}
	});
});
