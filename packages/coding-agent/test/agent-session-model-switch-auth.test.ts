import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// Switching the active model (Ctrl+P role cycling, /models selection) must be a
// cheap, synchronous operation. It used to call the async `getApiKey`, which can
// block the event loop on a command-backed key program (`execSync`) or stall on
// a network OAuth refresh. The real key is resolved lazily per request via the
// resolver, so the switch only needs a synchronous "is a credential configured"
// pre-flight (`hasConfiguredAuth`) — never the resolver.
describe("AgentSession model switch auth pre-flight", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let session: AgentSession | undefined;
	const spies: Array<{ mockRestore: () => void }> = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-model-switch-auth-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		registry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	afterEach(async () => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		if (session) {
			await session.dispose();
			session = undefined;
		}
	});

	function modelOrThrow(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	function makeSession(initialModel: Model<Api>, roles?: Record<string, string>): AgentSession {
		const settings = Settings.isolated();
		if (roles) {
			for (const role in roles) settings.setModelRole(role, roles[role]);
		}
		const agent = new Agent({
			initialState: {
				model: initialModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
		});
		return session;
	}

	it("switches the active model via the synchronous auth check, not the resolver", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const s = makeSession(from);

		const getApiKeySpy = spyOn(registry, "getApiKey");
		const hasAuthSpy = spyOn(registry, "hasConfiguredAuth");
		spies.push(getApiKeySpy, hasAuthSpy);

		await s.setModel(to);

		expect(s.model?.id).toBe(to.id);
		expect(hasAuthSpy).toHaveBeenCalled();
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});

	it("cycles role models without invoking the resolver", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const slow = modelOrThrow("claude-sonnet-4-6");
		const s = makeSession(from, {
			default: `${from.provider}/${from.id}`,
			slow: `${slow.provider}/${slow.id}`,
		});

		const getApiKeySpy = spyOn(registry, "getApiKey");
		spies.push(getApiKeySpy);

		const result = await s.cycleRoleModels(["default", "slow"]);

		expect(result?.role).toBe("slow");
		expect(result?.model.id).toBe(slow.id);
		expect(s.model?.id).toBe(slow.id);
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});

	it("temporary switch also avoids the resolver", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const s = makeSession(from);

		const getApiKeySpy = spyOn(registry, "getApiKey");
		spies.push(getApiKeySpy);

		await s.setModelTemporary(to);

		expect(s.model?.id).toBe(to.id);
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});

	it("rejects the switch synchronously when no credential is configured, without calling the resolver", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const s = makeSession(from);

		const getApiKeySpy = spyOn(registry, "getApiKey");
		const hasAuthSpy = spyOn(registry, "hasConfiguredAuth").mockReturnValue(false);
		spies.push(getApiKeySpy, hasAuthSpy);

		await expect(s.setModel(to)).rejects.toThrow(/No API key/);
		expect(s.model?.id).toBe(from.id);
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});
});
