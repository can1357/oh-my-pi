import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression guard for #11431: `set_auto_compaction`/`set_auto_retry` (which drive
 * `AgentSession.setAutoCompactionEnabled`/`setAutoRetryEnabled`) must configure only
 * the calling session by default, never write the machine-global `config.yml`. The
 * explicit `persist` flag — used by the TUI settings panel — is the only path that
 * mutates durable global state.
 */
describe("AgentSession auto-maintenance controls are session-scoped by default", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let settings: Settings;
	let session: AgentSession;
	let configPath: string;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-auto-scope-");
		const agentDir = tempDir.path();
		configPath = path.join(agentDir, "config.yml");

		authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
		settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(agentDir, agentDir),
			settings,
			modelRegistry,
			obfuscator: new SecretObfuscator([]),
		});
	});

	afterEach(async () => {
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
	});

	it("applies the change in-session without persisting to global config.yml", async () => {
		session.setAutoCompactionEnabled(false);
		session.setAutoRetryEnabled(false);
		await settings.flush();

		// Value is live for this session.
		expect(settings.get("compaction.enabled")).toBe(false);
		expect(settings.get("retry.enabled")).toBe(false);

		// ...but it never touched the persisted global layer or disk.
		expect(settings.getGlobalSettings()).toEqual({});
		expect(await Bun.file(configPath).exists()).toBe(false);
	});

	it("persists to global config.yml when persist=true (settings panel path)", async () => {
		session.setAutoCompactionEnabled(false, true);
		session.setAutoRetryEnabled(false, true);
		await settings.flush();

		expect(settings.getGlobalSettings()).toMatchObject({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const onDisk = await Bun.file(configPath).text();
		expect(onDisk).toContain("enabled: false");
	});
});
