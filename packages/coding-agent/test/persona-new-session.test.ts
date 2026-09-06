/**
 * `/new` (AgentSession.newSession) must not carry a persona across the
 * logical session boundary: the runtime exits before the transcript and
 * context are cleared, so the fresh session starts from the unrestricted
 * baseline — no stale grant, append prompt, or spawn override.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { PersonaRuntime } from "@oh-my-pi/pi-coding-agent/session/persona-runtime";
import { SessionToolPolicy, type DiscoveredAgent } from "@oh-my-pi/pi-coding-agent/session/tool-policy";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function makePersona(overrides: Partial<DiscoveredAgent> = {}): DiscoveredAgent {
	return {
		name: "persona-a",
		description: "test persona",
		systemPrompt: "persona-a identity prompt",
		tools: ["read", "grep"],
		source: "bundled",
		...overrides,
	};
}

describe("persona state teardown for /new sessions", () => {
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	afterEach(async () => {
		if (session) await session.dispose();
		for (const authStorage of authStorages.splice(0)) authStorage.close();
	});

	async function makePersonaSession(persona?: DiscoveredAgent): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const policy = new SessionToolPolicy({
			registry: () => new Set(["read", "grep", "bash", "edit", "write", "task"]),
			isDefaultActive: () => true,
		});
		const s = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
			toolPolicy: policy,
		});
		s.setPersonaRuntime(new PersonaRuntime(policy, s));
		if (persona) await s.getPersonaRuntime()!.enter(persona, {}, { apply: async () => {}, restore: async () => {} });
		return s;
	}

	it("newSession exits an active persona before clearing state", async () => {
		session = await makePersonaSession(makePersona());
		const policy = session.getToolPolicy()!;
		expect(policy.isPersonaActive()).toBe(true);
		expect(policy.effective("bash")).toBe(false); // persona tools: [read, grep]
		expect(session.getPersonaAppendPrompt()).toBe("persona-a identity prompt");

		await session.newSession();

		expect(policy.isPersonaActive()).toBe(false);
		expect(policy.effective("bash")).toBe(true); // unrestricted again
		expect(session.getPersonaAppendPrompt()).toBeUndefined();
		expect(session.getSessionSpawns()).toBe("*"); // no persona override → unrestricted host default
	});

	it("newSession is a no-op for persona state when none is active", async () => {
		session = await makePersonaSession();
		const policy = session.getToolPolicy()!;

		await session.newSession();

		expect(policy.isPersonaActive()).toBe(false);
		expect(session.getPersonaAppendPrompt()).toBeUndefined();
	});
});
