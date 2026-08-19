import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { AsyncJobManager } from "@pk-nerdsaver-ai/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import type { ClientBridge } from "@pk-nerdsaver-ai/pi-coding-agent/session/client-bridge";
import { TaskTool } from "@pk-nerdsaver-ai/pi-coding-agent/task";
import * as discoveryModule from "@pk-nerdsaver-ai/pi-coding-agent/task/discovery";
import * as executorModule from "@pk-nerdsaver-ai/pi-coding-agent/task/executor";
import { AgentOutputManager } from "@pk-nerdsaver-ai/pi-coding-agent/task/output-manager";
import type { SpawnPlan } from "@pk-nerdsaver-ai/pi-coding-agent/task/spawn-plan";
import type { AgentDefinition, SingleResult } from "@pk-nerdsaver-ai/pi-coding-agent/task/types";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

interface SessionFixture {
	readonly session: ToolSession;
	readonly outputManager: AgentOutputManager;
}

function successfulResult(options: executorModule.ExecutorOptions): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		executionProfile: options.executionProfile,
		exitCode: 0,
		output: "completed",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

describe("TaskTool spawn profile integration", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let selector: string;
	const managers: AsyncJobManager[] = [];

	beforeAll(async () => {
		tempDir = TempDir.createSync("@omp-spawn-profile-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		selector = `${model.provider}/${model.id}`;
	});

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent],
			projectAgentsDir: null,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) {
			await manager.dispose({ timeoutMs: 1000 });
		}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(
		settings: Record<string, unknown>,
		manager?: AsyncJobManager,
		clientBridge?: ClientBridge,
	): SessionFixture {
		const outputManager = new AgentOutputManager(() => null);
		return {
			outputManager,
			session: {
				cwd: tempDir.path(),
				hasUI: false,
				settings: Settings.isolated(settings),
				modelRegistry,
				agentOutputManager: outputManager,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getClientBridge: () => clientBridge,
				asyncJobManager: manager,
			} as unknown as ToolSession,
		};
	}

	it("resolves a known model role without requiring a subagent alias", async () => {
		const fixture = createSession({
			"async.enabled": false,
			modelRoles: { smol: selector },
			"subagent.modelAliases": {},
		});
		const allocateSpy = vi.spyOn(fixture.outputManager, "allocate");
		const executorSpy = vi
			.spyOn(executorModule, "runSubprocess")
			.mockImplementation(async options => successfulResult(options));
		const tool = await TaskTool.create(fixture.session);

		const result = await tool.execute("spawn-role-smol", {
			agent: "task",
			id: "RoleResolved",
			assignment: "Use the configured small-model role.",
			model: "smol",
		});

		expect(result.isError).not.toBe(true);
		expect(allocateSpy).toHaveBeenCalledTimes(1);
		expect(executorSpy).toHaveBeenCalledWith(expect.objectContaining({ modelOverride: ["pi/smol"] }));
	});

	it("rejects an unknown model selector before id, job, worktree, or child-session allocation", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const fixture = createSession(
			{
				"async.enabled": true,
				"task.isolation.mode": "worktree",
				"subagent.modelAliases": {},
			},
			manager,
		);
		const allocateSpy = vi.spyOn(fixture.outputManager, "allocate");
		const registerJobSpy = vi.spyOn(manager, "register");
		const executorSpy = vi.spyOn(executorModule, "runSubprocess");
		const tool = await TaskTool.create(fixture.session);

		const result = await tool.execute("spawn-invalid-selector", {
			agent: "task",
			id: "InvalidSelector",
			assignment: "Do not allocate this child.",
			model: "not-a-real-model",
			isolated: true,
		});

		expect(result.content.find(part => part.type === "text")?.text ?? "").toContain(
			'Model "not-a-real-model" not found for subagent spawn',
		);
		expect(result.details?.results).toEqual([]);
		expect(allocateSpy).not.toHaveBeenCalled();
		expect(registerJobSpy).not.toHaveBeenCalled();
		expect(executorSpy).not.toHaveBeenCalled();
	});

	it("preflights every synchronous batch item before allocating the first child", async () => {
		const fixture = createSession({
			"async.enabled": false,
			"subagent.modelAliases": {},
		});
		const allocateSpy = vi.spyOn(fixture.outputManager, "allocate");
		const executorSpy = vi.spyOn(executorModule, "runSubprocess");
		const tool = await TaskTool.create(fixture.session);

		const result = await tool.execute("spawn-sync-batch-invalid-selector", {
			agent: "task",
			context: "Both tasks must be planned before any child allocation.",
			tasks: [
				{ id: "ValidFirst", assignment: "This child must not be allocated.", model: "smol" },
				{ id: "InvalidSecond", assignment: "Reject before any allocation.", model: "not-a-real-model" },
			],
		});

		expect(result.content.find(part => part.type === "text")?.text ?? "").toContain(
			'Model "not-a-real-model" not found for subagent spawn',
		);
		expect(result.details?.results).toEqual([]);
		expect(allocateSpy).not.toHaveBeenCalled();
		expect(executorSpy).not.toHaveBeenCalled();
	});

	it("passes the valid frozen plan, resolved profile, and client bridge to the executor", async () => {
		const clientBridge: ClientBridge = {
			capabilities: { requestPermission: true, toolApprovalMode: "always-ask" },
			requestPermission: async () => ({ outcome: "cancelled" }),
		};
		const fixture = createSession(
			{
				"async.enabled": false,
				"task.prefetch.enabled": false,
				"task.agentPolicies": {
					task: {
						tier: "mid",
						autonomy: "supervised",
						collaboration: "report-only",
						workClass: "mechanical",
						editMode: "hashline",
						maxRequests: 7,
						maxRuntimeMs: 1234,
						modelPool: [selector],
					},
				},
			},
			undefined,
			clientBridge,
		);
		let capturedPlan: SpawnPlan | undefined;
		let capturedBridge: ClientBridge | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			capturedPlan = options.spawnPlan;
			capturedBridge = options.clientBridge;
			return successfulResult(options);
		});
		const tool = await TaskTool.create(fixture.session);

		const result = await tool.execute("spawn-valid-profile", {
			agent: "task",
			id: "Profiled",
			assignment: "Propagate the frozen execution envelope.",
		});

		expect(result.isError).not.toBe(true);
		expect(capturedPlan).toBeDefined();
		expect(Object.isFrozen(capturedPlan)).toBe(true);
		expect(Object.isFrozen(capturedPlan?.profile)).toBe(true);
		expect(Object.isFrozen(capturedPlan?.eligible)).toBe(true);
		expect(capturedPlan?.eligible.map(candidate => candidate.selector)).toEqual([selector]);
		expect(capturedPlan?.profile).toMatchObject({
			tier: "mid",
			autonomy: "supervised",
			collaboration: "report-only",
			workClass: "mechanical",
			editMode: "hashline",
			maxRequests: 7,
			maxRuntimeMs: 1234,
		});
		expect(capturedPlan?.maxRequests).toBe(7);
		expect(capturedBridge).toBe(clientBridge);
		expect(capturedPlan?.maxRuntimeMs).toBe(1234);
	});
});
