import { afterAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionAdvisors } from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("AgentSession.reconcileSecretObfuscator host propagation", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	afterAll(async () => {
		await session?.dispose();
		authStorage?.close();
		await tempDir?.remove();
	});

	it("propagates the rebuilt obfuscator into the provider boundary and rebuilds advisor runtimes", async () => {
		tempDir = TempDir.createSync("@pi-obfuscator-reconcile-");
		authStorage = createInMemoryAuthStorage();
		await Bun.write(tempDir.join("models.yml"), YAML.stringify({ models: [] }));
		const first = new SecretObfuscator([{ type: "plain", content: "alpha-secret-one" }]);
		const second = new SecretObfuscator([{ type: "plain", content: "beta-secret-two" }]);
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const mock = createMockModel({ provider: "anthropic" });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: [], tools: [] },
		});
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			modelRegistry,
			obfuscator: first,
			rebuildSecretObfuscator: async () => second,
		});

		// Content carrying the NEW obfuscator's placeholder lands mid-session…
		const placeholder = second.obfuscate("beta-secret-two");
		const message = createAssistantMessage(`token ${placeholder} tail`);
		session.agent.appendMessage(message);
		session.sessionManager.appendMessage(message);

		const rebuildAdvisors = vi.spyOn(SessionAdvisors.prototype, "rebuildRuntimesForHostChange");
		try {
			// …then secrets flip on and the reload rebuilds the obfuscator.
			session.settings.set("secrets.enabled", true);
			expect(await session.reconcileSecretObfuscator()).toBe(true);
			expect(session.obfuscator).toBe(second);

			// Cached hosts read the live obfuscator through their accessor: the
			// display context must deobfuscate through the REBUILT instance. A
			// stale construction-time capture would only know the first
			// instance's secrets and leave the second's placeholder opaque.
			const display = JSON.stringify(session.buildDisplaySessionContext().messages);
			expect(display).toContain("beta-secret-two");
			expect(display).not.toContain(placeholder);

			// Advisor runtimes copied the obfuscator at construction, so
			// reconcile must rebuild them instead of leaving stale captures.
			expect(rebuildAdvisors).toHaveBeenCalled();
		} finally {
			rebuildAdvisors.mockRestore();
		}
	});
});
