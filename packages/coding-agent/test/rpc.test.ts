import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent, AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, Effort, type TextContent } from "@oh-my-pi/pi-ai";
import {
	type CompactionEntry,
	type FileEntry,
	parseSessionEntries,
	type SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { BashExecutionMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "./utilities";

type MessageEndEvent = Extract<AgentEvent, { type: "message_end" }>;

const isMessageEndEvent = (event: AgentEvent): event is MessageEndEvent => event.type === "message_end";

const isAssistantMessage = (message: AgentMessage): message is AssistantMessage => message.role === "assistant";

const isSessionMessageEntry = (entry: FileEntry): entry is SessionMessageEntry => entry.type === "message";

const isCompactionEntry = (entry: FileEntry): entry is CompactionEntry => entry.type === "compaction";

/**
 * RPC mode tests.
 */
describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("RPC mode", () => {
	let client: RpcClient;
	let sessionDir: string;

	beforeEach(() => {
		sessionDir = path.join(os.tmpdir(), `omp-rpc-test-${Snowflake.next()}`);
		client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "dist", "cli.js"),
			cwd: path.join(import.meta.dir, ".."),
			env: { PI_CODING_AGENT_DIR: sessionDir },
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});
	});

	afterEach(async () => {
		client.stop();
		if (sessionDir && fs.existsSync(sessionDir)) {
			removeSyncWithRetries(sessionDir);
		}
	});

	test("should get state", async () => {
		await client.start();
		const state = await client.getState();

		expect(state.model).toBeDefined();
		expect(state.model?.provider).toBe("anthropic");
		expect(state.model?.id).toBe("claude-sonnet-4-5");
		expect(state.isStreaming).toBe(false);
		expect(state.messageCount).toBe(0);
		expect(state.tokensPerSecond).toBeNull();
	}, 30000);

	test("should set fast mode and expose enabled/active state", async () => {
		await client.start();

		const enabled = await client.setFastMode(true);
		expect(enabled).toEqual({ enabled: true, active: true });

		const stateWhileEnabled = await client.getState();
		expect(stateWhileEnabled.fastModeEnabled).toBe(true);
		expect(stateWhileEnabled.fastModeActive).toBe(true);

		const disabled = await client.setFastMode(false);
		expect(disabled).toEqual({ enabled: false, active: false });

		const stateWhileDisabled = await client.getState();
		expect(stateWhileDisabled.fastModeEnabled).toBe(false);
		expect(stateWhileDisabled.fastModeActive).toBe(false);
	}, 30000);

	test("should save messages to session file", async () => {
		await client.start();

		// Send prompt and wait for completion
		const events = await client.promptAndWait("Reply with just the word 'hello'");

		// Should have message events
		const messageEndEvents = events.filter(e => e.type === "message_end");
		expect(messageEndEvents.length).toBeGreaterThanOrEqual(2); // user + assistant

		// SessionManager appends each JSONL entry synchronously before the RPC response completes.

		// Verify session file
		const sessionsPath = path.join(sessionDir, "sessions");
		expect(fs.existsSync(sessionsPath)).toBe(true);

		const sessionDirs = fs.readdirSync(sessionsPath);
		expect(sessionDirs.length).toBeGreaterThan(0);

		const cwdSessionDir = path.join(sessionsPath, sessionDirs[0]);
		const sessionFiles = fs.readdirSync(cwdSessionDir).filter(f => f.endsWith(".jsonl"));
		expect(sessionFiles.length).toBe(1);

		const sessionContent = await Bun.file(path.join(cwdSessionDir, sessionFiles[0])).text();
		const entries = parseSessionEntries(sessionContent);

		// First entry should be session header
		expect(entries[0].type).toBe("session");

		// Should have user and assistant messages
		const messages = entries.filter(isSessionMessageEntry);
		expect(messages.length).toBeGreaterThanOrEqual(2);

		const roles = messages.map(message => message.message.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");
	}, 90000);

	test("should handle manual compaction", async () => {
		await client.start();

		// First send a prompt to have messages to compact
		await client.promptAndWait("Say hello");

		// Compact
		const result = await client.compact();
		expect(result.summary).toBeDefined();
		expect(result.tokensBefore).toBeGreaterThan(0);

		// Compaction persistence is synchronous with the completed RPC command.

		// Verify compaction in session file
		const sessionsPath = path.join(sessionDir, "sessions");
		const sessionDirs = fs.readdirSync(sessionsPath);
		const cwdSessionDir = path.join(sessionsPath, sessionDirs[0]);
		const sessionFiles = fs.readdirSync(cwdSessionDir).filter(f => f.endsWith(".jsonl"));
		const sessionContent = await Bun.file(path.join(cwdSessionDir, sessionFiles[0])).text();
		const entries = parseSessionEntries(sessionContent);

		const compactionEntries = entries.filter(isCompactionEntry);
		expect(compactionEntries.length).toBe(1);
		expect(compactionEntries[0].summary).toBeDefined();
	}, 120000);

	test("should execute bash command", async () => {
		await client.start();

		const result = await client.bash("echo hello");
		expect(result.output.trim()).toBe("hello");
		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
	}, 30000);

	test("should add bash output to context", async () => {
		await client.start();

		// First send a prompt to initialize session
		await client.promptAndWait("Say hi");

		// Run bash command
		const uniqueValue = `test-${Snowflake.next()}`;
		await client.bash(`echo ${uniqueValue}`);

		// Bash context persistence is synchronous with the completed RPC command.

		// Verify bash message in session
		const sessionsPath = path.join(sessionDir, "sessions");
		const sessionDirs = fs.readdirSync(sessionsPath);
		const cwdSessionDir = path.join(sessionsPath, sessionDirs[0]);
		const sessionFiles = fs.readdirSync(cwdSessionDir).filter(f => f.endsWith(".jsonl"));
		const sessionContent = await Bun.file(path.join(cwdSessionDir, sessionFiles[0])).text();
		const entries = parseSessionEntries(sessionContent);

		const bashMessages = entries.filter(
			(entry): entry is SessionMessageEntry & { message: BashExecutionMessage } =>
				isSessionMessageEntry(entry) && entry.message.role === "bashExecution",
		);
		expect(bashMessages.length).toBe(1);
		expect(bashMessages[0].message.output).toContain(uniqueValue);
	}, 90000);

	test("should include bash output in LLM context", async () => {
		await client.start();

		// Run a bash command with a unique value
		const uniqueValue = `unique-${Snowflake.next()}`;
		await client.bash(`echo ${uniqueValue}`);

		// Ask the LLM what the output was
		const events = await client.promptAndWait(
			"What was the exact output of the echo command I just ran? Reply with just the value, nothing else.",
		);

		// Find assistant's response
		const messageEndEvents = events.filter(isMessageEndEvent);
		const assistantMessage = messageEndEvents.find(
			(event): event is MessageEndEvent & { message: AssistantMessage } => isAssistantMessage(event.message),
		);

		expect(assistantMessage).toBeDefined();
		if (!assistantMessage) {
			throw new Error("Expected assistant message_end event");
		}

		const textContent = assistantMessage.message.content.find(
			(content): content is TextContent => content.type === "text",
		);
		expect(textContent?.text).toContain(uniqueValue);
	}, 90000);

	test("should set and get thinking level", async () => {
		await client.start();

		// Set thinking level
		await client.setThinkingLevel(Effort.High);

		// Verify via state
		const state = await client.getState();
		expect(state.thinkingLevel).toBe(Effort.High);
	}, 30000);

	test("should cycle thinking level", async () => {
		await client.start();

		// Get initial level
		const initialState = await client.getState();
		const initialLevel = initialState.thinkingLevel;

		// Cycle
		const result = await client.cycleThinkingLevel();
		expect(result).toBeDefined();
		expect(result!.level).not.toBe(initialLevel);

		// Verify via state
		const newState = await client.getState();
		expect(newState.thinkingLevel).toBe(result!.level);
	}, 30000);

	test("should get available models", async () => {
		await client.start();

		const models = await client.getAvailableModels();
		expect(models.length).toBeGreaterThan(0);

		// All models should have required fields
		for (const model of models) {
			expect(model.provider).toBeDefined();
			expect(model.id).toBeDefined();
			expect(model.contextWindow).toBeGreaterThan(0);
			expect(typeof model.reasoning).toBe("boolean");
		}
	}, 30000);

	test("should get session stats", async () => {
		await client.start();

		// Send a prompt first
		await client.promptAndWait("Hello");

		const stats = await client.getSessionStats();
		expect(stats.sessionFile).toBeDefined();
		expect(stats.sessionId).toBeDefined();
		expect(stats.userMessages).toBeGreaterThanOrEqual(1);
		expect(stats.assistantMessages).toBeGreaterThanOrEqual(1);
	}, 90000);

	test("should create new session", async () => {
		await client.start();

		// Send a prompt
		await client.promptAndWait("Hello");

		// Verify messages exist
		let state = await client.getState();
		expect(state.messageCount).toBeGreaterThan(0);

		// New session
		await client.newSession();

		// Verify messages cleared
		state = await client.getState();
		expect(state.messageCount).toBe(0);
	}, 90000);

	test("should export to HTML", async () => {
		await client.start();

		// Send a prompt first
		await client.promptAndWait("Hello");

		// Export
		const result = await client.exportHtml();
		expect(result.path).toBeDefined();
		expect(result.path.endsWith(".html")).toBe(true);
		expect(fs.existsSync(result.path)).toBe(true);
	}, 90000);

	test("should get last assistant text", async () => {
		await client.start();

		// Initially null
		let text = await client.getLastAssistantText();
		expect(text).toBeUndefined();

		// Send prompt
		await client.promptAndWait("Reply with just: test123");

		// Should have text now
		text = await client.getLastAssistantText();
		expect(text).toContain("test123");
	}, 90000);
});

describe("RPC fast mode with unsupported Fireworks model and priority tier", () => {
	let client: RpcClient;
	let sessionDir: string;

	beforeEach(async () => {
		sessionDir = path.join(os.tmpdir(), `omp-rpc-fast-mode-test-${Snowflake.next()}`);
		await Bun.write(path.join(sessionDir, "config.yml"), ["providers:", "  fireworksTier: priority", ""].join("\n"));
		client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "src", "cli.ts"),
			cwd: path.join(import.meta.dir, ".."),
			env: {
				PI_CODING_AGENT_DIR: sessionDir,
				FIREWORKS_API_KEY: "test-fireworks-key",
			},
			provider: "fireworks",
			model: "deepseek-v4-flash",
		});
	});

	afterEach(async () => {
		await client.stop();
		if (sessionDir && fs.existsSync(sessionDir)) {
			removeSyncWithRetries(sessionDir);
		}
	});

	test("rejects enable but disable preserves Fireworks priority activity", async () => {
		await client.start();

		await expect(client.setFastMode(true)).rejects.toMatchObject({
			message: "Fast mode is unavailable for the current model.",
		});

		const disabled = await client.setFastMode(false);
		expect(disabled).toEqual({ enabled: false, active: true });

		const state = await client.getState();
		expect(state.fastModeEnabled).toBe(false);
		expect(state.fastModeActive).toBe(true);
	}, 30000);
});
