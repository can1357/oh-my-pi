import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { approvalCacheKeyForPath } from "@oh-my-pi/pi-coding-agent/tools/approval-cache";
import { withToolApprovalScope } from "@oh-my-pi/pi-coding-agent/tools/approval-scope";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";

describe("taskFile approval binding", () => {
	let directory: string;
	const executions: ExecutorOptions[] = [];

	beforeEach(async () => {
		directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-task-file-approval-"));
		executions.length = 0;
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [{ name: "task", description: "Task agent", systemPrompt: "Complete the task.", source: "bundled" }],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			executions.push(options);
			const progress: AgentProgress = {
				index: options.index,
				id: options.id,
				agent: options.agent.name,
				agentSource: options.agent.source,
				task: options.task,
				assignment: options.assignment,
				status: "completed",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 1,
				tokens: 0,
				cost: 0,
				durationMs: 1,
			};
			options.onProgress?.(progress);
			return { ...progress, exitCode: 0, output: "Completed.", stderr: "", truncated: false };
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		await fs.promises.rm(directory, { recursive: true, force: true });
	});

	async function createWrapper(
		select: ExtensionUIContext["select"],
		mode = "always-ask",
		restrictedFolders = [path.join(directory, "restricted")],
	) {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.file": true,
			"tools.approvalMode": mode,
			"tools.restrictedFolders": restrictedFolders,
		});
		const tool = await TaskTool.create({
			cwd: directory,
			hasUI: true,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			localProtocolOptions: { getArtifactsDir: () => path.join(directory, "artifacts") },
		} as unknown as ToolSession);
		const sessionManager = SessionManager.inMemory(directory);
		const modelRegistry = {} as ModelRegistry;
		const runner = new ExtensionRunner([], new ExtensionRuntime(), directory, sessionManager, modelRegistry);
		runner.initialize(
			{} as Parameters<ExtensionRunner["initialize"]>[0],
			{} as Parameters<ExtensionRunner["initialize"]>[1],
			undefined,
			{ select } as ExtensionUIContext,
		);
		const wrapper = new ExtensionToolWrapper(
			{
				name: tool.name,
				label: tool.label,
				description: tool.description,
				parameters: tool.parameters,
				approval: tool.approval,
				bindApprovalTargets: tool.bindApprovalTargets,
				approvalRestrictionPaths: tool.approvalRestrictionPaths,
				formatApprovalDetails: tool.formatApprovalDetails,
				execute: tool.execute.bind(tool),
			},
			runner,
		);
		const context: AgentToolContext = {
			settings,
			sessionManager,
			modelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => undefined,
		};
		return { wrapper, context, runner, tool };
	}

	async function linkedFiles(local = false) {
		const safe = path.join(directory, "safe.md");
		const restricted = path.join(directory, "restricted", "task.md");
		const linkPath = path.join(directory, ...(local ? ["artifacts", "local"] : []), "task-link.md");
		const taskFile = local ? "local://task-link.md" : linkPath;
		await Bun.write(safe, "Approved assignment.");
		await Bun.write(restricted, "Unapproved restricted assignment.");
		await fs.promises.mkdir(path.dirname(linkPath), { recursive: true });
		await fs.promises.symlink(safe, linkPath);
		return { safe, restricted, taskFile, linkPath };
	}

	it.each([false, true])(
		"reads the approved target when its symlink changes while approval is pending (local=%s)",
		async local => {
			const { safe, taskFile, restricted, linkPath } = await linkedFiles(local);
			const expectedPath = `Task file: ${JSON.stringify(taskFile)} -> ${JSON.stringify(safe)}`;
			const { wrapper, context, tool } = await createWrapper(async title => {
				expect(title).toContain(expectedPath);
				await fs.promises.unlink(linkPath);
				await fs.promises.symlink(restricted, linkPath);
				expect(tool.formatApprovalDetails({ taskFile })).toContain(expectedPath);
				return "Approve";
			});

			const result = await wrapper.execute("swapped-link", { taskFile }, undefined, undefined, context);

			expect(result.isError).not.toBe(true);
			expect(executions.map(item => item.assignment)).toEqual(["Approved assignment."]);
		},
	);

	it("shows each bound batch target after an inline item", async () => {
		const { safe, taskFile } = await linkedFiles(true);
		const direct = path.join(directory, "direct.md");
		await Bun.write(direct, "Direct assignment.");
		const { wrapper, context } = await createWrapper(async title => {
			expect(title).toContain(`Task 2 file: ${JSON.stringify(taskFile)} -> ${JSON.stringify(safe)}`);
			expect(title.split("\n")).toContain(`Task 3 file: ${JSON.stringify(direct)}`);
			return "Approve";
		});

		const result = await wrapper.execute(
			"batch-target-display",
			{
				context: "Complete all assignments.",
				tasks: [{ task: "Inline assignment." }, { taskFile }, { taskFile: direct }],
			},
			undefined,
			undefined,
			context,
		);

		expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
		expect(executions.map(item => item.assignment).sort()).toEqual([
			"Approved assignment.",
			"Direct assignment.",
			"Inline assignment.",
		]);
	});

	it("does not authorize direct execution by querying restriction paths", async () => {
		const { safe, taskFile } = await linkedFiles();
		const { tool } = await createWrapper(async () => "Approve");

		const result = await withToolApprovalScope(async () => {
			expect(tool.approvalRestrictionPaths({ taskFile })).toEqual([approvalCacheKeyForPath(safe)]);
			return tool.execute("unbound-direct-call", { taskFile });
		});

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining("was not included in this call's approval") }),
		]);
		expect(executions).toHaveLength(0);
	});

	it("omits unresolved local URLs from restriction targets and reports the dispatch error", async () => {
		const taskFile = "local://%ZZ";
		const { wrapper, context, tool } = await createWrapper(async () => {
			expect(tool.approvalRestrictionPaths({ taskFile })).toBeUndefined();
			return "Approve";
		});

		const result = await wrapper.execute("unresolved-file", { taskFile }, undefined, undefined, context);

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining("does not resolve to a local file") }),
		]);
		expect(executions).toHaveLength(0);
	});

	it.each(["file", "ancestor", "regular-file"])(
		"rejects an approved %s replaced before dispatch",
		async replacement => {
			const parent = path.join(directory, "approved");
			const taskFile = path.join(parent, "task.md");
			const restrictedParent = path.join(directory, "restricted");
			await Bun.write(taskFile, "Approved assignment.");
			await Bun.write(path.join(restrictedParent, "task.md"), "Unapproved restricted assignment.");
			const { wrapper, context } = await createWrapper(async () => {
				if (replacement === "file") {
					await fs.promises.unlink(taskFile);
					await fs.promises.symlink(path.join(restrictedParent, "task.md"), taskFile);
				} else if (replacement === "ancestor") {
					await fs.promises.rename(parent, `${parent}-old`);
					await fs.promises.symlink(restrictedParent, parent);
				} else {
					await fs.promises.rename(taskFile, `${taskFile}-old`);
					await Bun.write(taskFile, "Replacement assignment.");
				}
				return "Approve";
			});

			const result = await wrapper.execute(`replaced-${replacement}`, { taskFile }, undefined, undefined, context);

			expect(result.isError).toBe(true);
			expect(result.content).toEqual([
				expect.objectContaining({ text: expect.stringContaining("changed after approval; retry the call") }),
			]);
			expect(executions).toHaveLength(0);
		},
	);

	it("binds task files even without restricted folders", async () => {
		const { taskFile, restricted } = await linkedFiles();
		const { wrapper, context } = await createWrapper(
			async () => {
				await fs.promises.unlink(taskFile);
				await fs.promises.symlink(restricted, taskFile);
				return "Approve";
			},
			"always-ask",
			[],
		);

		const result = await wrapper.execute("no-restrictions", { taskFile }, undefined, undefined, context);

		expect(result.isError).not.toBe(true);
		expect(executions.map(item => item.assignment)).toEqual(["Approved assignment."]);
	});

	it("rejects the whole batch when one approved target is replaced", async () => {
		const first = path.join(directory, "first.md");
		const second = path.join(directory, "second.md");
		await Bun.write(first, "First assignment.");
		await Bun.write(second, "Second assignment.");
		const { wrapper, context } = await createWrapper(async () => {
			await fs.promises.rename(second, `${second}-old`);
			await Bun.write(second, "Replacement assignment.");
			return "Approve";
		});

		const result = await wrapper.execute(
			"replaced-batch-target",
			{ context: "Complete both assignments.", tasks: [{ taskFile: first }, { taskFile: second }] },
			undefined,
			undefined,
			context,
		);

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining("changed after approval; retry the call") }),
		]);
		expect(executions).toHaveLength(0);
	});

	it("keeps stable symlinks and reads updated bytes and hash at dispatch", async () => {
		const { safe, taskFile } = await linkedFiles();
		const bytes = new TextEncoder().encode(" \nUpdated after approval began.\n ");
		const { wrapper, context } = await createWrapper(async () => {
			await Bun.write(safe, bytes);
			return "Approve";
		});

		const result = await wrapper.execute("updated-content", { taskFile }, undefined, undefined, context);
		const digest = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");

		expect(result.isError).not.toBe(true);
		expect(executions.map(item => item.assignment)).toEqual(["Updated after approval began."]);
		expect(result.details?.results[0]).toMatchObject({ taskFile, taskFileSha256: digest });
	});

	it("discards denied-call bindings before the same args object is reused", async () => {
		const { taskFile, restricted } = await linkedFiles();
		let prompts = 0;
		const { wrapper, context } = await createWrapper(async () => (++prompts === 1 ? "Deny" : "Approve"));
		const args = { taskFile };
		await expect(wrapper.execute("denied", args, undefined, undefined, context)).rejects.toThrow("denied by user");
		await fs.promises.unlink(taskFile);
		await fs.promises.symlink(restricted, taskFile);

		const result = await wrapper.execute("approved-reuse", args, undefined, undefined, context);

		expect(result.isError).not.toBe(true);
		expect(prompts).toBe(2);
		expect(executions.map(item => item.assignment)).toEqual(["Unapproved restricted assignment."]);
	});

	it("isolates simultaneous calls that share the same args object", async () => {
		const { taskFile, restricted } = await linkedFiles();
		const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const answers = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
		let prompts = 0;
		const { wrapper, context } = await createWrapper(async () => {
			const index = prompts++;
			entered[index]!.resolve();
			return answers[index]!.promise;
		});
		const args = { taskFile };
		const first = wrapper.execute("first-concurrent", args, undefined, undefined, context);
		let second: typeof first | undefined;
		try {
			await entered[0]!.promise;
			await fs.promises.unlink(taskFile);
			await fs.promises.symlink(restricted, taskFile);
			second = wrapper.execute("second-concurrent", args, undefined, undefined, context);
			await entered[1]!.promise;
			answers[1]!.resolve("Approve");
			expect((await second).isError).not.toBe(true);
			answers[0]!.resolve("Approve");
			expect((await first).isError).not.toBe(true);
			expect(executions.map(item => item.assignment)).toEqual([
				"Unapproved restricted assignment.",
				"Approved assignment.",
			]);
		} finally {
			for (const answer of answers) answer.resolve("Deny");
			await Promise.allSettled([first, second]);
		}
	});

	it.each(["missing", "directory"])("does not recapture a %s task file after approval", async initial => {
		const taskFile = path.join(directory, "task.md");
		if (initial === "directory") await fs.promises.mkdir(taskFile);
		const { wrapper, context } = await createWrapper(async () => {
			if (initial === "directory") await fs.promises.rmdir(taskFile);
			await Bun.write(taskFile, "Created after approval began.");
			return "Approve";
		});

		const result = await wrapper.execute(`invalid-${initial}`, { taskFile }, undefined, undefined, context);

		expect(result.isError).toBe(true);
		expect(executions).toHaveLength(0);
	});

	it("restores the outer file binding after a nested wrapper invocation", async () => {
		const { taskFile, restricted } = await linkedFiles();
		let prompts = 0;
		const args = { taskFile };
		const { wrapper, context } = await createWrapper(async () => {
			if (++prompts === 1) {
				await fs.promises.unlink(taskFile);
				await fs.promises.symlink(restricted, taskFile);
				const nested = await wrapper.execute("nested", args, undefined, undefined, context);
				expect(nested.isError).not.toBe(true);
			}
			return "Approve";
		});

		const result = await wrapper.execute("outer", args, undefined, undefined, context);

		expect(result.isError).not.toBe(true);
		expect(executions.map(item => item.assignment)).toEqual([
			"Unapproved restricted assignment.",
			"Approved assignment.",
		]);
	});

	it("uses the final preflight file in modes that do not ask for approval", async () => {
		const { safe, taskFile } = await linkedFiles();
		const select = vi.fn(async () => "Deny");
		const { wrapper, context, runner } = await createWrapper(select, "yolo");
		vi.spyOn(runner, "runToolCallPreflightBefore").mockImplementation(async () => {
			await fs.promises.rename(safe, `${safe}-old`);
			await Bun.write(safe, "Preflight replacement.");
			return undefined;
		});

		const result = await wrapper.execute("no-prompt", { taskFile }, undefined, undefined, context);

		expect(result.isError).not.toBe(true);
		expect(select).not.toHaveBeenCalled();
		expect(executions.map(item => item.assignment)).toEqual(["Preflight replacement."]);
	});

	it("reads the bound target when its symlink changes after automatic approval", async () => {
		const { taskFile, restricted } = await linkedFiles();
		const select = vi.fn(async () => "Deny");
		const { wrapper, context, runner } = await createWrapper(select, "yolo");
		const runScoped = runner.runScoped.bind(runner);
		vi.spyOn(runner, "runScoped").mockImplementation(run => {
			fs.unlinkSync(taskFile);
			fs.symlinkSync(restricted, taskFile);
			return runScoped(run);
		});

		const result = await wrapper.execute("automatic-approval-swap", { taskFile }, undefined, undefined, context);

		expect(result.isError).not.toBe(true);
		expect(select).not.toHaveBeenCalled();
		expect(executions.map(item => item.assignment)).toEqual(["Approved assignment."]);
	});
});
