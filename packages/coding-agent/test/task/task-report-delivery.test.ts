import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AsyncJobError, AsyncJobManager, type AsyncJobRunResult } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { buildAsyncResultBatchMessage } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { MAX_TASK_REPORT_BYTES, readTaskReportHistory } from "@oh-my-pi/pi-coding-agent/task/report";
import { formatTaskResultSummary } from "@oh-my-pi/pi-coding-agent/task/result-summary";
import { type AgentDefinition, MAX_OUTPUT_LINES } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { SingleResult, TaskReportReference } from "@oh-my-pi/pi-tui/tools/task";
import { createSessionDefaults } from "../helpers/session-defaults";

const agent: AgentDefinition = { name: "task", description: "report probe", systemPrompt: "test", source: "bundled" };
const privateMarkers = ["PRIVATE_THINKING", "PRIVATE_TOOL_OUTPUT", "PREFILL_ONLY", "EARLIER_NARRATION"];

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface Turn {
	text(text: string): void;
	content(content: AssistantMessage["content"]): void;
	emit(event: AgentSessionEvent): void;
	yield(data?: unknown, type?: string[]): void;
}

/** Same provider-facing spy seam as executor-pass-through; storage is deliberately real. */
function fakeSession(manager: SessionManager, onPrompt: (turn: Turn) => void): AgentSession {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const messages = [assistant([{ type: "text", text: "PREFILL_ONLY" }])];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const turn: Turn = {
		emit,
		content: content => {
			const message = assistant(content);
			messages.push(message);
			manager.appendMessage(message);
			emit({ type: "message_end", message });
		},
		text: text => turn.content([{ type: "text", text }]),
		yield: (data, type) =>
			emit({
				type: "tool_execution_end",
				toolCallId: crypto.randomUUID(),
				toolName: "yield",
				isError: false,
				result: {
					content: [{ type: "text", text: "Result submitted." }],
					details: { status: "success", data, type },
				},
			}),
	};
	return {
		...createSessionDefaults(),
		state: { messages },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: manager,
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setWorkPoolYieldItems: async () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		prompt: async () => {
			onPrompt(turn);
			return true;
		},
		getLastAssistantMessage: () => messages.at(-1),
	} as unknown as AgentSession;
}

function delivery(result: SingleResult): AsyncJobRunResult {
	const text = formatTaskResultSummary(result, { totalDurationMs: result.durationMs });
	if (result.exitCode !== 0) throw new AsyncJobError(text, result.structuredOutput, result.report);
	return { text, structured: result.structuredOutput, report: result.report };
}

function requireReport(result: SingleResult): TaskReportReference {
	if (!result.report) throw new Error("Executor omitted its typed report reference");
	expect(result.report.runId).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i);
	return result.report;
}

async function snapshot(manager: ArtifactManager, report: TaskReportReference): Promise<string> {
	if (!report.artifact) throw new Error("Expected a recoverable numeric report artifact");
	expect(report.artifact.id).toMatch(/^\d+$/);
	expect(report.artifact.uri).toBe(`artifact://${report.artifact.id}`);
	const file = await manager.getPath(report.artifact.id);
	if (!file) throw new Error("Numeric artifact disappeared");
	const text = await Bun.file(file).text();
	expect(Buffer.byteLength(text)).toBe(report.artifact.bytes);
	expect(new Bun.SHA256().update(text).digest("hex")).toBe(report.artifact.sha256);
	for (const marker of privateMarkers) expect(text).not.toContain(marker);
	return text;
}

function earlierWork(turn: Turn): void {
	turn.text("EARLIER_NARRATION");
	turn.content([
		{ type: "thinking", thinking: "PRIVATE_THINKING" },
		{ type: "toolCall", id: "private-read", name: "read", arguments: { path: "private.txt" } },
	]);
	turn.emit({
		type: "tool_execution_end",
		toolCallId: "private-read",
		toolName: "read",
		isError: false,
		result: { content: [{ type: "text", text: "PRIVATE_TOOL_OUTPUT" }] },
	});
}

describe("provider-free task report delivery smoke", () => {
	let root: string;
	let artifacts: ArtifactManager;
	const sessions = new Set<SessionManager>();
	const jobs = new Set<AsyncJobManager>();

	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-report-delivery-"));
		artifacts = new ArtifactManager(path.join(root, "numeric"));
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of jobs) await manager.dispose();
		jobs.clear();
		for (const manager of sessions) await manager.close();
		sessions.clear();
		AsyncJobManager.resetForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		await fs.rm(root, { recursive: true, force: true });
	});

	function install(onPrompt: (turn: Turn) => void, missingManager = false): void {
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const manager = options?.sessionManager;
			if (!manager) throw new Error("Executor did not supply its child manager");
			sessions.add(manager);
			await manager.ensureOnDisk();
			if (missingManager) vi.spyOn(manager, "getArtifactManager").mockReturnValue(null);
			return {
				session: fakeSession(manager, onPrompt),
				eventBus: new EventBus(),
				setToolUIContext: () => {},
				extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult,
			};
		});
	}

	function options(id = "ReportProbe") {
		return {
			cwd: root,
			agent,
			task: "publish findings",
			index: 0,
			id,
			structured: false,
			settings: Settings.isolated({ "launch.enabled": false }),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir: path.join(root, "children"),
			parentArtifactManager: artifacts,
		};
	}

	it("recovers a full table through wait, reopens the journal, and keeps both snapshots after delivery expiry and name reuse", async () => {
		const table = [
			"| unique-row | measured-value |",
			"| --- | --- |",
			...Array.from({ length: MAX_OUTPUT_LINES + 10 }, (_, n) => `| INITIAL_ROW_${n} | ${n * 17 + 3} |`),
		].join("\n");
		install(turn => {
			earlierWork(turn);
			turn.text(table);
		});
		const manager = new AsyncJobManager({ consumedResultEvictionMs: 0 });
		jobs.add(manager);
		const gate = Promise.withResolvers<void>();
		let initial: SingleResult | undefined;
		const id = manager.register(
			"task",
			"ReportProbe",
			async () => {
				await gate.promise;
				initial = await runSubprocess(options());
				return delivery(initial);
			},
			{ id: "ReportProbe", agentId: "ReportProbe", ownerId: "Main" },
		);
		const toolSession = {
			cwd: root,
			settings: Settings.isolated({ "launch.enabled": false }),
			agentRegistry: AgentRegistry.global(),
			asyncJobManager: manager,
			getAgentId: () => "Main",
		} as unknown as ToolSession;
		const waiting = new WaitTool(toolSession).execute("collect-report", {});
		gate.resolve();
		const collected = await waiting;
		await manager.waitForAll();
		if (!initial) throw new Error("Initial executor did not settle");
		const first = requireReport(initial);
		expect(initial.exitCode).toBe(0);
		expect(initial.truncated).toBe(true);
		expect(initial.output).not.toBe(table);
		expect(first.status).toBe("complete");
		expect(collected.details?.jobs?.[0]?.report).toEqual(first);
		expect(manager.isJobResultConsumed(id)).toBe(true);
		expect(await snapshot(artifacts, first)).toBe(table);

		// Release every original manager, then reconstruct from disk: no process-only journal can pass.
		for (const session of sessions) await session.close();
		sessions.clear();
		const reopened = await SessionManager.open(
			path.join(root, "children", "ReportProbe.jsonl"),
			undefined,
			undefined,
			{ suppressBreadcrumb: true, throwIfMissing: true },
		);
		sessions.add(reopened);
		reopened.adoptArtifactManager(artifacts);
		expect(readTaskReportHistory(reopened, "ReportProbe")).toEqual(first);
		const secondTable = "| followup-row | measured-value |\n| --- | --- |\n| FOLLOWUP_UNIQUE | 987654321 |";
		const final = "See previous table for the complete measurements.";
		const revived = fakeSession(reopened, turn => {
			turn.text(secondTable);
			turn.text(final);
		});
		vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockResolvedValue(revived);
		const followup = await runSubagentFollowUpTurn({
			id: "ReportProbe",
			agent,
			message: "continue the report",
			structured: false,
			artifactsDir: path.join(root, "children"),
			parentArtifactManager: artifacts,
		});
		const second = requireReport(followup);
		expect(followup.exitCode).toBe(0);
		expect(followup.output).toBe(final);
		expect(second.status).toBe("complete");
		expect(second.runId).not.toBe(first.runId);
		expect(second.artifact?.id).not.toBe(first.artifact?.id);
		expect(await snapshot(artifacts, second)).toBe(`${table}\n\n${secondTable}\n\n${final}`);
		expect(await snapshot(artifacts, first)).toBe(table);

		// The consumed job's real zero-grace timer expires; numeric reports are not its retained body.
		const deadline = Date.now() + 2_000;
		while (manager.getJob(id)) {
			if (Date.now() > deadline) throw new Error("Consumed job did not expire");
			await scheduler.yield();
		}
		const delivered = Promise.withResolvers<TaskReportReference>();
		manager.registerDeliverySink("Main", (jobId, text, job) => {
			const message = buildAsyncResultBatchMessage([{ jobId, result: text, job, durationMs: 0, epoch: 0 }]);
			const report = message?.details?.jobs[0]?.report;
			if (!report) throw new Error("Automatic delivery lost the typed report");
			delivered.resolve(report);
		});
		const reusedId = manager.register("task", "ReportProbe", async () => delivery(followup), {
			id,
			agentId: "ReportProbe",
			ownerId: "Main",
		});
		expect(reusedId).toBe(id);
		await manager.waitForAll();
		expect(await manager.drainDeliveries({ timeoutMs: 2_000 })).toBe(true);
		expect(await delivered.promise).toEqual(second);
		expect(await snapshot(artifacts, first)).toBe(table);
		expect(await snapshot(artifacts, second)).toBe(`${table}\n\n${secondTable}\n\n${final}`);
	});

	it("retains an accepted scalar table across more tool work without changing canonical latest-wins assembly", async () => {
		const table = "| accepted-row | value |\n| --- | --- |\n| YIELDED_TABLE_UNIQUE | 123456789 |";
		const pointer = "See previous accepted table for measurements.";
		install(turn => {
			turn.yield(table, ["report"]);
			earlierWork(turn);
			turn.yield(pointer, ["report"]);
			turn.yield();
		});
		const result = await runSubprocess({
			...options(),
			structured: true,
			outputSchemaMode: "strict",
			outputSchema: { type: "object", properties: { report: { type: "string" } }, required: ["report"] },
		});
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput).toMatchObject({ status: "valid", data: { report: pointer } });
		expect(JSON.parse(result.output)).toEqual({ report: pointer });
		expect(result.output).not.toContain("YIELDED_TABLE_UNIQUE");
		const report = requireReport(result);
		expect(report.status).toBe("complete");
		const recovered = await snapshot(artifacts, report);
		expect(recovered).toContain(JSON.stringify(table));
		expect(recovered).toContain(pointer);
	});

	it("downgrades cancellation during snapshot IO without discarding the saved artifact", async () => {
		const text = "Public measurements completed before cancellation: 1618033";
		install(turn => turn.text(text));
		const controller = new AbortController();
		const save = artifacts.save.bind(artifacts);
		vi.spyOn(artifacts, "save").mockImplementation(async (content, toolType) => {
			const id = await save(content, toolType);
			// The publisher is still awaiting save: cancellation must win over its pre-IO status.
			controller.abort("cancelled while publishing");
			return id;
		});
		const result = await runSubprocess({ ...options(), signal: controller.signal });
		expect(result.aborted).toBe(true);
		const report = requireReport(result);
		expect(report).toMatchObject({ status: "partial", reason: "aborted" });
		expect(await snapshot(artifacts, report)).toBe(text);
	});

	it("keeps a failed run failed while retaining only its public report", async () => {
		install(turn => {
			earlierWork(turn);
			turn.text("Public partial measurements: 271828");
			throw new Error("probe failed");
		});
		const result = await runSubprocess(options());
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("probe failed");
		const report = requireReport(result);
		expect(report).toMatchObject({ status: "partial", reason: "failed" });
		expect(await snapshot(artifacts, report)).toBe("Public partial measurements: 271828");
	});

	it("preserves strict schema-invalid data and failure semantics alongside a partial report", async () => {
		install(turn => {
			earlierWork(turn);
			turn.yield({ ok: "not-a-boolean" });
		});
		const result = await runSubprocess({
			...options(),
			structured: true,
			outputSchemaMode: "strict",
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});
		expect(result.exitCode).toBe(1);
		expect(result.structuredOutput).toMatchObject({ status: "invalid", data: { ok: "not-a-boolean" } });
		const report = requireReport(result);
		expect(report).toMatchObject({ status: "partial", reason: "schema-invalid" });
		expect(await snapshot(artifacts, report)).toContain("not-a-boolean");
	});

	it.each(["too-large", "storage-unavailable"] as const)(
		"marks %s publication partial without changing successful completion",
		async reason => {
			const text = reason === "too-large" ? "x".repeat(MAX_TASK_REPORT_BYTES + 1) : "Small public result: 314159";
			install(turn => turn.text(text), reason === "storage-unavailable");
			const result = await runSubprocess(
				reason === "storage-unavailable"
					? { ...options(), artifactsDir: undefined, parentArtifactManager: undefined }
					: options(),
			);
			expect(result.exitCode).toBe(0);
			expect(result.error).toBeUndefined();
			expect(result.structuredOutput).toBeUndefined();
			expect(requireReport(result)).toMatchObject({ status: "partial", reason });
			expect(result.report?.artifact).toBeUndefined();
			if (reason === "storage-unavailable") expect(result.output).toBe(text);
			else expect(result.truncated).toBe(true);
		},
	);
});
