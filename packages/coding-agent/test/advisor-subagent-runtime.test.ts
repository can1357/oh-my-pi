import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { AdvisorConfig } from "@oh-my-pi/pi-coding-agent/advisor/config";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("per-advisor subagent runtime roster", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let tempDir: TempDir;
	let sessions: AgentSession[];

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(() => authStorage.close());

	beforeEach(() => {
		tempDir = TempDir.createSync("omp-advisor-subagent-runtime-");
		sessions = [];
	});

	afterEach(async () => {
		for (const session of sessions) await session.dispose();
		await tempDir.remove();
	});

	function createSession(
		agentKind: "main" | "sub" | undefined,
		advisorConfigs?: AdvisorConfig[],
		advised = true,
	): AgentSession {
		const parent = Settings.isolated({
			"compaction.enabled": false,
			"advisor.enabled": true,
			modelRoles: { advisor: `${model.provider}/${model.id}` },
		});
		const settings =
			agentKind === "sub"
				? createSubagentSettings(parent, advised ? { "advisor.enabled": true } : {})
				: parent;
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry,
			agentKind,
			advisorConfigs,
			advisorTools: [],
		});
		sessions.push(session);
		return session;
	}

	const roster: AdvisorConfig[] = [
		{ name: "main-only", subagents: false },
		{ name: "inherited" },
		{ name: "included", subagents: true },
		{ name: "disabled", enabled: false, subagents: true },
	];

	it("keeps the full enabled roster in main sessions", () => {
		const session = createSession("main", roster);
		expect(session.getAdvisorStats().advisors.map(advisor => [advisor.name, advisor.status])).toEqual([
			["main-only", "running"],
			["inherited", "running"],
			["included", "running"],
			["disabled", "paused"],
		]);
	});

	it("defaults an unspecified session kind to main", () => {
		const session = createSession(undefined, [{ name: "main-only", subagents: false }]);
		expect(session.isAdvisorActive()).toBe(true);
		expect(session.getAdvisorStats().advisors[0].status).toBe("running");
	});

	it("filters an advised child at construction time and retains paused status entries", () => {
		const session = createSession("sub", roster);
		expect(session.getAdvisorStats().advisors.map(advisor => [advisor.name, advisor.status])).toEqual([
			["main-only", "paused"],
			["inherited", "running"],
			["included", "running"],
			["disabled", "paused"],
		]);
	});

	it("does not override the per-agent opt-in with subagents=true", () => {
		const session = createSession("sub", [{ name: "included", subagents: true }], false);
		expect(session.settings.get("advisor.enabled")).toBe(false);
		expect(session.isAdvisorEnabled()).toBe(false);
		expect(session.isAdvisorActive()).toBe(false);
		expect(session.getAdvisorAgent()).toBeUndefined();
	});

	it("does not override the per-advisor enabled switch", () => {
		const session = createSession("sub", [{ name: "disabled", enabled: false, subagents: true }]);
		expect(session.isAdvisorActive()).toBe(false);
		expect(session.getAdvisorStats().advisors[0].status).toBe("paused");
	});

	it("does not fall back to a synthetic advisor when every configured advisor is excluded", () => {
		const session = createSession("sub", [{ name: "main-only", subagents: false }]);
		expect(session.isAdvisorActive()).toBe(false);
		expect(session.getAdvisorStats().advisors.map(advisor => [advisor.name, advisor.status])).toEqual([
			["main-only", "paused"],
		]);
	});

	it("preserves the legacy default advisor in an opted-in child with no roster", () => {
		const session = createSession("sub");
		expect(session.isAdvisorActive()).toBe(true);
		expect(session.getAdvisorStats().advisors).toHaveLength(1);
		expect(session.getAdvisorStats().advisors[0].status).toBe("running");
	});

	it("reapplies eligibility when the live roster changes", () => {
		const session = createSession("sub", [{ name: "reviewer", subagents: false }]);
		expect(session.isAdvisorActive()).toBe(false);
		session.applyAdvisorConfigs([{ name: "reviewer", subagents: true }], undefined);
		expect(session.isAdvisorActive()).toBe(true);
		session.applyAdvisorConfigs([{ name: "reviewer", subagents: false }], undefined);
		expect(session.isAdvisorActive()).toBe(false);
		expect(session.getAdvisorStats().advisors[0].status).toBe("paused");
	});

	it("excludes a main-only advisor before resolving its invalid model", () => {
		const session = createSession("sub", [
			{ name: "main-only", model: "nonexistent-provider/nonexistent-model", subagents: false },
		]);
		expect(session.getAdvisorStats().advisors[0].status).toBe("paused");
	});

	it("allocates distinct roster entries even when an excluded advisor has a colliding slug", () => {
		const session = createSession("sub", [
			{ name: "Same Name", subagents: false },
			{ name: "same_name", subagents: true },
		]);
		expect(session.getAdvisorStats().advisors.map(advisor => [advisor.name, advisor.status])).toEqual([
			["Same Name", "paused"],
			["same_name", "running"],
		]);
	});
});
