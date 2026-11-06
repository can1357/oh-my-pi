import { afterEach, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	CODEX,
	PROVIDER,
	createHarness,
	credentialIdOf,
	disposeHarness,
	ENABLED,
	expectNoStrayFetch,
	seedAccounts,
	seedReports,
	windowAt,
} from "../../ai/test/fixtures/usage-governor/harness";

afterEach(async () => {
	await disposeHarness();
});

async function setup() {
	const h = await createHarness(ENABLED);
	const original = h.usage.provider.bind(h.usage);
	h.usage.provider = id => {
		const provider = original(id);
		return {
			...provider,
			governorAllowance: () => ["primary"],
			fetchUsage: async (params, ctx) => {
				const report = await provider.fetchUsage(params, ctx);
				if (report) for (const limit of report.limits) limit.observedAt = Date.now();
				return report;
			},
		};
	};
	await seedAccounts(h, PROVIDER, [
		{ accountId: "source", email: "source@example.test", window: windowAt(30000, 60000, 1) },
	]);
	await seedAccounts(h, CODEX, [
		{ accountId: "fallback", email: "fallback@example.test", window: windowAt(30000, 60000, 0.1) },
	]);
	await seedReports(h, PROVIDER);
	await seedReports(h, CODEX);
	const settings = Settings.isolated({
		"usageGovernor.enabled": true,
		"retry.modelFallback": true,
		"retry.fallbackChains": {
			task: [],
			[`${PROVIDER}/primary:high`]: [`${CODEX}/fallback`],
			[`${PROVIDER}/primary:low`]: [],
		},
	});
	settings.setModelRole("task", `${PROVIDER}/primary`);
	settings.setModelRole("default", `${PROVIDER}/primary`);
	const registry = new ModelRegistry(h.storage, `${h.dir}/models.yml`, { settings });
	const oauth = {
		name: "synthetic",
		login: async () => {
			throw new Error("unexpected login");
		},
	};
	const definition = (id: string) => ({
		id,
		name: id,
		reasoning: true,
		thinking: { mode: "effort" as const, efforts: [Effort.Low, Effort.High] },
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 8192,
	});
	registry.registerProvider(PROVIDER, {
		api: "openai-completions",
		baseUrl: "https://source.example.test",
		oauth,
		models: [definition("primary")],
	});
	registry.registerProvider(CODEX, {
		api: "openai-completions",
		baseUrl: "https://fallback.example.test",
		oauth,
		models: [definition("fallback")],
	});
	const source = registry.find(PROVIDER, "primary")!;
	const sourceId = credentialIdOf(h, PROVIDER, "source");
	async function transcript(name: string, role: string, suffix?: string) {
		const manager = SessionManager.create(h.dir, path.join(h.dir, name));
		manager.appendModelChange(`${PROVIDER}/primary`, role);
		if (suffix) manager.appendModelChange(`${PROVIDER}/primary`, suffix);
		await manager.ensureOnDisk();
		const file = manager.getSessionFile()!;
		await manager.close();
		return file;
	}
	return { h, settings, registry, source, sourceId, transcript };
}

async function prepare(session: AgentSession, x: { source: Model; sourceId: number }) {
	const fn = session.agent.prepareModelCallAuth;
	if (!fn) throw new Error("governor preparation missing");
	return fn(x.source, async () => ({
		model: x.source,
		apiKey: () => undefined,
		resolved: { apiKey: "source", credentialId: x.sourceId },
	}));
}

test("switch restores model ownership for temporary, skips internal markers, and rolls back named role", async () => {
	const x = await setup();
	const temporary = await x.transcript("temporary", "temporary", "prewalk");
	const named = await x.transcript("named", "task", "fallback");
	const manager = SessionManager.create(x.h.dir, path.join(x.h.dir, "active"));
	const agent = new Agent({ initialState: { model: x.source, systemPrompt: [], tools: [], messages: [] } });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: x.settings,
		modelRegistry: x.registry,
		routingRole: "default",
	});
	try {
		expect(await session.switchSession(temporary)).toBe(true);
		expect(session.usageRoutingContext?.routingRole).toBeUndefined();
		session.setThinkingLevel(Effort.High);
		expect((await prepare(session, x))?.model.id).toBe("fallback");
		expect(await session.switchSession(temporary)).toBe(true);
		session.setThinkingLevel(Effort.Low);
		expect((await prepare(session, x))?.model.id).toBe("primary");
		expect(await session.switchSession(named)).toBe(true);
		expect(session.usageRoutingContext?.routingRole).toBe("task");
		session.setThinkingLevel(Effort.High);
		expect((await prepare(session, x))?.model.id).toBe("primary");
		const failure = new Error("rejected switch");
		const setModel = spyOn(agent, "setModel").mockImplementationOnce(() => {
			expect(session.usageRoutingContext?.routingRole).toBeUndefined();
			throw failure;
		});
		try {
			await expect(session.switchSession(temporary, { model: x.registry.find(CODEX, "fallback")! })).rejects.toBe(
				failure,
			);
		} finally {
			setModel.mockRestore();
		}
		expect(session.usageRoutingContext?.routingRole).toBe("task");
		expectNoStrayFetch(x.h);
	} finally {
		await session.dispose();
		await manager.close();
	}
});

test("startup resume retains temporary model ownership and named role ownership", async () => {
	const x = await setup();
	for (const [role, suffix, expectedRole, expectedModel] of [
		["temporary", "prewalk", undefined, "fallback"],
		["task", "fallback", "task", "primary"],
	] as const) {
		const file = await x.transcript(`startup-${role}`, role, suffix);
		const manager = await SessionManager.open(file, path.dirname(file));
		const { session } = await createAgentSession({
			cwd: x.h.dir,
			agentDir: x.h.dir,
			authStorage: x.h.storage,
			modelRegistry: x.registry,
			sessionManager: manager,
			settings: x.settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		try {
			expect(session.usageRoutingContext?.routingRole).toBe(expectedRole);
			session.setThinkingLevel(Effort.High);
			expect((await prepare(session, x))?.model.id).toBe(expectedModel);
		} finally {
			await session.dispose();
			await manager.close();
		}
	}
	expectNoStrayFetch(x.h);
});
