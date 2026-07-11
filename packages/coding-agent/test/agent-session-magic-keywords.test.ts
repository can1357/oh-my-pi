import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@pk-nerdsaver-ai/pi-agent-core";
import { Effort } from "@pk-nerdsaver-ai/pi-ai";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import * as autoThinkingClassifier from "@pk-nerdsaver-ai/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { AUTO_THINKING } from "@pk-nerdsaver-ai/pi-coding-agent/thinking";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

async function createMagicKeywordSession(root: string): Promise<{
	session: AgentSession;
	settings: Settings;
	authStorage: AuthStorage;
}> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Claude Sonnet model");
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
			thinkingLevel: Effort.High,
		},
	});
	const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	const settings = Settings.isolated();
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry,
	});
	return { session, settings, authStorage };
}

describe("AgentSession magic keyword settings", () => {
	let root: string;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-magic-keywords-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		authStorage?.close();
		await removeWithRetries(root).catch(() => undefined);
		session = undefined;
		authStorage = undefined;
	});

	it("does not append magic keyword notices when disabled", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		created.settings.set("magicKeywords.enabled", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this and ultrathink through it");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("honors non-ultrathink per-keyword notice toggles", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		created.settings.set("magicKeywords.orchestrate", false);
		created.settings.set("magicKeywords.workflow", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate and workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("still appends enabled non-ultrathink notices", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate and workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([
			"orchestrate-notice",
			"workflow-notice",
		]);
	});

	it("does not use a disabled ultrathink keyword to force auto thinking", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		created.settings.set("magicKeywords.ultrathink", false);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
		session.setThinkingLevel(AUTO_THINKING);

		await session.prompt("ultrathink through the unsafe refactor");

		expect(classifierSpy).toHaveBeenCalledTimes(1);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Low);
	});

	it("queues the magic-keyword notice before the user message", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("ultrathink do the thing");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ role?: string; customType?: string }>;
		const noticeIdx = promptMessages.findIndex(m => m.customType === "ultrathink-notice");
		const userIdx = promptMessages.findIndex(m => m.role === "user");
		expect(noticeIdx).toBeGreaterThanOrEqual(0);
		expect(userIdx).toBeGreaterThanOrEqual(0);
		expect(noticeIdx).toBeLessThan(userIdx);
	});
});
