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
import { buildSessionContextView } from "@oh-my-pi/pi-coding-agent/session/context-view";
import * as repoContext from "@oh-my-pi/pi-coding-agent/utils/active-repo-context";
import type { WorkspaceTree } from "@oh-my-pi/pi-coding-agent/workspace-tree";
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

interface ReloadSession {
	session: AgentSession;
	close(): Promise<void>;
}

interface ReloadSessionOptions {
	settings?: Readonly<Record<string, unknown>>;
	sessionManager?: SessionManager;
	workspaceTree?: WorkspaceTree;
}

/** Session whose prompt inputs are discovered from `cwd` on disk. */
async function openReloadSession(
	tempDir: TempDir,
	cwd: string,
	options: ReloadSessionOptions = {},
): Promise<ReloadSession> {
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.keys.setRuntime("managed-primary", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const { session } = await createAgentSession({
		cwd,
		agentDir: tempDir.path(),
		sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry,
		settings: Settings.isolated({ "compaction.enabled": false, ...options.settings }),
		workspaceTree: options.workspaceTree,
		model: buildLocalModel(`context-reload-${Bun.nanoseconds().toString(36)}`),
		disableExtensionDiscovery: true,
		skills: [],
		// contextFiles intentionally omitted so discovery runs against disk.
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	return {
		session,
		async close() {
			await session.dispose();
			authStorage.close();
		},
	};
}

async function expectContextReload(reset: (session: AgentSession) => Promise<unknown>): Promise<void> {
	using tempDir = TempDir.createSync("@pi-context-reload-");
	const marker = Bun.nanoseconds().toString(36);
	const original = `ORIGINAL_RULES_${marker}`;
	const updated = `UPDATED_RULES_${marker}`;
	const agentsMd = path.join(tempDir.path(), "AGENTS.md");
	await fs.writeFile(agentsMd, original);

	const { session, close } = await openReloadSession(tempDir, tempDir.path());
	try {
		await session.refreshBaseSystemPrompt();
		expect(session.systemPrompt.join("\n")).toContain(original);

		// Attribution follows the committed prompt: the initial build, then the rebuild.
		const instructionText = () =>
			buildSessionContextView(session)
				.categories.find(category => category.id === "instruction-files")!
				.entries.map(entry => entry.text)
				.join("\n");
		expect(instructionText()).toContain(original);

		await fs.writeFile(agentsMd, updated);
		expect(await reset(session)).toBeTruthy();

		const rebuilt = session.systemPrompt.join("\n");
		expect(rebuilt).toContain(updated);
		expect(rebuilt).not.toContain(original);
		expect(instructionText()).toContain(updated);
		expect(instructionText()).not.toContain(original);
	} finally {
		await close();
	}
}

async function withTreeSession(
	run: (session: AgentSession, tempDir: TempDir) => Promise<void>,
	options: { persisted?: boolean; workspaceTree?: WorkspaceTree; expectInitial?: string } = {},
): Promise<void> {
	using tempDir = TempDir.createSync("@pi-workspace-tree-");
	await fs.mkdir(tempDir.join("project"));
	await Bun.write(tempDir.join("project", "original_entry.txt"), "x");
	const cwd = tempDir.join("project");
	const { session, close } = await openReloadSession(tempDir, cwd, {
		settings: { includeWorkspaceTree: true },
		sessionManager: options.persisted ? SessionManager.create(cwd, tempDir.join("sessions")) : undefined,
		workspaceTree: options.workspaceTree,
	});
	try {
		expect(session.systemPrompt.join("\n")).toContain(options.expectInitial ?? "original_entry.txt");
		await run(session, tempDir);
	} finally {
		await close();
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

describe("workspace tree in the system prompt", () => {
	it("keeps the tree within a transcript and rescans it after a context reset", async () => {
		await withTreeSession(async (session, tempDir) => {
			await Bun.write(tempDir.join("project", "checked_out_entry.txt"), "x");

			// Same transcript: the cached prefix must stay byte-stable.
			await session.refreshBaseSystemPrompt();
			expect(session.systemPrompt.join("\n")).not.toContain("checked_out_entry.txt");

			expect(await session.resetSessionContext()).toBeTruthy();
			expect(session.systemPrompt.join("\n")).toContain("checked_out_entry.txt");
		});
	});

	it("rescans the tree when a new session starts", async () => {
		await withTreeSession(async (session, tempDir) => {
			await Bun.write(tempDir.join("project", "checked_out_entry.txt"), "x");

			expect(await session.newSession()).toBe(true);
			expect(session.systemPrompt.join("\n")).toContain("checked_out_entry.txt");
		});
	});

	it("keeps the tree when resuming another session in the same directory", async () => {
		await withTreeSession(
			async (session, tempDir) => {
				const cwd = session.sessionManager.getCwd();
				const target = SessionManager.create(cwd, tempDir.join("sessions"));
				target.appendMessage({ role: "user", content: "target", timestamp: 1 });
				await target.ensureOnDisk();
				await target.flush();
				const targetFile = target.getSessionFile();
				await target.close();
				if (!targetFile) throw new Error("Expected the target session to be on disk");
				await Bun.write(path.join(cwd, "checked_out_entry.txt"), "x");

				// The resumed conversation may still be cached under this prefix.
				expect(await session.switchSession(targetFile)).toBe(true);
				expect(session.systemPrompt.join("\n")).not.toContain("checked_out_entry.txt");
			},
			{ persisted: true },
		);
	});

	it("gives a resumed conversation back its own tree after another one rescanned", async () => {
		await withTreeSession(
			async (session, tempDir) => {
				const cwd = session.sessionManager.getCwd();
				const earlier = SessionManager.create(cwd, tempDir.join("sessions"));
				earlier.appendMessage({ role: "user", content: "earlier", timestamp: 1 });
				await earlier.ensureOnDisk();
				await earlier.flush();
				const earlierFile = earlier.getSessionFile();
				await earlier.close();
				if (!earlierFile) throw new Error("Expected the earlier session to be on disk");
				expect(await session.switchSession(earlierFile)).toBe(true);

				await Bun.write(path.join(cwd, "checked_out_entry.txt"), "x");
				expect(await session.newSession()).toBe(true);
				expect(session.systemPrompt.join("\n")).toContain("checked_out_entry.txt");

				// The earlier conversation was sent the first scan; the new one's rescan must not leak into it.
				expect(await session.switchSession(earlierFile)).toBe(true);
				expect(session.systemPrompt.join("\n")).not.toContain("checked_out_entry.txt");
			},
			{ persisted: true },
		);
	});

	it("keeps the tree when the current session is reloaded from disk", async () => {
		await withTreeSession(
			async session => {
				await session.sendCustomMessage(
					{ customType: "note", content: "persist the session", display: true },
					{ triggerTurn: false },
				);
				const before = [...session.systemPrompt];
				await Bun.write(path.join(session.sessionManager.getCwd(), "checked_out_entry.txt"), "x");

				// Same conversation: a reload must not change the cached prefix.
				await session.reload();
				expect(session.systemPrompt).toEqual(before);
			},
			{ persisted: true },
		);
	});

	it("rescans the tree and nested AGENTS.md list after the session cwd moves", async () => {
		await withTreeSession(async (session, tempDir) => {
			await Bun.write(tempDir.join("project", "old_pkg", "AGENTS.md"), "old");
			expect(await session.resetSessionContext()).toBeTruthy();
			expect(session.systemPrompt.join("\n")).toContain("old_pkg/AGENTS.md");

			await Bun.write(tempDir.join("moved", "moved_entry.txt"), "x");
			await Bun.write(tempDir.join("moved", "new_pkg", "AGENTS.md"), "new");

			session.sessionManager.setCwdWithoutRelocation(tempDir.join("moved"));
			await session.refreshBaseSystemPrompt();

			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain("moved_entry.txt");
			expect(prompt).toContain("new_pkg/AGENTS.md");
			expect(prompt).not.toContain("original_entry.txt");
			expect(prompt).not.toContain("old_pkg/AGENTS.md");
		});
	});

	it("never replaces a caller-supplied tree with a scan", async () => {
		const supplied: WorkspaceTree = {
			rootPath: "/synthetic",
			rendered: ".\n  - supplied_entry.txt",
			truncated: false,
			totalLines: 2,
			agentsMdFiles: [],
		};
		await withTreeSession(
			async (session, tempDir) => {
				expect(await session.resetSessionContext()).toBeTruthy();
				await fs.mkdir(tempDir.join("moved"));
				session.sessionManager.setCwdWithoutRelocation(tempDir.join("moved"));
				await session.refreshBaseSystemPrompt();

				const prompt = session.systemPrompt.join("\n");
				expect(prompt).toContain("supplied_entry.txt");
				expect(prompt).not.toContain("original_entry.txt");
			},
			{ workspaceTree: supplied, expectInitial: "supplied_entry.txt" },
		);
	});
});
