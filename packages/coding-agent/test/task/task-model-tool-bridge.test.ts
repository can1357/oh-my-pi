import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let tempDir: TempDir;
let settingsState: SettingsTestState;

beforeEach(() => {
	settingsState = beginSettingsTest();
	tempDir = TempDir.createSync("@task-model-bridge-");
	setAgentDir(path.join(tempDir.path(), "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await disposeAllVmContexts();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	restoreSettingsTestState(settingsState);
	tempDir.removeSync();
});

describe("task model through JavaScript eval", () => {
	it("accepts an empty array through the bridge and rejects an unapproved selector", async () => {
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: [
				{ name: "task", description: "task", systemPrompt: "task", source: "bundled", model: ["default/route"] },
			],
			projectAgentsDir: null,
		});
		const seen: Array<{ model: unknown; grants: unknown }> = [];
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			seen.push({ model: options.modelOverride, grants: options.perCallModelGrants });
			return {
				index: 0,
				id: options.id ?? "?",
				agent: "task",
				agentSource: "bundled",
				task: "task",
				assignment: "work",
				exitCode: 0,
				output: "bridge-success",
				stderr: "",
				truncated: false,
				durationMs: 1,
				tokens: 0,
				requests: 1,
			} satisfies SingleResult;
		});
		const sessionId = `task-model-bridge-${crypto.randomUUID()}`;
		const session: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			settings: Settings.isolated({
				"async.enabled": false,
				"task.batch": false,
				"task.perCallModel": "off",
				"eval.autoProvision": false,
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => null,
			getSessionId: () => sessionId,
			getEvalSessionId: () => sessionId,
			getToolByName: name => (name === "task" ? (task as unknown as AgentTool) : undefined),
		};
		const task = await TaskTool.create(session);
		const evalTool = new EvalTool(session);
		const success = await evalTool.execute("empty", {
			language: "js",
			code: 'print(JSON.stringify(await tool.task({task:"work",solutionSpace:"bounded",model:[]})))',
			timeout: 0,
		});
		expect(success.details?.cells?.[0]?.status).toBe("complete");
		expect(success.details?.cells?.[0]?.output).toContain("bridge-success");
		const rejected = await evalTool.execute("denied", {
			language: "js",
			code: 'print(JSON.stringify(await tool.task({task:"work",solutionSpace:"bounded",model:"p/denied"})))',
			timeout: 0,
		});
		expect(rejected.details?.cells?.[0]?.output).toContain("task.perCallModel: off");
		expect(seen).toEqual([{ model: ["default/route"], grants: undefined }]);
	}, 15_000);
});
