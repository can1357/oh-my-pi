// The credential-resolved endpoint fingerprint describes the session that was
// dispatched, not the model. Two sessions on the same model can resolve to
// different session-sticky endpoints, so a switch must not judge the target
// session's compacted history against the endpoint the previous one reached.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getOpenAIResponsesRequestTarget } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { getOpenAIResponsesReferenceTarget } from "@oh-my-pi/pi-ai/utils";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { BuildSessionContextOptions, SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

type MockModel = ReturnType<typeof createMockModel>;

const ORIGINAL_TEXT = "Original compacted context";
const ENTERPRISE_ENDPOINT = "https://api.enterprise.githubcopilot.com";
const SESSION_DIR = "/memory/sessions";

const sharedDir = TempDir.createSync("@pi-switch-request-target-");
const sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir.path(), "models.yml"));

afterAll(() => {
	sharedAuthStorage.close();
	sharedDir.removeSync();
});

function copilotCredential(apiEndpoint: string | undefined): string {
	return JSON.stringify({ token: "copilot-access-token", ...(apiEndpoint ? { apiEndpoint } : {}) });
}

function textOf(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap(block => {
			const typed = block as { type?: string; text?: string };
			return typed.type === "text" && typeof typed.text === "string" ? [typed.text] : [];
		})
		.join("");
}

describe("AgentSession.switchSession request target", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		while (sessions.length > 0) await sessions.pop()?.dispose();
	});

	function createModel(): MockModel {
		const model = createMockModel({
			id: "gpt-5-copilot",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
			responses: [{ content: [{ type: "text", text: "ack" }], stopReason: "stop" }],
		});
		sharedAuthStorage.setRuntimeApiKey(model.provider, copilotCredential(ENTERPRISE_ENDPOINT));
		return model;
	}

	/** A session compacted while its credential still pointed at the default host. */
	async function seedTargetSession(storage: MemorySessionStorage, model: MockModel): Promise<string> {
		const manager = SessionManager.create(SESSION_DIR, SESSION_DIR, storage);
		const compactedId = manager.appendMessage({ role: "user", content: ORIGINAL_TEXT, timestamp: 1 });
		manager.appendCompaction("opaque remote summary", undefined, compactedId, 100, {
			preserveData: {
				openaiRemoteCompaction: {
					provider: model.provider,
					replayTarget: getOpenAIResponsesReferenceTarget(model),
					requestTarget: getOpenAIResponsesRequestTarget(model, copilotCredential(undefined)),
					compactionItem: { type: "compaction", encrypted_content: "enc_copilot" },
					replacementHistory: [
						{ type: "message", role: "user", content: [{ type: "input_text", text: "Preserved user" }] },
						{ type: "compaction", encrypted_content: "enc_copilot" },
					],
				},
			},
		});
		manager.appendMessage({ role: "user", content: "Recent context", timestamp: 2 });
		await manager.ensureOnDisk();
		await manager.flush();
		const file = manager.getSessionFile();
		await manager.close();
		if (!file) throw new Error("Expected the seeded session to have a file");
		return file;
	}

	async function createSession(
		storage: MemorySessionStorage,
		model: MockModel,
	): Promise<{ session: AgentSession; manager: SessionManager }> {
		const manager = SessionManager.create(SESSION_DIR, SESSION_DIR, storage);
		manager.appendMessage({ role: "user", content: "previous session", timestamp: 1 });
		await manager.ensureOnDisk();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const agent = new Agent({
			getApiKey: () => copilotCredential(ENTERPRISE_ENDPOINT),
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: model.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry: sharedModelRegistry,
		});
		sessions.push(session);
		return { session, manager };
	}

	/** The fingerprint the session hands the loader for its next context build. */
	function observeRequestTarget(session: AgentSession, manager: SessionManager): string | undefined {
		const original = manager.buildSessionContext.bind(manager);
		let seen: string | undefined;
		manager.buildSessionContext = ((options?: BuildSessionContextOptions): SessionContext => {
			seen = options?.activeRequestTarget;
			return original(options);
		}) as SessionManager["buildSessionContext"];
		try {
			session.buildDisplaySessionContext();
		} finally {
			manager.buildSessionContext = original;
		}
		return seen;
	}

	it("drops the previous session's resolved endpoint when loading another session", async () => {
		const storage = new MemorySessionStorage();
		const model = createModel();
		const targetFile = await seedTargetSession(storage, model);
		const { session, manager } = await createSession(storage, model);

		await session.prompt("continue");
		await session.agent.waitForIdle();
		expect(observeRequestTarget(session, manager)).toBeString();

		expect(await session.switchSession(targetFile)).toBe(true);

		expect(observeRequestTarget(session, manager)).toBeUndefined();
		expect(session.messages.some(message => message.role === "compactionSummary")).toBe(true);
		expect(session.messages.some(message => textOf(message) === ORIGINAL_TEXT)).toBe(false);
	});

	it("restores the resolved endpoint when the switch rolls back", async () => {
		const storage = new MemorySessionStorage();
		const model = createModel();
		const targetFile = await seedTargetSession(storage, model);
		const { session, manager } = await createSession(storage, model);

		await session.prompt("continue");
		await session.agent.waitForIdle();
		const before = observeRequestTarget(session, manager);
		expect(before).toBeString();

		const originalSetSessionFile = manager.setSessionFile.bind(manager);
		manager.setSessionFile = (() => {
			throw new Error("switch failed");
		}) as SessionManager["setSessionFile"];
		try {
			await expect(session.switchSession(targetFile)).rejects.toThrow("switch failed");
		} finally {
			manager.setSessionFile = originalSetSessionFile;
		}

		expect(observeRequestTarget(session, manager)).toBe(before);
	});
});
