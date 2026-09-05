/**
 * Regression tests for sticky `RULES.md` reload on in-process session reset.
 *
 * `RULES.md` is a sticky always-apply rule rendered into the system prompt's
 * generic-rules section. Creating or editing it while omp runs and then
 * resetting the context (`/clear`) or starting a new session (`/new`) MUST make
 * the next prompt observe the current file — otherwise the rule set stays frozen
 * at session creation until the process restarts (issue #10940).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "rules-reload-model",
		name: "Rules Reload Model",
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

async function expectStickyRuleReload(
	reset: (session: AgentSession) => Promise<unknown>,
	opts: { seedInitial: boolean },
): Promise<void> {
	using tempDir = TempDir.createSync("@pi-rules-reload-");
	const marker = Bun.nanoseconds().toString(36);
	const original = `ORIGINAL_STICKY_${marker}`;
	const updated = `UPDATED_STICKY_${marker}`;
	// Project-scope sticky rule: nearest `.omp/RULES.md` walking up from cwd.
	const rulesMd = path.join(tempDir.path(), ".omp", "RULES.md");
	if (opts.seedInitial) {
		await fs.mkdir(path.dirname(rulesMd), { recursive: true });
		await fs.writeFile(rulesMd, original);
	}

	const api = `rules-reload-${marker}`;
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey("managed-primary", "test-key");
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
		// rules intentionally omitted so discovery runs against disk.
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});

	try {
		await session.refreshBaseSystemPrompt();
		if (opts.seedInitial) {
			expect(session.systemPrompt.join("\n")).toContain(original);
		} else {
			expect(session.systemPrompt.join("\n")).not.toContain(updated);
		}

		await fs.mkdir(path.dirname(rulesMd), { recursive: true });
		await fs.writeFile(rulesMd, updated);
		expect(await reset(session)).toBeTruthy();

		const rebuilt = session.systemPrompt.join("\n");
		expect(rebuilt).toContain(updated);
		if (opts.seedInitial) expect(rebuilt).not.toContain(original);
	} finally {
		await session.dispose();
		authStorage.close();
	}
}

describe("AgentSession sticky RULES.md reload on session reset", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("re-reads an edited RULES.md after resetSessionContext()", async () => {
		await expectStickyRuleReload(session => session.resetSessionContext(), { seedInitial: true });
	});

	it("re-reads an edited RULES.md after newSession()", async () => {
		await expectStickyRuleReload(session => session.newSession(), { seedInitial: true });
	});

	it("picks up a RULES.md created after startup on resetSessionContext()", async () => {
		await expectStickyRuleReload(session => session.resetSessionContext(), { seedInitial: false });
	});
});
