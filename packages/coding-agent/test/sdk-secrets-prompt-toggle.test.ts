import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Name must satisfy collectEnvSecrets' SECRET_ENV_PATTERNS so the rebuilt
// obfuscator actually has configured secrets (hasSecrets() === true).
const ENV_SECRET_NAME = "PI_TEST_SESSION_TOKEN";
const ENV_SECRET_VALUE = "tok_live_secret_value_9f2c";

// Guards the sdk.ts prompt closure: the "opaque token" guidance must track the
// LIVE obfuscator (rebuilt by reconcileSecretObfuscator after a secrets.enabled
// reload), not a construction-time snapshot. The /reload-settings handler runs
// reconcile before the prompt pass, so a flip reaches the prompt without a
// restart — this mirrors that sequence directly.
describe("sdk secrets prompt guidance follows the live obfuscator", () => {
	const registryDirs: string[] = [];
	const storages: AuthStorage[] = [];
	const sessions: AgentSession[] = [];

	const createSession = async (secretsEnabled: boolean): Promise<AgentSession> => {
		const registryDir = path.join(os.tmpdir(), `pi-secrets-prompt-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		registryDirs.push(registryDir);
		const authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		storages.push(authStorage);
		authStorage.setRuntimeApiKey("openai", "test-key");
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry: new ModelRegistry(authStorage),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "secrets.enabled": secretsEnabled }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);
		return session;
	};

	afterAll(async () => {
		delete process.env[ENV_SECRET_NAME];
		for (const session of sessions) await session.dispose().catch(() => {});
		for (const storage of storages) storage.close();
		for (const dir of registryDirs) {
			if (fs.existsSync(dir)) removeSyncWithRetries(dir);
		}
	});

	it("adds the opaque-token guidance when secrets.enabled flips on without a restart", async () => {
		process.env[ENV_SECRET_NAME] = ENV_SECRET_VALUE;
		const session = await createSession(false);
		expect(session.agent.state.systemPrompt.join("\n\n")).not.toContain("opaque strings");

		session.settings.override("secrets.enabled", true);
		expect(await session.reconcileSecretObfuscator()).toBe(true);
		await session.refreshBaseSystemPrompt();

		expect(session.agent.state.systemPrompt.join("\n\n")).toContain("opaque strings");
		expect(session.agent.state.systemPrompt.join("\n\n")).toContain("$$HASH$$");
	});

	it("drops the opaque-token guidance when secrets.enabled flips off without a restart", async () => {
		process.env[ENV_SECRET_NAME] = ENV_SECRET_VALUE;
		const session = await createSession(true);
		expect(session.agent.state.systemPrompt.join("\n\n")).toContain("opaque strings");

		session.settings.override("secrets.enabled", false);
		expect(await session.reconcileSecretObfuscator()).toBe(true);
		await session.refreshBaseSystemPrompt();

		expect(session.agent.state.systemPrompt.join("\n\n")).not.toContain("opaque strings");
	});
});
