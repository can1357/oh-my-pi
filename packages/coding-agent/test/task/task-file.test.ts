import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolCall, SpeculativeOperationSink } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { TaskLaunchSession } from "@oh-my-pi/pi-coding-agent/task/speculative-launch";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { recordApprovalGrant, resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { getApprovalGrants } from "@oh-my-pi/pi-coding-agent/tools/approval-cache";
import type { AgentProgress, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	return Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
}

describe("taskFile dispatch", () => {
	let directory: string;
	const managers: AsyncJobManager[] = [];
	const executions: ExecutorOptions[] = [];
	const gates = new Map<string, PromiseWithResolvers<void>>();
	const started = new Map<string, PromiseWithResolvers<void>>();

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-file-"));
		executions.length = 0;
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [
				{
					name: "task",
					description: "General-purpose task agent",
					systemPrompt: "You are a task agent.",
					source: "bundled",
				},
			],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			executions.push(options);
			started.get(options.id)?.resolve();
			await gates.get(options.id)?.promise;
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
		for (const gate of gates.values()) gate.resolve();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
		gates.clear();
		started.clear();
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		await fs.rm(directory, { recursive: true, force: true });
	});

	async function createTool(
		batch = false,
		manager?: AsyncJobManager,
		settings: Record<string, unknown> = {},
		cwd = directory,
	): Promise<TaskTool> {
		return TaskTool.create({
			cwd,
			hasUI: false,
			settings: Settings.isolated({
				"async.enabled": manager !== undefined,
				"task.batch": batch,
				"task.file": true,
				...settings,
			}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			localProtocolOptions: { getArtifactsDir: () => path.join(directory, "artifacts") },
			asyncJobManager: manager,
		} as unknown as ToolSession);
	}

	async function writeTaskFile(name: string, contents: string | Uint8Array): Promise<string> {
		const file = path.join(directory, name);
		await Bun.write(file, contents);
		return file;
	}

	it("rejects taskFile while task.file is off", async () => {
		const taskFile = await writeTaskFile("disabled.md", "File task that must not run.");
		const tool = await createTool(false, undefined, { "task.file": false });

		const result = await tool.execute("disabled", { name: "Disabled", taskFile });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("task.file");
		expect(executions).toHaveLength(0);
	});

	it("matches task files and the working directory against restricted folders, and never remembers the approval", async () => {
		const cwd = path.join(directory, "work");
		const restricted = path.join(directory, "restricted");
		await fs.mkdir(cwd);
		const taskFile = await writeTaskFile("restricted/assignment.md", "Restricted assignment.");
		const outside = await writeTaskFile("assignment.md", "Unrestricted assignment.");
		const tool = await createTool(true, undefined, {}, cwd);
		const batch = (file: string) => ({ context: "Context.", tasks: [{ task: "Inline work." }, { taskFile: file }] });

		expect(
			resolveApproval(tool, batch(taskFile), "yolo", {}, undefined, { restrictedFolders: [restricted], cwd }),
		).toMatchObject({
			policy: "prompt",
			source: "restriction",
		});
		expect(
			resolveApproval(tool, batch(outside), "yolo", {}, undefined, { restrictedFolders: [cwd], cwd }),
		).toMatchObject({
			policy: "prompt",
			source: "restriction",
		});
		const grants = getApprovalGrants(path.join(directory, "agent"), "session");
		recordApprovalGrant(tool, batch(outside), grants, "exec", { grant: "target", always: false });
		expect(resolveApproval(tool, batch(outside), "always-ask-cached", {}, grants).policy).toBe("prompt");
	});

	it("dispatches a file item with its provenance, leaving inline items and the submitted args untouched", async () => {
		const source = " \r\nInspect <widget> & {{literal}}: café 🦀\tdata\r\n\r\n";
		const bytes = new TextEncoder().encode(source);
		const taskFile = await writeTaskFile("assignment.md", bytes);
		const args = {
			context: "Shared context.",
			tasks: [
				{ name: "FileTask", taskFile, solutionSpace: "Follow the steps." },
				{ name: "InlineTask", task: "  Inline work.\n", solutionSpace: "Follow the steps." },
			],
		};
		const submitted = structuredClone(args);
		const tool = await createTool(true);

		const result = await tool.execute("dispatch-file", args);

		expect(result.isError).not.toBe(true);
		expect(args).toEqual(submitted);
		const dispatched = executions.find(item => item.id === "FileTask");
		expect(dispatched).toMatchObject({ assignment: source.trim(), context: "Shared context." });
		expect(executions.find(item => item.id === "InlineTask")?.assignment).toBe("Inline work.");
		expect(result.details?.results.find(item => item.id === "FileTask")).toMatchObject({
			assignment: source.trim(),
			taskFile,
			taskFileSha256: await sha256(bytes),
		});
		expect(result.details?.progress).toBeUndefined();
	});

	it("formats file instructions exactly like inline ones", async () => {
		const source = "  First instruction.  \r\n\r\n\r\nSecond instruction.\r\n  ";
		const taskFile = await writeTaskFile("formatted.md", source);
		const tool = await createTool();

		await tool.execute("file", { name: "File", taskFile });
		await tool.execute("inline", { name: "Inline", task: source });

		expect(executions).toHaveLength(2);
		expect(executions[0].task).toBe(executions[1].task);
	});

	it("keeps literal JSON escape sequences in file contents", async () => {
		const source = String.raw`# Target\nKeep \"quoted\" text and \t tabs literal.`;
		const taskFile = await writeTaskFile("literal-escapes.md", source);
		const tool = await createTool();

		await tool.execute("literal-escapes", { name: "LiteralEscapes", taskFile });

		expect(executions[0]?.assignment).toBe(source);
	});

	it("resolves local URLs to their backing file for restrictions and dispatch", async () => {
		const localRoot = path.join(directory, "artifacts", "local");
		const taskFile = "local://nested/assignment.md";
		const bytes = new TextEncoder().encode("Local task instructions.\n");
		await Bun.write(path.join(localRoot, "nested", "assignment.md"), bytes);
		const tool = await createTool();

		expect(
			resolveApproval(tool, { taskFile }, "yolo", {}, undefined, { restrictedFolders: [localRoot], cwd: directory }),
		).toMatchObject({ policy: "prompt", source: "restriction" });
		const result = await tool.execute("local-file", { name: "Local", taskFile });

		expect(result.details?.results[0]).toMatchObject({
			assignment: "Local task instructions.",
			taskFile,
			taskFileSha256: await sha256(bytes),
		});
	});

	it("keeps the dispatch-time contents and hash for a queued async child", async () => {
		const taskFile = await writeTaskFile("async.md", "Stale contents before dispatch.");
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const tool = await createTool(true, manager, { "task.maxConcurrency": 1 });
		const gate = Promise.withResolvers<void>();
		const blockerStarted = Promise.withResolvers<void>();
		gates.set("Blocker", gate);
		started.set("Blocker", blockerStarted);
		await tool.execute("blocking-job", { name: "Blocker", task: "Occupy the only execution slot." });
		await blockerStarted.promise;
		const source = "\uFEFF  Resolve the async task.\r\n  ";
		const bytes = new TextEncoder().encode(source);
		await Bun.write(taskFile, bytes);
		const updates: TaskToolDetails[] = [];

		await tool.execute(
			"async-file",
			{ context: "Async context.", tasks: [{ name: "AsyncFile", taskFile }] },
			undefined,
			update => {
				if (update.details) updates.push(update.details);
			},
		);
		await Bun.write(taskFile, "Changed after dispatch.");
		gate.resolve();
		await manager.getJob("AsyncFile")?.promise;

		const expected = { assignment: source.trim(), taskFile, taskFileSha256: await sha256(bytes) };
		expect(executions.find(item => item.id === "AsyncFile")?.assignment).toBe(source.trim());
		expect(updates.at(-1)?.progress?.[0]).toMatchObject({ ...expected, status: "completed" });
	});

	it("reads files at dispatch, not while task arguments stream", async () => {
		const taskFile = await writeTaskFile("streamed.md", "Stale contents during streaming.");
		const tool = await createTool(true);
		const sink: SpeculativeOperationSink = {
			maxInFlight: 2,
			admit: async () => undefined,
			authorizeLaunch: async () => ({ allowed: true }),
			close: () => {},
		};
		const toolCall: AgentToolCall = { type: "toolCall", id: "streamed-file", name: "task", arguments: {} };
		const session = await tool.speculation.stream?.open({ coordinator: sink, parentToolCallId: toolCall.id });
		if (!session) throw new Error("Expected speculative task session");
		const args = { context: "Streamed context.", tasks: [{ name: "Streamed", taskFile }] };
		session.update(toolCall, JSON.stringify(args));
		session.finalize({ toolCall, args });
		await (session as TaskLaunchSession).adopt([]);
		expect(executions).toHaveLength(0);
		await Bun.write(taskFile, "Changed after streaming.");

		await tool.execute(toolCall.id, args);

		expect(executions.map(item => item.assignment)).toEqual(["Changed after streaming."]);
	});

	it.each([
		{ batch: false, item: { task: "Inline task.", taskFile: "/tmp/exclusive.md" } },
		{ batch: true, item: { name: "Neither" } },
	])("requires exactly one of task and taskFile (batch=$batch)", async ({ batch, item }) => {
		const tool = await createTool(batch);

		const result = await tool.execute("exclusive", batch ? { context: "Context.", tasks: [item] } : item);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/exactly one of `task` or `taskFile`/);
		expect(executions).toHaveLength(0);
	});

	it("rejects a file over 4 MiB before starting any batch item, and accepts exactly 4 MiB", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		const tool = await createTool(true, manager);
		const oversize = await writeTaskFile("oversize.md", "a".repeat(4 * 1024 * 1024 + 1));
		const limit = await writeTaskFile("limit.md", "a".repeat(4 * 1024 * 1024));

		const rejected = await tool.execute("oversize", {
			context: "Batch context.",
			tasks: [
				{ name: "Valid", task: "Must not start." },
				{ name: "Oversize", taskFile: oversize },
			],
		});

		expect(rejected.isError).toBe(true);
		expect(textOf(rejected)).toContain("4 MiB");
		expect(executions).toHaveLength(0);
		expect(manager.getJob("Valid")).toBeUndefined();
		const accepted = await createTool();
		expect((await accepted.execute("limit", { name: "Limit", taskFile: limit })).isError).not.toBe(true);
	});

	it.each([
		{
			name: "malformed UTF-8",
			taskFile: () => writeTaskFile("bad.md", new Uint8Array([0x61, 0xc3, 0x28])),
			error: /UTF-8/,
		},
		{ name: "blank contents", taskFile: () => writeTaskFile("bad.md", " \n\t "), error: /non-empty/ },
		{ name: "a directory", taskFile: () => directory, error: /regular file/ },
		{ name: "a relative path", taskFile: () => "relative.md", error: /absolute/ },
	])("rejects $name", async ({ taskFile: makeTaskFile, error }) => {
		const taskFile = await makeTaskFile();
		const tool = await createTool();

		const result = await tool.execute("bad", { name: "Bad", taskFile });

		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(error);
		expect(executions).toHaveLength(0);
	});
});
