import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { type Api, type AssistantMessage, type Context, clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { Skill } from "@oh-my-pi/pi-coding-agent/sdk";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";
import { createAssistantMessage } from "./helpers/agent-session-setup";

import { cfgAutolearnEnabled } from "@oh-my-pi/pi-coding-agent/autolearn/settings";
import { cfgSkillsCustomDirectories } from "@oh-my-pi/pi-coding-agent/extensibility/settings";

function createIsolatedSkillsSettings(extensions: string[] = []): Settings {
	return Settings.isolated({
		"skills.enabled": true,
		"skills.enableCodexUser": false,
		"skills.enableClaudeUser": false,
		"skills.enableClaudeProject": false,
		"skills.enablePiUser": false,
		"skills.enablePiProject": true,
		extensions,
	});
}

function createExtensionSkill(packageDir: string, skillName: string): void {
	fs.mkdirSync(path.join(packageDir, "skills", skillName), { recursive: true });
	fs.writeFileSync(
		path.join(packageDir, "package.json"),
		JSON.stringify({ name: path.basename(packageDir), omp: { extensions: ["./extension.ts"] } }),
	);
	fs.writeFileSync(path.join(packageDir, "extension.ts"), "export default function extension() {}\n");
	fs.writeFileSync(
		path.join(packageDir, "skills", skillName, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: SDK extension package skill\n---\nbody\n`,
	);
}

describe("createAgentSession skills option", () => {
	let tempDir: string;
	let skillsDir: string;
	let tempHomeDir = "";
	let originalHome: string | undefined;
	// Auth storage (SQLite DB) and the model registry are immutable across these tests: skill
	// discovery never touches models, and building them per test would make createAgentSession call
	// modelRegistry.refreshInBackground(), whose online model discovery saturates the event loop and
	// serializes the otherwise-parallel capability scans (~340ms/call). Supplying a prebuilt registry
	// skips that refresh entirely (~24ms/call).
	let sharedDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-skills-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		// Create skill in .omp/skills/ for native project-level discovery
		skillsDir = path.join(tempDir, ".omp", "skills", "test-skill");
		fs.mkdirSync(skillsDir, { recursive: true });
		originalHome = process.env.HOME;
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-home-"));
		process.env.HOME = tempHomeDir;
		const nativeUserSkillsDir = path.join(tempHomeDir, ".omp", "agent", "skills");
		fs.mkdirSync(nativeUserSkillsDir, { recursive: true });

		// Create a test skill in the pi skills directory
		fs.writeFileSync(
			path.join(skillsDir, "SKILL.md"),
			`---
name: test-skill
description: A test skill for SDK tests.
---

# Test Skill

This is a test skill.
`,
		);

		const externalSkillDir = path.join(tempDir, "external-symlinked-skill");
		fs.mkdirSync(externalSkillDir, { recursive: true });
		fs.writeFileSync(
			path.join(externalSkillDir, "SKILL.md"),
			`---
name: symlinked-skill
description: Skill loaded through a symlink.
---

# Symlinked Skill

Loaded via symbolic link.
`,
		);
		fs.symlinkSync(externalSkillDir, path.join(path.dirname(skillsDir), "symlinked-skill-link"), "dir");
	});

	// Every session binds process state (discovery toggles, effects, the shared-LSP mode) until disposed.
	const sessions: AgentSession[] = [];
	const createSession = async (options: Parameters<typeof createAgentSession>[0]) => {
		const created = await createAgentSession(options);
		sessions.push(created.session);
		return created;
	};
	const removeTempHome = cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome }));

	const captureSkillRequests = (
		respond: (requestIndex: number) => AssistantMessage = () => createAssistantMessage("ok"),
	) => {
		const api = "test-sdk-skill-notices";
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled skill-notice test model");
		const model = { ...bundled, api: api as Api, provider: "sdk-skill-notices" };
		const requests: Context[] = [];
		sharedAuthStorage.keys.setRuntime(model.provider, "test-key");
		registerCustomApi(api, (_model, context) => {
			requests.push({ ...context, messages: structuredClone(context.messages) });
			const message = respond(requests.length - 1);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
				else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
			});
			return stream;
		});
		return { model, requests };
	};

	const skillNotices = (request: Context | undefined): string[] =>
		(request?.messages ?? [])
			.map(message =>
				typeof message.content === "string"
					? message.content
					: message.content
							.flatMap(part => (part.type === "text" && "text" in part ? [part.text] : []))
							.join("\n"),
			)
			.filter(text => text.includes('<system-notice id="skill-delta">'));

	afterEach(async () => {
		clearCustomApis();
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) {
			if (!session.isDisposed) await session.dispose();
		}
		removeTempHome();
	});

	it("should discover skills by default and expose them on session.skills", async () => {
		const { session } = await createSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		// Skills should be discovered and exposed on the session
		expect(session.skills.length).toBeGreaterThan(0);
		expect(session.skills.some((s: Skill) => s.name === "test-skill")).toBe(true);
	});

	it("SDK invocation root scope isolates disabled discovery and merges normal discovery", async () => {
		const explicitPackage = path.join(tempDir, "sdk-explicit-extension");
		const settingsPackage = path.join(tempDir, "sdk-settings-extension");
		const installedPackage = path.join(tempHomeDir, ".omp", "plugins", "node_modules", "sdk-installed-extension");
		createExtensionSkill(explicitPackage, "sdk-explicit-skill");
		createExtensionSkill(settingsPackage, "sdk-settings-skill");
		createExtensionSkill(installedPackage, "sdk-installed-skill");
		fs.mkdirSync(path.join(tempHomeDir, ".omp", "plugins"), { recursive: true });
		fs.writeFileSync(
			path.join(tempHomeDir, ".omp", "plugins", "package.json"),
			JSON.stringify({ name: "omp-plugins", dependencies: { "sdk-installed-extension": "1.0.0" } }),
		);

		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempHomeDir, ".omp", "agent"));
		const baseSessionOptions = {
			cwd: tempDir,
			agentDir: path.join(tempHomeDir, ".omp", "agent"),
			modelRegistry: sharedModelRegistry,
			additionalExtensionPaths: [explicitPackage],
			enableMCP: false,
			enableLsp: false,
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
		};
		let session: AgentSession | undefined;
		try {
			({ session } = await createSession({
				...baseSessionOptions,
				sessionManager: SessionManager.inMemory(),
				settings: createIsolatedSkillsSettings([settingsPackage]),
				disableExtensionDiscovery: true,
			}));

			const isolatedSkillNames = session.skills.map(skill => skill.name);
			expect(isolatedSkillNames).toContain("sdk-explicit-skill");
			expect(isolatedSkillNames).not.toEqual(expect.arrayContaining(["sdk-settings-skill", "sdk-installed-skill"]));

			await session.dispose();
			session = undefined;
			({ session } = await createSession({
				...baseSessionOptions,
				sessionManager: SessionManager.inMemory(),
				settings: createIsolatedSkillsSettings([settingsPackage]),
			}));

			const mergedSkillNames = session.skills.map(skill => skill.name);
			expect(mergedSkillNames).toEqual(expect.arrayContaining(["sdk-explicit-skill", "sdk-settings-skill"]));
		} finally {
			await session?.dispose();
			setAgentDir(previousAgentDir);
		}
	});

	it("should discover skills when skill directory is a symlink", async () => {
		const { session } = await createSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "symlinked-skill")).toBe(true);
	});

	it("should still discover project skills when user skills directory is missing", async () => {
		const userAgentDir = path.join(tempHomeDir, ".omp", "agent");
		removeSyncWithRetries(path.join(userAgentDir, "skills"));
		fs.writeFileSync(path.join(userAgentDir, "placeholder.txt"), "placeholder");

		const { session } = await createSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "test-skill")).toBe(true);
	});

	it("refreshSkills reloads project skills on an existing session", async () => {
		const { session } = await createSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "runtime-added-skill")).toBe(false);

		const runtimeSkillDir = path.join(tempDir, ".omp", "skills", "runtime-added-skill");
		fs.mkdirSync(runtimeSkillDir, { recursive: true });
		fs.writeFileSync(
			path.join(runtimeSkillDir, "SKILL.md"),
			`---
name: runtime-added-skill
description: Added after the session is created.
---

# Runtime Added Skill

This skill is added after session creation.
`,
		);

		await session.refreshSkills();

		expect(session.skills.some((s: Skill) => s.name === "runtime-added-skill")).toBe(true);

		removeSyncWithRetries(runtimeSkillDir);

		await session.refreshSkills();

		expect(session.skills.some((s: Skill) => s.name === "runtime-added-skill")).toBe(false);
	});

	it("a live skills.customDirectories edit exposes the directory's skills without restart", async () => {
		const settings = createIsolatedSkillsSettings();
		const { session } = await createSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings,
		});
		const customDir = path.join(tempDir, "live-custom-skills");
		fs.mkdirSync(path.join(customDir, "live-custom-skill"), { recursive: true });
		fs.writeFileSync(
			path.join(customDir, "live-custom-skill", "SKILL.md"),
			"---\nname: live-custom-skill\ndescription: Added through a live settings edit.\n---\nbody\n",
		);
		expect(session.skills.some((s: Skill) => s.name === "live-custom-skill")).toBe(false);

		// Command pickers (TUI autocomplete, RPC/ACP) rebuild on this notification.
		const skillAnnounced = Promise.withResolvers<void>();
		const unsubscribe = session.subscribeCommandMetadataChanged(() => {
			if (session.skills.some((s: Skill) => s.name === "live-custom-skill")) skillAnnounced.resolve();
		});
		cfgSkillsCustomDirectories.set(settings, [customDir]);
		await skillAnnounced.promise;
		unsubscribe();

		expect(session.systemPrompt.join("\n")).toContain("live-custom-skill");
	});

	it("manage_skill hot-registers managed skills in the active session", async () => {
		const originalAgentDir = getAgentDir();
		const managedAgentDir = path.join(tempHomeDir, ".omp", "agent");
		setAgentDir(managedAgentDir);
		const settings = createIsolatedSkillsSettings();
		cfgAutolearnEnabled.set(settings, true);
		const { model, requests } = captureSkillRequests();
		const { session } = await createSession({
			cwd: tempDir,
			agentDir: managedAgentDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings,
			model,
			enableMCP: false,
			enableLsp: false,
		});
		let commandMetadataChanges = 0;
		const unsubscribeCommandMetadata = session.subscribeCommandMetadataChanged(() => {
			commandMetadataChanges++;
		});

		try {
			await session.sendUserMessage("Start the session before creating a skill.");
			const initialPrompt = [...session.agent.state.systemPrompt];
			const initialCacheKey = session.agent.promptCacheKey;
			const manageSkill = session.getToolByName("manage_skill");
			expect(manageSkill).toBeDefined();
			await manageSkill!.execute("manage-skill-create", {
				action: "create",
				name: "runtime-managed-skill",
				description: "Created by manage_skill during the session.",
				body: "# Runtime Managed Skill\n\nUse this immediately.",
			});

			expect(session.skills.some(skill => skill.name === "runtime-managed-skill")).toBe(true);
			expect(commandMetadataChanges).toBe(1);
			expect(getActiveSkills().some(skill => skill.name === "runtime-managed-skill")).toBe(true);
			expect(session.agent.state.systemPrompt).toEqual(initialPrompt);
			expect(session.agent.promptCacheKey).toBe(initialCacheKey);
			const readSkill = session.getToolByName("read");
			expect(readSkill).toBeDefined();
			const readResult = await readSkill!.execute("read-managed-skill", { path: "skill://runtime-managed-skill" });
			expect(
				readResult.content.some(part => part.type === "text" && part.text.includes("# Runtime Managed Skill")),
			).toBe(true);
			await session.sendUserMessage("Use the newly available skill.");
			expect(skillNotices(requests.at(-1))).toHaveLength(1);
			expect(skillNotices(requests.at(-1))[0]).toContain("runtime-managed-skill");
			expect(skillNotices(requests.at(-1))[0]).toContain("Created by manage_skill during the session.");
			await session.sendUserMessage("Continue without changing skills.");
			expect(skillNotices(requests.at(-1))).toHaveLength(1);

			// Body-only updates must announce a change even when the listing text is identical.
			await manageSkill!.execute("manage-skill-update", {
				action: "update",
				name: "runtime-managed-skill",
				description: "Created by manage_skill during the session.",
				body: "# Revised Runtime Managed Skill\n\nUse the revised procedure.",
			});
			expect(session.agent.state.systemPrompt).toEqual(initialPrompt);
			await session.sendUserMessage("Use the updated procedure.");
			expect(skillNotices(requests.at(-1))).toHaveLength(2);

			await manageSkill!.execute("manage-skill-delete", {
				action: "delete",
				name: "runtime-managed-skill",
			});
			expect(session.skills.some(skill => skill.name === "runtime-managed-skill")).toBe(false);
			expect(getActiveSkills().some(skill => skill.name === "runtime-managed-skill")).toBe(false);
			expect(session.agent.state.systemPrompt).toEqual(initialPrompt);
			expect(session.agent.promptCacheKey).toBe(initialCacheKey);
			expect(commandMetadataChanges).toBe(3);
			await expect(
				readSkill!.execute("read-deleted-managed-skill", { path: "skill://runtime-managed-skill" }),
			).rejects.toThrow(/Unknown skill/);
			expect(session.agent.state.systemPrompt).toEqual(initialPrompt);
			await session.sendUserMessage("Continue after deleting the skill.");
			expect(skillNotices(requests.at(-1))).toHaveLength(3);
			expect(skillNotices(requests.at(-1)).at(-1)).toContain("No longer available; do not load:");
			expect(skillNotices(requests.at(-1)).at(-1)).toContain("runtime-managed-skill");

			await manageSkill!.execute("transient-create", {
				action: "create",
				name: "transient-managed-skill",
				description: "Never announced.",
				body: "Temporary procedure.",
			});
			await manageSkill!.execute("transient-delete", { action: "delete", name: "transient-managed-skill" });
			await session.sendUserMessage("Continue after a cancelled skill delta.");
			expect(skillNotices(requests.at(-1))).toHaveLength(3);

			await manageSkill!.execute("catchup-create", {
				action: "create",
				name: "catchup-managed-skill",
				description: "Absorbed by an unrelated prompt rebuild.",
				body: "A persistent procedure.",
			});
			await session.refreshBaseSystemPrompt();
			expect(session.agent.state.systemPrompt.join("\n")).toContain("catchup-managed-skill");
			await session.sendUserMessage("Continue with the refreshed base.");
			expect(skillNotices(requests.at(-1))).toHaveLength(3);
			// Old delivered add/update notices must not resurrect the deleted skill
			// in the new base's knowledge snapshot.
			await session.sendUserMessage("Continue again.");
			expect(skillNotices(requests.at(-1))).toHaveLength(3);
		} finally {
			await session.dispose();
			unsubscribeCommandMetadata();
			setAgentDir(originalAgentDir);
		}
	});

	it("re-announces skill deltas after compaction until a base rebuild absorbs them", async () => {
		const originalAgentDir = getAgentDir();
		const managedAgentDir = path.join(tempHomeDir, ".omp", "agent");
		setAgentDir(managedAgentDir);
		const { model, requests } = captureSkillRequests();
		const settings = Settings.isolated({
			"skills.enabled": true,
			"skills.enableCodexUser": false,
			"skills.enableClaudeUser": false,
			"skills.enableClaudeProject": false,
			"skills.enablePiUser": false,
			"skills.enablePiProject": true,
			"autolearn.enabled": true,
			"compaction.enabled": false,
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["soft"],
			"compaction.experimentalContextManagement": false,
		});
		const { session } = await createSession({
			cwd: tempDir,
			agentDir: managedAgentDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings,
			model,
			enableMCP: false,
			enableLsp: false,
		});
		try {
			await session.sendUserMessage("Start a session with a cached catalog.");
			const initialPrompt = [...session.agent.state.systemPrompt];
			const manageSkill = session.getToolByName("manage_skill")!;
			await manageSkill.execute("compaction-skill-create", {
				action: "create",
				name: "compaction-managed-skill",
				description: "A skill absent from the cached base.",
				body: "Keep this procedure available after compaction.",
			});
			await session.sendUserMessage("Use the skill before compaction.");
			const originalNotice = session.agent.state.messages.find(
				message => message.role === "custom" && message.customType === "skill-delta-notice",
			);
			expect(originalNotice).toBeDefined();
			await session.sendUserMessage("A later turn keeps the original notice outside the retained tail.");
			const compact = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
				summary: "Compacted conversation.",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}));
			await session.compact();
			expect(compact).toHaveBeenCalledTimes(1);
			expect(session.agent.state.systemPrompt).toEqual(initialPrompt);
			// The replacement summary deliberately carries no skill knowledge, and
			// compaction itself leaves the history tail untouched: the delta is
			// re-derived with the next prompt instead.
			expect(
				session.agent.state.messages.filter(
					message => message.role === "custom" && message.customType === "skill-delta-notice",
				),
			).toHaveLength(0);
			await session.sendUserMessage("Continue with the compacted context.");
			expect(skillNotices(requests.at(-1))).toHaveLength(1);
			expect(skillNotices(requests.at(-1))[0]).toContain("compaction-managed-skill");

			await session.refreshBaseSystemPrompt();
			expect(session.systemPrompt.join("\n")).toContain("compaction-managed-skill");
			await session.sendUserMessage("The new base absorbs the delivered delta.");
			expect(skillNotices(requests.at(-1))).toHaveLength(1);
			await manageSkill.execute("compaction-skill-delete", { action: "delete", name: "compaction-managed-skill" });
			await session.sendUserMessage("The rebuilt catalog's skill is now unavailable.");
			expect(skillNotices(requests.at(-1))).toHaveLength(2);
			expect(skillNotices(requests.at(-1)).at(-1)).toContain("No longer available; do not load:");
			await session.refreshBaseSystemPrompt();
			await session.sendUserMessage("Do not replay stale notices from an older base.");
			expect(skillNotices(requests.at(-1))).toHaveLength(2);
		} finally {
			await session.dispose();
			setAgentDir(originalAgentDir);
		}
	});

	it("drops the overflowed turn before retrying when a skill delta is pending", async () => {
		const originalAgentDir = getAgentDir();
		const managedAgentDir = path.join(tempHomeDir, ".omp", "agent");
		setAgentDir(managedAgentDir);
		// The model writes a skill mid-turn, then the follow-up request overflows,
		// so the auto-compaction retry runs with an undelivered skill delta.
		const { model, requests } = captureSkillRequests(requestIndex => {
			if (requestIndex === 2) {
				return {
					...createAssistantMessage(""),
					content: [
						{
							type: "toolCall",
							id: "overflow-skill-create",
							name: "manage_skill",
							arguments: {
								action: "create",
								name: "overflow-managed-skill",
								description: "A skill written in the overflowing turn.",
								body: "Written right before the context overflowed.",
							},
						},
					],
					stopReason: "toolUse",
				};
			}
			if (requestIndex === 3) {
				return {
					...createAssistantMessage(""),
					api: "test-sdk-skill-notices",
					provider: "sdk-skill-notices",
					model: "claude-sonnet-4-5",
					stopReason: "error",
					errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
					usage: { ...createAssistantMessage("").usage, input: 250_000, totalTokens: 250_000 },
				};
			}
			return createAssistantMessage("ok");
		});
		const settings = Settings.isolated({
			"skills.enabled": true,
			"skills.enableCodexUser": false,
			"skills.enableClaudeUser": false,
			"skills.enableClaudeProject": false,
			"skills.enablePiUser": false,
			"skills.enablePiProject": true,
			"autolearn.enabled": true,
			"compaction.enabled": true,
			"compaction.keepRecentTokens": 1,
			"compaction.methodOrder": ["soft"],
			"compaction.experimentalContextManagement": false,
		});
		const { session } = await createSession({
			cwd: tempDir,
			agentDir: managedAgentDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings,
			model,
			enableMCP: false,
			enableLsp: false,
		});
		try {
			vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
				summary: "Compacted conversation.",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}));
			let retryTail: { role: string; stopReason?: string; customType?: string }[] | undefined;
			session.subscribe(event => {
				if (event.type !== "auto_compaction_end" || !event.willRetry) return;
				retryTail = session.agent.state.messages.map(message => ({
					role: message.role,
					stopReason: message.role === "assistant" ? message.stopReason : undefined,
					customType: message.role === "custom" ? message.customType : undefined,
				}));
			});
			// Older turns large enough that summarizing them reduces context.
			await session.sendUserMessage(`Start a session. ${"lorem ipsum ".repeat(4000)}`);
			await session.sendUserMessage(`Build up history. ${"lorem ipsum ".repeat(4000)}`);
			await session.sendUserMessage("Write a skill, then keep going.");
			await session.waitForIdle();

			expect(retryTail).toBeDefined();
			expect(retryTail!.filter(message => message.stopReason === "error")).toHaveLength(0);
			expect(retryTail!.at(-1)?.role).toBe("toolResult");
			expect(retryTail!.some(message => message.customType === "skill-delta-notice")).toBe(false);
			// The retry request resumes from the tool result, and the delta still
			// reaches the model with the next prompt.
			expect(requests.length).toBeGreaterThan(4);
			await session.sendUserMessage("Continue after the retry.");
			expect(skillNotices(requests.at(-1)).join("\n")).toContain("overflow-managed-skill");
		} finally {
			await session.dispose();
			setAgentDir(originalAgentDir);
		}
	});

	it("learn hot-registers minted managed skills in the active session", async () => {
		const originalAgentDir = getAgentDir();
		const managedAgentDir = path.join(tempHomeDir, ".omp", "agent");
		setAgentDir(managedAgentDir);
		const settings = Settings.isolated({
			"skills.enabled": true,
			"skills.enableCodexUser": false,
			"skills.enableClaudeUser": false,
			"skills.enableClaudeProject": false,
			"skills.enablePiUser": false,
			"skills.enablePiProject": true,
			"autolearn.enabled": true,
			"memory.backend": "local",
		});
		const { model, requests } = captureSkillRequests();
		const { session } = await createSession({
			cwd: tempDir,
			agentDir: managedAgentDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings,
			model,
			enableMCP: false,
			enableLsp: false,
		});

		try {
			await session.sendUserMessage("Start the session before learning a procedure.");
			const initialPrompt = [...session.agent.state.systemPrompt];
			const initialCacheKey = session.agent.promptCacheKey;
			const learn = session.getToolByName("learn");
			expect(learn).toBeDefined();
			await learn!.execute("learn-skill-create", {
				memory: "Use learned-managed-skill immediately in the same session.",
				skill: {
					action: "create",
					name: "learned-managed-skill",
					description: "Minted by learn during the active session.",
					body: "# Learned Managed Skill\n\nAvailable immediately via skill://.",
				},
			});

			expect(session.skills.some(skill => skill.name === "learned-managed-skill")).toBe(true);
			expect(getActiveSkills().some(skill => skill.name === "learned-managed-skill")).toBe(true);
			expect(session.agent.state.systemPrompt).toEqual(initialPrompt);
			expect(session.agent.promptCacheKey).toBe(initialCacheKey);
			const readSkill = session.getToolByName("read");
			expect(readSkill).toBeDefined();
			const readResult = await readSkill!.execute("read-learned-skill", { path: "skill://learned-managed-skill" });
			expect(
				readResult.content.some(part => part.type === "text" && part.text.includes("# Learned Managed Skill")),
			).toBe(true);
			await session.sendUserMessage("Use the learned procedure.");
			expect(skillNotices(requests.at(-1))).toHaveLength(1);
			expect(skillNotices(requests.at(-1))[0]).toContain("learned-managed-skill");
			expect(skillNotices(requests.at(-1))[0]).toContain("Minted by learn during the active session.");
			const manageSkill = session.getToolByName("manage_skill")!;
			await manageSkill.execute("delete-learned-skill", { action: "delete", name: "learned-managed-skill" });
			expect(session.agent.state.systemPrompt).toEqual(initialPrompt);
			await expect(
				readSkill!.execute("read-deleted-learned-skill", { path: "skill://learned-managed-skill" }),
			).rejects.toThrow(/Unknown skill/);
			await session.sendUserMessage("Continue after removing the learned procedure.");
			expect(skillNotices(requests.at(-1))).toHaveLength(2);
			expect(skillNotices(requests.at(-1)).at(-1)).toContain("No longer available; do not load:");
			expect(skillNotices(requests.at(-1)).at(-1)).toContain("learned-managed-skill");
		} finally {
			await session.dispose();
			setAgentDir(originalAgentDir);
		}
	});

	it("should have empty skills when options.skills is empty array (--no-skills)", async () => {
		const { session } = await createSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			skills: [], // Explicitly empty - like --no-skills
			settings: createIsolatedSkillsSettings(),
		});

		// session.skills should be empty
		expect(session.skills).toEqual([]);
		// No warnings since we didn't discover
		expect(session.skillWarnings).toEqual([]);
	});

	it("should use provided skills when options.skills is explicitly set", async () => {
		const customSkill: Skill = {
			name: "custom-skill",
			description: "A custom skill",
			filePath: "/fake/path/SKILL.md",
			baseDir: "/fake/path",
			source: "custom" as const,
		};

		const { session } = await createSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			skills: [customSkill],
			settings: createIsolatedSkillsSettings(),
		});

		// session.skills should contain only the provided skill
		expect(session.skills).toEqual([customSkill]);
		// No warnings since we didn't discover
		expect(session.skillWarnings).toEqual([]);
	});
});
