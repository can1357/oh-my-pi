import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@pk-nerdsaver-ai/pi-agent-core";
import * as compactionModule from "@pk-nerdsaver-ai/pi-agent-core/compaction";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { assistantMsg, userMsg } from "./utilities";

describe("issue #986 compaction auth fallback", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-issue-986-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		tempDir.removeSync();
	});

	async function createSession(options?: { fallbackModelRole?: string; configureFallbackAuth?: boolean }) {
		const currentModel = getBundledModel("openai-codex", "gpt-5.4-mini");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!currentModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.strategy": "context-full" });
		if (options?.fallbackModelRole) {
			settings.setModelRole(options.fallbackModelRole, `${fallbackModel.provider}/${fallbackModel.id}`);
		}

		const agent = new Agent({
			initialState: {
				model: currentModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(currentModel.provider, "codex-token");
		if (options?.configureFallbackAuth !== false) {
			authStorage.setRuntimeApiKey(fallbackModel.provider, "anthropic-token");
		}
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});

		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}

		return { currentModel, fallbackModel };
	}

	it("falls back to an authenticated role model when the current provider returns auth_unavailable", async () => {
		const { currentModel, fallbackModel } = await createSession({ fallbackModelRole: "smol" });
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw new Error(
					"Turn prefix summarization failed: 503 auth_unavailable: no auth available (providers=codex, model=gpt-5.4-mini)",
				);
			}
			if (model.provider !== fallbackModel.provider || model.id !== fallbackModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "fallback summary",
				shortSummary: "fallback short summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
				details: { provider: model.provider },
			};
		});
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) return "codex-token";
			if (model.provider === fallbackModel.provider && model.id === fallbackModel.id) return "anthropic-token";
			return undefined;
		});

		const result = await session.compact();

		expect(result.summary).toBe("fallback summary");
		expect(compactSpy).toHaveBeenCalledTimes(2);
		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${currentModel.provider}/${currentModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
	});

	it("fails fast with a clear provider-specific error when no authenticated fallback exists", async () => {
		const { currentModel } = await createSession({ configureFallbackAuth: false });
		vi.spyOn(compactionModule, "compact").mockImplementation(async (_preparation, model) => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw new Error(
					"Summarization failed: 503 auth_unavailable: no auth available (providers=codex, model=gpt-5.4-mini)",
				);
			}
			throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
		});
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) return "codex-token";
			return undefined;
		});

		const error = await session.compact().catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			`Compaction requires usable credentials for ${currentModel.provider}/${currentModel.id}`,
		);
		expect((error as Error).message).not.toMatch(/auth_unavailable/i);
	});

	it("falls back when the current provider returns a real HTTP 401 from the compaction call", async () => {
		// Companion to the auth_unavailable test above: that case exercises the
		// pi-native gateway synthetic ("no credential configured"), this one
		// exercises a configured-but-rejected credential (rotated/revoked
		// Anthropic key, expired OAuth token, wrong workspace). Before the
		// status-aware detector landed, only the synthetic was caught — a real
		// 401 from the provider bypassed the fallback and dumped the raw HTTP
		// body into the UI as "Compaction failed: 401 {...}".
		const { currentModel, fallbackModel } = await createSession({ fallbackModelRole: "smol" });
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw Object.assign(
					new Error(
						'Turn prefix summarization failed: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
					),
					{ status: 401 },
				);
			}
			if (model.provider !== fallbackModel.provider || model.id !== fallbackModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "fallback summary",
				shortSummary: "fallback short summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
				details: { provider: model.provider },
			};
		});
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) return "stale-codex-token";
			if (model.provider === fallbackModel.provider && model.id === fallbackModel.id) return "anthropic-token";
			return undefined;
		});

		const result = await session.compact();

		expect(result.summary).toBe("fallback summary");
		expect(compactSpy).toHaveBeenCalledTimes(2);
		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${currentModel.provider}/${currentModel.id}`,
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
	});

	it("fails fast with the configured-credentials hint when a 401 has no authenticated fallback", async () => {
		const { currentModel } = await createSession({ configureFallbackAuth: false });
		vi.spyOn(compactionModule, "compact").mockImplementation(async (_preparation, model) => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) {
				throw Object.assign(
					new Error(
						'Summarization failed: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}',
					),
					{ status: 401 },
				);
			}
			throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
		});
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === currentModel.provider && model.id === currentModel.id) return "stale-codex-token";
			return undefined;
		});

		const error = await session.compact().catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(
			`Compaction requires usable credentials for ${currentModel.provider}/${currentModel.id}`,
		);
		// The raw provider envelope must not leak into the actionable error.
		expect((error as Error).message).not.toContain("authentication_error");
		expect((error as Error).message).not.toMatch(/\b401\b/);
	});
});
