import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@pk-nerdsaver-ai/pi-agent-core";
import * as compactionModule from "@pk-nerdsaver-ai/pi-agent-core/compaction";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { assistantMsg, userMsg } from "./utilities";

/**
 * Regression: when the user sets `modelRoles.default` to a model on a different
 * provider than the current chat, compaction must still pick the active chat's
 * model first. Otherwise an Anthropic chat would route compaction through the
 * OpenAI remote-compaction endpoint (gated by `shouldUseOpenAiRemoteCompaction`),
 * even though the live conversation never used OpenAI.
 */
describe("compaction prefers the current session model over modelRoles.default", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-compact-current-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		tempDir.removeSync();
	});

	it("uses the active Anthropic chat model when modelRoles.default points at an OpenAI model", async () => {
		const currentModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const defaultRoleModel = getBundledModel("openai", "gpt-5");
		if (!currentModel || !defaultRoleModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.strategy": "context-full" });
		settings.setModelRole("default", `${defaultRoleModel.provider}/${defaultRoleModel.id}`);

		const agent = new Agent({
			initialState: {
				model: currentModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		// Both providers have credentials so an "auth failure" wouldn't be the
		// reason a candidate is skipped — order alone must drive the choice.
		authStorage.setRuntimeApiKey(currentModel.provider, "anthropic-token");
		authStorage.setRuntimeApiKey(defaultRoleModel.provider, "openai-token");
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

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => ({
			summary: "ok",
			shortSummary: "ok short",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 1,
			details: { provider: model.provider },
		}));

		await session.compact();

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(`${firstCandidate.provider}/${firstCandidate.id}`).toBe(`${currentModel.provider}/${currentModel.id}`);
	});

	it("uses compactionModel only for the summary call and leaves the active model unchanged", async () => {
		const baseCurrentModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const compactionModel = getBundledModel("openai", "gpt-5");
		if (!baseCurrentModel || !compactionModel) {
			throw new Error("Expected bundled test models to exist");
		}
		const currentModel = buildModel({
			...baseCurrentModel,
			compactionModel: `${compactionModel.provider}/${compactionModel.id}`,
			compat: baseCurrentModel.compatConfig,
		});

		const agent = new Agent({
			initialState: {
				model: currentModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(currentModel.provider, "anthropic-token");
		authStorage.setRuntimeApiKey(compactionModel.provider, "openai-token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.keepRecentTokens": 1, "compaction.strategy": "context-full" }),
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

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => ({
			summary: "ok",
			shortSummary: "ok short",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 1,
			details: { provider: model.provider },
		}));

		await session.compact();

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(`${firstCandidate.provider}/${firstCandidate.id}`).toBe(
			`${compactionModel.provider}/${compactionModel.id}`,
		);
		expect(`${session.model?.provider}/${session.model?.id}`).toBe(`${currentModel.provider}/${currentModel.id}`);
	});

	it("/compact remote skips a non-remote-capable compactionModel and uses the active remote-capable model", async () => {
		// Active model is OpenAI (provider-native remote-capable per
		// shouldUseOpenAiRemoteCompaction). compactionModel points at an
		// Anthropic model that is NOT remote-capable, so the default candidate
		// chain would try Anthropic first and run a local summary — exactly the
		// silent-fallback the reviewer flagged for `/compact remote`. The fix
		// filters non-remote candidates in this mode, so the spy must observe
		// the OpenAI model as the first invocation.
		const baseCurrentModel = getBundledModel("openai", "gpt-5");
		const nonRemoteCompactionModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!baseCurrentModel || !nonRemoteCompactionModel) {
			throw new Error("Expected bundled test models to exist");
		}
		const currentModel = buildModel({
			...baseCurrentModel,
			compactionModel: `${nonRemoteCompactionModel.provider}/${nonRemoteCompactionModel.id}`,
			compat: baseCurrentModel.compatConfig,
		});

		const agent = new Agent({
			initialState: {
				model: currentModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(currentModel.provider, "openai-token");
		authStorage.setRuntimeApiKey(nonRemoteCompactionModel.provider, "anthropic-token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.keepRecentTokens": 1 }),
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

		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => ({
			summary: "ok",
			shortSummary: "ok short",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 1,
			details: { provider: model.provider },
		}));

		await session.compact(undefined, { mode: "remote" });

		expect(compactSpy).toHaveBeenCalled();
		const [, firstCandidate] = compactSpy.mock.calls[0]!;
		expect(`${firstCandidate.provider}/${firstCandidate.id}`).toBe(`${currentModel.provider}/${currentModel.id}`);
	});
});
