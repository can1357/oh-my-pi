import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { loadAdvisorTranscriptCosts } from "@oh-my-pi/pi-coding-agent/advisor/transcript-recorder";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import * as advisorModule from "../src/advisor";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("AgentSession advisor toggle", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let replacementModel: Model;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		authStorage.setRuntimeApiKey("openrouter", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		const replacement = getBundledModel("openai", "gpt-4o-mini");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		if (!replacement) throw new Error("Expected built-in OpenAI model to exist");
		model = bundled;
		replacementModel = replacement;
	});

	afterAll(() => {
		authStorage.close();
	});

	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-advisor-toggle-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
		});
	});

	afterEach(async () => {
		await session.dispose();
		try {
			await tempDir.remove();
		} catch {}
	});

	function advisorMessage(cost: number, timestamp: number): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "reviewed" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
			},
			stopReason: "stop",
			timestamp,
		};
	}

	function appendAdvisorCost(advisor: Agent, cost: number, timestamp: number): void {
		advisor.emitExternalEvent({ type: "message_end", message: advisorMessage(cost, timestamp) });
	}

	function enableAdvisor(target: AgentSession = session): Agent {
		target.settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		target.toggleAdvisorEnabled();
		const advisor = target.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to exist");
		return advisor;
	}

	/**
	 * Persist advisor turns beside a session file the same way the recorder does,
	 * so the fixture stays valid if the transcript format ever moves.
	 */
	async function writeAdvisorTranscript(sessionFile: string, filename: string, costs: number[]): Promise<void> {
		const dir = sessionFile.slice(0, -".jsonl".length);
		await fs.mkdir(dir, { recursive: true });
		const manager = await SessionManager.open(path.join(dir, filename), undefined, undefined, {
			initialCwd: dir,
			suppressBreadcrumb: true,
		});
		try {
			for (const [index, cost] of costs.entries()) manager.appendMessage(advisorMessage(cost, index + 1));
		} finally {
			await manager.close();
		}
	}

	function prepareHandoffConversation(advisor: Agent): void {
		sessionManager.appendMessage({ role: "user", content: "work to hand off", timestamp: 1 });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		session.agent.replaceMessages(sessionManager.buildSessionContext().messages);
		appendAdvisorCost(advisor, 0.5, 1);
	}

	it("starts with advisor disabled", () => {
		expect(session.isAdvisorActive()).toBe(false);
		expect(session.isAdvisorEnabled()).toBe(false);
		expect(session.formatAdvisorStatus()).toBe("Advisor is disabled.");
	});

	it("toggle enables the advisor and runtime", () => {
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const active = session.toggleAdvisorEnabled();
		expect(active).toBe(true);
		expect(session.isAdvisorActive()).toBe(true);
		expect(session.isAdvisorEnabled()).toBe(true);
		expect(session.formatAdvisorStatus()).toContain("Advisor is enabled (anthropic/claude-sonnet-4-5)");
	});

	it("explicit enable rebuilds the runtime when the advisor role changes", () => {
		session.settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		expect(session.setAdvisorEnabled(true)).toBe(true);
		expect(session.getAdvisorAgent()?.state.model.provider).toBe(model.provider);
		expect(session.getAdvisorAgent()?.state.model.id).toBe(model.id);

		session.settings.setModelRole("advisor", `${replacementModel.provider}/${replacementModel.id}`);
		expect(session.setAdvisorEnabled(true)).toBe(true);

		expect(session.getAdvisorAgent()?.state.model.provider).toBe(replacementModel.provider);
		expect(session.getAdvisorAgent()?.state.model.id).toBe(replacementModel.id);
	});

	it("refreshes the live advisor when the advisor role setting changes", () => {
		session.settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		expect(session.setAdvisorEnabled(true)).toBe(true);
		expect(session.getAdvisorAgent()?.state.model.provider).toBe(model.provider);
		expect(session.getAdvisorAgent()?.state.model.id).toBe(model.id);

		session.settings.setModelRole("advisor", `${replacementModel.provider}/${replacementModel.id}`);

		expect(session.getAdvisorAgent()?.state.model.provider).toBe(replacementModel.provider);
		expect(session.getAdvisorAgent()?.state.model.id).toBe(replacementModel.id);
	});

	it("refreshes the live advisor when only the advisor route changes", () => {
		session.settings.setModelRole("advisor", "openrouter/z-ai/glm-4.7@cerebras");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		expect(session.getAdvisorAgent()?.state.model.provider).toBe("openrouter");
		expect(session.getAdvisorAgent()?.state.model.id).toBe("z-ai/glm-4.7");
		expect(
			(session.getAdvisorAgent()?.state.model.compat as { openRouterRouting?: { only?: string[] } } | undefined)
				?.openRouterRouting?.only,
		).toEqual(["cerebras"]);

		session.settings.setModelRole("advisor", "openrouter/z-ai/glm-4.7@fireworks");

		expect(session.getAdvisorAgent()?.state.model.provider).toBe("openrouter");
		expect(session.getAdvisorAgent()?.state.model.id).toBe("z-ai/glm-4.7");
		expect(
			(session.getAdvisorAgent()?.state.model.compat as { openRouterRouting?: { only?: string[] } } | undefined)
				?.openRouterRouting?.only,
		).toEqual(["fireworks"]);
	});

	it("refreshes the live advisor after project model-role reloads", async () => {
		const projectA = path.join(tempDir.path(), "project-a");
		const projectB = path.join(tempDir.path(), "project-b");
		const agentDir = path.join(tempDir.path(), "agent");
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(getProjectAgentDir(projectA), "settings.json"),
			JSON.stringify({ modelRoles: { advisor: `${model.provider}/${model.id}` } }),
		);
		await Bun.write(
			path.join(getProjectAgentDir(projectB), "settings.json"),
			JSON.stringify({ modelRoles: { advisor: `${replacementModel.provider}/${replacementModel.id}` } }),
		);

		const settings = await Settings.loadIsolated({
			cwd: projectA,
			agentDir,
			overrides: { "compaction.enabled": false },
		});
		const customSession = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
			advisorTools: [],
		});

		try {
			expect(customSession.setAdvisorEnabled(true)).toBe(true);
			expect(customSession.getAdvisorAgent()?.state.model.provider).toBe(model.provider);
			expect(customSession.getAdvisorAgent()?.state.model.id).toBe(model.id);

			await settings.reloadForCwd(projectB);

			expect(customSession.getAdvisorAgent()?.state.model.provider).toBe(replacementModel.provider);
			expect(customSession.getAdvisorAgent()?.state.model.id).toBe(replacementModel.id);
		} finally {
			await customSession.dispose();
			AgentStorage.close();
		}
	});

	it("keeps explicit enable idempotent when the advisor config is unchanged", () => {
		session.settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");
		const historyMessage: AgentMessage = { role: "user", content: "prior advisor context", timestamp: 1 };
		advisor.state.messages.push(historyMessage);

		expect(session.setAdvisorEnabled(true)).toBe(true);

		expect(session.getAdvisorAgent()).toBe(advisor);
		expect(session.getAdvisorAgent()?.state.messages).toEqual([historyMessage]);
	});

	it("explicit enable overrides default-off setting for the session only", () => {
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		session.settings.override("advisor.enabled", false);
		const customSession = new AgentSession({
			agent: session.agent,
			sessionManager,
			settings: session.settings,
			modelRegistry,
			advisorTools: [],
		});
		expect(customSession.isAdvisorEnabled()).toBe(false);

		const active = customSession.setAdvisorEnabled(true);

		expect(active).toBe(true);
		expect(customSession.isAdvisorActive()).toBe(true);
		expect(customSession.isAdvisorEnabled()).toBe(true);
		expect(customSession.settings.get("advisor.enabled")).toBe(false);
	});

	it("toggle disables the advisor and runtime", () => {
		session.settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		session.toggleAdvisorEnabled();
		const active = session.toggleAdvisorEnabled();
		expect(active).toBe(false);
		expect(session.isAdvisorActive()).toBe(false);
		expect(session.isAdvisorEnabled()).toBe(false);
	});

	it("setAdvisorEnabled reports inactive when the advisor role resolves to no model", () => {
		// The advisor role falls back to the `slow` priority chain when unset, so an
		// unset role still resolves a model. The inactive-but-enabled path is only
		// reached when the configured advisor model cannot be resolved at all.
		session.settings.setModelRole("advisor", "nonexistent/advisor-model");
		const active = session.setAdvisorEnabled(true);
		expect(active).toBe(false);
		expect(session.isAdvisorActive()).toBe(false);
		expect(session.isAdvisorEnabled()).toBe(true);
		expect(session.formatAdvisorStatus()).toBe(
			"Advisor setting is enabled, but no model is assigned to the 'advisor' role.",
		);
	});

	it("activates an enabled advisor once background model discovery settles", async () => {
		// Advisor role points at a valid model that is missing from the catalog at
		// construction (discovery-backed provider still loading), so the advisor
		// starts `no_model`. Regression for the startup ordering race in #9010.
		const advisorSelector = `${replacementModel.provider}/${replacementModel.id}`;
		const settings = Settings.isolated({ "compaction.enabled": false, "advisor.enabled": true });
		settings.setModelRole("advisor", advisorSelector);

		const fullCatalog = modelRegistry.getAvailable();
		const withoutAdvisorModel = fullCatalog.filter(
			m => !(m.provider === replacementModel.provider && m.id === replacementModel.id),
		);
		let discovered = false;
		vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() =>
			discovered ? fullCatalog : withoutAdvisorModel,
		);
		const { promise: refreshSettled, resolve: settleRefresh } = Promise.withResolvers<void>();
		vi.spyOn(modelRegistry, "awaitBackgroundRefresh").mockImplementation(() => refreshSettled);

		const raceSession = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
		});

		// The retry emits `model_changed` once it rebuilds; await that signal
		// rather than a wall-clock delay so the test tracks the real event.
		const { promise: advisorRebuilt, resolve: signalRebuilt } = Promise.withResolvers<void>();
		const unsubscribe = raceSession.subscribe(event => {
			if (event.type === "model_changed") signalRebuilt();
		});
		try {
			expect(raceSession.isAdvisorEnabled()).toBe(true);
			expect(raceSession.isAdvisorActive()).toBe(false);

			// Discovery completes and the background refresh settles: the advisor
			// rebuilds against the now-complete catalog and goes live.
			discovered = true;
			settleRefresh();
			await advisorRebuilt;
			expect(raceSession.isAdvisorActive()).toBe(true);
		} finally {
			unsubscribe();
			vi.restoreAllMocks();
			await raceSession.dispose();
		}
	});

	it("keeps sessions isolated when sharing a Settings instance", async () => {
		const sharedSettings = Settings.isolated({ "compaction.enabled": false });
		sharedSettings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(sharedSettings.get("advisor.enabled")).toBe(false);

		const sessionA = new AgentSession({
			agent: session.agent,
			sessionManager,
			settings: sharedSettings,
			modelRegistry,
			advisorTools: [],
		});
		const sessionB = new AgentSession({
			agent: session.agent,
			sessionManager,
			settings: sharedSettings,
			modelRegistry,
			advisorTools: [],
		});

		expect(sessionA.isAdvisorEnabled()).toBe(false);
		expect(sessionB.isAdvisorEnabled()).toBe(false);

		const activeA = sessionA.setAdvisorEnabled(true);
		expect(activeA).toBe(true);
		expect(sessionA.isAdvisorEnabled()).toBe(true);
		expect(sessionA.isAdvisorActive()).toBe(true);

		expect(sessionB.isAdvisorEnabled()).toBe(false);
		expect(sessionB.isAdvisorActive()).toBe(false);
		expect(sessionB.formatAdvisorStatus()).toBe("Advisor is disabled.");

		const activeB = sessionB.toggleAdvisorEnabled();
		expect(activeB).toBe(true);
		expect(sessionB.isAdvisorEnabled()).toBe(true);

		sessionA.setAdvisorEnabled(false);
		expect(sessionA.isAdvisorEnabled()).toBe(false);
		expect(sessionA.isAdvisorActive()).toBe(false);

		expect(sessionB.isAdvisorEnabled()).toBe(true);
		expect(sessionB.isAdvisorActive()).toBe(true);
	});

	it("exposes provider sessionId on live advisor stats", () => {
		session.settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		session.toggleAdvisorEnabled();

		const stats = session.getAdvisorStats();
		expect(stats.advisors).toHaveLength(1);
		const sid = stats.advisors[0].sessionId!;
		// Full UUIDv7 — must not contain the display-label "-advisor" suffix
		expect(sid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		expect(sid).not.toContain("-advisor");
	});
	it("retains cumulative advisor cost after the advisor is disabled", () => {
		const advisor = enableAdvisor();

		appendAdvisorCost(advisor, 0.41, 1);
		appendAdvisorCost(advisor, 0.09, 2);

		expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);
		session.setAdvisorEnabled(false);
		expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);
	});
	it("attributes advisor subscription spend after teardown without rescanning the catalog", () => {
		// #10131: with the runtime gone, isUsingSubscription() must read the
		// attribution captured as spend accrued, not fall back to a per-render
		// getAvailable() catalog scan (which reads credential files per provider).
		const oauthSpy = vi.spyOn(modelRegistry, "isUsingOAuth").mockReturnValue(true);
		try {
			const advisor = enableAdvisor();
			appendAdvisorCost(advisor, 0.5, 1);
			session.setAdvisorEnabled(false);
			expect(session.isAdvisorActive()).toBe(false);
			expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);

			const scanSpy = vi.spyOn(modelRegistry, "getAvailable");
			expect(session.isAdvisorUsingSubscription()).toBe(true);
			expect(scanSpy).not.toHaveBeenCalled();
			scanSpy.mockRestore();
		} finally {
			oauthSpy.mockRestore();
		}
	});
	it("does not attribute paid spend to a subscription after a zero-cost OAuth turn", () => {
		let usingOAuth = false;
		const oauthSpy = vi.spyOn(modelRegistry, "isUsingOAuth").mockImplementation(() => usingOAuth);
		try {
			const advisor = enableAdvisor();
			appendAdvisorCost(advisor, 0.5, 1);
			usingOAuth = true;
			appendAdvisorCost(advisor, 0, 2);
			session.setAdvisorEnabled(false);

			expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);
			expect(session.isAdvisorUsingSubscription()).toBe(false);
		} finally {
			oauthSpy.mockRestore();
		}
	});
	it("retains total advisor cost after the live roster changes", () => {
		const advisor = enableAdvisor();
		appendAdvisorCost(advisor, 0.5, 1);

		expect(session.applyAdvisorConfigs([{ name: "Security" }], undefined)).toBe(1);
		expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);
		expect(session.formatAdvisorStatus()).toContain("$0.5000");
	});
	it("retains cumulative advisor cost after an in-session history rewrite", async () => {
		const advisor = enableAdvisor();
		appendAdvisorCost(advisor, 0.5, 1);
		sessionManager.appendMessage({
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "image", data: "iVBORw0KGgo", mimeType: "image/png" },
			],
			timestamp: 2,
		});

		expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);
		expect(await session.dropImages()).toEqual({ removed: 1 });
		expect(advisor.state.messages).toHaveLength(0);
		expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);
		expect(session.getAdvisorStats().cost).toBeCloseTo(0.5, 8);
		expect(session.formatAdvisorStatus()).toContain("$0.5000");
	});
	it("retains cumulative advisor cost when reloading the same session", async () => {
		const advisor = enableAdvisor();
		appendAdvisorCost(advisor, 0.5, 1);

		await session.reload();

		expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);
	});
	it("restores advisor recording when a session switch fails before reset", async () => {
		const advisor = enableAdvisor();
		appendAdvisorCost(advisor, 0.5, 1);
		const previousSessionFile = sessionManager.getSessionFile();
		const targetSessionFile = SessionManager.createEmptySessionFile(tempDir.path());
		const failure = new Error("switch failed before advisor reset");
		const setSessionFile = sessionManager.setSessionFile.bind(sessionManager);
		vi.spyOn(sessionManager, "setSessionFile").mockImplementation(async file => {
			await setSessionFile(file);
			throw failure;
		});

		await expect(session.switchSession(targetSessionFile)).rejects.toThrow(failure);

		expect(sessionManager.getSessionFile()).toBe(previousSessionFile);
		expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);
		if (!previousSessionFile) throw new Error("Expected the previous session to be persisted");
		appendAdvisorCost(advisor, 0.25, 2);
		expect(session.getAdvisorCost()).toBeCloseTo(0.75, 8);
		await session.dispose();
		expect((await loadAdvisorTranscriptCosts(previousSessionFile)).get("")).toBeCloseTo(0.75, 8);
	});
	it("adopts only the target session's recorded advisor cost after a switch", async () => {
		const advisor = enableAdvisor();
		appendAdvisorCost(advisor, 0.5, 1);
		const targetSessionFile = SessionManager.createEmptySessionFile(tempDir.path());
		await writeAdvisorTranscript(targetSessionFile, "__advisor.jsonl", [0.25]);
		const setSessionFile = sessionManager.setSessionFile.bind(sessionManager);
		vi.spyOn(sessionManager, "setSessionFile").mockImplementation(async file => {
			await setSessionFile(file);
			// Reproduce an old advisor finishing after the target file became active.
			appendAdvisorCost(advisor, 9, 2);
		});

		expect(await session.switchSession(targetSessionFile)).toBe(true);
		expect(session.getAdvisorCost()).toBeCloseTo(0.25, 8);
		await session.dispose();
		expect((await loadAdvisorTranscriptCosts(targetSessionFile)).get("")).toBeCloseTo(0.25, 8);
	});
	it("hydrates persisted advisor cost during SDK session startup", async () => {
		const sessionFile = SessionManager.createEmptySessionFile(tempDir.path());
		await writeAdvisorTranscript(sessionFile, "__advisor.jsonl", [0.5]);
		// A subagent advisor writes one directory deeper; its spend belongs to that
		// subagent and must not inflate the resumed primary conversation.
		await writeAdvisorTranscript(
			path.join(sessionFile.slice(0, -".jsonl".length), "SubAgent.jsonl"),
			"__advisor.jsonl",
			[9],
		);
		const settings = Settings.isolated({
			"async.enabled": false,
			"advisor.enabled": true,
			"compaction.enabled": false,
		});
		settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: await SessionManager.open(sessionFile),
			authStorage,
			modelRegistry,
			settings,
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: tempDir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		try {
			// The scan runs off the critical path now (issue #9553), so await the
			// backfill signal the session exposes rather than a wall-clock guess.
			await result.session.advisorCostRestore;
			expect(result.session.getAdvisorCost()).toBeCloseTo(0.5, 8);
		} finally {
			await result.session.dispose();
		}
	});
	it("seeds persisted advisor spend when no turn has been billed yet", () => {
		enableAdvisor();
		session.restoreInitialAdvisorCosts(new Map([["", 0.5]]));
		expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);
	});
	it("attributes restored advisor spend to a subscription without a catalog scan", () => {
		// #10131 follow-up: with no live runtime, subscription attribution comes
		// from the providers that billed the restored spend, re-derived via the
		// current OAuth credentials — never a per-render getAvailable() scan.
		const oauthSpy = vi.spyOn(authStorage, "hasOAuth").mockImplementation(provider => provider === "anthropic");
		const scanSpy = vi.spyOn(modelRegistry, "getAvailable");
		try {
			session.restoreInitialAdvisorCosts(new Map([["", 0.5]]), new Map(), new Map([["", new Set(["anthropic"])]]));
			expect(session.isAdvisorActive()).toBe(false);
			expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);
			expect(session.isAdvisorUsingSubscription()).toBe(true);
			expect(scanSpy).not.toHaveBeenCalled();
		} finally {
			scanSpy.mockRestore();
			oauthSpy.mockRestore();
		}
	});
	it("does not attribute restored advisor spend to a subscription without OAuth on its provider", () => {
		const oauthSpy = vi.spyOn(authStorage, "hasOAuth").mockReturnValue(false);
		try {
			session.restoreInitialAdvisorCosts(new Map([["", 0.5]]), new Map(), new Map([["", new Set(["anthropic"])]]));
			expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);
			expect(session.isAdvisorUsingSubscription()).toBe(false);
		} finally {
			oauthSpy.mockRestore();
		}
	});
	it("adds a turn billed while the resume scan is running to persisted spend", async () => {
		const restore = Promise.withResolvers<Map<string, number>>();
		const events: string[] = [];
		const unsubscribe = session.subscribe(event => events.push(event.type));
		const load = vi.spyOn(advisorModule, "loadAdvisorTranscriptCosts").mockImplementation(async (_file, options) => {
			await options?.beforeSnapshot;
			options?.onSnapshot?.();
			return restore.promise;
		});
		try {
			const advisor = enableAdvisor();
			session.beginInitialAdvisorCostRestore();
			appendAdvisorCost(advisor, 0.25, 1);
			restore.resolve(new Map([["", 0.5]]));
			await session.advisorCostRestore;

			expect(session.getAdvisorCost()).toBeCloseTo(0.75, 8);
			expect(events).toContain("advisor_cost_changed");
		} finally {
			unsubscribe();
			load.mockRestore();
		}
	});
	it("cancels an initial cost restore when the session is disposed", async () => {
		const restore = Promise.withResolvers<Map<string, number>>();
		let shouldContinue: (() => boolean) | undefined;
		const load = vi.spyOn(advisorModule, "loadAdvisorTranscriptCosts").mockImplementation((_file, options) => {
			shouldContinue = options?.shouldContinue;
			options?.onSnapshot?.();
			return restore.promise;
		});
		try {
			session.beginInitialAdvisorCostRestore();
			expect(shouldContinue?.()).toBe(true);
			session.beginDispose();
			expect(shouldContinue?.()).toBe(false);
			restore.resolve(new Map([["", 0.5]]));
			await session.advisorCostRestore;

			expect(session.getAdvisorCost()).toBe(0);
		} finally {
			load.mockRestore();
		}
	});
	it("ignores an initial cost restore after the active session changes", async () => {
		const restore = Promise.withResolvers<Map<string, number>>();
		const load = vi.spyOn(advisorModule, "loadAdvisorTranscriptCosts").mockImplementation((_file, options) => {
			options?.onSnapshot?.();
			return restore.promise;
		});
		try {
			session.beginInitialAdvisorCostRestore();
			await session.newSession();
			restore.resolve(new Map([["", 0.5]]));
			await session.advisorCostRestore;

			expect(session.getAdvisorCost()).toBe(0);
		} finally {
			load.mockRestore();
		}
	});
	it("starts a new session with only post-transition advisor cost", async () => {
		const advisor = enableAdvisor();
		appendAdvisorCost(advisor, 0.5, 1);
		const newSession = sessionManager.newSession.bind(sessionManager);
		vi.spyOn(sessionManager, "newSession").mockImplementation(async options => {
			const result = await newSession(options);
			appendAdvisorCost(advisor, 9, 2);
			return result;
		});

		await session.newSession();
		const replacementSessionFile = session.sessionFile;
		if (!replacementSessionFile) throw new Error("Expected the replacement session to be persisted");
		appendAdvisorCost(advisor, 0.25, 3);
		expect(session.getAdvisorCost()).toBeCloseTo(0.25, 8);
		await session.dispose();
		expect((await loadAdvisorTranscriptCosts(replacementSessionFile)).get("")).toBeCloseTo(0.25, 8);
	});
	it("records an advisor completion that races abort onto the previous session", async () => {
		const advisor = enableAdvisor();
		const previousSessionFile = session.sessionFile;
		if (!previousSessionFile) throw new Error("Expected the previous session to be persisted");
		appendAdvisorCost(advisor, 0.5, 1);

		let injected = false;
		const abort = advisor.abort.bind(advisor);
		vi.spyOn(advisor, "abort").mockImplementation((reason?: unknown) => {
			if (!injected) {
				injected = true;
				// Provider completes with billed usage while we stop the advisor for /new.
				appendAdvisorCost(advisor, 0.41, 2);
			}
			return abort(reason);
		});

		await session.newSession();
		const replacementSessionFile = session.sessionFile;
		if (!replacementSessionFile) throw new Error("Expected the replacement session to be persisted");
		expect(session.getAdvisorCost()).toBe(0);
		await session.dispose();

		expect((await loadAdvisorTranscriptCosts(previousSessionFile)).get("")).toBeCloseTo(0.91, 8);
		expect((await loadAdvisorTranscriptCosts(replacementSessionFile)).get("")).toBeUndefined();
	});
	it("restores advisor recording when a new session fails before commit", async () => {
		const advisor = enableAdvisor();
		const previousSessionFile = session.sessionFile;
		if (!previousSessionFile) throw new Error("Expected the previous session to be persisted");
		appendAdvisorCost(advisor, 0.5, 1);
		const failure = new Error("new session failed");
		vi.spyOn(sessionManager, "newSession").mockRejectedValue(failure);

		await expect(session.newSession()).rejects.toThrow(failure);

		expect(advisor.state.messages).toHaveLength(1);
		appendAdvisorCost(advisor, 0.25, 4);
		expect(session.getAdvisorCost()).toBeCloseTo(0.75, 8);
		await session.dispose();

		expect((await loadAdvisorTranscriptCosts(previousSessionFile)).get("")).toBeCloseTo(0.75, 8);
	});
	it("does not record a late advisor turn into a branched session", async () => {
		const advisor = enableAdvisor();
		sessionManager.appendMessage({ role: "user", content: "ancestor", timestamp: 1 });
		sessionManager.appendMessage({ role: "user", content: "branch point", timestamp: 2 });
		const entryId = sessionManager.getLeafId();
		if (!entryId) throw new Error("Expected a branchable entry");
		const createBranchedSession = sessionManager.createBranchedSession.bind(sessionManager);
		vi.spyOn(sessionManager, "createBranchedSession").mockImplementation(parentId => {
			const result = createBranchedSession(parentId);
			queueMicrotask(() => appendAdvisorCost(advisor, 9, 3));
			return result;
		});

		await expect(session.branch(entryId)).resolves.toMatchObject({ cancelled: false });
		const replacementSessionFile = session.sessionFile;
		if (!replacementSessionFile) throw new Error("Expected the replacement session to be persisted");
		appendAdvisorCost(advisor, 0.25, 4);
		expect(session.getAdvisorCost()).toBeCloseTo(0.25, 8);
		await session.dispose();

		expect((await loadAdvisorTranscriptCosts(replacementSessionFile)).get("")).toBeCloseTo(0.25, 8);
	});
	it("keeps advisor cost across a fork of the same conversation", async () => {
		const advisor = enableAdvisor();
		sessionManager.appendMessage({ role: "user", content: "keep me", timestamp: 1 });
		appendAdvisorCost(advisor, 0.5, 1);
		const previousSessionFile = sessionManager.getSessionFile();
		const fork = sessionManager.fork.bind(sessionManager);
		vi.spyOn(sessionManager, "fork").mockImplementation(async () => {
			const result = await fork();
			// Reproduce the outgoing advisor finalizing after the fork selected its file.
			appendAdvisorCost(advisor, 9, 2);
			return result;
		});

		expect(await session.fork()).toBe(true);

		// A fork copies the entries and artifacts and keeps the messages, so the
		// conversation continues under a new file and its spend continues with it.
		expect(sessionManager.getSessionFile()).not.toBe(previousSessionFile);
		expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);
		expect(advisor.state.messages).toContainEqual(advisorMessage(0.5, 1));
		const forkedSessionFile = sessionManager.getSessionFile();
		if (!forkedSessionFile) throw new Error("Expected the forked session to be persisted");
		await session.dispose();
		expect((await loadAdvisorTranscriptCosts(forkedSessionFile)).get("")).toBeCloseTo(0.5, 8);
	});
	it("restores advisor recording when a fork fails", async () => {
		const advisor = enableAdvisor();
		appendAdvisorCost(advisor, 0.5, 1);
		const previousSessionFile = sessionManager.getSessionFile();
		if (!previousSessionFile) throw new Error("Expected the previous session to be persisted");
		const failure = new Error("fork failed");
		vi.spyOn(sessionManager, "fork").mockRejectedValue(failure);

		await expect(session.fork()).rejects.toThrow(failure);

		expect(sessionManager.getSessionFile()).toBe(previousSessionFile);
		expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);
		appendAdvisorCost(advisor, 0.25, 2);
		expect(session.getAdvisorCost()).toBeCloseTo(0.75, 8);
		await session.dispose();
		expect((await loadAdvisorTranscriptCosts(previousSessionFile)).get("")).toBeCloseTo(0.75, 8);
	});
	it("resets advisor runtimes after an in-place handoff compaction", async () => {
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue from here");
		const advisor = enableAdvisor();
		prepareHandoffConversation(advisor);
		session.settings.set("compaction.keepRecentTokens", 1);
		const sessionFile = session.sessionFile;

		const result = await session.handoff();

		expect(result?.document).toContain("Continue from here");
		expect(session.sessionFile).toBe(sessionFile);
		const compaction = sessionManager.getBranch().at(-1);
		expect(compaction).toMatchObject({ type: "compaction" });
		if (compaction?.type !== "compaction") throw new Error("Expected handoff compaction entry");
		expect(compaction.summary).toContain("Continue from here");
	});
	it("clears advisor cost when a branch skips conversation restore", async () => {
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session_before_branch",
			emit: async () => ({ skipConversationRestore: true }),
		} as unknown as ExtensionRunner;
		const branchDir = TempDir.createSync("@pi-advisor-branch-");
		const branchManager = SessionManager.create(branchDir.path(), branchDir.path());
		const branchSession = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: branchManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			advisorTools: [],
			extensionRunner,
		});
		try {
			const advisor = enableAdvisor(branchSession);
			const branchPoint = { role: "user" as const, content: "branch point", timestamp: 1 };
			branchManager.appendMessage(branchPoint);
			const entryId = branchManager.getLeafId();
			if (!entryId) throw new Error("Expected a branchable entry");
			branchManager.appendMessage({ role: "user", content: "after the branch point", timestamp: 2 });
			branchSession.agent.replaceMessages(branchManager.buildSessionContext().messages);
			await branchManager.flush();
			appendAdvisorCost(advisor, 0.5, 1);

			expect(await branchSession.branch(entryId)).toMatchObject({ cancelled: false });

			// Restoring would rewind to the branch point; the extension owns that, so both
			// messages stay. Only the spend of the conversation we left must not follow.
			expect(branchSession.messages).toHaveLength(2);
			expect(branchSession.getAdvisorCost()).toBe(0);
		} finally {
			await branchSession.dispose();
			await branchDir.remove().catch(() => {});
		}
	});
	it("clears advisor cost when a branch hook throws after the session changed", async () => {
		const failure = new Error("session_branch handler failed");
		const extensionRunner = {
			hasHandlers: () => false,
			emit: async (event: { type: string }) => {
				if (event.type === "session_branch") throw failure;
				return undefined;
			},
		} as unknown as ExtensionRunner;
		const branchDir = TempDir.createSync("@pi-advisor-branch-fail-");
		const branchManager = SessionManager.create(branchDir.path(), branchDir.path());
		const branchSession = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: branchManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			advisorTools: [],
			extensionRunner,
		});
		try {
			const advisor = enableAdvisor(branchSession);
			branchManager.appendMessage({ role: "user", content: "branch point", timestamp: 1 });
			const entryId = branchManager.getLeafId();
			if (!entryId) throw new Error("Expected a branchable entry");
			const previousSessionFile = branchManager.getSessionFile();
			await branchManager.flush();
			appendAdvisorCost(advisor, 0.5, 1);

			await expect(branchSession.branch(entryId)).rejects.toThrow(failure);

			// The hook failed only after the branch had already taken over the transcript,
			// so the abandoned conversation's spend must not be billed to the new one.
			expect(branchManager.getSessionFile()).not.toBe(previousSessionFile);
			expect(branchSession.getAdvisorCost()).toBe(0);
			appendAdvisorCost(advisor, 0.25, 2);
			expect(branchSession.getAdvisorCost()).toBeCloseTo(0.25, 8);
		} finally {
			await branchSession.dispose();
			await branchDir.remove().catch(() => {});
		}
	});
	it("marks structurally classified advisor usage limits", async () => {
		const mock = createMockModel({ responses: [{ content: ["primary complete"] }] });
		const primaryAgent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		const quotaSession = new AgentSession({
			agent: primaryAgent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
		});

		try {
			expect(quotaSession.setAdvisorEnabled(true)).toBe(true);
			const advisorAgent = quotaSession.getAdvisorAgent();
			if (!advisorAgent) throw new Error("Expected advisor agent to exist");
			vi.spyOn(advisorAgent, "prompt").mockRejectedValue(
				new AIError.ProviderHttpError("Generic provider failure", 429, { code: "insufficient_quota" }),
			);
			const markUsageLimitReached = vi
				.spyOn(authStorage, "markUsageLimitReached")
				.mockResolvedValue({ switched: false });

			await quotaSession.prompt("Trigger advisor");
			await quotaSession.waitForIdle();

			expect(markUsageLimitReached).toHaveBeenCalledTimes(1);
			expect(markUsageLimitReached.mock.calls[0]?.[0]).toBe(model.provider);
		} finally {
			await quotaSession.dispose();
			vi.restoreAllMocks();
		}
	});
});
