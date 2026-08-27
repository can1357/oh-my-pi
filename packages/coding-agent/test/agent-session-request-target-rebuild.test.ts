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
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const ORIGINAL_TEXT = "Original compacted context";
const ENTERPRISE_ENDPOINT = "https://api.enterprise.githubcopilot.com";

const sharedDir = TempDir.createSync("@pi-request-target-rebuild-");
const sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
const sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir.path(), "models.yml"));

afterAll(() => {
	sharedAuthStorage.close();
	sharedDir.removeSync();
});

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

function copilotCredential(apiEndpoint: string | undefined): string {
	return JSON.stringify({ token: "copilot-access-token", ...(apiEndpoint ? { apiEndpoint } : {}) });
}

describe("AgentSession credential-resolved request target", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		while (sessions.length > 0) await sessions.pop()?.dispose();
	});

	async function createHarness(credential: string): Promise<{ session: AgentSession }> {
		const model = createMockModel({
			id: "gpt-5-copilot",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
			responses: [{ content: [{ type: "text", text: "ack" }], stopReason: "stop" }],
		});
		sharedAuthStorage.setRuntimeApiKey(model.provider, credential);

		const sessionManager = SessionManager.inMemory(sharedDir.path());
		const compactedId = sessionManager.appendMessage({
			role: "user",
			content: ORIGINAL_TEXT,
			timestamp: Date.now() - 2,
		});
		sessionManager.appendCompaction("opaque remote summary", undefined, compactedId, 100, {
			preserveData: {
				openaiRemoteCompaction: {
					provider: model.provider,
					replayTarget: getOpenAIResponsesReferenceTarget(model),
					// Issued while the credential still pointed at the default host.
					requestTarget: getOpenAIResponsesRequestTarget(model, copilotCredential(undefined)),
					compactionItem: { type: "compaction", encrypted_content: "enc_copilot" },
					replacementHistory: [
						{ type: "message", role: "user", content: [{ type: "input_text", text: "Preserved user" }] },
						{ type: "compaction", encrypted_content: "enc_copilot" },
					],
				},
			},
		});
		sessionManager.appendMessage({ role: "user", content: "Recent context", timestamp: Date.now() - 1 });

		// Resume shape: the model is known but no credential has been resolved yet,
		// so the blob is admitted against the credential-free replay target.
		const resumed = sessionManager.buildSessionContext({ activeModel: model });
		expect(resumed.messages.some(message => message.role === "compactionSummary")).toBe(true);
		expect(resumed.messages.some(message => textOf(message) === ORIGINAL_TEXT)).toBe(false);

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const agent = new Agent({
			getApiKey: () => credential,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: resumed.messages },
			convertToLlm,
			streamFn: model.stream,
		});
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry: sharedModelRegistry });
		sessions.push(session);
		return { session };
	}

	it("re-expands originals when the first credential resolution moves the endpoint", async () => {
		const { session } = await createHarness(copilotCredential(ENTERPRISE_ENDPOINT));

		await session.prompt("continue");
		await session.agent.waitForIdle();

		expect(session.messages.some(message => message.role === "compactionSummary")).toBe(false);
		expect(session.messages.some(message => textOf(message) === ORIGINAL_TEXT)).toBe(true);
	});

	it("keeps the compaction collapsed when the first credential resolution matches", async () => {
		const { session } = await createHarness(copilotCredential(undefined));

		await session.prompt("continue");
		await session.agent.waitForIdle();

		expect(session.messages.some(message => message.role === "compactionSummary")).toBe(true);
		expect(session.messages.some(message => textOf(message) === ORIGINAL_TEXT)).toBe(false);
	});
});
