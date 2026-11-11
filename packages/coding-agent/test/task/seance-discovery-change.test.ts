import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentTool, validateAgentToolArguments } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

let home: string;
beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seance-discovery-"));
	vi.spyOn(os, "homedir").mockReturnValue(home);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(home, { recursive: true, force: true });
});

for (const source of ["project", "user"] as const) {
	for (const batch of [false, true]) {
		for (const raw of [false, true]) {
			for (const form of ["absent", "empty-string", "empty-array"] as const) {
				it(`does not turn an empty override into the saved model after removing ${source} seance (batch ${batch}, raw ${raw}, ${form})`, async () => {
					const cwd = path.join(home, "project");
					await fs.mkdir(cwd);
					const agentFile =
						source === "project"
							? path.join(cwd, ".omp", "agents", "seance.md")
							: path.join(home, ".omp", "agent", "agents", "seance.md");
					await Bun.write(
						agentFile,
						"---\nname: seance\ndescription: Ordinary custom agent\nmodel: mock/granted\n---\nReply PONG.\n",
					);
					const timestamp = new Date().toISOString();
					const sourceSession = path.join(cwd, "source.jsonl");
					await Bun.write(
						sourceSession,
						[
							{ type: "session", version: CURRENT_SESSION_VERSION, id: "source", timestamp, cwd },
							{
								type: "model_change",
								id: "m1",
								parentId: null,
								timestamp,
								model: "mock/granted",
								role: "default",
							},
						]
							.map(entry => JSON.stringify(entry))
							.join("\n") + "\n",
					);
					const model = createMockModel({ id: "granted" });
					const session = {
						cwd,
						hasUI: false,
						settings: Settings.isolated({
							"task.batch": batch,
							"async.enabled": false,
							"task.perCallModel": "off",
							modelRoles: { default: "mock/granted" },
						}),
						modelRegistry: {
							getAll: () => [model],
							getAvailable: () => [model],
							find: (provider: string, id: string) =>
								provider === "mock" && id === "granted" ? model : undefined,
							isBackgroundRefreshPending: () => false,
							awaitBackgroundRefresh: async () => {},
							hasConfiguredAuth: () => true,
							getApiKey: async () => "synthetic-test-key",
						},
						getSessionFile: () => null,
						getSessionSpawns: () => "seance,task",
						getAgentId: () => null,
						getArtifactsDir: () => null,
					} as unknown as ToolSession;
					const run = vi.spyOn(executor, "runSubprocess").mockImplementation(
						async options =>
							({
								index: 0,
								id: "Probe",
								agent: options.agent.name,
								agentSource: options.agent.source,
								task: "Read source",
								exitCode: 0,
								output: "PONG",
								stderr: "",
								truncated: false,
								durationMs: 0,
								tokens: 0,
								requests: 0,
							}) as SingleResult,
					);
					const tool = await TaskTool.create(session);
					await fs.unlink(agentFile);
					const item = {
						name: "Probe",
						agent: "seance",
						task: "Read source",
						solutionSpace: "read only",
						sourceSession,
						...(form === "absent" ? {} : { model: form === "empty-array" ? [] : "" }),
					};
					const input = batch ? { context: "Context", tasks: [item] } : item;
					const args = raw
						? input
						: validateAgentToolArguments(tool as unknown as AgentTool, {
								type: "toolCall",
								id: "discovery-change",
								name: "task",
								arguments: input,
							});
					const result = await tool.execute("discovery-change", args);
					if (form === "absent") {
						expect(result.isError).toBeFalsy();
						expect(run).toHaveBeenCalledTimes(1);
						expect(run.mock.calls[0]?.[0].agent.source).toBe("bundled");
						expect(run.mock.calls[0]?.[0].modelOverride).toEqual(["mock/granted"]);
					} else {
						expect(result.isError).toBe(true);
						expect(run).not.toHaveBeenCalled();
					}
				});
			}
		}
	}
}
