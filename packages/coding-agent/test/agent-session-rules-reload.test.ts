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
import { getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

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

// User-scope `RULES.md` resolves through the process-global agent dir (getAgentDir()),
// not the createAgentSession `agentDir` option, so a user-scope case must redirect it.
const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function restoreAgentDir(): void {
	if (originalAgentDirEnv) {
		setAgentDir(originalAgentDirEnv);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
}

async function createReloadSession(tempDir: TempDir): Promise<{ session: AgentSession; authStorage: AuthStorage }> {
	const marker = Bun.nanoseconds().toString(36);
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
		model: buildLocalModel(`rules-reload-${marker}`),
		disableExtensionDiscovery: true,
		skills: [],
		// rules intentionally omitted so discovery runs against disk.
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	return { session, authStorage };
}

async function expectStickyRuleReload(
	reset: (session: AgentSession) => Promise<unknown>,
	opts: { seedInitial: boolean; scope: "user" | "project" },
): Promise<void> {
	using tempDir = TempDir.createSync("@pi-rules-reload-");
	const marker = Bun.nanoseconds().toString(36);
	const original = `ORIGINAL_STICKY_${marker}`;
	const updated = `UPDATED_STICKY_${marker}`;
	// User scope: `<agentDir>/RULES.md` via the process-global getAgentDir().
	// Project scope: nearest `.omp/RULES.md` walking up from cwd.
	if (opts.scope === "user") setAgentDir(tempDir.path());
	const rulesMd =
		opts.scope === "user" ? path.join(tempDir.path(), "RULES.md") : path.join(tempDir.path(), ".omp", "RULES.md");
	if (opts.seedInitial) {
		await fs.mkdir(path.dirname(rulesMd), { recursive: true });
		await fs.writeFile(rulesMd, original);
	}

	const { session, authStorage } = await createReloadSession(tempDir);

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
		if (opts.scope === "user") restoreAgentDir();
	}
}

describe("AgentSession sticky RULES.md reload on session reset", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("re-reads an edited project RULES.md after resetSessionContext()", async () => {
		await expectStickyRuleReload(session => session.resetSessionContext(), { seedInitial: true, scope: "project" });
	});

	it("re-reads an edited project RULES.md after newSession()", async () => {
		await expectStickyRuleReload(session => session.newSession(), { seedInitial: true, scope: "project" });
	});

	it("picks up a project RULES.md created after startup on resetSessionContext()", async () => {
		await expectStickyRuleReload(session => session.resetSessionContext(), { seedInitial: false, scope: "project" });
	});

	it("re-reads an edited user RULES.md after resetSessionContext()", async () => {
		await expectStickyRuleReload(session => session.resetSessionContext(), { seedInitial: true, scope: "user" });
	});

	it("picks up a user RULES.md created after startup on resetSessionContext()", async () => {
		await expectStickyRuleReload(session => session.resetSessionContext(), { seedInitial: false, scope: "user" });
	});
});

describe("AgentSession session-local rule snapshot reload on session reset", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves rule://<name> for a rulebook rule created after startup once the context resets", async () => {
		using tempDir = TempDir.createSync("@pi-rules-reload-book-");
		const marker = Bun.nanoseconds().toString(36);
		const body = `RULEBOOK_BODY_${marker}`;
		const ruleName = `reload-book-${marker}`;
		// Empty `.omp/rules/` keeps the project config scope present without any rulebook rule yet.
		const rulesDir = path.join(tempDir.path(), ".omp", "rules");
		await fs.mkdir(rulesDir, { recursive: true });

		const { session, authStorage } = await createReloadSession(tempDir);
		const readRule = async (label: string): Promise<string> => {
			const readTool = session.getToolByName("read");
			expect(readTool).toBeDefined();
			try {
				const result = await readTool!.execute(
					`${label}-${marker}`,
					{ path: `rule://${ruleName}` },
					new AbortController().signal,
				);
				return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
			} catch (err) {
				return String(err);
			}
		};

		try {
			await session.refreshBaseSystemPrompt();
			// The read tool cannot resolve a rule that discovery has not seen yet.
			expect(await readRule("before")).not.toContain(body);

			await fs.writeFile(
				path.join(rulesDir, `${ruleName}.md`),
				`---\ndescription: reloaded rulebook rule\n---\n${body}\n`,
			);
			expect(await session.resetSessionContext()).toBeTruthy();

			// After the reset, `toolSession.activeRules` reflects the new snapshot, so `rule://` resolves.
			expect(await readRule("after")).toContain(body);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
