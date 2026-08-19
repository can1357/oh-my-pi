import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import type { CompletionGateInput } from "@pk-nerdsaver-ai/pi-coding-agent/orchestration/completion-gate";
import {
	type CreateAgentSessionOptions,
	createAgentSession,
	discoverAuthStorage,
	type ExtensionFactory,
} from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TaskTool } from "@pk-nerdsaver-ai/pi-coding-agent/task";
import {
	ASSIGNMENT_CONTRACT_VERSION,
	ASSIGNMENT_RESULT_VERSION,
	withAssignmentContractDigest,
} from "@pk-nerdsaver-ai/pi-coding-agent/task/assignment-contract";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";

const toolActivationExtension: ExtensionFactory = pi => {
	pi.registerTool({
		name: "default_inactive_tool",
		label: "Default Inactive Tool",
		description: "Tool hidden from the initial active set unless explicitly requested.",
		parameters: type({}),
		defaultInactive: true,
		async execute() {
			return { content: [{ type: "text", text: "inactive" }] };
		},
	});
	pi.registerTool({
		name: "default_active_tool",
		label: "Default Active Tool",
		description: "Tool included in the initial active set.",
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: "active" }] };
		},
	});
};

describe("createAgentSession defaultInactive tool activation", () => {
	const tempDirs: string[] = [];

	// Built once and shared by every session. `ModelRegistry` eagerly loads all
	// bundled + cached models and `discoverAuthStorage` opens the auth DB — the
	// dominant (~50ms) slice of a cold boot, and identical for every test here.
	// Injecting it drops each per-test boot to the ~4ms of activation-specific work
	// these tests vary, and skips the background model refresh the SDK would
	// otherwise start when it builds its own registry.
	let modelRegistry!: ModelRegistry;
	let registryAuthDir: string;

	const makeTempDir = (): string => {
		const tempDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempDir;
	};

	beforeAll(async () => {
		registryAuthDir = path.join(os.tmpdir(), `pi-sdk-tool-activation-auth-${Snowflake.next()}`);
		fs.mkdirSync(registryAuthDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(registryAuthDir));
	});

	// Shared options for every session. `rules: []` and `workspaceTree` short-circuit
	// the two slow startup scans (rule discovery + native workspace walk, ~100ms each)
	// that are irrelevant to tool activation: these tests assert only which tools are
	// registered/active and that tool names appear in the system prompt. The shared
	// `modelRegistry` is injected here; each call still returns fresh
	// `settings`/`sessionManager` instances to keep tests isolated.
	const baseOptions = (tempDir: string): CreateAgentSessionOptions => ({
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		rules: [],
		workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}

		vi.restoreAllMocks();
	});

	afterAll(() => {
		modelRegistry.authStorage.close();
		removeSyncWithRetries(registryAuthDir);
	});

	it("excludes defaultInactive extension tools from the initial active set unless explicitly requested", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [toolActivationExtension],
		});

		try {
			expect(session.getAllToolNames()).toEqual(
				expect.arrayContaining(["default_active_tool", "default_inactive_tool"]),
			);
			expect(session.getActiveToolNames()).toContain("default_active_tool");
			expect(session.getActiveToolNames()).not.toContain("default_inactive_tool");
			expect(session.systemPrompt.join("\n")).toContain("default_active_tool");
			expect(session.systemPrompt.join("\n")).not.toContain("default_inactive_tool");
		} finally {
			await session.dispose();
		}
	});

	it("allows explicitly requested defaultInactive extension tools into the initial active set", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			extensions: [toolActivationExtension],
			toolNames: ["read", "default_inactive_tool"],
		});

		try {
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "default_active_tool", "default_inactive_tool"]),
			);
			expect(session.systemPrompt.join("\n")).toContain("default_inactive_tool");
		} finally {
			await session.dispose();
		}
	});

	it("activates the yield tool when requireYieldTool is set and toolNames is explicit", async () => {
		// Regression for #1408: plan-mode subagents pass an explicit `toolNames` list
		// (e.g. `["read", "grep", "glob", "lsp", "web_search"]`). Without this
		// invariant, `yield` ended up registered but not active, and the model
		// could not satisfy the idle-reminder contract that demands a `yield` call.
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			requireYieldTool: true,
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			expect(session.getActiveToolNames()).toContain("yield");
		} finally {
			await session.dispose();
		}
	});

	it("normalizes legacy builtin toolNames before selecting the active SDK tools", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "search", "find"],
		});

		try {
			const activeToolNames = session.getActiveToolNames();

			expect(activeToolNames).toContain("read");
			expect(activeToolNames).toContain("grep");
			expect(activeToolNames).toContain("glob");
			expect(activeToolNames).not.toContain("search");
			expect(activeToolNames).not.toContain("find");
		} finally {
			await session.dispose();
		}
	});

	it("keeps the hidden resolve tool registered for plan mode even when no deferrable tool is requested", async () => {
		// Regression for #1428: plan mode submits its finalized plan via
		// `resolve { action: "apply" }` dispatched through a standing handler
		// (interactive-mode.ts: `setStandingResolveHandler`). With an explicit
		// read-only `toolNames` (e.g. `read`, `search`, `find`, `web_search`)
		// the registry has no `deferrable` tool, so the previous gate dropped
		// `resolve` from the registry and plan mode silently activated without
		// it — leaving the agent stuck after drafting the plan.
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			expect(session.getToolByName("resolve")).toBeDefined();
		} finally {
			await session.dispose();
		}
	});

	it("drops the hidden resolve tool when neither a deferrable tool nor plan mode can use it", async () => {
		const tempDir = makeTempDir();

		const settings = Settings.isolated();
		settings.set("plan.enabled", false);

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings,
			toolNames: ["read", "grep", "glob", "web_search"],
		});

		try {
			expect(session.getToolByName("resolve")).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	it("does not register the xAI TTS tool unless enabled", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
		});

		try {
			expect(session.getToolByName("tts")).toBeUndefined();
			expect(session.getAllToolNames()).not.toContain("tts");
			expect(session.getActiveToolNames()).not.toContain("tts");
		} finally {
			await session.dispose();
		}
	});

	it("registers the xAI TTS tool when enabled", async () => {
		const tempDir = makeTempDir();

		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings: Settings.isolated({ "speechgen.enabled": true }),
		});

		try {
			expect(session.getToolByName("tts")).toBeDefined();
			expect(session.getActiveToolNames()).toContain("tts");
		} finally {
			await session.dispose();
		}
	});

	it("wires assignment completion contracts through the TaskTool and YieldTool session seam", async () => {
		const tempDir = makeTempDir();
		modelRegistry.authStorage.setRuntimeApiKey("openai", "test-key");
		let contractSeam: ToolSession | undefined;
		const createTaskTool = TaskTool.create;
		vi.spyOn(TaskTool, "create").mockImplementation(async toolSession => {
			contractSeam = toolSession;
			return createTaskTool(toolSession);
		});
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings: Settings.isolated({ "async.enabled": true, "task.prefetch.enabled": false }),
			toolNames: ["task", "yield"],
		});

		try {
			if (!contractSeam) throw new Error("Expected SDK to construct TaskTool with a ToolSession");
			expect(contractSeam.setActiveTaskContract).toBeFunction();
			expect(contractSeam.getActiveTaskContract).toBeFunction();
			expect(contractSeam.evaluateRootCompletionGate).toBeFunction();

			const task = await TaskTool.create(contractSeam);
			const yieldTool = session.getToolByName("yield");
			if (!yieldTool) throw new Error("Expected yield tool");
			const assignmentContract = withAssignmentContractDigest({
				version: ASSIGNMENT_CONTRACT_VERSION,
				id: "sdk-contract-child",
				revision: 1,
				role: "task",
				workClass: "mechanical",
				autonomy: "bound",
				objective: "Wire the ToolSession contract seam",
				deliverables: ["packages/coding-agent/src/sdk.ts"],
				scope: { allowedPaths: ["packages/coding-agent/src/sdk.ts"] },
				acceptance: [
					{
						id: "seam-wired",
						description: "The completion gate is reachable from YieldTool",
						check: "content_match",
					},
				],
				reporting: ASSIGNMENT_RESULT_VERSION,
			});

			const spawn = await task.execute("contract-child", {
				agent: "task",
				id: "ContractChild",
				model: "openai/gpt-4o-mini",
				assignment: "Wire the ToolSession completion-contract seam.",
				assignmentContract,
			});
			expect(spawn.content).not.toHaveLength(0);

			const activeContract = contractSeam.getActiveTaskContract?.();
			if (!activeContract) throw new Error("Expected assignment contract snapshot to remain active");
			expect(activeContract).toMatchObject({
				objective: assignmentContract.objective,
				deliverables: assignmentContract.deliverables,
			});

			const gateInput: CompletionGateInput = {
				contract: activeContract,
				deliverablesPresent: [],
				criteriaEvidence: {},
				triggeredNonSolutions: [],
				requiredEvidencePresent: false,
				unresolvedBlockers: [],
				scopeValid: true,
			};
			const expected = contractSeam.evaluateRootCompletionGate?.(gateInput);
			if (!expected?.reminder) throw new Error("Expected a recoverable completion-gate reminder");
			expect(expected.outcome).toBe("recoverable");
			expect(expected).toEqual(session.evaluateRootCompletionGate(gateInput));

			await expect(yieldTool.execute("contract-yield", { result: { data: {} } })).rejects.toThrow(expected.reminder);
		} finally {
			await session.dispose();
		}
	}, 60000);
});
