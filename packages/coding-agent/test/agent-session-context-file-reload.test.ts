import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as capabilities from "@oh-my-pi/pi-coding-agent/capability";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as repoContext from "@oh-my-pi/pi-coding-agent/utils/active-repo-context";
import { TempDir } from "@oh-my-pi/pi-utils";

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "context-reload-model",
		name: "Context Reload Model",
		api,
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

async function expectContextReload(reset: (session: AgentSession) => Promise<unknown>): Promise<void> {
	using tempDir = TempDir.createSync("@pi-context-reload-");
	const marker = Bun.nanoseconds().toString(36);
	const original = `ORIGINAL_RULES_${marker}`;
	const updated = `UPDATED_RULES_${marker}`;
	const agentsMd = path.join(tempDir.path(), "AGENTS.md");
	await fs.writeFile(agentsMd, original);

	const api = `context-reload-${marker}`;
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.keys.setRuntime("managed-primary", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const { session } = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		sessionManager: SessionManager.inMemory(tempDir.path()),
		authStorage,
		modelRegistry,
		settings: Settings.isolated({ "compaction.enabled": false }),
		model: buildLocalModel(api),
		disableExtensionDiscovery: true,
		skills: [],
		// contextFiles intentionally omitted so discovery runs against disk.
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});

	try {
		await session.refreshBaseSystemPrompt();
		expect(session.systemPrompt.join("\n")).toContain(original);

		await fs.writeFile(agentsMd, updated);
		expect(await reset(session)).toBeTruthy();

		const rebuilt = session.systemPrompt.join("\n");
		expect(rebuilt).toContain(updated);
		expect(rebuilt).not.toContain(original);
	} finally {
		await session.dispose();
		authStorage.close();
	}
}

describe("AgentSession context-file reload on session reset", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("re-reads an edited AGENTS.md after newSession()", async () => {
		await expectContextReload(session => session.newSession());
	});

	it("re-reads an edited AGENTS.md after resetSessionContext()", async () => {
		await expectContextReload(session => session.resetSessionContext());
	});

	it("rejects a failed parallel discovery without replacing the prompt and can retry", async () => {
		await expectContextReload(async session => {
			const previousPrompt = [...session.systemPrompt];
			const loadCapability = capabilities.loadCapability;
			const discovery = vi.spyOn(capabilities, "loadCapability").mockImplementation(async (id, options) => {
				if (id === "rules") throw new Error("Rule discovery failed");
				return await loadCapability(id, options);
			});
			try {
				await expect(session.refreshBaseSystemPrompt()).rejects.toThrow("Rule discovery failed");
				expect(session.systemPrompt).toEqual(previousPrompt);
			} finally {
				discovery.mockRestore();
			}
			return await session.resetSessionContext();
		});
	});

	it("starts rule discovery before the repository lookup settles", async () => {
		await expectContextReload(async session => {
			let rulesStarted = false;
			const observedAtRepoCompletion: boolean[] = [];
			const loadCapability = capabilities.loadCapability;
			vi.spyOn(repoContext, "resolveActiveRepoContext").mockImplementation(async () => {
				// Yield one microtask, not a wall-clock delay: independent discovery
				// must already have started when this lookup is allowed to settle.
				await Promise.resolve();
				observedAtRepoCompletion.push(rulesStarted);
				return null;
			});
			vi.spyOn(capabilities, "loadCapability").mockImplementation(async (id, options) => {
				if (id === "rules") rulesStarted = true;
				return await loadCapability(id, options);
			});

			const reset = await session.newSession();
			expect(observedAtRepoCompletion.length).toBeGreaterThan(0);
			expect(observedAtRepoCompletion[0]).toBe(true);
			return reset;
		});
	});
});
