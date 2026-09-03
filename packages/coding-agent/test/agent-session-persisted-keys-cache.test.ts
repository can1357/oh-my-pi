import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession persistence-keys cache", () => {
	let session: AgentSession;
	let tempDir: string;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let authDir: TempDir;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authDir = TempDir.createSync("@pi-cache-auth-");
		authStorage = await AuthStorage.create(authDir.join("auth.db"));
		modelRegistry = new ModelRegistry(authStorage, authDir.join("models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		authDir.removeSync();
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-cache-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });

		const tools: AgentTool[] = [];
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("bundled model claude-sonnet-4-5 not found");
		}
		const agent = new Agent({
			getApiKey: () => "fake-key",
			initialState: { model, systemPrompt: [], tools },
		});

		sessionManager = SessionManager.create(tempDir, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});

		session.subscribe(() => {});
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		if (fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("does not duplicate a message on re-persist attempts", async () => {
		const msg: AgentMessage = { role: "user", content: [{ type: "text", text: "Hello cache" }], timestamp: 1000 };

		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) {
			await Promise.resolve();
		}

		const count1 = sessionManager.getBranch().filter(e => e.type === "message").length;
		expect(count1).toBe(1);

		// Re-emit should be ignored due to cache
		session.agent.emitExternalEvent({ type: "message_end", message: msg });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) {
			await Promise.resolve();
		}

		const count2 = sessionManager.getBranch().filter(e => e.type === "message").length;
		expect(count2).toBe(1);
	});

	it("caches missing-key checks across a growing branch", async () => {
		const getBranch = spyOn(sessionManager, "getBranch");

		try {
			for (let i = 0; i < 25; i++) {
				const msg: AgentMessage = {
					role: "user",
					content: [{ type: "text", text: `Cache perf ${i}` }],
					timestamp: 2000 + i,
				};
				session.agent.emitExternalEvent({ type: "message_end", message: msg });
				await sessionManager.flush();
				for (let spin = 0; spin < 5; spin++) {
					await Promise.resolve();
				}
			}

			expect(getBranch).toHaveBeenCalledTimes(1);
		} finally {
			getBranch.mockRestore();
		}

		const entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.length).toBe(25);
	});

	it("reflects the NEW branch after a rewind (stale cache would wrongly skip)", async () => {
		// 1. Send first message (assistant)
		const msg1: AssistantMessage = createAssistantMessage("Msg 1");
		session.agent.emitExternalEvent({ type: "message_end", message: msg1 });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		// 2. Send second message (user)
		const msg2: AgentMessage = { role: "user", content: [{ type: "text", text: "Msg 2" }], timestamp: 1002 };
		session.agent.emitExternalEvent({ type: "message_end", message: msg2 });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		let entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.length).toBe(2);

		// 3. Rewind to msg1 (by navigating to the assistant message msg1)
		// This sets the leaf exactly to msg1.
		const msg1EntryId = entries[0].id;
		const navResult = await session.navigateTree(msg1EntryId, { summarize: false });
		expect(navResult.cancelled).toBe(false);

		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		// Confirm rewind occurred (only msg1 remains)
		entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.length).toBe(1);
		expect(entries[0].message.role).toBe("assistant");

		// 4. Send msg2 AGAIN
		// If cache wasn't invalidated on rewind, it remembers msg2 and wrongly skips it.
		session.agent.emitExternalEvent({ type: "message_end", message: msg2 });
		await sessionManager.flush();
		for (let i = 0; i < 5; i++) await Promise.resolve();

		// Cache must be invalidated, so the re-persist succeeds.
		entries = sessionManager.getBranch().filter(e => e.type === "message");
		expect(entries.length).toBe(2);
		expect(entries[1].message.role).toBe("user");
	});
});
