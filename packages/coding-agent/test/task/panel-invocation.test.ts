import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	artifactsDirsFromRegistry,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import {
	type PanelAgentDefinition,
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
	StructuredSubagentError,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const PANEL_AGENT: PanelAgentDefinition = {
	name: "panel-independent",
	description: "Read-only independent panel member.",
	systemPrompt: "You are one read-only member of a panel.",
	tools: ["read", "grep", "glob"],
	source: "bundled",
};

const TASK_AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["read", "write", "ast_grep"],
};

function session(
	options: {
		planMode?: boolean;
		maxDepth?: number;
		mcpManager?: NonNullable<ToolSession["mcpManager"]>;
		extensionPaths?: string[];
	} = {},
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"task.maxRecursionDepth": options.maxDepth ?? 2,
			"task.isolation.enabled": false,
			"task.enableLsp": true,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getPlanModeState: () => (options.planMode ? { enabled: true } : undefined),
		mcpManager: options.mcpManager,
		extensionPaths: options.extensionPaths,
	} as unknown as ToolSession;
}

function panelRequest(overrides: Partial<StructuredSubagentRequest> = {}): StructuredSubagentRequest {
	return {
		session: session(),
		invocationKind: "panel",
		assignment: "Answer the shared question.",
		agentDefinition: PANEL_AGENT,
		...overrides,
	};
}

function taskRequest(overrides: Partial<StructuredSubagentRequest> = {}): StructuredSubagentRequest {
	return {
		session: session(),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		...overrides,
	};
}

function result(): SingleResult {
	return {
		index: 0,
		id: "Worker",
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 0,
		output: "ok",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function mockDiscovery(agent: AgentDefinition = TASK_AGENT): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
}

afterEach(() => {
	vi.restoreAllMocks();
	resetRegisteredArtifactDirsForTests();
});

describe("panel structured subagent policy", () => {
	it("bypasses discovery and spawn policy entirely for panel dispatch", async () => {
		const discover = vi.spyOn(discoveryModule, "discoverAgents");
		const disabledSpawnSession = session();
		disabledSpawnSession.getSessionSpawns = () => "";

		const policy = await resolveEffectiveSubagentPolicy(panelRequest({ session: disabledSpawnSession }));

		expect(discover).not.toHaveBeenCalled();
		expect(policy.agentName).toBe("panel-independent");
		expect(policy.agent).toBe(PANEL_AGENT);
		expect(policy.effectiveAgent).toBe(PANEL_AGENT);
	});

	it("forces read-only restriction flags and rejects LSP by default", async () => {
		const policy = await resolveEffectiveSubagentPolicy(panelRequest());

		expect(policy.restrictToolNames).toBe(true);
		expect(policy.enableMCP).toBe(false);
		expect(policy.enableIrc).toBe(false);
		expect(policy.enableLsp).toBe(false);
		expect(policy.isIsolated).toBe(false);
		expect(policy.applyChanges).toBe(false);
	});

	it("honors an explicit allowLsp:true definition flag", async () => {
		const lspAgent: PanelAgentDefinition = { ...PANEL_AGENT, allowLsp: true };
		const policy = await resolveEffectiveSubagentPolicy(panelRequest({ agentDefinition: lspAgent }));
		expect(policy.enableLsp).toBe(true);
	});

	it("threads request.model and request.thinkingLevel into executor dispatch without agent selection", async () => {
		const options: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async executorOptions => {
			options.push(executorOptions);
			return result();
		});

		const settled = await runStructuredSubagent(
			panelRequest({ model: "anthropic/claude-x", thinkingLevel: ThinkingLevel.High, retainArtifacts: true }),
		);

		expect(options[0]?.thinkingLevel).toBe(ThinkingLevel.High);
		expect(options[0]?.modelOverride).toEqual(["anthropic/claude-x"]);
		expect(options[0]?.agent).toBe(PANEL_AGENT);
		expect(options[0]?.restrictToolNames).toBe(true);
		expect(options[0]?.enableMCP).toBe(false);
		expect(options[0]?.enableIrc).toBe(false);
		expect(options[0]?.preloadedExtensionPaths).toEqual([]);
		expect(options[0]?.preloadedCustomToolPaths).toEqual([]);
		expect(options[0]?.skills).toEqual([]);
		expect(options[0]?.autoloadSkills).toEqual([]);
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("suppresses MCP capabilities even when the parent session exposes them", async () => {
		const mcpManager = {} as NonNullable<ToolSession["mcpManager"]>;
		const parentSession = session({ mcpManager, extensionPaths: ["/plugins/example.ts"] });
		const options: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async executorOptions => {
			options.push(executorOptions);
			return result();
		});

		const settled = await runStructuredSubagent(panelRequest({ session: parentSession, retainArtifacts: true }));

		expect(options[0]?.mcpManager).toBeUndefined();
		expect(options[0]?.enableMCP).toBe(false);
		expect(options[0]?.preloadedExtensionPaths).toEqual([]);
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("still allocates a child id, registers temporary artifacts, and reports normal output", async () => {
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async executorOptions => {
			artifactsDir = executorOptions.artifactsDir;
			return result();
		});

		const settled = await runStructuredSubagent(panelRequest({ retainArtifacts: true, keepAlive: true }));

		expect(settled.temporaryArtifacts).toBe(true);
		expect(artifactsDir).toBe(settled.artifactsDir);
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(settled.result.output).toBe("ok");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("rejects panel dispatch missing a bundled agent definition", async () => {
		await expect(resolveEffectiveSubagentPolicy({ ...panelRequest(), agentDefinition: undefined })).rejects.toThrow(
			"require a bundled agent definition",
		);
	});

	it("rejects a caller-supplied agent name for panel dispatch", async () => {
		await expect(resolveEffectiveSubagentPolicy(panelRequest({ agent: "task" }))).rejects.toThrow(
			"agent selection is unavailable",
		);
	});

	it("rejects isolation, apply, and merge controls for panel dispatch", async () => {
		await expect(resolveEffectiveSubagentPolicy(panelRequest({ isolation: { requested: true } }))).rejects.toThrow(
			"do not support isolation",
		);
	});

	it("rejects explicit enableIrc/enableLsp overrides for panel dispatch", async () => {
		await expect(resolveEffectiveSubagentPolicy(panelRequest({ enableIrc: true }))).rejects.toThrow(
			"controlled by its bundled agent definition",
		);
		await expect(resolveEffectiveSubagentPolicy(panelRequest({ enableLsp: true }))).rejects.toThrow(
			"controlled by its bundled agent definition",
		);
	});

	it("rejects coarse effort for panel dispatch", async () => {
		await expect(resolveEffectiveSubagentPolicy(panelRequest({ effort: "hi" }))).rejects.toThrow(
			"coarse effort is unavailable",
		);
	});

	it("rejects an inherit thinking selector for panel dispatch", async () => {
		await expect(
			resolveEffectiveSubagentPolicy(panelRequest({ thinkingLevel: ThinkingLevel.Inherit })),
		).rejects.toThrow("instead of inherit");
	});

	it("accepts auto and off exact thinking selectors for panel dispatch", async () => {
		const options: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async executorOptions => {
			options.push(executorOptions);
			return result();
		});

		const autoRun = await runStructuredSubagent(panelRequest({ thinkingLevel: "auto", retainArtifacts: true }));
		const offRun = await runStructuredSubagent(
			panelRequest({ thinkingLevel: ThinkingLevel.Off, retainArtifacts: true }),
		);

		expect(options[0]?.thinkingLevel).toBe("auto");
		expect(options[1]?.thinkingLevel).toBe(ThinkingLevel.Off);
		await fs.rm(autoRun.artifactsDir, { recursive: true, force: true });
		await fs.rm(offRun.artifactsDir, { recursive: true, force: true });
	});

	it("rejects a non-bundled panel agent definition", async () => {
		const userAgent: PanelAgentDefinition = { ...PANEL_AGENT, source: "user" };
		await expect(resolveEffectiveSubagentPolicy(panelRequest({ agentDefinition: userAgent }))).rejects.toThrow(
			'source "bundled"',
		);
	});

	it("rejects a panel agent definition that declares nested spawns", async () => {
		const spawningAgent: PanelAgentDefinition = { ...PANEL_AGENT, spawns: "*" };
		await expect(resolveEffectiveSubagentPolicy(panelRequest({ agentDefinition: spawningAgent }))).rejects.toThrow(
			"may not declare nested spawns",
		);
	});

	it("rejects a panel agent definition that declares prewalk or autoloaded skills", async () => {
		const prewalkAgent: PanelAgentDefinition = { ...PANEL_AGENT, prewalk: true };
		await expect(resolveEffectiveSubagentPolicy(panelRequest({ agentDefinition: prewalkAgent }))).rejects.toThrow(
			"may not declare prewalk",
		);
		const autoloadAgent: PanelAgentDefinition = { ...PANEL_AGENT, autoloadSkills: ["some-skill"] };
		await expect(resolveEffectiveSubagentPolicy(panelRequest({ agentDefinition: autoloadAgent }))).rejects.toThrow(
			"may not declare prewalk",
		);
	});

	it("rejects a panel agent definition with no declared tools", async () => {
		const emptyToolsAgent: PanelAgentDefinition = { ...PANEL_AGENT, tools: [] };
		await expect(resolveEffectiveSubagentPolicy(panelRequest({ agentDefinition: emptyToolsAgent }))).rejects.toThrow(
			"must explicitly declare at least one tool",
		);
	});

	it("rejects a panel agent definition with tools outside the read-only surface", async () => {
		const writeAgent: PanelAgentDefinition = { ...PANEL_AGENT, tools: ["read", "write", "bash", "task", "hub"] };
		await expect(resolveEffectiveSubagentPolicy(panelRequest({ agentDefinition: writeAgent }))).rejects.toThrow(
			"only use read-only tools: write, bash, task, hub",
		);
	});

	it("rejects a bundled agent definition supplied outside of panel dispatch", async () => {
		mockDiscovery();
		await expect(resolveEffectiveSubagentPolicy(taskRequest({ agentDefinition: PANEL_AGENT }))).rejects.toThrow(
			"Bundled agent definitions are only available for panel subagents",
		);
	});

	it("does not surface StructuredSubagentError instances as generic execution failures", async () => {
		try {
			await resolveEffectiveSubagentPolicy(panelRequest({ isolation: { requested: true } }));
			throw new Error("expected rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(StructuredSubagentError);
			expect((error as StructuredSubagentError).kind).toBe("preflight");
		}
	});
});

describe("task and eval regression coverage under the shared policy path", () => {
	it("keeps discovery-based agent resolution and depth/spawn checks for task dispatch", async () => {
		mockDiscovery();
		const policy = await resolveEffectiveSubagentPolicy(taskRequest());
		expect(policy.agentName).toBe("worker");
		expect(policy.agent).toBe(TASK_AGENT);
		expect(policy.restrictToolNames).toBe(false);
		expect(policy.enableMCP).toBe(true);

		const blockedSession = session();
		blockedSession.getSessionSpawns = () => "";
		await expect(resolveEffectiveSubagentPolicy(taskRequest({ session: blockedSession }))).rejects.toThrow(
			"Cannot spawn",
		);
	});

	it("keeps eval dispatch on the same discovery path with identical restriction defaults", async () => {
		mockDiscovery();
		const policy = await resolveEffectiveSubagentPolicy(taskRequest({ invocationKind: "eval" }));
		expect(policy.agentName).toBe("worker");
		expect(policy.restrictToolNames).toBe(false);
		expect(policy.enableMCP).toBe(true);
		expect(policy.enableIrc).toBe(true);
	});

	it("still restricts plan-mode task dispatch exactly as before, independent of the panel path", async () => {
		mockDiscovery();
		const policy = await resolveEffectiveSubagentPolicy(taskRequest({ session: session({ planMode: true }) }));
		expect(policy.restrictToolNames).toBe(true);
		expect(policy.enableLsp).toBe(false);
		expect(policy.enableIrc).toBe(false);
		expect(policy.effectiveAgent.tools).toEqual(["read", "grep", "glob", "web_search", "ast_grep"]);
	});

	it("still dispatches task executor options unaffected by the panel branch", async () => {
		mockDiscovery();
		const options: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async executorOptions => {
			options.push(executorOptions);
			return result();
		});

		const settled = await runStructuredSubagent(taskRequest({ retainArtifacts: true }));

		expect(options[0]?.agent).toBe(TASK_AGENT);
		expect(options[0]?.restrictToolNames).toBe(false);
		expect(options[0]?.thinkingLevel).toBeUndefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("still accepts coarse effort for task dispatch, unaffected by the panel-only rejection", async () => {
		mockDiscovery();
		const options: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async executorOptions => {
			options.push(executorOptions);
			return result();
		});

		const settled = await runStructuredSubagent(taskRequest({ effort: "hi", retainArtifacts: true }));

		expect(options[0]?.effort).toBe("hi");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
});
