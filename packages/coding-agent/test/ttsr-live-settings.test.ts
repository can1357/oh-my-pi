import { describe, expect, it } from "bun:test";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgTtsrDisabledRules, cfgTtsrEnabled } from "@oh-my-pi/pi-coding-agent/export/ttsr-settings";

function buildLocalModel(): Model<Api> {
	return buildModel({
		id: "ttsr-live-model",
		name: "TTSR Live Model",
		api: `ttsr-live-${Bun.nanoseconds().toString(36)}`,
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

const guard: Rule = {
	name: "live-guard",
	path: "/tmp/live-guard.md",
	content: "Never write FORBIDDEN_TOKEN.",
	description: "blocks the forbidden token",
	condition: ["FORBIDDEN_TOKEN"],
	_source: { provider: "native", providerName: "native", path: "/tmp/live-guard.md", level: "user" },
};

/** Lets the coalesced settings watcher run, then waits for the prompt rebuild it queued. */
async function settleSettingWatchers(session: AgentSession): Promise<void> {
	await Promise.resolve();
	await session.runToolRegistryMutation(async () => {});
}

async function withGuardedSession(run: (session: AgentSession, settings: Settings) => Promise<void>): Promise<void> {
	using tempDir = TempDir.createSync("@pi-ttsr-live-");
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.keys.setRuntime("managed-primary", "test-key");
	const settings = Settings.isolated({ "compaction.enabled": false });
	const { session } = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		sessionManager: SessionManager.inMemory(tempDir.path()),
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
		settings,
		model: buildLocalModel(),
		disableExtensionDiscovery: true,
		skills: [],
		rules: [guard],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	try {
		await run(session, settings);
	} finally {
		await session.dispose();
		authStorage.close();
	}
}

describe("TTSR settings changed mid-session", () => {
	it("stops and resumes stream matching when ttsr.enabled flips", async () => {
		await withGuardedSession(async (session, settings) => {
			const manager = session.ttsrManager!;
			expect(manager.checkDelta("FORBIDDEN_TOKEN", { source: "text" })).toEqual([guard]);
			manager.resetBuffer();

			cfgTtsrEnabled.set(settings, false);
			expect(manager.hasRules()).toBe(false);
			expect(manager.checkDelta("FORBIDDEN_TOKEN", { source: "text" })).toEqual([]);
			await settleSettingWatchers(session);
			// Disabled TTSR re-buckets the described rule into the rulebook.
			expect(session.systemPrompt.join("\n")).toContain("blocks the forbidden token");

			cfgTtsrEnabled.set(settings, true);
			await settleSettingWatchers(session);
			expect(manager.getRules()).toEqual([guard]);
			expect(manager.checkDelta("FORBIDDEN_TOKEN", { source: "text" })).toEqual([guard]);
		});
	});

	it("drops a rule named in ttsr.disabledRules without a session reset", async () => {
		await withGuardedSession(async (session, settings) => {
			const manager = session.ttsrManager!;
			expect(manager.getRules()).toEqual([guard]);

			cfgTtsrDisabledRules.set(settings, [guard.name]);
			await settleSettingWatchers(session);

			expect(manager.getRules()).toEqual([]);
			expect(manager.checkDelta("FORBIDDEN_TOKEN", { source: "text" })).toEqual([]);
			expect(session.systemPrompt.join("\n")).not.toContain("blocks the forbidden token");
		});
	});
});
